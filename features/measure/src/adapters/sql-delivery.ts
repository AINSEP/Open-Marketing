import { callContextSchema, idSchema, parseBoundary } from "@open-marketing/contracts";
import type { CallContext, ClockPort, IdPort, ServiceContext } from "@open-marketing/contracts";
import type { ConversionDeliveryStatePort, MeasureAuditPort, MeasureObserverPort, MeasureSqlDatabase, MeasureSqlQueryable } from "../ports.js";
import type { ConversionDispatchRecord } from "../types.js";
import { dispatchRecordSchema, failure, scopeKey, serviceContextSchema } from "../rules.js";
import { validateDeliveryTransition } from "../delivery/ledger-rules.js";
import { sqlBoundary, unwrap } from "./sql-boundary.js";

/** SQL dispatch claim + append-only history, sharing the memory ledger suite.
 * Transactions must serialize competing claims. No mutable overwrite or retry loop.
 * @example createSqlConversionDeliveryState({ database }, { observer })
 * @complexity Indexed latest-record lookup and append, O(log n). */
export function createSqlConversionDeliveryState(required: { database: MeasureSqlDatabase }, optional?: { observer?: MeasureObserverPort }): ConversionDeliveryStatePort {
  return {
    async begin(input, options) {
      const context = parseBoundary({ schema: serviceContextSchema, input: input.context });
      if (!context.ok) return context;
      const parsed = parseBoundary({ schema: dispatchRecordSchema, input: input.record });
      if (!parsed.ok) return parsed;
      if (parsed.value.status !== "dispatching") return failure({ code: "invalid_input", message: "Claim must begin dispatching" });
      return sqlBoundary({ context: asCallContext({ context: input.context }), operation: "measure.sql.claimDelivery", observer: optional?.observer, work: () => required.database.transaction({ work: async transaction => {
        const previous = await latestRecord({ transaction, context: input.context, deliveryId: parsed.value.deliveryId });
        if (previous) {
          if (previous.record.identity !== parsed.value.identity || previous.record.subjectId !== parsed.value.subjectId || previous.record.eventId !== parsed.value.eventId) return unwrap({ outcome: failure({ code: "conflict", message: "Delivery ID already binds another payload" }) });
          return { acquired: false, record: previous.record };
        }
        await insertRecord({ transaction, context: input.context, record: parsed.value, version: 1 });
        return { acquired: true, record: parsed.value };
      } }) }, options);
    },
    async append(input, options) {
      const context = parseBoundary({ schema: serviceContextSchema, input: input.context });
      if (!context.ok) return context;
      const parsed = parseBoundary({ schema: dispatchRecordSchema, input: input.record });
      if (!parsed.ok) return parsed;
      return sqlBoundary({ context: asCallContext({ context: input.context }), operation: "measure.sql.appendDelivery", observer: optional?.observer, work: () => required.database.transaction({ work: async transaction => {
        const previous = await latestRecord({ transaction, context: input.context, deliveryId: parsed.value.deliveryId });
        unwrap({ outcome: validateDeliveryTransition({ previous: previous?.record, record: parsed.value }) });
        await insertRecord({ transaction, context: input.context, record: parsed.value, version: (previous?.version ?? 0) + 1 });
        return parsed.value;
      } }) }, options);
    },
  };
}
async function latestRecord(required: { transaction: MeasureSqlQueryable; context: ServiceContext; deliveryId: string }): Promise<{ record: ConversionDispatchRecord; version: number } | null> {
  const result = await required.transaction.query({ text: "SELECT record_json, version FROM measure_conversion_delivery WHERE scope_key=$1 AND delivery_id=$2 ORDER BY version DESC LIMIT 1", values: [scopeKey({ scope: required.context.scope }), required.deliveryId] });
  const row = result.rows[0];
  if (!row) return null;
  const version = Number(row.version);
  if (!Number.isSafeInteger(version) || version < 1) return unwrap({ outcome: failure({ code: "invalid_input", message: "Invalid delivery ledger version" }) });
  return { record: unwrap({ outcome: parseBoundary({ schema: dispatchRecordSchema, input: JSON.parse(String(row.record_json)) }) }), version };
}
async function insertRecord(required: { transaction: MeasureSqlQueryable; context: ServiceContext; record: ConversionDispatchRecord; version: number }): Promise<void> {
  await required.transaction.query({ text: "INSERT INTO measure_conversion_delivery (scope_key,delivery_id,version,record_json,context_json,subject_id,event_id) VALUES ($1,$2,$3,$4,$5,$6,$7)", values: [scopeKey({ scope: required.context.scope }), required.record.deliveryId, required.version, JSON.stringify(required.record), JSON.stringify(required.context), required.record.subjectId, required.record.eventId] });
}
/** Durable redacted egress audit; IDs/clock/DB are caller-owned. */
export function createSqlMeasureAudit(required: { database: MeasureSqlDatabase; ids: IdPort; clock: ClockPort }, optional?: { observer?: MeasureObserverPort }): MeasureAuditPort {
  return {
    async record(input, options) {
      const context = parseBoundary({ schema: callContextSchema, input: input.context });
      if (!context.ok) return context;
      const operationId = parseBoundary({ schema: idSchema, input: input.operationId });
      if (!operationId.ok) return operationId;
      const outcome = parseBoundary({ schema: idSchema, input: input.outcome });
      if (!outcome.ok) return outcome;
      return sqlBoundary({ context: context.value, operation: "measure.sql.audit", observer: optional?.observer, work: async () => {
        await required.database.query({ text: "INSERT INTO measure_egress_audit (scope_key,audit_id,operation_id,outcome,context_json,recorded_at) VALUES ($1,$2,$3,$4,$5,$6)", values: [scopeKey({ scope: context.value.scope }), required.ids.next({}), operationId.value, outcome.value, JSON.stringify(context.value), required.clock.now({})] });
      } }, options);
    },
  };
}
function asCallContext(required: { context: ServiceContext }): CallContext {
  return { scope: required.context.scope, principal: { kind: "service", serviceId: required.context.serviceId }, correlationId: required.context.correlationId, traceId: required.context.traceId };
}

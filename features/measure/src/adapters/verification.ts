import { z } from "zod";
import { parseBoundary, scopeSchema } from "@open-marketing/contracts";
import type { Scope } from "@open-marketing/contracts";
import type { ConversionVerificationPort, MeasureObserverPort, MeasureSqlDatabase } from "../ports.js";
import type { ConversionInput } from "../types.js";
import { clone, conversionSchema, eventIdentity, sameScope, scopeKey, serviceContextSchema } from "../rules.js";
import { sqlBoundary } from "./sql-boundary.js";

const verificationInputSchema = z.strictObject({ context: serviceContextSchema, event: conversionSchema });
const committedEventSchema = z.strictObject({ scope: scopeSchema, event: conversionSchema });

/** Explicit committed-inbox fixture; empty/malformed/oversized fixtures fail closed.
 * This test double is never an authentication shortcut for production ingestion.
 * @complexity O(n*k log k) time over at most 1000 events; O(n*k) storage. */
export function createMemoryConversionVerification(required: { events?: readonly { scope: Scope; event: ConversionInput }[] }): ConversionVerificationPort {
  const events = clone({ value: required.events?.slice(0, 1001) ?? [] });
  return {
    async verify(input) {
      const parsed = parseBoundary({ schema: verificationInputSchema, input });
      if (!parsed.ok) return parsed;
      const stored = parseBoundary({ schema: z.array(committedEventSchema).max(1000), input: events });
      if (!stored.ok) return stored;
      const identity = eventIdentity({ event: parsed.value.event });
      const verified = stored.value.some(entry => sameScope({ left: entry.scope, right: parsed.value.context.scope }) && eventIdentity({ event: entry.event }) === identity);
      return { ok: true, value: { verified } };
    },
  };
}

/** Reads the committed inbox using the same DB as ingestion. No mutable verification
 * cache or second outbox is created. @complexity Indexed event lookup O(log n); one query. */
export function createSqlConversionVerification(required: { database: MeasureSqlDatabase }, optional?: { observer?: MeasureObserverPort }): ConversionVerificationPort {
  return {
    async verify(input, options) {
      const parsed = parseBoundary({ schema: verificationInputSchema, input });
      if (!parsed.ok) return parsed;
      const context = parsed.value.context;
      const auditContext = { scope: context.scope, principal: { kind: "service" as const, serviceId: context.serviceId }, correlationId: context.correlationId, traceId: context.traceId };
      return sqlBoundary({ context: auditContext, operation: "measure.sql.verifyConversion", observer: optional?.observer, work: async () => {
        const result = await required.database.query({ text: "SELECT event_id FROM measure_conversion_event WHERE scope_key=$1 AND event_id=$2 AND identity=$3 LIMIT 1", values: [scopeKey({ scope: context.scope }), parsed.value.event.eventId, eventIdentity({ event: parsed.value.event })] });
        return { verified: result.rows.length === 1 };
      } }, options);
    },
  };
}

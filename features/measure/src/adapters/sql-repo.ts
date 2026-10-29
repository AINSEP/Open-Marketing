import { callContextSchema, idSchema, parseBoundary } from "@open-marketing/contracts";
import type { CallContext, CallOptions, Outcome, ObserverPort } from "@open-marketing/contracts";
import type { MeasurePrivacyPort, MeasureRepoPort, MeasureSqlDatabase, MeasureSqlQueryable, MeasureTransactionalJobPort } from "../ports.js";
import type { AttributionResult, ConversionInput, ConversionReceipt, PlatformMetricSnapshot, VerifiedConversionSource } from "../types.js";
import { attributionInputSchema, attributionSchema, eventIdentity, failure, ingestionContext, parseSourceEvent, querySchema, scopeKey, snapshotSchema, summarySchema } from "../rules.js";
import { snapshotIdentity, validateLineage } from "../reporting/snapshot-rules.js";
import { sqlBoundary, unwrap } from "./sql-boundary.js";

type RepoDependencies = { database: MeasureSqlDatabase; jobs: MeasureTransactionalJobPort };
/** SQL repository behind the server's injected DB port. No driver construction,
 * hidden connection, migration application or second outbox. The jobs adapter MUST
 * use the supplied transaction; row + job failures roll back together.
 * @example createSqlMeasureRepo({ database, jobs }, { observer })
 * @complexity Indexed event lookup/insert; reporting selects earliest subject/definition outcomes before period filters. */
export function createSqlMeasureRepo(required: RepoDependencies, optional?: { observer?: ObserverPort }): MeasureRepoPort & MeasurePrivacyPort {
  return {
    async purgeSubject(input, options) {
      const parsed = parseBoundary({ schema: callContextSchema, input: input.context });
      if (!parsed.ok) return parsed;
      const subjectId = parseBoundary({ schema: idSchema, input: input.subjectId });
      if (!subjectId.ok) return subjectId;
      return sqlBoundary({ context: parsed.value, operation: "measure.sql.purgeSubject", observer: optional?.observer, work: () => required.database.transaction({ work: async ({ session: transaction }) => {
        // Only the reloadable order reference is cleared; the original semantic digest stays immutable.
        await transaction.query({ text: "UPDATE measure_conversion_event SET event_json=json_remove(event_json,'$.orderRef') WHERE scope_key=$1 AND subject_id=$2", values: [scopeKey({ scope: parsed.value.scope }), subjectId.value] });
      } }) }, options);
    },
    async appendConversion(input, options) {
      const parsed = parseSourceEvent({ input });
      if (!parsed.ok) return parsed;
      const value = parsed.value;
      return sqlBoundary({ context: ingestionContext(value), operation: "measure.sql.appendConversion", observer: optional?.observer, work: () => required.database.transaction({ work: ({ session: transaction }) => commitConversion({ ...required, transaction, ...value }, options) }) }, options);
    },
    async appendSnapshot(input, options) {
      const context = parseBoundary({ schema: callContextSchema, input: input.context });
      if (!context.ok) return context;
      const parsed = parseBoundary({ schema: snapshotSchema, input: input.snapshot });
      if (!parsed.ok) return parsed;
      return sqlBoundary({ context: context.value, operation: "measure.sql.appendSnapshot", observer: optional?.observer, work: () => required.database.transaction({ work: ({ session: transaction }) => commitSnapshot({ transaction, context: context.value, snapshot: parsed.value }) }) }, options);
    },
    async appendAttribution(input, options) {
      const parsed = parseBoundary({ schema: attributionInputSchema, input });
      if (!parsed.ok) return parsed;
      return sqlBoundary({ context: parsed.value.context, operation: "measure.sql.appendAttribution", observer: optional?.observer, work: () => required.database.transaction({ work: ({ session: transaction }) => commitAttribution({ ...parsed.value, transaction }) }) }, options);
    },
    async readAttribution(input, options) {
      const context = parseBoundary({ schema: callContextSchema, input: input.context });
      if (!context.ok) return context;
      const parsed = parseBoundary({ schema: querySchema, input: input.query });
      if (!parsed.ok) return parsed;
      return sqlBoundary({ context: context.value, operation: "measure.sql.readAttribution", observer: optional?.observer, work: async () => {
        // One aggregate query: indexed subject/definition anti-join excludes every later outcome.
        const result = await required.database.query({ text: "SELECT COUNT(*) AS conversions, MAX(e.occurred_at) AS watermark FROM measure_attribution_result a JOIN measure_conversion_event e ON a.scope_key=e.scope_key AND a.source_id=e.source_id AND a.event_id=e.event_id WHERE a.scope_key=$1 AND a.model_version=$2 AND a.campaign_id IS NOT NULL AND e.occurred_at >= $3 AND e.occurred_at < $4 AND a.account_id=$5 AND e.definition_id=$6 AND NOT EXISTS (SELECT 1 FROM measure_conversion_event prior WHERE prior.scope_key=e.scope_key AND prior.subject_id=e.subject_id AND prior.definition_id=e.definition_id AND (prior.occurred_at < e.occurred_at OR (prior.occurred_at=e.occurred_at AND prior.event_id < e.event_id) OR (prior.occurred_at=e.occurred_at AND prior.event_id=e.event_id AND prior.source_id < e.source_id)))", values: [scopeKey({ scope: context.value.scope }), parsed.value.attributionModel, parsed.value.window.start, parsed.value.window.end, parsed.value.accountId, parsed.value.definitionId] });
        const row = result.rows[0];
        return unwrap({ outcome: parseBoundary({ schema: summarySchema, input: { conversions: Number(row?.conversions), modelVersion: parsed.value.attributionModel, watermark: row?.watermark == null ? parsed.value.window.start : Number(row.watermark) } }) });
      } }, options);
    },
  };
}
/** A failed jobs outcome is thrown to force rollback of BOTH participants. */
async function commitConversion(required: RepoDependencies & { transaction: MeasureSqlQueryable; source: VerifiedConversionSource; event: ConversionInput }, optional?: CallOptions): Promise<ConversionReceipt> {
  if (optional?.signal?.aborted) return unwrap({ outcome: failure({ code: "cancelled", message: "Conversion transaction cancelled" }) });
  const tenant = scopeKey({ scope: required.source.scope });
  const values = [tenant, required.source.sourceId, required.event.eventId];
  const existing = await required.transaction.query({ text: "SELECT identity, job_id FROM measure_conversion_event WHERE scope_key=$1 AND source_id=$2 AND event_id=$3", values });
  const identity = eventIdentity({ event: required.event });
  const row = existing.rows[0];
  if (row) return unwrap({ outcome: existingConversion({ row, identity, eventId: required.event.eventId }) });
  const context = ingestionContext(required);
  const job = unwrap({ outcome: await required.jobs.enqueue({ transaction: required.transaction, source: required.source, event: required.event, context }, optional) });
  if (optional?.signal?.aborted) return unwrap({ outcome: failure({ code: "cancelled", message: "Conversion transaction cancelled" }) });
  const jobId = unwrap({ outcome: parseBoundary({ schema: idSchema, input: job.jobId }) });
  await required.transaction.query({ text: "INSERT INTO measure_conversion_event (scope_key,source_id,event_id,subject_id,definition_id,authentication_revision,occurred_at,identity,event_json,context_json,job_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)", values: [...values, required.event.subjectId, required.event.definitionId, required.source.authenticationRevision, required.event.occurredAt, identity, JSON.stringify(required.event), JSON.stringify(context), jobId] });
  return { eventId: required.event.eventId, status: "accepted", jobId };
}
function existingConversion(required: { row: Record<string, unknown>; identity: string; eventId: string }): Outcome<ConversionReceipt> {
  if (required.row.identity !== required.identity) return failure({ code: "conflict", message: "Conflicting duplicate conversion" });
  const jobId = parseBoundary({ schema: idSchema, input: required.row.job_id });
  if (!jobId.ok) return jobId;
  return { ok: true, value: { eventId: required.eventId, status: "duplicate", jobId: jobId.value } };
}
async function readSnapshot(required: { transaction: MeasureSqlQueryable; tenant: string; snapshotId: string }): Promise<PlatformMetricSnapshot | null> {
  const result = await required.transaction.query({ text: "SELECT snapshot_json FROM measure_platform_snapshot WHERE scope_key=$1 AND snapshot_id=$2", values: [required.tenant, required.snapshotId] });
  if (!result.rows[0]) return null;
  return unwrap({ outcome: parseBoundary({ schema: snapshotSchema, input: JSON.parse(String(result.rows[0].snapshot_json)) }) });
}
async function commitSnapshot(required: { transaction: MeasureSqlQueryable; context: CallContext; snapshot: PlatformMetricSnapshot }): Promise<PlatformMetricSnapshot> {
  const tenant = scopeKey({ scope: required.context.scope });
  const existing = await readSnapshot({ ...required, tenant, snapshotId: required.snapshot.snapshotId });
  if (existing) {
    if (snapshotIdentity({ snapshot: existing }) !== snapshotIdentity({ snapshot: required.snapshot })) return unwrap({ outcome: failure({ code: "conflict", message: "Snapshot ID is immutable" }) });
    return existing;
  }
  await checkSqlLineage({ ...required, tenant });
  await required.transaction.query({ text: "INSERT INTO measure_platform_snapshot (scope_key,snapshot_id,snapshot_json) VALUES ($1,$2,$3)", values: [tenant, required.snapshot.snapshotId, JSON.stringify(required.snapshot)] });
  return required.snapshot;
}
async function checkSqlLineage(required: { transaction: MeasureSqlQueryable; tenant: string; snapshot: PlatformMetricSnapshot }): Promise<void> {
  if (!required.snapshot.restatementOf) return;
  const parent = await readSnapshot({ ...required, snapshotId: required.snapshot.restatementOf });
  if (!parent) return unwrap({ outcome: failure({ code: "invalid_input", message: "Restatement parent is missing" }) });
  unwrap({ outcome: validateLineage({ parent, snapshot: required.snapshot }) });
}
async function commitAttribution(required: { transaction: MeasureSqlQueryable; context: CallContext; sourceId: string; result: AttributionResult }): Promise<AttributionResult> {
  const tenant = scopeKey({ scope: required.context.scope });
  const values = [tenant, required.sourceId, required.result.eventId, required.result.modelVersion];
  const existing = await required.transaction.query({ text: "SELECT result_json FROM measure_attribution_result WHERE scope_key=$1 AND source_id=$2 AND event_id=$3 AND model_version=$4", values });
  if (existing.rows[0]) {
    const previous = unwrap({ outcome: parseBoundary({ schema: attributionSchema, input: JSON.parse(String(existing.rows[0].result_json)) }) });
    if (previous.resultId !== required.result.resultId || previous.campaignId !== required.result.campaignId || previous.accountId !== required.result.accountId) return unwrap({ outcome: failure({ code: "conflict", message: "Attribution is immutable for a declared model" }) });
    return previous;
  }
  const reused = await required.transaction.query({ text: "SELECT result_id FROM measure_attribution_result WHERE scope_key=$1 AND result_id=$2", values: [tenant, required.result.resultId] });
  if (reused.rows[0]) return unwrap({ outcome: failure({ code: "conflict", message: "Attribution result ID already binds another event or model" }) });
  const event = await required.transaction.query({ text: "SELECT event_id FROM measure_conversion_event WHERE scope_key=$1 AND source_id=$2 AND event_id=$3", values: values.slice(0, 3) });
  if (!event.rows[0]) return unwrap({ outcome: failure({ code: "invalid_input", message: "Attribution requires a verified conversion" }) });
  await required.transaction.query({ text: "INSERT INTO measure_attribution_result (scope_key,source_id,event_id,model_version,result_id,campaign_id,result_json,account_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", values: [...values, required.result.resultId, required.result.campaignId, JSON.stringify(required.result), required.result.accountId] });
  return required.result;
}

import { z } from "zod";
import { metricBatchSchema, parseBoundary } from "@open-marketing/contracts";
import type { CampaignKey, MetricBatch, ObserverPort, Outcome, SqlSession } from "@open-marketing/contracts";
import { boundedMetricDays, metricCampaignGroups, metricDaySchema, metricPartition, metricsBoundary, metricsFailure, metricsObservedSchema, metricsReadSchema, metricsScope, observedMetricCampaigns, parseMetricsAppend, reportingDays } from "../reporting/metrics.js";
import type { MetricDay, MetricSyncReceipt, MetricsRepoPort } from "../reporting/metrics.js";

/** Transactional append-only metrics adapter. The server injects the serialized SQL
 * session and applies migrations. No jobs store, driver construction or startup I/O.
 * @complexity One indexed bounded day selection; <=32 inserts per append.
 * @example createSqlMetricsRepo({ database }, { observer }) */
export function createSqlMetricsRepo(required: { database: SqlSession }, optional?: { observer?: ObserverPort }): MetricsRepoPort {
  return {
    async append(input, options) {
      const parsed = parseMetricsAppend(input);
      if (!parsed.ok) return parsed;
      return metricsBoundary({ context: parsed.value.context, operation: "measure.metrics.append", observer: optional?.observer, work: () => required.database.transaction({ work: ({ session }) => appendTransaction({ ...parsed.value, session }) }) }, options);
    },
    async readDays(input, options) {
      const parsed = parseBoundary({ schema: metricsReadSchema, input });
      if (!parsed.ok) return parsed;
      return metricsBoundary({ context: parsed.value.context, operation: "measure.metrics.readDays", observer: optional?.observer, work: async () => {
        const rows = await latestRows({ session: required.database, scope: metricsScope(parsed.value), query: parsed.value.query });
        return decodeDays({ rows: rows.rows });
      } }, options);
    },
    async observedCampaigns(input, options) {
      const parsed = parseBoundary({ schema: metricsObservedSchema, input });
      if (!parsed.ok) return parsed;
      return metricsBoundary({ context: parsed.value.context, operation: "measure.metrics.observedCampaigns", observer: optional?.observer,
        work: () => readObservedCampaigns({ session: required.database, scope: metricsScope(parsed.value), keys: parsed.value.keys }) }, options);
    },
  };
}
/** One portable SQL read per plugin/account group (<=100), newest 31 batches only.
 * O(groups * 31 * rows) decode work, rows <=5,000; no JSON SQL or unbounded result buffer. */
async function readObservedCampaigns(required: { session: SqlSession; scope: string; keys: readonly CampaignKey[] }): Promise<Outcome<readonly CampaignKey[]>> {
  const observed: CampaignKey[] = [];
  for (const keys of metricCampaignGroups(required)) {
    const { pluginId, accountId } = keys[0]!;
    const rows = await required.session.query({ text: "SELECT sync_id,batch_json FROM measure_metrics_batch WHERE scope_key=$1 AND plugin_id=$2 AND account_id=$3 AND grain='campaign' ORDER BY retrieved_at DESC, sync_id DESC LIMIT 31", values: [required.scope, pluginId, accountId] });
    const batches = new Map<string, MetricBatch>();
    for (const row of rows.rows) {
      const decoded = decodeBatch({ syncId: String(row.sync_id), json: row.batch_json, batches });
      if (!decoded.ok) return decoded;
    }
    observed.push(...observedMetricCampaigns({ keys, batches: [...batches.values()] }));
  }
  return { ok: true, value: observed };
}
/** Any driver/commit throw rolls back through the injected transaction contract.
 * Domain conflicts return BEFORE writes; day insert failures cannot leak a batch.
 * O(days) statements, <=31; prior evidence is read once rather than per-day queries. */
async function appendTransaction(required: Parameters<MetricsRepoPort["append"]>[0] & { session: SqlSession }): Promise<Outcome<MetricSyncReceipt>> {
  const { session, request, batch } = required, scope = metricsScope(required);
  const previous = await session.query({ text: "SELECT request_json FROM measure_metrics_batch WHERE scope_key=$1 AND sync_id=$2", values: [scope, request.syncId] });
  const identity = JSON.stringify(request), existing = previous.rows[0];
  if (existing && existing.request_json !== identity) return metricsFailure({ code: "conflict", message: "Sync ID reused for different arguments" });
  if (existing) return { ok: true, value: { syncId: request.syncId, status: "existing" } };
  const query = { pluginId: request.pluginId, connectionId: request.connectionId, accountId: request.accountId, grain: request.input.grain, days: request.input.days };
  const prior = await latestRows({ session, scope, query });
  await session.query({ text: "INSERT INTO measure_metrics_batch (scope_key,sync_id,plugin_id,connection_id,account_id,grain,retrieved_at,request_json,batch_json) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)", values: [scope, request.syncId, batch.pluginId, batch.connectionId, batch.accountId, batch.grain, batch.retrievedAt, identity, JSON.stringify(batch)] });
  for (const day of reportingDays({ days: batch.days })) {
    const predecessor = prior.rows.find(row => row.day === day);
    await session.query({ text: "INSERT INTO measure_metrics_day (scope_key,sync_id,day,previous_sync_id) VALUES ($1,$2,$3,$4)", values: [scope, request.syncId, day, predecessor?.sync_id ?? null] });
  }
  return { ok: true, value: { syncId: request.syncId, status: "stored" } };
}
/** Indexed scope/account/window filter followed by whole-day ranking. History can
 * grow; only <=31 winning partitions cross the SQL boundary. No row fallback. */
function latestRows(required: { session: SqlSession; scope: string; query: Parameters<MetricsRepoPort["readDays"]>[0]["query"] }) {
  const { query } = required;
  return required.session.query({ text: `SELECT day,sync_id,previous_sync_id,batch_json FROM (
    SELECT d.day,b.sync_id,d.previous_sync_id,b.batch_json,
      ROW_NUMBER() OVER (PARTITION BY d.day ORDER BY b.retrieved_at DESC,b.sync_id DESC) AS rank
    FROM measure_metrics_batch b JOIN measure_metrics_day d ON d.scope_key=b.scope_key AND d.sync_id=b.sync_id
    WHERE b.scope_key=$1 AND b.plugin_id=$2 AND b.connection_id=$3 AND b.account_id=$4 AND b.grain=$5 AND d.day >= $6 AND d.day < $7
  ) WHERE rank=1 ORDER BY day LIMIT 31`, values: [required.scope, query.pluginId, query.connectionId, query.accountId, query.grain, query.days.start, query.days.end] });
}
const dayMetadataSchema = z.strictObject({ day: metricDaySchema.shape.day, syncId: metricDaySchema.shape.syncId, previousSyncId: metricDaySchema.shape.previousSyncId });
/** Validate each distinct persisted batch once per read, and every day's metadata.
 * Retain period reach; reject >5,000 combined rows without truncation.
 * @complexity O(B*N + D*N) time/O(B*N) space, B distinct batches, D days <=31,
 * N rows per batch <=5,000. Repeated days only filter rows, without revalidation. */
function decodeDays({ rows }: { rows: readonly Readonly<Record<string, unknown>>[] }): Outcome<readonly MetricDay[]> {
  const partitions: MetricDay[] = [];
  const batches = new Map<string, MetricBatch>();
  for (const row of rows) {
    const parsed = parseBoundary({ schema: dayMetadataSchema, input: { day: row.day, syncId: row.sync_id, previousSyncId: row.previous_sync_id } });
    if (!parsed.ok) return parsed;
    const decoded = decodeBatch({ syncId: parsed.value.syncId, json: row.batch_json, batches });
    if (!decoded.ok) return decoded;
    const batch = decoded.value;
    if (parsed.value.day < batch.days.start || parsed.value.day >= batch.days.end) return metricsFailure({ code: "invalid_input", message: "Reporting day is outside batch window" });
    partitions.push(metricPartition({ ...parsed.value, batch }));
  }
  return boundedMetricDays({ partitions });
}
/** Call-local cache of schema-validated evidence; errors never enter the cache. */
function decodeBatch(required: { syncId: string; json: unknown; batches: Map<string, MetricBatch> }): Outcome<MetricBatch> {
  const cached = required.batches.get(required.syncId);
  if (cached) return { ok: true, value: cached };
  const parsed = parseBoundary({ schema: metricBatchSchema, input: JSON.parse(String(required.json)) });
  if (parsed.ok) required.batches.set(required.syncId, parsed.value);
  return parsed;
}

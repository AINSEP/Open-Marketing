import { z } from "zod";
import { appErrorSchema, callContextSchema, campaignKeySchema, epochSchema, idSchema, metricBatchSchema, metricGrainSchema, parseBoundary, reportMetricsInputSchema } from "@open-marketing/contracts";
import type { AppError, CallContext, CallOptions, CampaignKey, MetricBatch, ObserverPort, Outcome } from "@open-marketing/contracts";

/** Each outbox invocation owns one account/grain and at most 31 calendar days. */
export const METRICS_SYNC_JOB = "measure.sync_metrics";
export const reportingDaysSchema = reportMetricsInputSchema.shape.days.refine(days => Date.parse(days.end) - Date.parse(days.start) <= 31 * 86400000);
// Server-generated ASCII IDs have the same simple tie order in memory and SQLite.
const syncIdSchema = idSchema.regex(/^[\x21-\x7e]+$/);
export const metricSyncRequestSchema = z.strictObject({ syncId: syncIdSchema, pluginId: idSchema, connectionId: idSchema, accountId: idSchema, input: reportMetricsInputSchema.extend({ days: reportingDaysSchema }) });
export type MetricSyncRequest = z.infer<typeof metricSyncRequestSchema>;
export const metricSyncReceiptSchema = z.strictObject({ syncId: idSchema, status: z.enum(["stored", "existing"]) });
export type MetricSyncReceipt = z.infer<typeof metricSyncReceiptSchema>;
export const campaignResultsQuerySchema = z.strictObject({ pluginId: idSchema, connectionId: idSchema, accountId: idSchema, days: reportingDaysSchema });
export type CampaignResultsQuery = z.infer<typeof campaignResultsQuerySchema>;
export const metricsReadSchema = z.strictObject({ context: callContextSchema, query: campaignResultsQuerySchema.extend({ grain: metricGrainSchema }) });
export const metricsObservedSchema = z.strictObject({ context: callContextSchema, keys: z.array(campaignKeySchema).max(100) });
export const metricsAppendSchema = z.strictObject({ context: callContextSchema, request: metricSyncRequestSchema, batch: metricBatchSchema });
export const metricDaySchema = z.strictObject({ day: z.iso.date(), syncId: syncIdSchema, previousSyncId: syncIdSchema.nullable(), batch: metricBatchSchema })
  .refine(value => value.day >= value.batch.days.start && value.day < value.batch.days.end);
export type MetricDay = z.infer<typeof metricDaySchema>;
export const verifiedLeadCountsSchema = z.strictObject({ counts: z.array(z.strictObject({ campaign: campaignKeySchema, count: epochSchema })).max(5000), unattributed: epochSchema });
export type VerifiedLeadCounts = z.infer<typeof verifiedLeadCountsSchema>;

/** Append batch evidence and ALL covered days atomically. Duplicate scoped sync IDs
 * return existing; different request arguments conflict. Reads select whole latest days.
 * @example repo.append({ context, request, batch }) */
export interface MetricsRepoPort {
  append(required: z.infer<typeof metricsAppendSchema>, optional?: CallOptions): Promise<Outcome<MetricSyncReceipt>>;
  readDays(required: z.infer<typeof metricsReadSchema>, optional?: CallOptions): Promise<Outcome<readonly MetricDay[]>>;
  /** Requested campaign keys seen in the latest 31 campaign batches per plugin/account.
   * Historical membership does not establish current admission or fill missing metrics. */
  observedCampaigns(required: { context: CallContext; keys: readonly CampaignKey[] }, optional?: CallOptions): Promise<Outcome<readonly CampaignKey[]>>;
}
/** Caller supplies creation-date cohort counts, in the account timezone, for every
 * requested CampaignKey (including explicit zeros). Missing evidence is unavailable.
 * Additional keys belong to the queried plugin/account; unattributed is workspace-wide.
 * @example leads.cohort({ context, pluginId, accountId, campaigns, days, timezone }) */
export interface VerifiedLeadCountsPort {
  cohort(required: { context: CallContext; pluginId: string; accountId: string; campaigns: readonly CampaignKey[]; days: CampaignResultsQuery["days"]; timezone: string }, optional?: CallOptions): Promise<Outcome<VerifiedLeadCounts>>;
}

/** Pure typed failure, without exposing tainted provider/driver messages. */
export function metricsFailure(required: { code: AppError["code"]; message: string }): Outcome<never> {
  return { ok: false, error: { ...required, retryable: false } };
}
/** Reporting-only I/O boundary; never loads delivery/ingestion or policy modules.
 * Observers cannot change committed outcomes. O(1) wrapper, work is separately bounded. */
export async function metricsBoundary<T>(required: { context: CallContext; operation: string; observer?: ObserverPort; work: () => Promise<Outcome<T>> }, optional?: CallOptions): Promise<Outcome<T>> {
  if (optional?.signal?.aborted) return metricsFailure({ code: "cancelled", message: "Reporting cancelled" });
  let result: Outcome<T>;
  try { result = await required.work(); }
  catch { result = metricsFailure({ code: "unavailable", message: "Reporting boundary failed" }); }
  try { required.observer?.observe({ operation: required.operation, outcome: result.ok ? "succeeded" : result.error.code, correlationId: required.context.correlationId, traceId: required.context.traceId, runId: required.context.runId }); }
  catch { /* Observation cannot turn a committed append into a failed job. */ }
  return result;
}
/** Parse the complete tainted capability outcome, including its failure arm. */
export const metricOutcomeSchema = z.discriminatedUnion("ok", [z.strictObject({ ok: z.literal(true), value: metricBatchSchema }), z.strictObject({ ok: z.literal(false), error: appErrorSchema })]);
/** Validate evidence and exact request binding before either repository mutates.
 * O(rows + reach) time/space, each capped at 5,000 by contracts. */
export function parseMetricsAppend(required: z.infer<typeof metricsAppendSchema>): Outcome<z.infer<typeof metricsAppendSchema>> {
  const parsed = parseBoundary({ schema: metricsAppendSchema, input: required });
  if (!parsed.ok) return parsed;
  const { request, batch } = parsed.value;
  const actual = [batch.pluginId, batch.connectionId, batch.accountId, batch.grain, batch.days.start, batch.days.end];
  const expected = [request.pluginId, request.connectionId, request.accountId, request.input.grain, request.input.days.start, request.input.days.end];
  if (JSON.stringify(actual) !== JSON.stringify(expected)) return metricsFailure({ code: "conflict", message: "Metric batch does not match sync request" });
  return parsed;
}
/** Pure scope identity; principal identity never partitions account evidence. */
export function metricsScope({ context }: { context: CallContext }): string { return JSON.stringify([context.scope.ownerId, context.scope.workspaceId]); }
/** Group <=100 validated keys for one bounded read per plugin/account, without a connection claim.
 * O(keys) time/space; shared by SQL and memory adapters. */
export function metricCampaignGroups({ keys }: { keys: readonly CampaignKey[] }): CampaignKey[][] {
  const groups = new Map<string, CampaignKey[]>();
  for (const key of keys) {
    const identity = JSON.stringify([key.pluginId, key.accountId]);
    const group = groups.get(identity) ?? [];
    group.push(key);
    groups.set(identity, group);
  }
  return [...groups.values()];
}
/** Return requested membership only, preserving missing data as absent.
 * O(rows + keys) time/space, <=31 batches of <=5,000 rows per group. */
export function observedMetricCampaigns(required: { keys: readonly CampaignKey[]; batches: readonly MetricBatch[] }): CampaignKey[] {
  const observed = new Set<string>();
  for (const batch of required.batches) {
    for (const row of batch.rows) {
      if (row.entity.grain === "campaign") observed.add(JSON.stringify([batch.pluginId, batch.accountId, row.entity.vendorCampaignId]));
    }
  }
  return required.keys.filter(key => observed.has(JSON.stringify([key.pluginId, key.accountId, key.vendorCampaignId])));
}
/** Enumerate a validated half-open calendar window without reading wall time. O(days), <=31. */
export function reportingDays({ days }: { days: CampaignResultsQuery["days"] }): string[] {
  const result: string[] = [];
  for (let time = Date.parse(days.start); time < Date.parse(days.end); time += 86400000) result.push(new Date(time).toISOString().slice(0, 10));
  return result;
}
/** Filter a whole observation to one day; period reach retains its ORIGINAL window.
 * O(rows), <=5,000; the original unfiltered batch remains immutable evidence. */
export function metricPartition(required: { batch: MetricBatch; syncId: string; day: string; previousSyncId: string | null }): MetricDay {
  return { ...required, batch: { ...required.batch, rows: required.batch.rows.filter(row => row.day === required.day) } };
}
/** Match a stored day to one scoped account/grain read. */
export function matchesMetricsQuery(required: { partition: MetricDay; query: z.infer<typeof metricsReadSchema>["query"] }): boolean {
  const { partition: { day, batch }, query } = required;
  return day >= query.days.start && day < query.days.end && batch.pluginId === query.pluginId && batch.connectionId === query.connectionId && batch.accountId === query.accountId && batch.grain === query.grain;
}
/** Retrieval time wins; validated ASCII sync IDs give a simple stable tie order. */
export function newerMetricDay(required: { left: MetricDay; right: MetricDay }): boolean {
  if (required.left.batch.retrievedAt !== required.right.batch.retrievedAt) return required.left.batch.retrievedAt > required.right.batch.retrievedAt;
  return required.left.syncId > required.right.syncId;
}
/** Combined selected rows are bounded independently of each incoming batch. */
export function boundedMetricDays({ partitions }: { partitions: MetricDay[] }): Outcome<readonly MetricDay[]> {
  if (partitions.reduce((total, day) => total + day.batch.rows.length, 0) > 5000) return metricsFailure({ code: "limit_exceeded", message: "Reporting read exceeds 5000 rows" });
  return { ok: true, value: partitions.sort((left, right) => left.day.localeCompare(right.day)) };
}

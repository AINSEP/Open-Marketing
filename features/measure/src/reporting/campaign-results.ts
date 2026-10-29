import { z } from "zod";
import { appErrorSchema, campaignKeySchema, deriveMetricRatios, epochSchema, metricBatchSchema, metricValuesSchema, parseBoundary, ratioResultSchema } from "@open-marketing/contracts";
import type { CallContext, CallOptions, ClockPort, MetricBatch, MetricValues, ObserverPort, Outcome } from "@open-marketing/contracts";
import { boundedMetricDays, campaignResultsQuerySchema, matchesMetricsQuery, metricDaySchema, metricsBoundary, metricsFailure, metricsReadSchema, reportingDays, verifiedLeadCountsSchema } from "./metrics.js";
import type { CampaignResultsQuery, MetricDay, MetricsRepoPort, VerifiedLeadCounts, VerifiedLeadCountsPort } from "./metrics.js";

const metricNames = ["spend", "impressions", "clicks", "vendorConversions", "vendorConversionValue"] as const;
const leadCountsOutcomeSchema = z.discriminatedUnion("ok", [z.strictObject({ ok: z.literal(true), value: verifiedLeadCountsSchema }), z.strictObject({ ok: z.literal(false), error: appErrorSchema })]);
const leadResultSchema = z.discriminatedUnion("status", [z.strictObject({ status: z.literal("available"), count: epochSchema }), z.strictObject({ status: z.literal("unavailable"), reason: appErrorSchema.shape.code })]);
const campaignResultSchema = z.strictObject({ campaign: campaignKeySchema, vendorSource: z.literal("report.metrics.v1"), metrics: metricValuesSchema, ratios: z.strictObject({ ctr: ratioResultSchema, cpcMicros: ratioResultSchema, cpmMicros: ratioResultSchema, vendorCpaMicros: ratioResultSchema, vendorRoas: ratioResultSchema }), leadSource: z.literal("om_verified_creation_cohort"), verifiedLeads: leadResultSchema });
/** One compatible mapping applies to the whole result; absent observations yield null. */
export const campaignResultsSchema = z.strictObject({
  query: campaignResultsQuerySchema, currency: metricBatchSchema.shape.currency.nullable(), timezone: z.string().nullable(), mapping: metricBatchSchema.shape.mapping.nullable(),
  campaigns: z.array(campaignResultSchema).max(5000), complete: z.boolean(), missingDays: z.array(z.iso.date()).max(31),
  attributionModel: z.literal("last_paid_touch_30d.v1"), workspaceUnattributed: leadResultSchema,
  observations: z.array(z.strictObject({ day: z.iso.date(), syncId: z.string(), previousSyncId: z.string().nullable(), retrievedAt: epochSchema, dataThrough: epochSchema, ageMs: epochSchema, complete: z.boolean(), freshness: metricBatchSchema.shape.freshness, finality: metricBatchSchema.shape.finality, restated: z.boolean() })).max(31),
  periodReach: z.array(z.strictObject({ syncId: z.string(), days: metricBatchSchema.shape.days, reach: metricBatchSchema.shape.reach })).max(31),
});
export type CampaignResults = z.infer<typeof campaignResultsSchema>;

/** Read persisted campaign-grain observations, then join verified creation-cohort leads.
 * Never combines currencies, mapping meanings or timezones; reach is period evidence.
 * @complexity O(rows + days), <=5,000 rows / 31 days, one repo and one leads call.
 * @example campaignResults({ context, query, repo, leads, clock }) */
export async function campaignResults(required: { context: CallContext; query: CampaignResultsQuery; repo: MetricsRepoPort; leads: VerifiedLeadCountsPort; clock: ClockPort }, optional?: CallOptions & { observer?: ObserverPort }): Promise<Outcome<CampaignResults>> {
  const query = parseBoundary({ schema: campaignResultsQuerySchema, input: required.query });
  if (!query.ok) return query;
  const parsed = parseBoundary({ schema: metricsReadSchema, input: { context: required.context, query: { ...query.value, grain: "campaign" } } });
  if (!parsed.ok) return parsed;
  return metricsBoundary<CampaignResults>({ context: parsed.value.context, operation: "measure.campaignResults", observer: optional?.observer, work: async () => {
    const read = await required.repo.readDays(parsed.value, optional);
    if (!read.ok) return read;
    if (optional?.signal?.aborted) return metricsFailure({ code: "cancelled", message: "Reporting cancelled" });
    const now = required.clock.now({});
    const partitions = validateRead({ partitions: read.value, query: parsed.value.query, now });
    if (!partitions.ok) return partitions;
    const results = aggregate({ partitions: partitions.value });
    if (!results.ok) return results;
    const first = partitions.value[0]?.batch;
    const joined = await joinLeads({ context: parsed.value.context, query: query.value, timezone: first?.timezone, mapping: first?.mapping, campaigns: results.value, leads: required.leads }, optional);
    if (!joined.ok) return joined;
    if (optional?.signal?.aborted) return metricsFailure({ code: "cancelled", message: "Reporting cancelled" });
    const missingDays = reportingDays({ days: query.value.days }).filter(day => !partitions.value.some(partition => partition.day === day));
    const observations = partitions.value.map(({ day, syncId, previousSyncId, batch }) => ({ day, syncId, previousSyncId, retrievedAt: batch.retrievedAt, dataThrough: batch.dataThrough, ageMs: now - batch.retrievedAt, complete: batch.complete, freshness: batch.freshness, finality: batch.finality, restated: batch.restated }));
    const unique = [...new Map(partitions.value.map(day => [day.syncId, day])).values()];
    return { ok: true, value: { query: query.value, currency: first?.currency ?? null, timezone: first?.timezone ?? null, mapping: first?.mapping ?? null, ...joined.value, attributionModel: "last_paid_touch_30d.v1", complete: missingDays.length === 0 && partitions.value.every(day => day.batch.complete), missingDays, observations, periodReach: unique.filter(day => day.batch.reach !== undefined).map(day => ({ syncId: day.syncId, days: day.batch.days, reach: day.batch.reach })) } };
  } }, optional);
}
/** Validate the repository boundary and all selected series dimensions. O(rows + days). */
function validateRead(required: { partitions: readonly MetricDay[]; query: Parameters<MetricsRepoPort["readDays"]>[0]["query"]; now: number }): Outcome<readonly MetricDay[]> {
  const parsed = parseBoundary({ schema: z.array(metricDaySchema).max(31), input: required.partitions });
  if (!parsed.ok) return parsed;
  const days = parsed.value;
  if (new Set(days.map(day => day.day)).size !== days.length) return metricsFailure({ code: "invalid_input", message: "Duplicate reporting day" });
  if (days.some(day => !matchesMetricsQuery({ partition: day, query: required.query }) || day.batch.retrievedAt > required.now || day.batch.rows.some(row => row.day !== day.day))) return metricsFailure({ code: "invalid_input", message: "Invalid reporting partition" });
  if (new Set(days.map(day => seriesIdentity({ day }))).size > 1) return metricsFailure({ code: "conflict", message: "Incompatible reporting dimensions" });
  return boundedMetricDays({ partitions: days });
}
/** Fixed-order semantic identity ignores record-key insertion order. */
function seriesIdentity({ day: { batch } }: { day: MetricDay }): string {
  const support = batch.mapping.grains.campaign;
  return JSON.stringify([batch.currency, batch.timezone, batch.mapping.pluginId, batch.mapping.version, metricNames.map(name => support?.[name]), batch.mapping.reach?.campaign]);
}
/** Accumulate additive cells only. A supported null poisons that metric's total;
 * unsupported cells stay absent. O(rows), <=5,000; BigInt never rounds micros. */
function aggregate({ partitions }: { partitions: readonly MetricDay[] }): Outcome<z.infer<typeof campaignResultSchema>[]> {
  const totals = new Map<string, MetricValues>();
  for (const row of partitions.flatMap(day => day.batch.rows)) {
    if (row.entity.grain !== "campaign") return metricsFailure({ code: "invalid_input", message: "Expected campaign grain" });
    const metrics = totals.get(row.entity.vendorCampaignId) ?? {};
    for (const name of metricNames.filter(name => row.metrics[name] !== undefined)) metrics[name] = sumCell({ left: metrics[name], right: row.metrics[name] });
    totals.set(row.entity.vendorCampaignId, metrics);
  }
  const batch = partitions[0]?.batch, campaigns: z.infer<typeof campaignResultSchema>[] = [];
  for (const [vendorCampaignId, metrics] of totals) {
    const ratios = deriveMetricRatios({ metrics });
    if (!ratios.ok) return metricsFailure({ code: "limit_exceeded", message: "Aggregate exceeds contract integer bounds" });
    campaigns.push({ campaign: { pluginId: batch!.pluginId, accountId: batch!.accountId, vendorCampaignId }, vendorSource: "report.metrics.v1", metrics, ratios: ratios.value, leadSource: "om_verified_creation_cohort", verifiedLeads: { status: "unavailable", reason: "unavailable" } });
  }
  return { ok: true, value: campaigns };
}
/** Three distinct states: unsupported, unavailable and exact decimal integer. */
function sumCell({ left, right }: { left: string | null | undefined; right: string | null | undefined }): string | null | undefined {
  if (right === undefined) return undefined;
  if (left === null || right === null) return null;
  return (BigInt(left ?? "0") + BigInt(right)).toString();
}
/** One caller-owned cohort read; port failure preserves vendor evidence with an
 * explicit unavailable status. Malformed/duplicate/foreign keys are rejected.
 * O(vendor rows + cohort keys), bounded to 5,000 joined rows. */
async function joinLeads(required: { context: CallContext; query: CampaignResultsQuery; timezone?: string; mapping?: MetricBatch["mapping"]; campaigns: z.infer<typeof campaignResultSchema>[]; leads: VerifiedLeadCountsPort }, optional?: CallOptions): Promise<Outcome<Pick<CampaignResults, "campaigns" | "workspaceUnattributed">>> {
  if (!required.timezone) return { ok: true, value: { campaigns: required.campaigns, workspaceUnattributed: { status: "unavailable", reason: "unavailable" } } };
  const { pluginId, accountId, days } = required.query;
  const response = await metricsBoundary({ context: required.context, operation: "measure.leadCounts", work: () => required.leads.cohort({ context: required.context, pluginId, accountId, campaigns: required.campaigns.map(row => row.campaign), days, timezone: required.timezone! }, optional) }, optional);
  const parsed = parseBoundary({ schema: leadCountsOutcomeSchema, input: response });
  if (!parsed.ok) return parsed;
  const outcome = parsed.value;
  if (!outcome.ok) return { ok: true, value: { campaigns: required.campaigns.map(row => ({ ...row, verifiedLeads: { status: "unavailable", reason: outcome.error.code } })), workspaceUnattributed: { status: "unavailable", reason: outcome.error.code } } };
  const counts = new Map(outcome.value.counts.map(row => [JSON.stringify(row.campaign), row.count]));
  if (counts.size !== outcome.value.counts.length || outcome.value.counts.some(({ campaign }) => campaign.pluginId !== pluginId || campaign.accountId !== accountId)) return metricsFailure({ code: "invalid_input", message: "Unexpected verified lead keys" });
  const campaigns = unionCampaigns({ campaigns: required.campaigns, counts, cohort: outcome.value, mapping: required.mapping });
  if (!campaigns.ok) return campaigns;
  return { ok: true, value: { campaigns: campaigns.value, workspaceUnattributed: { status: "available", count: outcome.value.unattributed } } };
}
/** Lead-only rows carry null supported vendor cells and no unsupported cells.
 * O(vendor rows + cohort keys) time/space; reject an oversized union, never truncate. */
function unionCampaigns(required: { campaigns: z.infer<typeof campaignResultSchema>[]; counts: Map<string, number>; cohort: VerifiedLeadCounts; mapping?: MetricBatch["mapping"] }): Outcome<z.infer<typeof campaignResultSchema>[]> {
  const campaigns = required.campaigns.map(row => withLeadCount({ row, counts: required.counts }));
  const vendorKeys = new Set(campaigns.map(row => JSON.stringify(row.campaign)));
  const metrics: MetricValues = Object.fromEntries(metricNames.filter(name => required.mapping?.grains.campaign?.[name] !== undefined).map(name => [name, null]));
  const ratios = deriveMetricRatios({ metrics });
  if (!ratios.ok) return ratios;
  for (const { campaign, count } of required.cohort.counts) {
    if (vendorKeys.has(JSON.stringify(campaign))) continue;
    campaigns.push({ campaign, metrics, ratios: ratios.value, vendorSource: "report.metrics.v1", leadSource: "om_verified_creation_cohort", verifiedLeads: { status: "available", count } });
  }
  if (campaigns.length > 5000) return metricsFailure({ code: "limit_exceeded", message: "Campaign results exceed 5000 rows" });
  return { ok: true, value: campaigns };
}
/** Missing cohort evidence stays unavailable; an explicit zero remains available. */
function withLeadCount(required: { row: z.infer<typeof campaignResultSchema>; counts: Map<string, number> }): z.infer<typeof campaignResultSchema> {
  const count = required.counts.get(JSON.stringify(required.row.campaign));
  if (count === undefined) return required.row;
  return { ...required.row, verifiedLeads: { status: "available", count } };
}

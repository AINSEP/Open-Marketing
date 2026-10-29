import { z } from "zod";
import { decimalToMicros, metricBatchSchema, metricMappingSchema, parseBoundary } from "@open-marketing/contracts";
import type { MetricBatch, MetricGrain, Outcome, ReportMetricsInput } from "@open-marketing/contracts";
import { vendorIdSchema } from "./commands.js";
import { failure } from "./boundary.js";

const meanings = {
  spend: { vendorField: "spend", meaning: "Reported spend in account currency micros, scaled exactly from decimal text." },
  impressions: { vendorField: "impressions", meaning: "Vendor-reported impressions." },
  clicks: { vendorField: "clicks", meaning: "All vendor clicks, not link clicks or unique visitors." },
  vendorConversions: { vendorField: "actions[offsite_conversion.fb_pixel_purchase].7d_click", meaning: "Website pixel purchases only, explicit 7-day click attribution, impression-date reporting; millionths. Omitted purchase entries are zero; null/ambiguous attribution evidence is unavailable." },
  vendorConversionValue: { vendorField: "action_values[offsite_conversion.fb_pixel_purchase].7d_click", meaning: "Website pixel purchase value only, 7-day click attribution, impression-date reporting; account currency micros." },
};
/** One non-overlapping website-purchase action series; never sum purchase aliases or lead categories. */
export const metricMapping = metricMappingSchema.parse({ pluginId: "meta-ads", version: "meta-v26-1", grains: {
  account: meanings, campaign: meanings, ad_group: meanings, ad: meanings,
} });
const decimal = z.string().max(100).nullable().optional();
const action = z.object({ action_type: z.string().min(1).max(128), "7d_click": decimal });
/** Vendor projection: unknown SDK fields are discarded; all consumed values remain bounded and schema-derived. */
export const insightRowSchema = z.object({
  account_id: vendorIdSchema, account_currency: z.string().regex(/^[A-Z]{3}$/), date_start: z.iso.date(), date_stop: z.iso.date(),
  campaign_id: vendorIdSchema.optional(), adset_id: vendorIdSchema.optional(), ad_id: vendorIdSchema.optional(),
  spend: decimal, impressions: decimal, clicks: decimal,
  actions: z.array(action).max(100).nullish(), action_values: z.array(action).max(100).nullish(),
});
type Insight = z.infer<typeof insightRowSchema>;
const effectiveStatuses = {
  account: [],
  campaign: ["ACTIVE", "PAUSED", "DELETED", "ARCHIVED", "IN_PROCESS", "WITH_ISSUES"],
  ad_group: ["ACTIVE", "PAUSED", "DELETED", "ARCHIVED", "CAMPAIGN_PAUSED", "IN_PROCESS", "WITH_ISSUES"],
  ad: ["ACTIVE", "PAUSED", "DELETED", "ARCHIVED", "PENDING_REVIEW", "DISAPPROVED", "PREAPPROVED", "PENDING_BILLING_INFO", "CAMPAIGN_PAUSED", "ADSET_PAUSED", "IN_PROCESS", "WITH_ISSUES"],
};
/** Calendar arithmetic is independent of DST: Graph's until is inclusive, OM's end is exclusive. */
export function insightsParameters({ input }: { input: ReportMetricsInput }): Record<string, string> {
  const ids: Record<MetricGrain, string[]> = { account: [], campaign: ["campaign_id"], ad_group: ["campaign_id", "adset_id"], ad: ["campaign_id", "adset_id", "ad_id"] };
  const level = input.grain === "ad_group" ? "adset" : input.grain;
  return {
    fields: ["account_id", "account_currency", "date_start", "date_stop", ...ids[input.grain], "spend", "impressions", "clicks", "actions", "action_values"].join(","),
    level,
    ...(level === "account" ? {} : { filtering: JSON.stringify([{ field: `${level}.effective_status`, operator: "IN", value: effectiveStatuses[input.grain] }]) }),
    time_range: JSON.stringify({ since: input.days.start, until: new Date(Date.parse(input.days.end) - 86400000).toISOString().slice(0, 10) }),
    time_increment: "1", action_attribution_windows: '["7d_click"]', action_report_time: "impression",
  };
}
/** Pure decimal text -> micros; no currency exponent lookup, floats, rounding or safe-integer ceiling.
 * Undefined rejects malformed/overprecision values; null retains unavailability. O(d), d<=100.
 */
export function decimalMicros({ value }: { value: string | null | undefined }): string | null | undefined {
  if (value === null || value === undefined) return null;
  const scaled = decimalToMicros({ value, rounding: "reject" });
  return scaled.ok ? scaled.value : undefined;
}
function wholeCount({ value }: { value: string | null | undefined }): string | null | undefined {
  if (value === undefined || value === null) return null;
  return /^(0|[1-9]\d{0,37})$/.test(value) ? value : undefined;
}
function purchase({ values }: { values: Insight["actions"] }): string | null | undefined {
  if (values === null) return null;
  const matches = values?.filter(item => item.action_type === "offsite_conversion.fb_pixel_purchase") ?? [];
  if (matches.length === 0) return "0";
  if (matches.length !== 1) return null;
  return decimalMicros({ value: matches[0]["7d_click"] });
}
/** Project all fetched pages; row identity/support validation remains owned by contracts.
 * Completeness covers every grain; child levels send the effective_status inclusion filter.
 * Freshness describes this observation; dataThrough is query coverage, never vendor finality.
 * restated:false means no vendor restatement marker; persistence detects subsequent revisions.
 * @complexity O(n) time/space, <=5,000 rows with <=100 actions each; no effects.
 */
export function decodeMetrics(required: { rows: Insight[]; accountId: string; connectionId: string; currency: string; timezone: string; input: ReportMetricsInput; retrievedAt: number }): Outcome<MetricBatch> {
  if (required.rows.some(row => row.account_id !== required.accountId || row.account_currency !== required.currency)) return failure({ code: "forbidden", message: "Meta metric account/currency mismatch" });
  if (required.rows.some(row => row.date_stop !== row.date_start)) return failure({ code: "invalid_input", message: "Meta metrics must be daily" });
  return parseBoundary({ schema: metricBatchSchema, input: {
    schema: "report.metrics.v1", pluginId: "meta-ads", accountId: required.accountId, connectionId: required.connectionId,
    currency: required.currency, timezone: required.timezone, ...required.input, mapping: metricMapping, retrievedAt: required.retrievedAt,
    dataThrough: Math.min(required.retrievedAt, coverageCutoff({ end: required.input.days.end, timezone: required.timezone })),
    // Child queries explicitly include deleted/archived effective statuses; pages must all succeed.
    complete: true, freshness: "fresh", finality: "provisional", restated: false,
    rows: required.rows.map(row => metricRow({ row, grain: required.input.grain })),
  } });
}
function metricRow({ row, grain }: { row: Insight; grain: MetricGrain }): unknown {
  const entity: Record<string, unknown> = { grain };
  if (grain !== "account") entity.vendorCampaignId = row.campaign_id;
  if (grain === "ad_group" || grain === "ad") entity.vendorAdGroupId = row.adset_id;
  if (grain === "ad") entity.vendorAdId = row.ad_id;
  return { day: row.date_start, entity, metrics: {
    spend: decimalMicros({ value: row.spend }), impressions: wholeCount({ value: row.impressions }), clicks: wholeCount({ value: row.clicks }),
    vendorConversions: purchase({ values: row.actions }), vendorConversionValue: purchase({ values: row.action_values }),
  } };
}
/** Resolve the queried local midnight with its actual offset (including DST), not a fixed 24h shift.
 * O(1): three offset corrections. No clock read; nonexistent midnight fails the final epoch schema.
 */
export function coverageCutoff({ end, timezone }: { end: string; timezone: string }): number {
  const target = Date.parse(end + "T00:00:00Z");
  const format = new Intl.DateTimeFormat("en", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  let instant = target;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    instant += target - localWall({ format, instant });
  }
  return localWall({ format, instant }) === target ? instant : NaN;
}
function localWall({ format, instant }: { format: Intl.DateTimeFormat; instant: number }): number {
  const parts = Object.fromEntries(format.formatToParts(instant).map(part => [part.type, part.value]));
  return Date.parse(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}Z`);
}

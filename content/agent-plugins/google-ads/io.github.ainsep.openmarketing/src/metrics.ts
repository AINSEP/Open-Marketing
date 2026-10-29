import { decimalToMicros, metricBatchSchema, metricMappingSchema, parseBoundary } from "@open-marketing/contracts";
import type { MetricBatch, MetricGrain, Outcome, ReportMetricsInput } from "@open-marketing/contracts";
import { failure, numericId, parse, success } from "./schema.ts";
import { asRecord } from "./readback.ts";
import { googleDateTime } from "./rules.ts";
import type { AccountBinding } from "./types.ts";

const meanings = {
  spend: { vendorField: "metrics.cost_micros", meaning: "Served cost in account currency micros; not billed cost." },
  impressions: { vendorField: "metrics.impressions", meaning: "Vendor-reported ad impressions." },
  clicks: { vendorField: "metrics.clicks", meaning: "Vendor-reported clicks, not unique visitors." },
  vendorConversions: { vendorField: "metrics.conversions", meaning: "Included conversion actions, interaction-date reporting and each action's configured attribution/window; rounded half-even to millionths from source decimal text." },
  vendorConversionValue: { vendorField: "metrics.conversions_value", meaning: "Value of included conversion actions in account currency micros, rounded half-even from source decimal text; same attribution/window as conversions." },
};
/** Fixed Google v26 meanings at every supported daily grain; no optional reach series. */
export const metricMapping = metricMappingSchema.parse({ pluginId: "google-ads", version: "google-v26-1", grains: {
  account: meanings, campaign: meanings, ad_group: meanings, ad: meanings,
} });
const sources: Record<MetricGrain, { resource: string; ids: string[] }> = {
  account: { resource: "customer", ids: [] }, campaign: { resource: "campaign", ids: ["campaign.id"] },
  ad_group: { resource: "ad_group", ids: ["campaign.id", "ad_group.id"] },
  ad: { resource: "ad_group_ad", ids: ["campaign.id", "ad_group.id", "ad_group_ad.ad.id"] },
};
/** Fixed field set and half-open days; one sentinel row detects the bounded partial result. */
export function metricsQuery({ input }: { input: ReportMetricsInput }): string {
  const source = sources[input.grain];
  const fields = ["customer.id", "customer.currency_code", "customer.time_zone", "segments.date", ...source.ids,
    "metrics.cost_micros", "metrics.impressions", "metrics.clicks", "metrics.conversions", "metrics.conversions_value"];
  return `SELECT ${fields.join(", ")} FROM ${source.resource} WHERE segments.date >= '${input.days.start}' AND segments.date < '${input.days.end}' LIMIT 1001`;
}
/** One bounded search page; partial failures and pagination cannot be labelled complete.
 * @complexity O(b+n) time/space, b<=1MiB and n<=1,001. No I/O.
 */
export function metricSearchRows({ value }: { value: unknown }): Outcome<{ rows: Record<string, unknown>[]; complete: boolean }> {
  const envelope = asRecord({ value });
  if (value === null || typeof value !== "object" || Array.isArray(value)) return failure({ code: "invalid_input", message: "Invalid Google search envelope" });
  if (Buffer.byteLength(JSON.stringify(value)) > 1048576) return failure({ code: "limit_exceeded", message: "Google response exceeds 1 MiB" });
  if (!validEnvelope({ envelope })) return failure({ code: "invalid_input", message: "Invalid Google search result" });
  const rows = envelope.results ?? [];
  if (!Array.isArray(rows)) return failure({ code: "invalid_input", message: "Invalid Google rows" });
  if (rows.length > 1001) return failure({ code: "limit_exceeded", message: "Google row limit exceeded" });
  if (rows.some(row => row === null || typeof row !== "object" || Array.isArray(row))) return failure({ code: "invalid_input", message: "Invalid Google row" });
  return success({ value: { rows: rows.slice(0, 1000) as Record<string, unknown>[], complete: rows.length <= 1000 && !envelope.nextPageToken } });
}
function validEnvelope({ envelope }: { envelope: Record<string, unknown> }): boolean {
  const allowed = ["results", "nextPageToken", "fieldMask", "totalResultsCount", "queryResourceConsumption"];
  if (Object.keys(envelope).some(key => !allowed.includes(key))) return false;
  return envelope.nextPageToken === undefined || typeof envelope.nextPageToken === "string";
}
/** Shared half-even scaling, including JSON exponent tokens. Undefined rejects unrepresentable values;
 * null preserves missing metrics. Numeric doubles are deliberately rejected after precision is lost.
 * @complexity O(d) time/space, d<=100 input characters and <=38 output digits; pure.
 */
export function decimalMicros({ value }: { value: unknown }): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return undefined;
  const scaled = decimalToMicros({ value, rounding: "half_even" });
  return scaled.ok ? scaled.value : undefined;
}
/** Int64 fields stay text; only exactly representable integer JSON numbers are accepted. */
export function integerText({ value }: { value: unknown }): string | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === "string" && /^(0|[1-9]\d{0,37})$/.test(value)) return value;
  return undefined;
}
/** Project tainted rows into the frozen schema; duplicates, foreign accounts, bad dates and missing parents fail.
 * Freshness is observation recency; dataThrough is a conservative coverage cutoff, not vendor finality.
 * restated:false means no vendor marker; persistence compares later observations. Always provisional.
 * @complexity O(n) time/space for <=5,000 rows; no effects.
 */
export function decodeMetrics(required: { rows: Record<string, unknown>[]; complete: boolean; binding: Pick<AccountBinding, "connectionId" | "customerId" | "currency" | "timezone">; input: ReportMetricsInput; retrievedAt: number }): Outcome<MetricBatch> {
  if (required.rows.some(row => !matchesAccount({ row, binding: required.binding }))) return failure({ code: "forbidden", message: "Google metric account metadata mismatch" });
  return parseBoundary({ schema: metricBatchSchema, input: {
    schema: "report.metrics.v1", pluginId: "google-ads", connectionId: required.binding.connectionId, accountId: required.binding.customerId,
    currency: required.binding.currency, timezone: required.binding.timezone, ...required.input, mapping: metricMapping,
    retrievedAt: required.retrievedAt, dataThrough: required.complete ? Math.min(required.retrievedAt, coverageCutoff({ end: required.input.days.end, timezone: required.binding.timezone })) : 0,
    complete: required.complete, freshness: required.complete ? "fresh" : "stale", finality: "provisional", restated: false,
    rows: required.rows.map(row => metricRow({ row, grain: required.input.grain })),
  } });
}
/** Resolve the coverage cutoff in the account timezone using the existing wall-time formatter.
 * O(1), three DST offset corrections; invalid local midnights fail the final epoch schema.
 */
function coverageCutoff({ end, timezone }: { end: string; timezone: string }): number {
  const wall = Date.parse(end + "T00:00:00Z");
  let instant = wall;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    instant += wall - Date.parse(googleDateTime({ epoch: instant, timezone }).replace(" ", "T") + "Z");
  }
  return googleDateTime({ epoch: instant, timezone }) === end + " 00:00:00" ? instant : NaN;
}
function matchesAccount({ row, binding }: { row: Record<string, unknown>; binding: Pick<AccountBinding, "connectionId" | "customerId" | "currency" | "timezone"> }): boolean {
  const customer = asRecord({ value: row.customer });
  return customer.id === binding.customerId && customer.currencyCode === binding.currency && customer.timeZone === binding.timezone;
}
function metricRow({ row, grain }: { row: Record<string, unknown>; grain: MetricGrain }): unknown {
  const metrics = asRecord({ value: row.metrics });
  const entity: Record<string, unknown> = { grain };
  if (grain !== "account") entity.vendorCampaignId = asRecord({ value: row.campaign }).id;
  if (grain === "ad_group" || grain === "ad") entity.vendorAdGroupId = asRecord({ value: row.adGroup }).id;
  if (grain === "ad") entity.vendorAdId = asRecord({ value: asRecord({ value: row.adGroupAd }).ad }).id;
  if (Object.entries(entity).some(([key, value]) => key !== "grain" && !parse({ schema: numericId, input: value }).ok)) return null;
  if (row.metrics !== undefined && (row.metrics === null || typeof row.metrics !== "object" || Array.isArray(row.metrics))) return null;
  return { day: asRecord({ value: row.segments }).date, entity, metrics: {
    spend: integerText({ value: metrics.costMicros }), impressions: integerText({ value: metrics.impressions }), clicks: integerText({ value: metrics.clicks }),
    vendorConversions: decimalMicros({ value: metrics.conversions }), vendorConversionValue: decimalMicros({ value: metrics.conversionsValue }),
  } };
}

import { z } from "zod";
import { callContextSchema, serviceContextSchema, idSchema, metricMappingSchema } from "@open-marketing/contracts";
import type { CampaignStatusOutput, MetricBatch, Outcome } from "@open-marketing/contracts";
import { failure, success, timestamp, vendorId } from "./commands.js";

export const context = z.union([callContextSchema, serviceContextSchema]);
export const envelope = z.strictObject({ context, connection: z.strictObject({ connectionId: idSchema, accountId: vendorId }), input: z.unknown() });
const integer = z.string().regex(/^(0|[1-9]\d{0,37})$/);
const metrics = z.object({ spend: integer.nullish(), impressions: integer.nullish(), swipes: integer.nullish(), conversion_purchases: integer.nullish(), conversion_purchases_value: integer.nullish() });
const series = z.object({ id: vendorId, type: z.enum(["AD_ACCOUNT", "CAMPAIGN"]), granularity: z.literal("DAY"), start_time: timestamp, end_time: timestamp,
  finalized_data_end_time: timestamp.optional(), conversion_data_processed_end_time: timestamp.optional(),
  timeseries: z.array(z.object({ start_time: timestamp, end_time: timestamp, stats: metrics })).max(366), ad_account_id: vendorId.optional(), paging: z.object({ next_link: z.string().max(4096).nullish() }).optional() });
const campaign = z.object({ id: vendorId, ad_account_id: vendorId, status: z.enum(["ACTIVE", "PAUSED"]), delivery_status: z.array(z.string().min(1).max(200)).max(50).optional(), end_time: timestamp.optional() });
export const campaignPage = z.object({ request_status: success, campaigns: z.array(z.object({ sub_request_status: success, campaign })).max(100), paging: z.object({ next_link: z.string().max(4096).nullish() }).optional() });
const spend = { vendorField: "spend", meaning: "Account-currency micros; no assumed two-decimal currency exponent" };
export const mapping = metricMappingSchema.parse({ pluginId: "snapchat-ads", version: "snap-v1-2026-10-26", grains: { account: { spend }, campaign: { spend,
  impressions: { vendorField: "impressions", meaning: "Vendor-reported impressions" }, clicks: { vendorField: "swipes", meaning: "Swipe-ups, not all clicks" },
  vendorConversions: { vendorField: "conversion_purchases", meaning: "Total-source purchases; 28-day swipe-up, 1-day view, vendor-default engaged view; millionths" },
  vendorConversionValue: { vendorField: "conversion_purchases_value", meaning: "Same-attribution total-source purchase value in account-currency micros" },
} } });

/** Calendar midnight resolved with Intl and round-trip validation, including DST. No host timezone
 * or current time dependency. O(1), at most three offset corrections; skipped days fail closed. */
export function midnight(required: { day: string; timezone: string }): string | null {
  const target = Date.parse(required.day + "T00:00:00Z");
  let instant = target;
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const local = localTime({ instant, timezone: required.timezone });
      if (local === required.day + "T00:00:00") return new Date(instant).toISOString();
      instant += target - Date.parse(local + "Z");
    }
    return null;
  } catch { return null; }
}
function localTime(required: { instant: number; timezone: string }): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: required.timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(required.instant).replace(" ", "T");
}

export function statsUrl(required: { id: string; grain: string; start: string; end: string }): string {
  const url = new URL("https://adsapi.snapchat.com/v1/adaccounts/" + required.id + "/stats");
  url.search = new URLSearchParams({ granularity: "DAY", start_time: required.start, end_time: required.end,
    fields: required.grain === "account" ? "spend" : "spend,impressions,swipes,conversion_purchases,conversion_purchases_value",
    swipe_up_attribution_window: "28_DAY", view_attribution_window: "1_DAY", conversion_source_types: "total" }).toString();
  if (required.grain === "campaign") url.searchParams.set("breakdown", "campaign");
  return url.href;
}

const paging = z.object({ next_link: z.string().max(4096).nullish() });
const accountStats = series.omit({ timeseries: true }).extend({
  granularity: z.literal("DAY").optional(), timeseries: series.shape.timeseries.optional(),
  breakdown_stats: z.object({ campaign: z.array(series).max(5000), paging: paging.optional() }).optional(),
});

/** Decode account stats and nested campaign DAY series atomically. Empty unpaged breakdowns
 * are complete responses; unknown watermarks stay zero. O(r+c), <=5,000 output rows/1MiB. */
export function projectSeries(required: { input: unknown; id: string; grain: string; days: MetricBatch["days"]; timezone: string; start: string; end: string }): Outcome<{ rows: MetricBatch["rows"]; dataThrough: number; complete: boolean }> {
  const parsed = z.object({ request_status: success, paging: paging.optional(), timeseries_stats: z.array(z.object({ sub_request_status: success, timeseries_stat: accountStats, paging: paging.optional() })).length(1) }).safeParse(required.input);
  if (!parsed.success) return failure({ code: "protocol_mismatch" });
  const wrapper = parsed.data.timeseries_stats[0], account = wrapper.timeseries_stat;
  if (account.id !== required.id || account.type !== "AD_ACCOUNT") return failure({ code: "forbidden" });
  if (Date.parse(account.start_time) !== Date.parse(required.start) || Date.parse(account.end_time) !== Date.parse(required.end)) return failure({ code: "protocol_mismatch" });
  const paginated = [parsed.data.paging, wrapper.paging, account.paging, account.breakdown_stats?.paging].some(page => Boolean(page?.next_link));
  if (required.grain === "account") {
    const result = projectEntity({ ...required, input: account });
    if (!result.ok) return result;
    return { ok: true, value: { ...result.value, complete: result.value.complete && !paginated } };
  }
  return projectCampaigns({ ...required, account, complete: !paginated });
}

/** Nested campaign rows share the validated account boundary; duplicate/foreign children reject
 * the entire response. O(r+c) time/space within the response and canonical row caps. */
function projectCampaigns(required: { account: z.infer<typeof accountStats>; id: string; grain: string; days: MetricBatch["days"]; timezone: string; start: string; end: string; complete: boolean }): Outcome<{ rows: MetricBatch["rows"]; dataThrough: number; complete: boolean }> {
  const { account } = required;
  if (!account.breakdown_stats) return failure({ code: "protocol_mismatch" });
  const children = account.breakdown_stats.campaign;
  if (children.some(item => item.ad_account_id !== undefined && item.ad_account_id !== required.id)) return failure({ code: "forbidden" });
  if (new Set(children.map(item => item.id)).size !== children.length) return failure({ code: "protocol_mismatch" });
  const rows: MetricBatch["rows"] = [];
  let complete = required.complete, dataThrough = watermark({ item: account, grain: required.grain });
  for (const child of children) {
    const projected = projectEntity({ ...required, id: child.id, input: { ...child, finalized_data_end_time: child.finalized_data_end_time ?? account.finalized_data_end_time, conversion_data_processed_end_time: child.conversion_data_processed_end_time ?? account.conversion_data_processed_end_time } });
    if (!projected.ok) return projected;
    rows.push(...projected.value.rows);
    dataThrough = Math.min(dataThrough, projected.value.dataThrough);
    complete = complete && projected.value.complete;
  }
  return { ok: true, value: { rows, dataThrough, complete } };
}

/** Validate an entity window and local DAY intervals before exposing any rows. O(r), r<=366. */
function projectEntity(required: { input: unknown; id: string; grain: string; days: MetricBatch["days"]; timezone: string; start: string; end: string }): Outcome<{ rows: MetricBatch["rows"]; dataThrough: number; complete: boolean }> {
  const parsed = series.safeParse(required.input);
  if (!parsed.success) return failure({ code: "protocol_mismatch" });
  const item = parsed.data;
  const matched = validateEntity({ item, ...required });
  if (!matched.ok) return matched;
  const rows: MetricBatch["rows"] = [];
  for (const interval of item.timeseries) {
    const projected = projectInterval({ interval, ...required });
    if (!projected.ok) return projected;
    rows.push(projected.value);
  }
  if (new Set(rows.map(row => row.day)).size !== rows.length) return failure({ code: "protocol_mismatch" });
  return { ok: true, value: { rows, dataThrough: watermark({ item, grain: required.grain }), complete: !item.paging?.next_link && rows.length === (Date.parse(required.days.end) - Date.parse(required.days.start)) / 86400000 } };
}

/** Preserve distinct identity and window errors before decoding intervals. O(1), no effects. */
function validateEntity(required: { item: z.infer<typeof series>; id: string; grain: string; start: string; end: string }): Outcome<void> {
  const { item } = required;
  const type = required.grain === "account" ? "AD_ACCOUNT" : "CAMPAIGN";
  if (item.id !== required.id || item.type !== type) return failure({ code: "forbidden" });
  if (Date.parse(item.start_time) !== Date.parse(required.start) || Date.parse(item.end_time) !== Date.parse(required.end)) return failure({ code: "protocol_mismatch" });
  return { ok: true, value: undefined };
}

/** Response coverage is independent of processing freshness; missing provider marks stay zero. */
function watermark(required: { item: { finalized_data_end_time?: string; conversion_data_processed_end_time?: string }; grain: string }): number {
  const finalized = Date.parse(required.item.finalized_data_end_time ?? "1970-01-01T00:00:00Z");
  if (required.grain === "account") return finalized;
  return Math.min(finalized, Date.parse(required.item.conversion_data_processed_end_time ?? "1970-01-01T00:00:00Z"));
}

/** One real local-day interval; malformed/overlapping hour windows never masquerade as DAY.
 * O(1) native timezone work; no effects, returns one row or a protocol failure. */
function projectInterval(required: { interval: z.infer<typeof series>["timeseries"][number]; id: string; grain: string; days: MetricBatch["days"]; timezone: string }): Outcome<MetricBatch["rows"][number]> {
  const { interval } = required;
  const day = localTime({ instant: Date.parse(interval.start_time), timezone: required.timezone }).slice(0, 10);
  const nextDay = new Date(Date.parse(day) + 86400000).toISOString().slice(0, 10);
  if (day < required.days.start || day >= required.days.end) return failure({ code: "protocol_mismatch" });
  if (Date.parse(interval.start_time) !== Date.parse(midnight({ day, timezone: required.timezone }) ?? "")) return failure({ code: "protocol_mismatch" });
  if (Date.parse(interval.end_time) !== Date.parse(midnight({ day: nextDay, timezone: required.timezone }) ?? "")) return failure({ code: "protocol_mismatch" });
  return { ok: true, value: { day, entity: required.grain === "account" ? { grain: "account" } : { grain: "campaign", vendorCampaignId: required.id }, metrics: values({ stats: interval.stats, grain: required.grain }) } };
}

/** Pure projection: unsupported account metrics are absent; supported missing values are null. */
function values(required: { stats: z.infer<typeof metrics>; grain: string }): MetricBatch["rows"][number]["metrics"] {
  const { stats } = required;
  if (required.grain === "account") return { spend: stats.spend ?? null };
  return { spend: stats.spend ?? null, impressions: stats.impressions ?? null, clicks: stats.swipes ?? null,
    vendorConversions: stats.conversion_purchases == null ? null : (BigInt(stats.conversion_purchases) * 1000000n).toString(), vendorConversionValue: stats.conversion_purchases_value ?? null };
}

export function status(required: { campaign: z.infer<typeof campaign> }): CampaignStatusOutput["campaigns"][number]["status"] {
  if (required.campaign.status === "PAUSED") return "paused";
  return required.campaign.delivery_status?.length === 1 && required.campaign.delivery_status[0] === "DELIVERING" ? "active" : "unknown";
}

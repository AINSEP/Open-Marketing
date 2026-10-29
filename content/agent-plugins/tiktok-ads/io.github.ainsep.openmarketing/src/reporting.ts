import { z } from "zod";
import { epochSchema, idSchema, parseBoundary, decimalToMicros, metricMappingSchema } from "@open-marketing/contracts";
import type { Money, Outcome, MetricBatch, ReportMetricsInput } from "@open-marketing/contracts";
import { decodeTikTokRead, failure, tiktokCommandSchema, tiktokPageSchema, tiktokReportDataSchema, tiktokSpendSchema, vendorIdSchema } from "./commands.js";
import type { TikTokReportQuery } from "./commands.js";

/** Host supplies the bound advertiser's verified currency, IANA timezone and currency
 * exponent. Tool arguments cannot guess currency precision or override account metadata.
 */
export const tiktokAccountMetadataSchema = z.strictObject({ accountId: vendorIdSchema, currency: z.string().regex(/^[A-Z]{3}$/), timezone: z.string().min(1).max(100), minorUnitExponent: z.number().int().min(0).max(3) });
export type TikTokAccountMetadata = z.infer<typeof tiktokAccountMetadataSchema>;
/** Immutable read receipt; persistence/restatement lineage belongs to measure, not the plugin.
 * Dates are inclusive in the account timezone. Empty/partial pages have no spend total.
 */
export interface TikTokReport {
  readonly snapshotId: string;
  readonly accountId: string;
  readonly currency: string;
  readonly timezone: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly retrievedAt: number;
  readonly pageInfo: z.infer<typeof tiktokPageSchema>;
  readonly complete: boolean;
  readonly rows: readonly { accountId: string; spend: Money }[];
  readonly spend: Money | null;
}

/** Exact decimal conversion with caller-verified minor-unit exponent; no floating arithmetic.
 * @example decimalToMinor({ amount: "12.34", exponent: 2 }) // { ok: true, value: 1234 }
 * @complexity O(n) time/space, n <= 20 characters; rejects rounding and safe-integer overflow.
 */
export function decimalToMinor(required: { amount: string; exponent: number }): Outcome<number> {
  const parsed = parseBoundary({ schema: z.strictObject({ amount: tiktokSpendSchema, exponent: z.number().int().min(0).max(3) }), input: required });
  if (!parsed.ok) return parsed;
  const [major, fraction = ""] = parsed.value.amount.split(".");
  if (fraction.length > parsed.value.exponent) return failure({ code: "invalid_input", message: "TikTok spend precision exceeds currency units" });
  const minor = BigInt(major + fraction.padEnd(parsed.value.exponent, "0"));
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) return failure({ code: "limit_exceeded", message: "TikTok spend overflows safe money units" });
  return { ok: true, value: Number(minor) };
}

/** Normalize one advertiser-total report, keeping pagination and caller-supplied retrieval time.
 * No totals for incomplete/empty data and no aggregation of attributed conversions into CAC.
 * @example decodeTikTokReport({ input: response, query, accountMetadata, snapshotId: "snapshot", retrievedAt: clock.now({}) })
 * @complexity O(b) bounded decoding, b <= 1 MiB, at most one account-total row; no I/O/time reads.
 */
export function decodeTikTokReport(required: { input: unknown; query: TikTokReportQuery; accountMetadata: TikTokAccountMetadata; snapshotId: string; retrievedAt: number }): Outcome<TikTokReport> {
  const metadata = parseBoundary({ schema: z.strictObject({ accountMetadata: tiktokAccountMetadataSchema, snapshotId: idSchema, retrievedAt: epochSchema }), input: { accountMetadata: required.accountMetadata, snapshotId: required.snapshotId, retrievedAt: required.retrievedAt } });
  if (!metadata.ok) return metadata;
  const query = parseBoundary({ schema: tiktokCommandSchema, input: required.query });
  if (!query.ok) return query;
  if (query.value.kind !== "report") return failure({ code: "invalid_input", message: "TikTok report command required" });
  const account = metadata.value.accountMetadata;
  const zone = validateTimezone({ timezone: account.timezone });
  if (!zone.ok) return zone;
  const decoded = decodeTikTokRead({ input: required.input, command: query.value, accountId: account.accountId });
  if (!decoded.ok) return decoded;
  const wire = parseBoundary({ schema: z.object({ code: z.literal(0), data: tiktokReportDataSchema }), input: decoded.value });
  if (!wire.ok) return wire;
  return buildReport({ ...metadata.value, query: query.value, data: wire.value.data });
}

/** Host timezone must be interpretable without guessing vendor offset labels. */
function validateTimezone(required: { timezone: string }): Outcome<void> {
  try { new Intl.DateTimeFormat("en", { timeZone: required.timezone }); }
  catch { return failure({ code: "invalid_input", message: "TikTok account timezone is not an IANA timezone" }); }
  return { ok: true, value: undefined };
}

function buildReport(required: { accountMetadata: TikTokAccountMetadata; snapshotId: string; retrievedAt: number; query: TikTokReportQuery; data: z.infer<typeof tiktokReportDataSchema> }): Outcome<TikTokReport> {
  const { accountMetadata: account, data, query } = required;
  const complete = data.page_info.page === 1 && data.page_info.total_page === 1 && data.page_info.total_number === 1 && data.list.length === 1;
  const rows: { accountId: string; spend: Money }[] = [];
  if (data.list.length === 1) {
    const minor = decimalToMinor({ amount: data.list[0].metrics.spend, exponent: account.minorUnitExponent });
    if (!minor.ok) return minor;
    rows.push({ accountId: account.accountId, spend: { currency: account.currency, minorUnits: minor.value } });
  }
  const spend = complete ? rows[0].spend : null;
  return { ok: true, value: { snapshotId: required.snapshotId, accountId: account.accountId, currency: account.currency, timezone: account.timezone, startDate: query.startDate, endDate: query.endDate, retrievedAt: required.retrievedAt, pageInfo: { ...data.page_info }, complete, rows, spend } };
}

export const dailyPageSize = 1000;
const dailyInteger = z.string().regex(/^(0|[1-9]\d{0,37})$/);
const dailyDecimal = z.string().max(80).regex(/^(0|[1-9]\d{0,37})(\.\d{1,32})?$/);
const dailyRow = z.object({
  dimensions: z.object({ advertiser_id: vendorIdSchema.optional(), campaign_id: vendorIdSchema.optional(), adgroup_id: vendorIdSchema.optional(), ad_id: vendorIdSchema.optional(), stat_time_day: z.string().regex(/^\d{4}-\d{2}-\d{2}( 00:00:00)?$/) }),
  metrics: z.object({ spend: dailyDecimal.nullish(), impressions: dailyInteger.nullish(), clicks: dailyInteger.nullish(), campaign_id: vendorIdSchema.optional(), adgroup_id: vendorIdSchema.optional() }),
});
const dailyResponse = z.object({ code: z.literal(0), data: z.object({ list: z.array(dailyRow).max(dailyPageSize), page_info: tiktokPageSchema }) });
/** Only documented additive metrics; parent attributes supply lineage at child grains. */
const dailyMetrics = {
  spend: { vendorField: "spend", meaning: "Advertiser spend in account currency, exactly converted from decimal major units to integer micros." },
  impressions: { vendorField: "impressions", meaning: "Ad impressions reported by TikTok for the account-local day." },
  clicks: { vendorField: "clicks", meaning: "Destination clicks reported by TikTok; excludes social interactions, not unique visitors." },
};
export const dailyMetricMapping = metricMappingSchema.parse({ pluginId: "tiktok-ads", version: "v1.3-daily-2", grains: { account: dailyMetrics, campaign: dailyMetrics, ad_group: dailyMetrics, ad: dailyMetrics } });
/** Decode one bounded daily page; foreign accounts, impossible days and inconsistent totals fail closed.
 * Pure O(n) time/space for <=1,000 rows. Null/missing supported values remain null; observed zero stays zero.
 * @example decodeTikTokDailyPage({ input: response, accountId: "123", start: "2026-03-01", end: "2026-03-02", page: 1 })
 */
export function decodeTikTokDailyPage(required: { input: unknown; accountId: string; start: string; end: string; page: number; grain?: ReportMetricsInput["grain"] }): Outcome<{ rows: MetricBatch["rows"]; totalPages: number; totalRows: number }> {
  const parsed = dailyResponse.safeParse(required.input);
  if (!parsed.success) return failure({ code: "protocol_mismatch", message: "Invalid TikTok daily report" });
  const { list, page_info: info } = parsed.data.data;
  if (info.page !== required.page || info.page_size !== dailyPageSize || info.total_page !== Math.ceil(info.total_number / dailyPageSize)) return failure({ code: "protocol_mismatch", message: "Invalid TikTok daily pagination" });
  const expected = Math.min(dailyPageSize, Math.max(0, info.total_number - (info.page - 1) * dailyPageSize));
  if (info.page > Math.max(1, info.total_page) || list.length !== expected) return failure({ code: "protocol_mismatch", message: "Incomplete TikTok daily page" });
  const rows: MetricBatch["rows"] = [];
  for (const item of list) {
    const row = dailyMetricRow({ item, ...required });
    if (!row.ok) return row;
    rows.push(row.value);
  }
  if (new Set(rows.map(row => JSON.stringify([row.day, row.entity]))).size !== rows.length) return failure({ code: "protocol_mismatch", message: "Duplicate TikTok daily rows" });
  return { ok: true, value: { rows, totalPages: info.total_page, totalRows: info.total_number } };
}
/** Exact decimal arithmetic reuses contracts; never routes canonical money through minor-unit numbers. */
function dailyMetricRow(required: { item: z.infer<typeof dailyRow>; accountId: string; start: string; end: string; grain?: ReportMetricsInput["grain"] }): Outcome<MetricBatch["rows"][number]> {
  const { item } = required;
  if (item.dimensions.advertiser_id !== undefined && item.dimensions.advertiser_id !== required.accountId) return failure({ code: "forbidden", message: "TikTok daily advertiser mismatch" });
  const day = item.dimensions.stat_time_day.slice(0, 10);
  if (!z.iso.date().safeParse(day).success || day < required.start || day >= required.end) return failure({ code: "protocol_mismatch", message: "TikTok daily date outside request" });
  const spend = item.metrics.spend == null ? { ok: true as const, value: null } : decimalToMicros({ value: item.metrics.spend, rounding: "reject" });
  if (!spend.ok) return failure({ code: "protocol_mismatch", message: "TikTok daily spend loses precision" });
  const entity = dailyEntity({ item, grain: required.grain ?? "account", accountId: required.accountId });
  if (!entity.ok) return entity;
  return { ok: true, value: { day, entity: entity.value, metrics: { spend: spend.value, impressions: item.metrics.impressions ?? null, clicks: item.metrics.clicks ?? null } } };
}
/** Require the requested dimension and documented parent attributes; never synthesize lineage.
 * O(1), pure. Account ownership is bound by the authenticated advertiser-filtered request. */
function dailyEntity(required: { item: z.infer<typeof dailyRow>; grain: ReportMetricsInput["grain"]; accountId: string }): Outcome<MetricBatch["rows"][number]["entity"]> {
  const { dimensions, metrics } = required.item;
  switch (required.grain) {
    case "account": return dimensions.advertiser_id === required.accountId ? { ok: true, value: { grain: "account" } } : failure({ code: "protocol_mismatch", message: "Missing advertiser dimension" });
    case "campaign": if (dimensions.campaign_id) return { ok: true, value: { grain: "campaign", vendorCampaignId: dimensions.campaign_id } }; break;
    case "ad_group":
      if (!dimensions.adgroup_id || !metrics.campaign_id) break;
      return { ok: true, value: { grain: "ad_group", vendorCampaignId: metrics.campaign_id, vendorAdGroupId: dimensions.adgroup_id } };
    case "ad":
      if (!dimensions.ad_id || !metrics.campaign_id || !metrics.adgroup_id) break;
      return { ok: true, value: { grain: "ad", vendorCampaignId: metrics.campaign_id, vendorAdGroupId: metrics.adgroup_id, vendorAdId: dimensions.ad_id } };
    default: { const exhaustive: never = required.grain; return exhaustive; }
  }
  return failure({ code: "protocol_mismatch", message: "Missing TikTok entity lineage" });
}
/** Resolve account-local midnight with Intl offsets, round-tripping across DST changes.
 * Pure constant work (at most four offset corrections); nonexistent/ambiguous unresolved boundaries fail.
 * @example accountDayBoundary({ day: "2026-03-09", timezone: "America/Los_Angeles" })
 */
export function accountDayBoundary(required: { day: string; timezone: string }): Outcome<number> {
  try {
    const format = new Intl.DateTimeFormat("en-CA", { timeZone: required.timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
    const target = Date.parse(required.day + "T00:00:00Z");
    let instant = target;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const parts = Object.fromEntries(format.formatToParts(instant).map(part => [part.type, part.value]));
      const local = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}Z`;
      const correction = target - Date.parse(local);
      if (correction === 0) return { ok: true, value: instant };
      instant += correction;
    }
  } catch { /* Invalid IANA zone/date is a typed boundary failure below. */ }
  return failure({ code: "protocol_mismatch", message: "TikTok local day boundary unavailable" });
}

import { z } from "zod";
import type { Outcome, ReportMetricsInput } from "@open-marketing/contracts";

const dayMs = 86400000;
const utcDay = z.number().int().min(Date.UTC(2000, 0, 1)).max(Date.UTC(2100, 0, 1)).refine(value => value % dayMs === 0);
/** Shared one-page bounds for all four commands. */
export const pageFields = { pageSize: z.number().int().min(1).max(100).default(100), pageToken: z.string().min(1).max(2048).regex(/^[^\x00-\x20\x7f]+$/).optional() };
/** UTC request boundaries, <=31 days; provider timestamps are emitted without date rounding. */
export const reportCommandSchema = z.strictObject({
  kind: z.literal("report"), pivot: z.enum(["ACCOUNT", "CAMPAIGN"]),
  window: z.strictObject({ start: utcDay, end: utcDay }),
  ...pageFields,
}).refine(value => value.window.end > value.window.start && value.window.end - value.window.start <= 31 * dayMs);
type ReportCommand = z.output<typeof reportCommandSchema>;
// The shared exact JSON reader yields metric lexemes. The legacy codec keeps safe numeric
// output and rejects fractions/exponents before conversion, including rounded-safe decimals.
const count = z.union([z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  z.string().regex(/^(0|[1-9]\d{0,15})$/).refine(value => Number.isSafeInteger(Number(value))).transform(value => Number(value)),
]).nullable();
const rowSchema = z.object({ account_id: z.string().min(1).max(128), campaign_id: z.string().regex(/^[0-9]{1,128}$/).optional(), currency: z.string().regex(/^[A-Z]{3}$/).nullable().optional(), spend: count, impressions: count, clicks: count });
const reportSchema = z.object({ metrics: z.array(rowSchema).max(100), metrics_updated_at: z.iso.datetime({ offset: true }).optional() });
/** Source-labelled report; null metrics and empty pages never imply zero spend or completeness. */
export interface RedditReport {
  readonly source: "reddit_ads"; readonly apiVersion: "v3"; readonly accountId: string; readonly currency: string;
  readonly retrievedAt: number; readonly metricsUpdatedAt: string | null;
  readonly window: { readonly start: number; readonly end: number }; readonly windowBasis: "request_utc";
  readonly availability: "reported" | "no_data_access_unconfirmed";
  readonly rows: readonly { readonly entityId: string; readonly spendMicros: string | null; readonly impressions: number | null; readonly clicks: number | null }[];
}
/** Pure fixed-metric payload; AD_ACCOUNT_ID is included to validate returned ownership.
 * @returns JSON body; O(1) bounded time/space; no I/O.
 */
export function encodeReport(required: { command: ReportCommand }): string {
  const { command } = required;
  const breakdowns = command.pivot === "ACCOUNT" ? ["AD_ACCOUNT_ID"] : ["AD_ACCOUNT_ID", "CAMPAIGN_ID"];
  return JSON.stringify({ data: { breakdowns, fields: ["SPEND", "IMPRESSIONS", "CLICKS"], starts_at: new Date(command.window.start).toISOString().replace(".000Z", "Z"), ends_at: new Date(command.window.end).toISOString().replace(".000Z", "Z"), time_zone_id: "UTC" } });
}
/** Canonical UTC DAY request; aggregate report encoding above remains unchanged.
 * @returns Fixed three-field JSON body. O(1) time/space, no effects. */
export function encodeDailyReport(required: { input: ReportMetricsInput }): string {
  const { grain, days } = required.input;
  return JSON.stringify({ data: {
    breakdowns: [grain === "account" ? "AD_ACCOUNT_ID" : "CAMPAIGN_ID", "DATE"],
    fields: ["SPEND", "IMPRESSIONS", "CLICKS"], starts_at: days.start + "T00:00:00Z",
    ends_at: days.end + "T00:00:00Z", time_zone_id: "UTC",
  } });
}
/** Validate a complete page atomically; preserve exact safe microcurrency without summing/FX.
 * @param required - Tainted data plus validated host selection and retrieval clock.
 * @returns Projected report or protocol_mismatch for foreign, duplicate or unsafe rows.
 * @complexity O(n) time/space, n<=100; no I/O or input mutation.
 */
export function decodeReport(required: { input: unknown; command: ReportCommand; accountId: string; currency: string; retrievedAt: number }): Outcome<RedditReport> {
  const parsed = reportSchema.safeParse(required.input);
  if (!parsed.success) return invalidReport();
  const metrics = parsed.data.metrics;
  if (metrics.length > required.command.pageSize || metrics.some(row => row.account_id !== required.accountId || (row.currency != null && row.currency !== required.currency))) return invalidReport();
  if (required.command.pivot === "CAMPAIGN" && metrics.some(row => row.campaign_id === undefined)) return invalidReport();
  const rows = metrics.map(row => ({ entityId: required.command.pivot === "ACCOUNT" ? row.account_id : row.campaign_id!, spendMicros: row.spend === null ? null : String(row.spend), impressions: row.impressions, clicks: row.clicks }));
  if (new Set(rows.map(row => row.entityId)).size !== rows.length) return invalidReport();
  return { ok: true, value: { source: "reddit_ads", apiVersion: "v3", accountId: required.accountId, currency: required.currency, retrievedAt: required.retrievedAt, metricsUpdatedAt: parsed.data.metrics_updated_at ?? null, window: required.command.window, windowBasis: "request_utc", availability: rows.length ? "reported" : "no_data_access_unconfirmed", rows } };
}
function invalidReport(): Outcome<never> { return { ok: false, error: { code: "protocol_mismatch", message: "Reddit report response invalid", retryable: false } }; }

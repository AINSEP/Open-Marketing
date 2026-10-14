/** LinkedIn analytics codec: pure UTC/date mapping and atomic response projection. */
import { z } from "zod";
import type { Outcome } from "@open-marketing/contracts";
import type { LinkedInWireRequest } from "./wire.js";

const dayMs = 86400000;
const utcDay = z.number().int().min(Date.UTC(2000, 0, 1)).max(Date.UTC(2100, 0, 1)).refine(value => value % dayMs === 0);
const campaignIds = z.array(z.string().regex(/^[1-9][0-9]{0,18}$/)).min(1).max(100).refine(value => new Set(value).size === value.length);
/** OM half-open UTC days, up to 366 days; account or explicit campaigns, one aggregate per pivot.
 * Older ALL queries may round to months; out-of-window provider data is rejected, never relabelled.
 */
export const reportCommandSchema = z.strictObject({
  kind: z.literal("report"), pivot: z.enum(["ACCOUNT", "CAMPAIGN"]),
  window: z.strictObject({ start: utcDay, end: utcDay }), campaignIds: campaignIds.optional(),
})
  .refine(value => value.window.end > value.window.start && value.window.end - value.window.start <= 366 * dayMs)
  .refine(value => value.pivot === "CAMPAIGN" ? value.campaignIds !== undefined : value.campaignIds === undefined);
type ReportCommand = z.infer<typeof reportCommandSchema>;
const date = z.object({ year: z.number().int().min(2000).max(2100), month: z.number().int().min(1).max(12), day: z.number().int().min(1).max(31) }).refine(value => new Date(Date.UTC(value.year, value.month - 1, value.day)).getUTCDate() === value.day);
const decimal = z.string().max(64).regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const row = z.object({ dateRange: z.object({ start: date, end: date }), pivotValues: z.array(z.string().regex(/^urn:li:sponsored(Account|Campaign):[1-9][0-9]{0,18}$/)).length(1), costInLocalCurrency: decimal, impressions: count, clicks: count });
const responseSchema = z.object({ elements: z.array(row).max(100) });
/** Source-labelled provider aggregates. Spend stays a decimal; no rounding or inferred zero total. */
export interface LinkedInReport {
  readonly source: "linkedin_ad_analytics";
  readonly apiVersion: "202609";
  readonly accountId: string;
  readonly currency: string;
  readonly retrievedAt: number;
  readonly window: { readonly start: number; readonly end: number };
  readonly availability: "reported" | "no_data_access_unconfirmed";
  readonly rows: readonly { readonly entityUrn: string; readonly window: { readonly start: number; readonly end: number }; readonly spend: string; readonly impressions: number; readonly clicks: number }[];
}

/** Encode inclusive LinkedIn dates from OM's exclusive end; fixed metrics and no provider paging.
 * @example encodeLinkedInReport({ command, accountId: "123" })
 * @complexity O(n) time/space for <=100 campaign URNs, one request.
 */
export function encodeLinkedInReport(required: { command: ReportCommand; accountId: string }): LinkedInWireRequest {
  const { command } = required;
  const range = `(start:${wireDate({ epoch: command.window.start })},end:${wireDate({ epoch: command.window.end - dayMs })})`;
  let url = `https://api.linkedin.com/rest/adAnalytics?q=analytics&pivot=${command.pivot}&timeGranularity=ALL&dateRange=${range}&accounts=List(${encodeURIComponent("urn:li:sponsoredAccount:" + required.accountId)})`;
  if (command.campaignIds) url += "&campaigns=List(" + command.campaignIds.map(id => encodeURIComponent("urn:li:sponsoredCampaign:" + id)).join(",") + ")";
  return { url: url + "&fields=dateRange,pivotValues,costInLocalCurrency,impressions,clicks", method: "GET", restliMethod: "FINDER" };
}
function wireDate(required: { epoch: number }): string {
  const value = new Date(required.epoch);
  return `(year:${value.getUTCFullYear()},month:${value.getUTCMonth() + 1},day:${value.getUTCDate()})`;
}
function epoch(required: { date: z.infer<typeof date> }): number { return Date.UTC(required.date.year, required.date.month - 1, required.date.day); }

/** Validate the entire page before returning any row. Foreign/duplicate pivots, unsafe numbers,
 * impossible dates and expanded monthly windows reject. Empty means no data/access unconfirmed.
 * @example decodeLinkedInReport({ input: { elements: [] }, command, accountId: "123", currency: "USD", retrievedAt, apiVersion: "202609" })
 * @complexity O(n*m) time/O(n) space, n,m<=100; no summation, FX or I/O.
 */
export function decodeLinkedInReport(required: { input: unknown; command: ReportCommand; accountId: string; currency: string; apiVersion: "202609"; retrievedAt: number }): Outcome<LinkedInReport> {
  const parsed = responseSchema.safeParse(required.input);
  if (!parsed.success || !Number.isSafeInteger(required.retrievedAt) || required.retrievedAt < 0) return invalidReport();
  const rows = parsed.data.elements.map(item => ({ entityUrn: item.pivotValues[0], window: { start: epoch({ date: item.dateRange.start }), end: epoch({ date: item.dateRange.end }) + dayMs }, spend: item.costInLocalCurrency, impressions: item.impressions, clicks: item.clicks }));
  const expected = required.command.pivot === "ACCOUNT" ? ["urn:li:sponsoredAccount:" + required.accountId] : (required.command.campaignIds ?? []).map(id => "urn:li:sponsoredCampaign:" + id);
  if (rows.some(item => !expected.includes(item.entityUrn) || item.window.end <= item.window.start || item.window.start < required.command.window.start || item.window.end > required.command.window.end)) return invalidReport();
  if (new Set(rows.map(item => item.entityUrn)).size !== rows.length) return invalidReport();
  return { ok: true, value: { source: "linkedin_ad_analytics", apiVersion: required.apiVersion, accountId: required.accountId, currency: required.currency, retrievedAt: required.retrievedAt, window: required.command.window, availability: rows.length ? "reported" : "no_data_access_unconfirmed", rows } };
}
function invalidReport(): Outcome<never> { return { ok: false, error: { code: "protocol_mismatch", message: "LinkedIn analytics response invalid", retryable: false } }; }

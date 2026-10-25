import { z } from "zod";
import type { Outcome } from "@open-marketing/contracts";
import { failure } from "./ports.js";

const day = 86400000;
const date = z.iso.date();
const ids = z.array(z.string().regex(/^[0-9]{1,18}$/)).min(1).max(100).refine(value => new Set(value).size === value.length);
/** Native vendor UTC date parameters; no unverified inclusive/exclusive conversion. */
export const reportCommandSchema = z.strictObject({ kind: z.literal("report"), level: z.enum(["ACCOUNT", "CAMPAIGN"]), startDate: date, endDate: date, campaignIds: ids.optional() })
  .refine(value => value.level === "CAMPAIGN" ? value.campaignIds !== undefined : value.campaignIds === undefined);
type ReportCommand = z.infer<typeof reportCommandSchema>;
const metric = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable().optional();
const row = z.object({ DATE: date, AD_ACCOUNT_ID: z.string().regex(/^[0-9]{1,18}$/).optional(), CAMPAIGN_ID: z.string().regex(/^[0-9]{1,18}$/).optional(), SPEND_IN_MICRO_DOLLAR: metric, TOTAL_IMPRESSION: metric, TOTAL_CLICKTHROUGH: metric });
export interface PinterestReport {
  readonly source: "pinterest";
  readonly level: ReportCommand["level"];
  readonly vendorDateParameters: { readonly start_date: string; readonly end_date: string };
  readonly timezone: "UTC";
  readonly granularity: "DAY";
  readonly currency: string;
  readonly spendUnit: "advertiser_currency_microunits";
  readonly retrievedAt: number;
  readonly rows: readonly z.infer<typeof row>[];
}
/** Validate local OM date caps, then return unavailable until vendor end-date/window semantics are verified.
 * @param required - Schema-validated native dates and injected epoch-ms clock value.
 * @returns invalid_input outside local caps; otherwise unavailable, with no request encoded or I/O.
 * @complexity O(1) time/space; no vendor boundary interpretation or timestamp conversion.
 */
export function reportQuery(required: { command: ReportCommand; now: number }): Outcome<string> {
  const { command, now } = required;
  const start = Date.parse(command.startDate), end = Date.parse(command.endDate);
  const today = Math.floor(now / day) * day;
  if (start > end || end - start >= 90 * day || start < today - 90 * day || end > today) return failure({ code: "invalid_input" });
  return failure({ code: "unavailable" });
}
/** Atomic projection: reject duplicate/foreign/out-of-range rows; missing metrics stay missing.
 * @complexity O(r*c) time, O(r) space; r<=9000, c<=100, one bounded response, no fan-out.
 */
export function decodeReport(required: { input: unknown; command: ReportCommand; accountId: string; currency: string; retrievedAt: number }): Outcome<PinterestReport> {
  const parsed = z.array(row).max(9000).safeParse(required.input);
  if (!parsed.success) return failure({ code: "protocol_mismatch" });
  const keys = new Set<string>();
  for (const item of parsed.data) {
    if (!rowMatches({ item, command: required.command, accountId: required.accountId })) return failure({ code: "protocol_mismatch" });
    const key = item.DATE + ":" + (item.CAMPAIGN_ID ?? item.AD_ACCOUNT_ID);
    if (keys.has(key)) return failure({ code: "protocol_mismatch" });
    keys.add(key);
  }
  return { ok: true, value: { source: "pinterest", level: required.command.level, vendorDateParameters: { start_date: required.command.startDate, end_date: required.command.endDate }, timezone: "UTC", granularity: "DAY", currency: required.currency, spendUnit: "advertiser_currency_microunits", retrievedAt: required.retrievedAt, rows: parsed.data } };
}
function rowMatches(required: { item: z.infer<typeof row>; command: ReportCommand; accountId: string }): boolean {
  const { item, command, accountId } = required;
  if (item.DATE < command.startDate || item.DATE > command.endDate) return false;
  if (item.AD_ACCOUNT_ID !== undefined && item.AD_ACCOUNT_ID !== accountId) return false;
  if (command.level === "ACCOUNT") return item.AD_ACCOUNT_ID === accountId && item.CAMPAIGN_ID === undefined;
  return item.CAMPAIGN_ID !== undefined && command.campaignIds!.includes(item.CAMPAIGN_ID);
}

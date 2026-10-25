import { z } from "zod";
import type { Outcome } from "@open-marketing/contracts";
import { campaignIdSchema } from "./commands.js";
import type { ParsedCommand } from "./commands.js";

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
// SummaryStatResponse / SummaryStatMap, selected by ids + allDays. Strip unconsumed fields.
const responseSchema = z.object({ data: z.array(z.object({ id: campaignIdSchema, impCnt: count, clkCnt: count, salesAmt: count })).max(1) });
/** Source-labelled, unsummed KRW stats. Dates retain the vendor's KST labels without schedule conversion. */
export interface NaverReport {
  readonly source: "naver_search_ads_stats";
  readonly accountId: string;
  readonly currency: "KRW";
  readonly timezone: "Asia/Seoul";
  readonly vatIncluded: true;
  readonly since: string;
  readonly until: string;
  readonly retrievedAt: number;
  readonly availability: "reported" | "no_data_access_unconfirmed";
  readonly rows: readonly { campaignId: string; impressions: number; clicks: number; spend: number }[];
}
/** Validate the complete documented summary before returning any metric; foreign/duplicate IDs reject.
 * @param required - Bounded tainted response, validated command, server customer and injected retrieval time.
 * @returns Report or protocol_mismatch; no I/O, summation, FX or invented zero rows.
 * @example decodeReport({ input: { data: [] }, command, accountId: "123", retrievedAt: 1791849600000 })
 * @complexity O(b) time/space for b<=1MiB; at most one campaign row.
 */
export function decodeReport(required: { input: unknown; command: Extract<ParsedCommand, { kind: "report" }>; accountId: string; retrievedAt: number }): Outcome<NaverReport> {
  const parsed = responseSchema.safeParse(required.input);
  if (!parsed.success || !Number.isSafeInteger(required.retrievedAt) || required.retrievedAt < 0) return invalid();
  if (parsed.data.data.some(row => row.id !== required.command.campaignId)) return invalid();
  const rows = parsed.data.data.map(row => ({ campaignId: row.id, impressions: row.impCnt, clicks: row.clkCnt, spend: row.salesAmt }));
  return { ok: true, value: { source: "naver_search_ads_stats", accountId: required.accountId, currency: "KRW", timezone: "Asia/Seoul", vatIncluded: true, since: required.command.since, until: required.command.until, retrievedAt: required.retrievedAt, availability: rows.length ? "reported" : "no_data_access_unconfirmed", rows } };
}
function invalid(): Outcome<never> { return { ok: false, error: { code: "protocol_mismatch", message: "Naver stats response invalid", retryable: false } }; }

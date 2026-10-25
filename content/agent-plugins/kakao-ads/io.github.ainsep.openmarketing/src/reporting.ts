import { z } from "zod";
import type { Outcome } from "@open-marketing/contracts";

/** Calendar validation uses UTC only as Gregorian arithmetic, never as a provider timezone. */
function calendarDay(required: { value: string }): number {
  const iso = required.value.slice(0, 4) + "-" + required.value.slice(4, 6) + "-" + required.value.slice(6, 8);
  const epoch = Date.parse(iso + "T00:00:00Z");
  return Number.isFinite(epoch) && new Date(epoch).toISOString().startsWith(iso) ? epoch : NaN;
}
const day = z.string().regex(/^[1-9][0-9]{7}$/).refine(value => Number.isFinite(calendarDay({ value })));
/** Explicit inclusive provider calendar days, at most 31. No datePreset/TODAY fallback. */
export const reportCommandSchema = z.strictObject({ kind: z.literal("report"), start: day, end: day }).refine(value => {
  const duration = calendarDay({ value: value.end }) - calendarDay({ value: value.start });
  return duration >= 0 && duration <= 30 * 86400000;
});
// The type table says yyyyMMdd; report examples use yyyy-MM-dd. Accept both, preserve bytes.
const providerDay = z.string().regex(/^(?:[1-9][0-9]{7}|[1-9][0-9]{3}-[0-9]{2}-[0-9]{2})$/).refine(value => day.safeParse(value.replaceAll("-", "")).success);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const metric = z.number().finite().nonnegative();
const metrics = z.object({ imp: count.optional(), click: count.optional(), ctr: metric.optional(), cost: metric.optional(), video_play_3s: count.optional(), vtr: metric.optional() });
const row = z.object({ start: providerDay, end: providerDay, dimensions: z.object({ ad_account_id: z.string().regex(/^[1-9][0-9]{0,18}$/).optional() }), metrics });
const response = z.object({ code: z.literal(200), data: z.array(row).max(31) });
/** BASIC coverage, not Message metrics, billing currency, finalized totals or UTC instants. */
export interface KakaoReport { readonly source: "kakao-moment-v4"; readonly metricsGroup: "BASIC"; readonly retrievedAt: number; readonly rows: readonly z.infer<typeof row>[] }

/** Compare against Kakao's documented KST day using injected time. @complexity O(1). */
export function reportBeforeToday(required: { end: string; now: number }): boolean {
  return required.end < new Date(required.now + 9 * 3600000).toISOString().slice(0, 10).replaceAll("-", "");
}
/** Validate atomically; foreign accounts, repeated/out-of-window days and malformed metrics reject.
 * Empty dimensions+metrics are the documented no-data response and remain empty.
 * @param required - Tainted bounded body, requested calendar window and host-bound account/time.
 * @returns Projected BASIC report or typed protocol failure, with no partial rows.
 * @complexity O(n) time/space, n<=31; no I/O or input mutation.
 */
export function decodeKakaoReport(required: { input: unknown; start: string; end: string; accountId: string; retrievedAt: number }): Outcome<KakaoReport> {
  const parsed = response.safeParse(required.input);
  if (!parsed.success) return protocolFailure();
  const rows = parsed.data.data;
  const foreign = rows.some(item => item.dimensions.ad_account_id !== undefined && item.dimensions.ad_account_id !== required.accountId);
  if (foreign) return { ok: false, error: { code: "forbidden", message: "Kakao report account mismatch", retryable: false } };
  if (rows.some(item => !validRowDates({ item, start: required.start, end: required.end }))) return protocolFailure();
  if (rows.some(item => item.dimensions.ad_account_id === undefined && Object.keys(item.metrics).length > 0)) return protocolFailure();
  if (new Set(rows.map(item => item.start.replaceAll("-", ""))).size !== rows.length) return protocolFailure();
  return { ok: true, value: { source: "kakao-moment-v4", metricsGroup: "BASIC", retrievedAt: required.retrievedAt, rows } };
}
/** No-data rows may retain a range; populated DAY rows must identify a single day. @complexity O(1). */
function validRowDates(required: { item: z.infer<typeof row>; start: string; end: string }): boolean {
  const start = required.item.start.replaceAll("-", ""), end = required.item.end.replaceAll("-", "");
  if (start < required.start || end > required.end || start > end) return false;
  return Object.keys(required.item.metrics).length === 0 || start === end;
}
function protocolFailure(): Outcome<never> { return { ok: false, error: { code: "protocol_mismatch", message: "Kakao report invalid", retryable: false } }; }

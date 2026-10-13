import { z } from "zod";
import { epochSchema, idSchema, timeWindowSchema } from "@open-marketing/contracts";
import type { Money, Outcome, TimeWindow } from "@open-marketing/contracts";
import { boundedJson, failure, parse } from "./boundary.js";
import { vendorIdSchema } from "./commands.js";
import { accountMetadataSchema, verifyMetaAccountMetadata } from "./account.js";
import type { MetaAccountMetadata } from "./account.js";
export type { MetaAccountMetadata } from "./account.js";

const querySchema = z.strictObject({ accountId: vendorIdSchema, since: z.iso.date(), until: z.iso.date(), window: timeWindowSchema, currency: z.string().regex(/^[A-Z]{3}$/), timezone: idSchema, attributionWindow: z.enum(["1d_click", "7d_click", "1d_view"]) });
const rowSchema = z.strictObject({ account_id: vendorIdSchema, spend: z.string().regex(/^(0|[1-9][0-9]{0,15})(\.[0-9]{1,3})?$/), account_currency: z.string().regex(/^[A-Z]{3}$/), date_start: z.iso.date(), date_stop: z.iso.date() });
/** One account total, no aggregation of breakdown rows or platform conversion counts. */
const reportSchema = z.strictObject({ data: z.array(rowSchema).length(1) });
export type MetaReportQuery = z.infer<typeof querySchema>;
/** Structurally matches measure's immutable snapshot DTO. Owner persists append/restatement lineage. */
export interface MetaSpendSnapshot { readonly snapshotId: string; readonly accountId: string; readonly window: TimeWindow; readonly spend: Money; readonly timezone: string; readonly attributionWindow: string; readonly retrievedAt: number; readonly restatementOf?: string }

/** Parse a verified account-level spend report with explicit currency/local-day/attribution binding.
 * OM periods are [start,end); Meta's date_stop is inclusive. DST-length days remain valid.
 * @example decodeMetaSpendSnapshot({ input, query, metadata, snapshotId, retrievedAt: clock.now({}) })
 * @complexity O(n) bounded JSON work plus constant local-time formatting; <=16KiB and exactly one row.
 */
export function decodeMetaSpendSnapshot(required: { input: unknown; query: MetaReportQuery; metadata: MetaAccountMetadata; snapshotId: string; retrievedAt: number; restatementOf?: string }): Outcome<MetaSpendSnapshot> {
  const envelope = parse({ schema: z.strictObject({ query: querySchema, metadata: accountMetadataSchema, snapshotId: idSchema, retrievedAt: epochSchema, restatementOf: idSchema.optional() }), input: { query: required.query, metadata: required.metadata, snapshotId: required.snapshotId, retrievedAt: required.retrievedAt, ...(required.restatementOf === undefined ? {} : { restatementOf: required.restatementOf }) } });
  if (!envelope.ok) return envelope;
  const bound = validateReportBinding({ query: envelope.value.query, metadata: envelope.value.metadata, retrievedAt: envelope.value.retrievedAt });
  if (!bound.ok) return bound;
  const bounded = boundedJson({ input: required.input, maxBytes: 16384 });
  if (!bounded.ok) return bounded;
  const report = parse({ schema: reportSchema, input: bounded.value });
  if (!report.ok) return report;
  const row = report.value.data[0];
  if (!rowMatches({ row, query: required.query })) return failure({ code: "conflict", message: "Meta report account, currency or period mismatch" });
  const minor = decimalToMinor({ amount: row.spend, exponent: required.metadata.minorUnitExponent });
  if (!minor.ok) return minor;
  const value: MetaSpendSnapshot = { snapshotId: required.snapshotId, accountId: required.query.accountId, window: { ...required.query.window }, spend: { currency: required.query.currency, minorUnits: minor.value }, timezone: required.query.timezone, attributionWindow: required.query.attributionWindow, retrievedAt: required.retrievedAt, ...(required.restatementOf === undefined ? {} : { restatementOf: required.restatementOf }) };
  return { ok: true, value };
}

/** Verify account metadata and local midnight endpoints before interpreting date-only rows. @complexity O(1). */
function validateReportBinding(required: { query: MetaReportQuery; metadata: MetaAccountMetadata; retrievedAt: number }): Outcome<void> {
  const { query, metadata, retrievedAt } = required;
  const checked = verifyMetaAccountMetadata({ input: metadata, accountId: query.accountId, currency: query.currency, now: retrievedAt });
  if (!checked.ok) return checked;
  if (metadata.timezone !== query.timezone) return failure({ code: "forbidden", message: "Meta reporting account timezone mismatch" });
  if (query.window.end - query.window.start > 366 * 86400000) return failure({ code: "limit_exceeded", message: "Meta report window exceeds OM bound" });
  try {
    const start = localParts({ epoch: query.window.start, timezone: query.timezone });
    const end = localParts({ epoch: query.window.end, timezone: query.timezone });
    const last = localParts({ epoch: query.window.end - 1, timezone: query.timezone });
    if (!localBoundariesMatch({ start, end, last, query })) return failure({ code: "invalid_input", message: "Meta inclusive dates differ from OM local-day period" });
  } catch { return failure({ code: "invalid_input", message: "Meta reporting timezone invalid" }); }
  return { ok: true, value: undefined };
}

/** Render an explicitly supplied epoch, never current time; invalid zones fail at the calling boundary. @complexity O(1). */
function localParts(required: { epoch: number; timezone: string }): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: required.timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(required.epoch));
  const map = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return { date: `${map.year}-${map.month}-${map.day}`, time: `${map.hour}:${map.minute}:${map.second}` };
}

/** Midnight endpoints and the last included local date bind inclusive vendor dates. @complexity O(1). */
function localBoundariesMatch(required: { start: { date: string; time: string }; end: { date: string; time: string }; last: { date: string; time: string }; query: MetaReportQuery }): boolean {
  return required.start.date === required.query.since && required.last.date === required.query.until && required.start.time === "00:00:00" && required.end.time === "00:00:00" && required.query.window.start % 1000 === 0 && required.query.window.end % 1000 === 0;
}

/** No cross-account, cross-currency or adjacent-date substitutions. @complexity O(1). */
function rowMatches(required: { row: z.infer<typeof rowSchema>; query: MetaReportQuery }): boolean {
  return required.row.account_id === required.query.accountId && required.row.account_currency === required.query.currency && required.row.date_start === required.query.since && required.row.date_stop === required.query.until;
}

/** Convert exact decimal text using host-verified minor-unit exponent. Avoid floating point drift.
 * @example decimalToMinor({ amount: "12.34", exponent: 2 }) // 1234
 * @complexity O(n) time/space, n<=20 characters. Rejects excess precision and safe-integer overflow.
 */
export function decimalToMinor(required: { amount: string; exponent: number }): Outcome<number> {
  const parsed = parse({ schema: z.strictObject({ amount: rowSchema.shape.spend, exponent: z.number().int().min(0).max(3) }), input: required });
  if (!parsed.ok) return parsed;
  const [major, fractional = ""] = parsed.value.amount.split(".");
  if (fractional.length > parsed.value.exponent) return failure({ code: "invalid_input", message: "Meta spend precision exceeds currency units" });
  const minor = BigInt(major + fractional.padEnd(parsed.value.exponent, "0"));
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) return failure({ code: "limit_exceeded", message: "Meta spend overflows safe money units" });
  return { ok: true, value: Number(minor) };
}

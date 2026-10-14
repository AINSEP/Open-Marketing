import { z } from "zod";
import { epochSchema, idSchema, parseBoundary } from "@open-marketing/contracts";
import type { Money, Outcome } from "@open-marketing/contracts";
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

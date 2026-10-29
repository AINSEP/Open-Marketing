import { z } from "zod";
import { decimalToMicros } from "@open-marketing/contracts";
import type { Outcome } from "@open-marketing/contracts";

/** Rate-card edition requested by the approved scope; numeric rows await primary evidence. */
export const effectiveDate = "2026-10-01";
export const sourceUrl = "https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing";
export const rateCategorySchema = z.enum(["marketing", "utility", "authentication"]);
/** USD major units as exact decimal text; omitted categories cannot authorize sending. */
export const ratesSchema = z.record(z.string().min(1).max(100), z.strictObject({
  marketing: z.string().min(1).max(100).optional(), utility: z.string().min(1).max(100).optional(),
  authentication: z.string().min(1).max(100).optional(), authenticationInternational: z.string().min(1).max(100).optional(),
})).refine(rows => Object.keys(rows).length <= 100);
export type Rates = z.infer<typeof ratesSchema>;
/** No verified USD CSV was retrievable. Never populate this from fixture rates. */
export const usdRates: Rates = {};
/** Partial mapping: only prefixes recorded from Meta pricing.md in the binding review.
 * Unmapped +1 numbers take the max-rate path until the full NANP market list is transcribed.
 * Complete the remaining NANP exceptions and market mapping before adding production rates.
 */
const prefixMarkets: Readonly<Record<string, string>> = {
  "1809": "Rest of Latin America", "1829": "Rest of Latin America", "1849": "Rest of Latin America",
};
const rateEvidenceSchema = z.object({ micros: z.bigint(), matchedPrefix: z.string(), rateString: z.string() });

/** Select the longest market prefix, or the highest listed category rate for an unknown prefix.
 * Authentication includes international list pricing, regardless of notice-based eligibility.
 * @param required E.164 digits and the vendor-observed template category.
 * @param optional Fixture rate rows; host calls use the primary-evidence table above.
 * @returns Exact micros and evidence inputs, or not_implemented for missing/invalid rates.
 * @example maximumRate({ digits: "18095550100", category: "utility" }, { rates: fixtureRates })
 * @complexity O(p log p + r), p fixed prefixes and r<=100 markets; no I/O or mutation.
 */
export function maximumRate(required: { digits: string; category: z.infer<typeof rateCategorySchema> }, optional: { rates?: Rates } = {}): Outcome<z.infer<typeof rateEvidenceSchema>> {
  const unavailable: Outcome<never> = { ok: false, error: { code: "not_implemented", message: "WhatsApp pricing evidence unavailable", retryable: false } };
  const parsed = ratesSchema.safeParse(optional.rates ?? usdRates);
  if (!parsed.success) return unavailable;
  const matchedPrefix = Object.keys(prefixMarkets).filter(prefix => required.digits.startsWith(prefix)).sort((a, b) => b.length - a.length)[0];
  const markets = matchedPrefix ? [prefixMarkets[matchedPrefix]!] : Object.keys(parsed.data);
  const rows = markets.map(market => parsed.data[market]);
  if (!rows.length || rows.some(row => row?.[required.category] === undefined)) return unavailable;
  const rateStrings = rows.flatMap(row => required.category === "authentication" && row!.authenticationInternational !== undefined
    ? [row![required.category]!, row!.authenticationInternational] : [row![required.category]!]);
  let maximum = { micros: -1n, matchedPrefix: matchedPrefix ?? "max", rateString: "" };
  for (const rateString of rateStrings) {
    const micros = decimalToMicros({ value: rateString, rounding: "reject" });
    if (!micros.ok) return unavailable;
    if (BigInt(micros.value) > maximum.micros) maximum = { ...maximum, micros: BigInt(micros.value), rateString };
  }
  return { ok: true, value: maximum };
}

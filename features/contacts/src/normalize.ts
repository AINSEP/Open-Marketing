import { createHash, createHmac } from "node:crypto";
import { parsePhoneNumberWithError } from "libphonenumber-js/max";
import type { CountryCode } from "libphonenumber-js";
import type { Outcome } from "@open-marketing/contracts";
import type { IdentifierKind } from "./types.js";

const kinds: readonly string[] = ["email", "phone", "external_customer_id", "fbclid", "fbc", "fbp", "gclid", "gbraid", "wbraid"];
function invalid(): Outcome<never> {
  return { ok: false, error: { code: "invalid_input", message: "Invalid identifier", retryable: false } };
}
function bounded(required: { value: unknown; max: number }): required is { value: string; max: number } {
  return typeof required.value === "string" && required.value.length > 0 && required.value.length <= required.max;
}

/** Trim and lowercase email without rewriting dots or plus aliases. Invalid input is redacted.
 * @example normalizeEmail({ raw: " Alice@Example.test " })
 * @complexity O(n) time/space, n <= 320 characters. No effects. */
export function normalizeEmail(required: { raw: string }): Outcome<string> {
  if (!bounded({ value: required.raw, max: 320 })) return invalid();
  const value = required.raw.trim().toLowerCase();
  if (value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return invalid();
  return { ok: true, value };
}

/** Strictly parse a valid phone; national numbers need an explicit country. Extensions reject.
 * @example normalizePhoneE164({ raw: "2133734253" }, { country: "US" })
 * @complexity O(n) time/space, n <= 128 characters. No effects. */
export function normalizePhoneE164(required: { raw: string }, optional?: { country?: CountryCode }): Outcome<string> {
  if (!bounded({ value: required.raw, max: 128 })) return invalid();
  const raw = required.raw.trim();
  if (!raw.startsWith("+") && !optional?.country) return invalid();
  try {
    const phone = parsePhoneNumberWithError(raw, { defaultCountry: optional?.country, extract: false });
    if (phone.ext || !phone.isValid()) return invalid();
    return { ok: true, value: phone.number };
  } catch { return invalid(); }
}

/** Local HMAC-SHA-256 with an unambiguous versioned message; never persist the supplied key.
 * @example identifierDigest({ kind: "email", normalizedValue: "a@example.test", key, keyVersion: "v1" })
 * @complexity O(n) time/space for <= 2048 value characters and <= 4096 key bytes. */
export function identifierDigest(required: { kind: IdentifierKind; normalizedValue: string; key: Uint8Array; keyVersion: string }): Outcome<string> {
  if (!kinds.includes(required.kind) || !bounded({ value: required.normalizedValue, max: 2048 })) return invalid();
  if (!bounded({ value: required.keyVersion, max: 256 })) return invalid();
  if (!(required.key instanceof Uint8Array) || required.key.length < 1 || required.key.length > 4096) return invalid();
  const message = JSON.stringify(["om.contacts.hmac.v1", required.kind, required.keyVersion, required.normalizedValue]);
  return { ok: true, value: createHmac("sha256", required.key).update(message, "utf8").digest("hex") };
}

/** Destination SHA-256 uses normalized values, with no key or vendor-specific preprocessing.
 * @example destinationIdentifierHash({ normalizedValue: "a@example.test" })
 * @complexity O(n) time/space, n <= 2048 characters. No effects. */
export function destinationIdentifierHash(required: { normalizedValue: string }): Outcome<string> {
  if (!bounded({ value: required.normalizedValue, max: 2048 })) return invalid();
  return { ok: true, value: createHash("sha256").update(required.normalizedValue, "utf8").digest("hex") };
}

/** Build fbc from a captured click timestamp, never the dispatch clock.
 * @example toMetaFbc({ fbclid: "fixture-click", clickTimeMs: 1710000000123 })
 * @complexity O(n) time/space, n <= 220 characters. No effects. */
export function toMetaFbc(required: { fbclid: string; clickTimeMs: number }): Outcome<string> {
  if (!bounded({ value: required.fbclid, max: 220 }) || !/^[A-Za-z0-9_-]+$/.test(required.fbclid)) return invalid();
  if (!Number.isSafeInteger(required.clickTimeMs) || required.clickTimeMs < 0) return invalid();
  return { ok: true, value: `fb.1.${required.clickTimeMs}.${required.fbclid}` };
}

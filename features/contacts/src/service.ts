import { notImplemented } from "@open-marketing/contracts";
import type { ClockPort, IdPort, Outcome } from "@open-marketing/contracts";
import type { CountryCode } from "libphonenumber-js";
import type { ContactRepoPort, ContactSuppressionPort } from "./ports.js";
import type { ContactService, IdentifierKind } from "./types.js";

/** Inert scaffold; every method fails explicitly without reading dependencies.
 * @example createContactService({ repo, suppression, clock, ids })
 * @complexity O(1) time/space; no effects. */
export function createContactService(_required: { repo: ContactRepoPort; suppression: ContactSuppressionPort; clock: ClockPort; ids: IdPort }): ContactService {
  return {
    async upsert() { return notImplemented({ operation: "contacts.upsert" }); },
    async resolve() { return notImplemented({ operation: "contacts.resolve" }); },
    async merge() { return notImplemented({ operation: "contacts.merge" }); },
    async identifiersFor() { return notImplemented({ operation: "contacts.identifiersFor" }); },
  };
}
/** Reserved email normalization; no provider-specific dot/plus rewriting. @example normalizeEmail({ raw }) */
export function normalizeEmail(_required: { raw: string }): Outcome<string> { return notImplemented({ operation: "contacts.normalizeEmail" }); }
/** Reserved E.164 normalization with an explicit region. @example normalizePhoneE164({ raw }, { country: "US" }) */
export function normalizePhoneE164(_required: { raw: string }, _optional?: { country?: CountryCode }): Outcome<string> { return notImplemented({ operation: "contacts.normalizePhoneE164" }); }
/** Reserved local keyed HMAC; key material is injected and never retained. @example identifierDigest({ kind, normalizedValue, key, keyVersion }) */
export function identifierDigest(_required: { kind: IdentifierKind; normalizedValue: string; key: Uint8Array; keyVersion: string }): Outcome<string> { return notImplemented({ operation: "contacts.identifierDigest" }); }
/** Reserved destination SHA-256, separate from local HMAC. @example destinationIdentifierHash({ normalizedValue }) */
export function destinationIdentifierHash(_required: { normalizedValue: string }): Outcome<string> { return notImplemented({ operation: "contacts.destinationIdentifierHash" }); }
/** Reserved Meta fbc conversion; clickTimeMs is epoch milliseconds. @example toMetaFbc({ fbclid, clickTimeMs }) */
export function toMetaFbc(_required: { fbclid: string; clickTimeMs: number }): Outcome<string> { return notImplemented({ operation: "contacts.toMetaFbc" }); }

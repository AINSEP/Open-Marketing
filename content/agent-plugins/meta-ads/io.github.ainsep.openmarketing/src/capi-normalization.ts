import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { z } from "zod";
import type { Outcome } from "@open-marketing/contracts";
import { failure, parse } from "./boundary.js";

const value = z.string().min(1).max(256);
const url = z.string().max(2048).url().refine(input => { const parsed = new URL(input); return parsed.protocol === "https:" && !parsed.username && !parsed.password && !parsed.hash; });
/** Narrow consent-visible identifier keys. Unimplemented PII fields fail closed rather than being forwarded. */
export const identifiersSchema = z.strictObject({ email: value.optional(), phone: value.optional(), external_id: value.refine(input => input.trim().length > 0).optional(), fbc: value.regex(/^fb\.\d+\.\d+\.[A-Za-z0-9_-]+$/).optional(), fbp: value.regex(/^fb\.\d+\.\d+\.\d+$/).optional(), client_ip_address: value.refine(input => isIP(input) !== 0).optional(), client_user_agent: z.string().min(1).max(1024), event_source_url: url });
export interface MetaUserData { readonly em?: readonly string[]; readonly ph?: readonly string[]; readonly external_id?: readonly string[]; readonly fbc?: string; readonly fbp?: string; readonly client_ip_address?: string; readonly client_user_agent: string }
export interface NormalizedMetaIdentifiers { readonly userData: MetaUserData; readonly sourceUrl: string }

/** Match the documented SDK email/phone preparation and SHA-256 format; explicit 64-hex input
 * is not double-hashed. Country-code phones are required; no locale/country guessing.
 * Raw IP/UA/fbc/fbp are consent-controlled and remain unhashed. Only explicit external_id is sent.
 * @example normalizeMetaIdentifiers({ input: { email: " A@Example.com ", client_user_agent: "fixture", event_source_url: "https://example.com/signup" } })
 * @complexity O(n) time/O(n) space for <=4KiB fields. No I/O.
 */
export function normalizeMetaIdentifiers(required: { input: unknown }): Outcome<NormalizedMetaIdentifiers> {
  const parsed = parse({ schema: identifiersSchema, input: required.input });
  if (!parsed.ok) return parsed;
  const input = parsed.value;
  const email = normalizeEmail({ value: input.email });
  if (!email.ok) return email;
  const phone = normalizePhone({ value: input.phone });
  if (!phone.ok) return phone;
  const external = hashOptional({ value: input.external_id });
  const userData = buildUserData({ input, email: email.value, phone: phone.value, external });
  if (!hasMatchIdentifier({ input })) return failure({ code: "invalid_input", message: "Meta conversion has no supported match identifier" });
  return { ok: true, value: { userData, sourceUrl: input.event_source_url } };
}

/** Omit absent fields from the wire; never manufacture a subject identifier. @complexity O(1). */
function buildUserData(required: { input: z.infer<typeof identifiersSchema>; email?: string; phone?: string; external?: string }): MetaUserData {
  const { input, email, phone, external } = required;
  return {
    ...(email === undefined ? {} : { em: [email] }),
    ...(phone === undefined ? {} : { ph: [phone] }),
    ...(external === undefined ? {} : { external_id: [external] }),
    ...(input.fbc === undefined ? {} : { fbc: input.fbc }),
    ...(input.fbp === undefined ? {} : { fbp: input.fbp }),
    ...(input.client_ip_address === undefined ? {} : { client_ip_address: input.client_ip_address }),
    client_user_agent: input.client_user_agent,
  };
}

/** UA/source alone provide no match key; nothing is derived from the internal subject. @complexity O(1). */
function hasMatchIdentifier(required: { input: z.infer<typeof identifiersSchema> }): boolean {
  const { input } = required;
  return input.email !== undefined || input.phone !== undefined || input.external_id !== undefined || input.fbc !== undefined || input.fbp !== undefined || input.client_ip_address !== undefined;
}

/** Reject malformed email and MD5-looking input; 64-hex is an explicit prehashed identifier. @complexity O(n). */
function normalizeEmail(required: { value?: string }): Outcome<string | undefined> {
  if (required.value === undefined) return { ok: true, value: undefined };
  const value = required.value.toLowerCase().trim();
  if (/^[a-f0-9]{64}$/.test(value)) return { ok: true, value };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return failure({ code: "invalid_input", message: "Meta email format invalid" });
  return { ok: true, value: hashOptional({ value }) };
}

/** Remove documented phone formatting/prefixes; preserve only explicit international digits. @complexity O(n). */
function normalizePhone(required: { value?: string }): Outcome<string | undefined> {
  if (required.value === undefined) return { ok: true, value: undefined };
  const trimmed = required.value.toLowerCase().trim();
  if (/^[a-f0-9]{64}$/.test(trimmed)) return { ok: true, value: trimmed };
  const value = trimmed.replace(/[\s()\-]/g, "").replace(/^\+/, "").replace(/^00/, "");
  if (!/^[1-9][0-9]{6,14}$/.test(value)) return failure({ code: "invalid_input", message: "Meta phone requires international digits" });
  return { ok: true, value: hashOptional({ value }) };
}

/** Optional SHA-256 preparation, no implicit subject-ID export. @complexity O(n) time/O(n) space. */
function hashOptional(required: { value?: string }): string | undefined {
  if (required.value === undefined) return undefined;
  const normalized = required.value.toLowerCase().trim();
  if (/^[a-f0-9]{64}$/.test(normalized)) return normalized;
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

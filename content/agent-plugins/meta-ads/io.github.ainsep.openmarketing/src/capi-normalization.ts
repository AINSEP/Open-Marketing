import { isIP } from "node:net";
import { z } from "zod";
import type { Outcome } from "@open-marketing/contracts";
import { failure, parse } from "./boundary.js";

const value = z.string().min(1).max(256);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const clickTime = z.string().regex(/^(0|[1-9][0-9]{0,15})$/).refine(input => Number.isSafeInteger(Number(input)));
const url = z.string().max(2048).url().refine(input => { const parsed = new URL(input); return parsed.protocol === "https:" && !parsed.username && !parsed.password && !parsed.hash; });
/** Contacts owns normalization/hashing. Paired click fields are captured attribution, not dispatch time. */
export const identifiersSchema = z.strictObject({ email: sha256.optional(), phone: sha256.optional(), external_id: sha256.optional(), fbclid: z.string().min(1).max(220).regex(/^[A-Za-z0-9_-]+$/).optional(), click_time_ms: clickTime.optional(), fbc: value.regex(/^fb\.\d+\.\d+\.[A-Za-z0-9_-]+$/).optional(), fbp: value.regex(/^fb\.\d+\.\d+\.\d+$/).optional(), client_ip_address: value.refine(input => isIP(input) !== 0).optional(), client_user_agent: z.string().min(1).max(1024), event_source_url: url }).refine(input => (input.fbclid === undefined) === (input.click_time_ms === undefined));
export interface MetaUserData { readonly em?: readonly string[]; readonly ph?: readonly string[]; readonly external_id?: readonly string[]; readonly fbc?: string; readonly fbp?: string; readonly client_ip_address?: string; readonly client_user_agent: string }
/** Validated contacts digests mapped to Meta wire fields; no identifiers are normalized here. */
export interface NormalizedMetaIdentifiers { readonly userData: MetaUserData; readonly sourceUrl: string }

/** Validate contacts-produced lowercase SHA-256 digests and assemble Meta wire fields without hashing.
 * Captured fbclid/click_time_ms assemble fbc; a conflicting supplied cookie rejects the whole input.
 * The backend separately checks click time against conversion occurrence. UA/source alone cannot match.
 * @param required - Supported identifier map; raw email/phone/external IDs return invalid_input.
 * @returns Validated wire identifiers/source URL or a typed rejection. No I/O or input mutation.
 * @example mapMetaIdentifiers({ input: { email: "a".repeat(64), client_user_agent: "fixture", event_source_url: "https://example.com/signup" } })
 * @complexity O(n) time/O(n) space for bounded fields (<5KiB).
 */
export function mapMetaIdentifiers(required: { input: unknown }): Outcome<NormalizedMetaIdentifiers> {
  const parsed = parse({ schema: identifiersSchema, input: required.input });
  if (!parsed.ok) return parsed;
  const input = parsed.value;
  const fbc = input.fbclid === undefined ? input.fbc : `fb.1.${input.click_time_ms}.${input.fbclid}`;
  if (input.fbc !== undefined && input.fbc !== fbc) return failure({ code: "invalid_input", message: "Meta click attribution conflicts with supplied fbc" });
  if (!hasMatchIdentifier({ input })) return failure({ code: "invalid_input", message: "Meta conversion has no supported match identifier" });
  return { ok: true, value: { userData: buildUserData({ input, fbc }), sourceUrl: input.event_source_url } };
}

/** Omit absent fields; never manufacture a subject identifier or hash a supplied digest. @complexity O(1). */
function buildUserData(required: { input: z.infer<typeof identifiersSchema>; fbc?: string }): MetaUserData {
  const { input, fbc } = required;
  return {
    ...(input.email === undefined ? {} : { em: [input.email] }),
    ...(input.phone === undefined ? {} : { ph: [input.phone] }),
    ...(input.external_id === undefined ? {} : { external_id: [input.external_id] }),
    ...(fbc === undefined ? {} : { fbc }),
    ...(input.fbp === undefined ? {} : { fbp: input.fbp }),
    ...(input.client_ip_address === undefined ? {} : { client_ip_address: input.client_ip_address }),
    client_user_agent: input.client_user_agent,
  };
}

/** UA/source alone provide no match key; paired fbclid can supply the assembled fbc. @complexity O(1). */
function hasMatchIdentifier(required: { input: z.infer<typeof identifiersSchema> }): boolean {
  const { input } = required;
  return input.email !== undefined || input.phone !== undefined || input.external_id !== undefined || input.fbc !== undefined || input.fbclid !== undefined || input.fbp !== undefined || input.client_ip_address !== undefined;
}

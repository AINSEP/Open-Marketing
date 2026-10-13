import { isTokenDueForRefresh, refreshAccessToken } from "@jini-ai/oauth";
import type { OAuthTokenSet } from "@jini-ai/oauth";
import type { CallOptions, Outcome } from "@open-marketing/contracts";
import type { CredentialRefreshPort } from "./ports.js";
import type { SealedSecret } from "./types.js";
import { brokerSchema, failure, recordSchema, sameScope } from "./rules.js";
import { correlatedFetch, jiniBoundary, oauthTimeout, parseTokens, resolveProvider } from "./jini-oauth-common.js";
import type { JiniOAuthDependencies } from "./jini-oauth-common.js";

/** Published Jini expiry/refresh protocol behind the existing OM refresh port.
 * Invoke under the broker's shared lock. Decrypt only in the host, reseal the next version,
 * and let the broker CAS/store/recheck authority before dispatch. Never retries a grant.
 * @complexity Time/space O(token bytes); one bounded HTTP call only when due.
 * @example createJiniCredentialRefresh({ providers, fetchFn, guard, clock, sealer })
 */
export function createJiniCredentialRefresh(required: JiniOAuthDependencies & { readonly refreshSkewMs?: number }): CredentialRefreshPort {
  const dependencies = { ...required, providers: new Map(Array.from(required.providers, ([id, provider]) => [id, structuredClone(provider)])) };
  return {
    refresh(input, options) {
      return jiniBoundary<SealedSecret | null>({ run: async () => {
        const valid = validateRefreshInput({ input });
        if (!valid.ok) return valid;
        const snapshot = structuredClone(input);
        const skewMs = dependencies.refreshSkewMs ?? 120000;
        if (!Number.isSafeInteger(skewMs) || skewMs < 0 || skewMs > 3600000) return failure({ code: "invalid_input" });
        const tokens = await readTokens({ dependencies, input: snapshot }, options);
        if (!tokens.ok) return tokens;
        if (!isTokenDueForRefresh({ tokens: tokens.value, nowIso: new Date(dependencies.clock.now({})).toISOString(), skewMs })) return { ok: true, value: null };
        if (!tokens.value.refreshToken) return failure({ code: "unauthenticated" });
        return refreshDue({ dependencies, input: snapshot, tokens: tokens.value }, options);
      } }, options);
    },
  };
}

/** Reject cross-scope, mismatched or revoked records before opening their payload.
 * @complexity Time/space O(record bytes), bounded by record schemas.
 */
function validateRefreshInput(required: { input: Parameters<CredentialRefreshPort["refresh"]>[0] }): Outcome<void> {
  const input = required.input;
  if (!recordSchema.safeParse(input.record).success) return failure({ code: "invalid_input" });
  if (!brokerSchema.safeParse({ context: input.context, reference: input.record.reference, operationId: "refresh" }).success) return failure({ code: "invalid_input" });
  if (input.context.principal.kind !== "service" || input.record.summary.status !== "connected") return failure({ code: "forbidden" });
  if (!sameScope({ left: input.context.scope, right: input.record.reference.scope })) return failure({ code: "forbidden" });
  return { ok: true, value: undefined };
}

/** Stored JSON is tainted even after authenticated decryption; parse the bounded token schema.
 * @complexity Time/space O(token bytes), bounded to 64 KiB by the sealer.
 */
async function readTokens(required: { dependencies: JiniOAuthDependencies; input: Parameters<CredentialRefreshPort["refresh"]>[0] }, optional?: CallOptions): Promise<Outcome<OAuthTokenSet>> {
  const opened = await required.dependencies.sealer.open({ reference: required.input.record.reference, secret: required.input.record.secret }, optional);
  if (!opened.ok) return opened;
  if (Buffer.byteLength(opened.value) > 65536) return failure({ code: "protocol_mismatch" });
  try { return parseTokens({ value: JSON.parse(opened.value) }); }
  catch { return failure({ code: "protocol_mismatch" }); }
}

/** Refresh with original consent scopes/resource; omitted scope means unchanged, broader scope denies.
 * Next-version ciphertext is returned only after bounded parsing, never persisted here.
 * @complexity Time/space O(token bytes + scopes), scopes bounded to 64; one HTTP call.
 */
async function refreshDue(required: { dependencies: JiniOAuthDependencies; input: Parameters<CredentialRefreshPort["refresh"]>[0]; tokens: OAuthTokenSet }, optional?: CallOptions): Promise<Outcome<SealedSecret>> {
  if (required.input.record.reference.version === 2147483647) return failure({ code: "limit_exceeded" });
  const resolved = resolveProvider({ providers: required.dependencies.providers, pluginId: required.input.record.summary.pluginId });
  if (!resolved.ok) return resolved;
  const timeout = oauthTimeout({ dependencies: required.dependencies });
  if (!timeout.ok) return timeout;
  const tokens = await refreshAccessToken({
    tokenEndpoint: resolved.value.provider.tokenEndpoint, client: resolved.value.client,
    refreshToken: required.tokens.refreshToken!, guard: required.dependencies.guard,
    fetchFn: correlatedFetch({ dependencies: required.dependencies, context: required.input.context }, optional),
    clock: { nowMs: () => required.dependencies.clock.now({}) },
  }, { scopes: required.tokens.scopes, resource: resolved.value.resource, timeoutMs: timeout.value });
  const parsed = parseTokens({ value: tokens });
  if (!parsed.ok) return parsed;
  const allowed = new Set(required.tokens.scopes);
  if (parsed.value.scopes.some(scope => !allowed.has(scope))) return failure({ code: "protocol_mismatch" });
  const updated = { ...parsed.value, scopes: parsed.value.scopes.length ? parsed.value.scopes : required.tokens.scopes };
  const reference = { ...required.input.record.reference, version: required.input.record.reference.version + 1 };
  // A successful rotation must be sealed even when its initiating caller disconnects.
  return required.dependencies.sealer.seal({ reference, plaintext: JSON.stringify(updated) });
}

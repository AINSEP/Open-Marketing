import { beginAuthorizationCode, completeAuthorizationCode } from "@jini-ai/oauth";
import type { OAuthRandomBytes, PendingAuthorizationStore } from "@jini-ai/oauth";
import type { CallOptions, IdPort, Outcome } from "@open-marketing/contracts";
import type { OAuthClientPort } from "./ports.js";
import type { OAuthHostBindings } from "./oauth.js";
import type { SealedSecret } from "./types.js";
import { createBoundOAuthClient } from "./oauth.js";
import { correlatedFetch, jiniBoundary, oauthTimeout, parseTokens, resolveProvider } from "./jini-oauth-common.js";
import type { JiniOAuthDependencies } from "./jini-oauth-common.js";
import { failure, scopeKey } from "./rules.js";

/** Stateful browser-grant adapter using published Jini PKCE/state/exchange.
 * Host injects a Jini pending store (memory or durable atomic take), entropy and guarded HTTP.
 * OM callbacks expire on restart; pending PKCE must be encrypted if persisted by the host.
 * @complexity O(pending) begin pruning, O(1) completion plus bounded token I/O/crypto.
 * @example createJiniOAuthClient({ ...httpDependencies, pending, ids, randomBytesFn, allowedReturnUris, allowedAuthorizationOrigins, clientDisplayName, softwareId })
 */
export function createJiniOAuthClient(required: JiniOAuthDependencies & {
  readonly pending: PendingAuthorizationStore;
  readonly randomBytesFn: OAuthRandomBytes;
  readonly ids: IdPort;
  readonly allowedReturnUris: readonly string[];
  readonly allowedAuthorizationOrigins: readonly string[];
  readonly clientDisplayName: string;
  readonly softwareId: string;
  readonly maxPending?: number;
}): OAuthClientPort {
  const dependencies = { ...required, allowedReturnUris: [...required.allowedReturnUris], allowedAuthorizationOrigins: [...required.allowedAuthorizationOrigins], providers: new Map(Array.from(required.providers, ([id, provider]) => [id, structuredClone(provider)])) };
  const bindings: OAuthHostBindings = {
    authorize(input, options) {
      return jiniBoundary({ run: async () => {
        const resolved = resolveProvider({ providers: dependencies.providers, pluginId: input.request.pluginId });
        if (!resolved.ok) return resolved;
        const result = await beginAuthorizationCode({
          provider: resolved.value.provider, client: resolved.value.client, pending: dependencies.pending,
          randomBytesFn: dependencies.randomBytesFn, guard: dependencies.guard,
          ownerKey: scopeKey(input.reference), redirectUri: input.request.returnUri,
          options: { clientDisplayName: dependencies.clientDisplayName, softwareId: dependencies.softwareId, redirectUris: dependencies.allowedReturnUris },
        }, { resource: resolved.value.resource });
        return { ok: true, value: { authorizationUrl: result.authorizationUrl, expiresAt: Date.parse(result.expiresAt) } };
      } }, options);
    },
    exchange(input, options) { return exchange({ dependencies, input }, options); },
  };
  return createBoundOAuthClient({ ...dependencies, bindings });
}

/** Exchange once, parse normalized tokens, then seal before any token leaves the host seam.
 * @complexity Time/space O(token bytes), one bounded HTTP request, no retries.
 */
async function exchange(required: { dependencies: Parameters<typeof createJiniOAuthClient>[0]; input: Parameters<OAuthHostBindings["exchange"]>[0] }, optional?: CallOptions): Promise<Outcome<SealedSecret>> {
  return jiniBoundary({ run: async () => {
    const resolved = resolveProvider({ providers: required.dependencies.providers, pluginId: required.input.request.pluginId });
    if (!resolved.ok) return resolved;
    const timeout = oauthTimeout({ dependencies: required.dependencies });
    if (!timeout.ok) return timeout;
    const tokens = await completeAuthorizationCode({
      provider: resolved.value.provider, client: resolved.value.client, pending: required.dependencies.pending,
      guard: required.dependencies.guard, fetchFn: correlatedFetch({ dependencies: required.dependencies, context: required.input.context }, optional),
      clock: { nowMs: () => required.dependencies.clock.now({}) }, ownerKey: scopeKey(required.input.reference),
      params: { state: required.input.callback.state, code: required.input.callback.code },
    }, { timeoutMs: timeout.value });
    const parsed = parseTokens({ value: tokens });
    if (!parsed.ok) return parsed;
    const scopes = resolved.value.provider.defaultScopes;
    const allowed = new Set(scopes);
    if (parsed.value.scopes.some(scope => !allowed.has(scope))) return failure({ code: "protocol_mismatch" });
    const updated = { ...parsed.value, scopes: parsed.value.scopes.length ? parsed.value.scopes : scopes };
    return required.dependencies.sealer.seal({ reference: required.input.reference, plaintext: JSON.stringify(updated) }, optional);
  } }, optional);
}

import { createOAuthUrlGuard, createPendingAuthorizationStore } from "@jini-ai/oauth";
import type { OAuthFetch } from "@jini-ai/oauth";
import { createJiniOAuthClient, createJiniCredentialRefresh, createMemorySecretSealer, createMemoryCredentialObserver } from "../index.js";
import type { JiniOAuthDependencies, JiniOAuthProvider, CredentialRecord } from "../index.js";
import { clock, context, reference, request, value } from "./fixtures.js";

export const oauthProvider: JiniOAuthProvider = {
  provider: { providerId: "provider", label: "Test provider", supportedGrants: ["authorization_code"], authorizationEndpoint: "https://oauth.example/authorize", tokenEndpoint: "https://oauth.example/token", defaultScopes: ["ads.read"], usesPkce: true, clientAuth: "none" },
  client: { clientId: "test-client", authMethod: "none" },
  resource: "https://api.example/ads",
};
export const freshTokens = { accessToken: "sensitive-access-token", refreshToken: "sensitive-refresh-token", tokenType: "Bearer", scopes: ["ads.read"], expiresAt: "2030-01-01T00:00:00.000Z" };
export const expiredTokens = { ...freshTokens, expiresAt: "1970-01-01T00:00:00.000Z" };

/** Published Jini protocol/URL/store with an injected HTTP fixture, never network I/O. */
export function createJiniFixture(required: { body?: Record<string, unknown>; status?: number; fetchFn?: OAuthFetch; timeoutMs?: number; provider?: JiniOAuthProvider; maxPending?: number }) {
  const sealer = createMemorySecretSealer({});
  const observer = createMemoryCredentialObserver({});
  const requests: { url: string; init: RequestInit }[] = [];
  const guard = createOAuthUrlGuard({ assertAllowed(input) {
    if (!["oauth.example", "studio.example"].includes(input.url.hostname)) throw new Error("Unadmitted OAuth URL");
  } });
  let entropy = 0;
  let ids = 0;
  const randomBytesFn = (input: { byteLength: number }) => new Uint8Array(input.byteLength).fill(++entropy);
  const pending = createPendingAuthorizationStore({ clock: { nowMs: () => clock.now({}) }, randomBytesFn }, { ttlMs: 300000, maxEntries: 256 });
  const fetchFn: OAuthFetch = async (input, init) => {
    requests.push({ url: String(input.url), init: init ?? {} });
    if (required.fetchFn) return required.fetchFn(input, init);
    return Response.json(required.body ?? { access_token: "sensitive-access-token", refresh_token: "sensitive-refresh-token", token_type: "Bearer", scope: "ads.read", expires_in: 3600 }, { status: required.status ?? 200 });
  };
  const dependencies: JiniOAuthDependencies = { providers: new Map([["plugin", required.provider ?? oauthProvider]]), fetchFn, guard, sealer, clock, observer, timeoutMs: required.timeoutMs };
  const oauth = createJiniOAuthClient({ ...dependencies, pending, randomBytesFn, ids: { next() { return `jini-connection-${++ids}`; } }, allowedReturnUris: [request.returnUri], allowedAuthorizationOrigins: ["https://oauth.example"], clientDisplayName: "OM Test", softwareId: "io.github.ainsep.openmarketing", maxPending: required.maxPending });
  return { oauth, sealer, dependencies, pending, requests, observer, refresh: createJiniCredentialRefresh(dependencies) };
}

/** Seed an authenticated record using the harness sealer; assertions never need private state. */
export async function createTokenRecord(required: { sealer: JiniOAuthDependencies["sealer"]; tokens?: typeof freshTokens }): Promise<CredentialRecord> {
  const secret = value({ outcome: await required.sealer.seal({ reference, plaintext: JSON.stringify(required.tokens ?? freshTokens) }) });
  return { summary: { connectionId: reference.connectionId, scope: context.scope, pluginId: "plugin", status: "connected" }, reference, secret };
}

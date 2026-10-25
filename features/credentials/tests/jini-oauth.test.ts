import { deriveCodeChallenge } from "@jini-ai/oauth";
import { describe, expect, it } from "vitest";
import { createCredentialBroker, createJiniOAuthClient, createMemoryCredentialAudit, createMemoryCredentialLock, createMemoryCredentialRepo } from "../index.js";
import type { OAuthHostBindings } from "../index.js";
import { createJiniFixture, createTokenRecord as createFixtureRecord, expiredTokens, freshTokens, oauthProvider } from "./jini-fixture.js";
import { context, hostContext, request, value } from "./fixtures.js";

/** Versioned fixture storage exercises the production decoder without changing legacy fixtures. */
async function createTokenRecord(required: Parameters<typeof createFixtureRecord>[0]) {
  return createFixtureRecord({ ...required, sealer: { ...required.sealer, seal(input, options) {
    return required.sealer.seal({ ...input, plaintext: "om.oauth.v1:" + input.plaintext }, options);
  } } });
}
/** Assert the storage tag before inspecting secret fields inside this host-only test. */
function payload(required: { plaintext: string }) {
  expect(required.plaintext.startsWith("om.oauth.v1:")).toBe(true);
  return JSON.parse(required.plaintext.slice("om.oauth.v1:".length));
}

/** Drive only the public OAuth port; the HTTP fixture observes actual protocol output. */
async function connect(required: { fixture: ReturnType<typeof createJiniFixture> }) {
  const challenge = value({ outcome: await required.fixture.oauth.begin({ context, request }) });
  const callback = { transactionId: challenge.transactionId, state: new URL(challenge.authorizationUrl).searchParams.get("state")!, code: "sensitive-code", redirectUri: request.returnUri };
  return { challenge, callback, result: await required.fixture.oauth.complete({ callback }) };
}

describe("published Jini OAuth adapter", () => {
  it("uses injected bindings within the same owner-bound, one-shot lifecycle", async () => {
    const h = createJiniFixture({});
    let exchanges = 0;
    const bindings: OAuthHostBindings = {
      async authorize(input) {
        const url = new URL("https://oauth.example/authorize");
        url.search = new URLSearchParams({ state: "S".repeat(43), redirect_uri: input.request.returnUri, response_type: "code", config_id: "1234" }).toString();
        return { ok: true, value: { authorizationUrl: url.href, expiresAt: 301234 } };
      },
      async exchange(input) {
        exchanges++;
        expect(input.context.scope).toEqual(context.scope);
        expect(input.request.pluginId).toBe("custom");
        return h.sealer.seal({ reference: input.reference, plaintext: "om.oauth.v1:" + JSON.stringify(freshTokens) });
      },
    };
    let nextId = 0;
    const oauth = createJiniOAuthClient({ ...h.dependencies, bindings({ standard }) { return {
      authorize(input, options) { return input.request.pluginId === "custom" ? bindings.authorize(input, options) : standard.authorize(input, options); },
      exchange(input, options) { return input.request.pluginId === "custom" ? bindings.exchange(input, options) : standard.exchange(input, options); },
    }; }, pending: h.pending, randomBytesFn(input) { return new Uint8Array(input.byteLength).fill(7); },
      ids: { next() { return `injected-${++nextId}`; } }, allowedReturnUris: [request.returnUri], allowedAuthorizationOrigins: ["https://oauth.example"],
      clientDisplayName: "OM Test", softwareId: "io.github.ainsep.openmarketing",
      challengeRules: new Map([["custom", { usesPkce: false, responseType: "code", additionalParameters: ["config_id"] }]]) });
    const customRequest = { ...request, pluginId: "custom" };
    const challenge = value({ outcome: await oauth.begin({ context, request: customRequest }) });
    const callback = { transactionId: challenge.transactionId, state: "S".repeat(43), code: "sensitive-code", redirectUri: request.returnUri };
    const results = await Promise.all([oauth.complete({ callback }), oauth.complete({ callback })]);
    const secret = value({ outcome: results.find(result => result.ok)! });
    expect(exchanges).toBe(1); expect(h.requests).toHaveLength(0);
    expect(results.filter(result => !result.ok && result.error.code === "expired")).toHaveLength(1);
    expect(JSON.stringify([challenge, secret])).not.toMatch(/sensitive-(code|access|refresh)/);
    expect(payload({ plaintext: value({ outcome: await h.sealer.open({ reference: { scope: context.scope, connectionId: challenge.transactionId, version: 1 }, secret }) }) })).toEqual(freshTokens);
    const standard = value({ outcome: await oauth.begin({ context, request }) });
    expect(new URL(standard.authorizationUrl).searchParams.get("code_challenge_method")).toBe("S256");
    expect(await oauth.complete({ callback: { ...callback, transactionId: standard.transactionId, state: new URL(standard.authorizationUrl).searchParams.get("state")! } })).toMatchObject({ ok: true });
    expect(h.requests).toHaveLength(1);
  });
  it("consumes denial through Jini without exchanging tokens, and rejects replay", async () => {
    const h = createJiniFixture({});
    const challenge = value({ outcome: await h.oauth.begin({ context, request }) });
    const callback = { transactionId: challenge.transactionId, state: new URL(challenge.authorizationUrl).searchParams.get("state")!, redirectUri: request.returnUri, error: "access_denied" };
    expect(await h.oauth.complete({ callback })).toMatchObject({ ok: false, error: { code: "unauthenticated" } });
    expect(await h.oauth.complete({ callback })).toMatchObject({ ok: false, error: { code: "expired" } });
    expect(await h.pending.size({})).toBe(0);
    expect(h.requests).toHaveLength(0);
  });
  it("passes offline/consent parameters and captures the provider's refresh deadline", async () => {
    const h = createJiniFixture({ provider: { ...oauthProvider, extraAuthorizationParams: { access_type: "offline", prompt: "consent" } }, body: { access_token: "access", refresh_token: "refresh", expires_in: 3600, refresh_token_expires_in: 86400 } });
    const connected = await connect({ fixture: h });
    const url = new URL(connected.challenge.authorizationUrl);
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    const reference = { scope: context.scope, connectionId: connected.challenge.transactionId, version: 1 };
    const tokens = payload({ plaintext: value({ outcome: await h.sealer.open({ reference, secret: value({ outcome: connected.result }) }) }) });
    expect(tokens.refreshExpiresAt).toBe(new Date(1234 + 86400000).toISOString());
  });
  it.each([-1, "3600", null])("rejects malformed refresh lifetime %s before saving", async lifetime => {
    const h = createJiniFixture({ body: { access_token: "access", refresh_token_expires_in: lifetime } });
    expect((await connect({ fixture: h })).result).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
    expect(h.requests).toHaveLength(1);
  });
  it.each(["broken-json", JSON.stringify({ access_token: "x".repeat(65537) })])("bounds and validates raw token responses", async body => {
    const h = createJiniFixture({ fetchFn: async () => new Response(body, { headers: { "content-type": "application/json" } }) });
    expect((await connect({ fixture: h })).result).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
    expect(h.requests).toHaveLength(1);
  });
  it("exchanges the verifier matching the displayed PKCE challenge, and returns only ciphertext", async () => {
    const h = createJiniFixture({});
    const connected = await connect({ fixture: h });
    const secret = value({ outcome: connected.result });
    const form = new URLSearchParams(String(h.requests[0].init.body));
    const url = new URL(connected.challenge.authorizationUrl);
    expect(deriveCodeChallenge({ codeVerifier: form.get("code_verifier")! })).toBe(url.searchParams.get("code_challenge"));
    expect(form.get("code")).toBe("sensitive-code");
    expect(form.get("redirect_uri")).toBe(request.returnUri);
    expect(form.get("resource")).toBe(oauthProvider.resource);
    expect(h.requests[0].init.redirect).toBe("error");
    const headers = new Headers(h.requests[0].init.headers);
    expect(headers.get("x-om-correlation-id")).toBe(context.correlationId);
    expect(headers.get("x-om-trace-id")).toBe(context.traceId);
    expect(headers.get("x-om-run-id")).toBe(context.runId);
    expect(JSON.stringify([secret, connected.challenge, h.observer.events({})])).not.toMatch(/sensitive-(access|refresh)-token|sensitive-code|code_verifier/);
    const reference = { scope: context.scope, connectionId: connected.challenge.transactionId, version: 1 };
    const opened = value({ outcome: await h.sealer.open({ reference, secret }) });
    expect(payload({ plaintext: opened })).toMatchObject({ accessToken: "sensitive-access-token", refreshToken: "sensitive-refresh-token" });
    expect(await h.pending.size({})).toBe(0);
  });
  it("never exchanges wrong state, changed redirect, or concurrent replay", async () => {
    const h = createJiniFixture({});
    const challenge = value({ outcome: await h.oauth.begin({ context, request }) });
    const callback = { transactionId: challenge.transactionId, state: new URL(challenge.authorizationUrl).searchParams.get("state")!, code: "code", redirectUri: request.returnUri };
    expect((await h.oauth.complete({ callback: { ...callback, state: "z".repeat(32) } })).ok).toBe(false);
    expect((await h.oauth.complete({ callback })).ok).toBe(false);
    expect(h.requests).toHaveLength(0);
    const next = value({ outcome: await h.oauth.begin({ context, request }) });
    const nextCallback = { ...callback, transactionId: next.transactionId, state: new URL(next.authorizationUrl).searchParams.get("state")! };
    const results = await Promise.all([h.oauth.complete({ callback: nextCallback }), h.oauth.complete({ callback: nextCallback })]);
    expect(results.filter(result => result.ok)).toHaveLength(1);
    expect(h.requests).toHaveLength(1);
    const third = value({ outcome: await h.oauth.begin({ context, request }) });
    expect((await h.oauth.complete({ callback: { ...callback, transactionId: third.transactionId, state: new URL(third.authorizationUrl).searchParams.get("state")!, redirectUri: "https://evil.example/callback" } })).ok).toBe(false);
    expect(h.requests).toHaveLength(1);
  });
  it("retains requested scopes when the token endpoint omits scope", async () => {
    const h = createJiniFixture({ body: { access_token: "sensitive-access-token", expires_in: 3600 } });
    const connected = await connect({ fixture: h });
    const secret = value({ outcome: connected.result });
    const reference = { scope: context.scope, connectionId: connected.challenge.transactionId, version: 1 };
    expect(payload({ plaintext: value({ outcome: await h.sealer.open({ reference, secret }) }) }).scopes).toEqual(oauthProvider.provider.defaultScopes);
  });
  it.each([
    { body: { error: "invalid_grant", error_description: "sensitive-provider-error" }, status: 400, code: "unauthenticated" },
    { body: { access_token: 42 }, status: 200, code: "protocol_mismatch" },
    { body: { access_token: "token", token_type: "MAC" }, status: 200, code: "protocol_mismatch" },
    { body: { access_token: "token", scope: "ads.write" }, status: 200, code: "protocol_mismatch" },
  ])("redacts errors and validates tokens ($code)", async testCase => {
    const h = createJiniFixture(testCase);
    const result = (await connect({ fixture: h })).result;
    expect(result).toMatchObject({ ok: false, error: { code: testCase.code } });
    expect(JSON.stringify(result)).not.toContain("sensitive-provider-error");
  });
  it("denies missing plugins, non-PKCE configuration and invalid timeouts before HTTP", async () => {
    const h = createJiniFixture({});
    expect((await h.oauth.begin({ context, request: { ...request, pluginId: "missing" } })).ok).toBe(false);
    const noPkce = createJiniFixture({ provider: { ...oauthProvider, provider: { ...oauthProvider.provider, usesPkce: false } } });
    expect((await noPkce.oauth.begin({ context, request })).ok).toBe(false);
    const invalidTimeout = createJiniFixture({ timeoutMs: 15001 });
    expect((await connect({ fixture: invalidTimeout })).result.ok).toBe(false);
    expect(invalidTimeout.requests).toHaveLength(0);
  });
  it("forwards caller cancellation into a request already in flight", async () => {
    const controller = new AbortController();
    const h = createJiniFixture({ fetchFn: async (_input, init) => {
      controller.abort();
      expect(init?.signal?.aborted).toBe(true);
      throw new Error("sensitive-cancelled-request");
    } });
    const challenge = value({ outcome: await h.oauth.begin({ context, request }) });
    const callback = { transactionId: challenge.transactionId, state: new URL(challenge.authorizationUrl).searchParams.get("state")!, code: "code", redirectUri: request.returnUri };
    expect(await h.oauth.complete({ callback }, { signal: controller.signal })).toMatchObject({ ok: false, error: { code: "cancelled" } });
  });
});

describe("published Jini refresh adapter", () => {
  it("persists a completed token rotation even when its initiating caller disconnects", async () => {
    const controller = new AbortController();
    const h = createJiniFixture({ fetchFn: async () => {
      controller.abort();
      return Response.json({ access_token: "rotated-after-disconnect", refresh_token: "rotated-refresh-token", expires_in: 3600 });
    } });
    const record = await createTokenRecord({ sealer: h.sealer, tokens: expiredTokens });
    const repo = createMemoryCredentialRepo({});
    value({ outcome: await repo.store({ context, reference: record.reference, secret: record.secret, pluginId: "plugin" }) });
    const broker = createCredentialBroker({ repo, locks: createMemoryCredentialLock({}), audit: createMemoryCredentialAudit({}), sealer: h.sealer, refresh: h.refresh });
    expect(await broker.use({ context: hostContext, reference: record.reference, operationId: "dispatch" }, { signal: controller.signal })).toMatchObject({ ok: false, error: { code: "cancelled" } });
    const updated = value({ outcome: await repo.getSecret({ context: hostContext, connectionId: record.reference.connectionId }) })!;
    expect(updated.reference.version).toBe(2);
    expect(payload({ plaintext: value({ outcome: await h.sealer.open({ reference: updated.reference, secret: updated.secret }) }) })).toMatchObject({ refreshToken: "rotated-refresh-token" });
    expect(h.requests).toHaveLength(1);
  });
  it("refreshes once through the broker for racing stale references", async () => {
    const h = createJiniFixture({ body: { access_token: "rotated-access-token", expires_in: 3600 } });
    const record = await createTokenRecord({ sealer: h.sealer, tokens: expiredTokens });
    const repo = createMemoryCredentialRepo({});
    value({ outcome: await repo.store({ context, reference: record.reference, secret: record.secret, pluginId: "plugin" }) });
    const broker = createCredentialBroker({ repo, locks: createMemoryCredentialLock({}), audit: createMemoryCredentialAudit({}), sealer: h.sealer, refresh: h.refresh });
    const input = { context: hostContext, reference: record.reference, operationId: "dispatch" };
    const results = await Promise.all([broker.use(input), broker.use(input), broker.use(input)]);
    expect(h.requests).toHaveLength(1);
    expect(results.filter(result => result.ok)).toHaveLength(1);
    expect(results.filter(result => !result.ok && result.error.code === "conflict")).toHaveLength(2);
    const updated = value({ outcome: await repo.getSecret({ context: hostContext, connectionId: record.reference.connectionId }) })!;
    const tokens = payload({ plaintext: value({ outcome: await h.sealer.open({ reference: updated.reference, secret: updated.secret }) }) });
    expect(tokens).toMatchObject({ accessToken: "rotated-access-token", refreshToken: freshTokens.refreshToken, scopes: freshTokens.scopes });
    const form = new URLSearchParams(String(h.requests[0].init.body));
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("scope")).toBe("ads.read");
    expect(form.get("resource")).toBe(oauthProvider.resource);
  });
  it("marks a rejected refresh reconnect_required without exposing its provider description", async () => {
    const h = createJiniFixture({ body: { error: "invalid_grant", error_description: "sensitive-refresh-token" }, status: 400 });
    const record = await createTokenRecord({ sealer: h.sealer, tokens: expiredTokens });
    const repo = createMemoryCredentialRepo({});
    value({ outcome: await repo.store({ context, reference: record.reference, secret: record.secret, pluginId: "plugin" }) });
    const broker = createCredentialBroker({ repo, locks: createMemoryCredentialLock({}), audit: createMemoryCredentialAudit({}), sealer: h.sealer, refresh: h.refresh });
    const result = await broker.use({ context: hostContext, reference: record.reference, operationId: "dispatch" });
    expect(result).toMatchObject({ ok: false, error: { code: "unauthenticated", message: "Connection unavailable; reconnect required" } });
    expect(JSON.stringify(result)).not.toContain("sensitive-refresh-token");
    expect(value({ outcome: await repo.get({ context, connectionId: record.reference.connectionId }) })?.status).toBe("reconnect_required");
  });
  it("rejects scope expansion and cross-scope records", async () => {
    const h = createJiniFixture({ body: { access_token: "rotated", scope: "ads.read ads.write", expires_in: 3600 } });
    const record = await createTokenRecord({ sealer: h.sealer, tokens: expiredTokens });
    expect(await h.refresh.refresh({ context: hostContext, record })).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
    expect(h.requests).toHaveLength(1);
    expect((await h.refresh.refresh({ context: { ...hostContext, scope: { ...hostContext.scope, ownerId: "other" } }, record })).ok).toBe(false);
    expect(h.requests).toHaveLength(1);
  });
  it("does not call HTTP for fresh or malformed tagged token JSON", async () => {
    const h = createJiniFixture({});
    const record = await createTokenRecord({ sealer: h.sealer });
    expect(value({ outcome: await h.refresh.refresh({ context: hostContext, record }) })).toBeNull();
    const secret = value({ outcome: await h.sealer.seal({ reference: record.reference, plaintext: "om.oauth.v1:not-json" }) });
    expect(await h.refresh.refresh({ context: hostContext, record: { ...record, secret } })).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
    expect(h.requests).toHaveLength(0);
  });
});

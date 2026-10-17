import { describe, expect, it } from "vitest";
import { createBoundOAuthClient, createCredentialService, createMemoryCredentialRepo, createMemoryCredentialAudit, createMemoryCredentialLock, createMemoryKeyring, createMemorySecretSealer } from "../index.js";
import type { BrowserOAuthCallback } from "../index.js";
import { createJiniFixture } from "./jini-fixture.js";
import { clock, context, request, value } from "./fixtures.js";

/** Provider fixture is deliberately tainted by the case under test. OM must reject before UI/exchange. */
function client(required: { mutate?: (required: { url: URL }) => void; maxPending?: number; expired?: boolean }) {
  const sealer = createMemorySecretSealer({});
  let nextId = 0;
  let exchanges = 0;
  const port = createBoundOAuthClient({ clock, ids: { next() { return `txn-${++nextId}`; } }, maxPending: required.maxPending,
    allowedReturnUris: [request.returnUri], allowedAuthorizationOrigins: ["https://oauth.example"], bindings: {
      async authorize(input) {
        const url = new URL("https://oauth.example/authorize");
        url.searchParams.set("state", "S".repeat(43));
        url.searchParams.set("redirect_uri", input.request.returnUri);
        url.searchParams.set("response_type", "code");
        url.searchParams.set("code_challenge", "C".repeat(43));
        url.searchParams.set("code_challenge_method", "S256");
        required.mutate?.({ url });
        return { ok: true, value: { authorizationUrl: url.href, expiresAt: clock.now({}) + (required.expired ? 0 : 300000) } };
      },
      async exchange(input) { exchanges++; return sealer.seal({ reference: input.reference, plaintext: "protected-token" }); },
    },
  });
  return { port, exchanges() { return exchanges; } };
}

/** Real service/Jini lifecycle with fixture HTTP and an independently advanced service clock. */
function lifecycle(required: Parameters<typeof createJiniFixture>[0] = {}) {
  const h = createJiniFixture(required);
  let now = clock.now({});
  const repo = createMemoryCredentialRepo({});
  const dependencies = { ...h, repo, audit: createMemoryCredentialAudit({}), locks: createMemoryCredentialLock({}), keyring: createMemoryKeyring({}), clock: { now() { return now; } } };
  return { ...h, repo, service: createCredentialService(dependencies), restart() { return createCredentialService(dependencies); }, expire() { now += 300000; } };
}

describe("state-resolved browser callbacks", () => {
  it("keeps consumed callbacks pending through deferred exchange and storage, including expiry cleanup", async () => {
    const exchange = Promise.withResolvers<Response>();
    const exchanging = Promise.withResolvers<void>();
    const storage = Promise.withResolvers<void>();
    const storing = Promise.withResolvers<void>();
    const h = lifecycle({ fetchFn: async () => { exchanging.resolve(); return exchange.promise; } });
    const store = h.repo.store;
    h.repo.store = async (input, options) => { storing.resolve(); await storage.promise; return store(input, options); };
    const challenge = value({ outcome: await h.service.beginConnect({ context, request }) });
    const status = { context, transactionId: challenge.transactionId };
    const callback = { state: new URL(challenge.authorizationUrl).searchParams.get("state")!, code: "code", redirectUri: request.returnUri };
    const completion = h.service.completeConnect({ callback });
    await exchanging.promise;
    expect(value({ outcome: await h.service.connectStatus(status) })).toEqual({ status: "pending" });
    for (const replay of [callback, { ...callback, transactionId: challenge.transactionId }]) {
      expect(await h.service.completeConnect({ callback: replay })).toMatchObject({ ok: false, error: { code: "expired" } });
    }
    h.expire();
    // Drive expiry cleanup; the independent provider clock still yields an expired challenge.
    expect(await h.service.beginConnect({ context, request })).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
    expect(value({ outcome: await h.service.connectStatus(status) })).toEqual({ status: "pending" });
    exchange.resolve(Response.json({ access_token: "sensitive-access-token", token_type: "Bearer", scope: "ads.read", expires_in: 3600 }));
    await storing.promise;
    expect(value({ outcome: await h.service.connectStatus(status) })).toEqual({ status: "pending" });
    storage.resolve();
    expect(value({ outcome: await completion })).toMatchObject({ status: "connected", connectionId: challenge.transactionId });
    expect(value({ outcome: await h.service.connectStatus(status) })).toMatchObject({ status: "complete", connection: { status: "connected" } });
    expect(await h.service.completeConnect({ callback })).toMatchObject({ ok: false, error: { code: "expired" } });
    expect(h.requests).toHaveLength(1);
  });
  it.each(["returned", "thrown"])("cleans up a deferred %s exchange failure with a redacted result", async mode => {
    const exchange = Promise.withResolvers<Response>();
    const exchanging = Promise.withResolvers<void>();
    const h = lifecycle({ fetchFn: async () => { exchanging.resolve(); return exchange.promise; } });
    const challenge = value({ outcome: await h.service.beginConnect({ context, request }) });
    const status = { context, transactionId: challenge.transactionId };
    const callback = { transactionId: challenge.transactionId, state: new URL(challenge.authorizationUrl).searchParams.get("state")!, code: "code", redirectUri: request.returnUri };
    const completion = h.service.completeConnect({ callback });
    await exchanging.promise;
    expect(value({ outcome: await h.service.connectStatus(status) })).toEqual({ status: "pending" });
    expect(await h.service.completeConnect({ callback })).toMatchObject({ ok: false, error: { code: "expired" } });
    if (mode === "thrown") exchange.reject(new Error("sensitive-provider-description"));
    else exchange.resolve(Response.json({ error: "invalid_grant", error_description: "sensitive-provider-description" }, { status: 400 }));
    const failed = await completion;
    expect(failed).toMatchObject({ ok: false, error: { message: expect.any(String) } });
    expect(JSON.stringify(failed)).not.toContain("sensitive-");
    expect(value({ outcome: await h.service.connectStatus(status) })).toEqual({ status: "expired" });
    expect(await h.service.completeConnect({ callback })).toMatchObject({ ok: false, error: { code: "expired" } });
    expect(h.requests).toHaveLength(1);
  });
  it("validates result, state and redirect before consumption, then completes once", async () => {
    const h = lifecycle();
    const challenge = value({ outcome: await h.service.beginConnect({ context, request }) });
    const status = { context, transactionId: challenge.transactionId };
    const callback = { state: new URL(challenge.authorizationUrl).searchParams.get("state")!, code: "code", redirectUri: request.returnUri };
    expect(value({ outcome: await h.service.connectStatus(status) })).toEqual({ status: "pending" });
    expect(value({ outcome: await h.service.connectStatus({ ...status, context: { ...context, scope: { ...context.scope, workspaceId: "other" } } }) })).toEqual({ status: "expired" });
    for (const invalid of [{ ...callback, state: "z".repeat(43) }, { ...callback, redirectUri: "https://evil.example" }, { ...callback, error: "access_denied" }, { state: callback.state, redirectUri: callback.redirectUri }, { ...callback, code: ["first", "second"] }, { ...callback, scope: { ownerId: "other", workspaceId: "other" } }, { ...callback, pluginId: "other" }]) {
      expect((await h.service.completeConnect({ callback: invalid as unknown as BrowserOAuthCallback })).ok).toBe(false);
    }
    expect(h.requests).toHaveLength(0);
    const results = await Promise.all([h.service.completeConnect({ callback }), h.service.completeConnect({ callback })]);
    expect(results.filter(result => result.ok)).toHaveLength(1);
    expect(h.requests).toHaveLength(1);
    const completed = value({ outcome: await h.service.connectStatus(status) });
    expect(completed).toMatchObject({ status: "complete", connection: { connectionId: challenge.transactionId, pluginId: request.pluginId } });
    expect(JSON.stringify(completed)).not.toMatch(/sensitive-|refreshToken|ciphertext/);
    expect(value({ outcome: await h.restart().connectStatus(status) })).toEqual(completed);
    const other = { ...context, scope: { ...context.scope, workspaceId: "other" } };
    expect(value({ outcome: await h.service.connectStatus({ ...status, context: other }) })).toEqual({ status: "expired" });
    expect((await h.service.connectStatus({ ...status, context: { ...context, principal: { kind: "service", serviceId: "agent" } } })).ok).toBe(false);
  });
  it("consumes denial without HTTP, expires attempts and loses pending state on restart", async () => {
    const h = lifecycle();
    const challenge = value({ outcome: await h.service.beginConnect({ context, request }) });
    const status = { context, transactionId: challenge.transactionId };
    const callback = { state: new URL(challenge.authorizationUrl).searchParams.get("state")!, error: "access_denied", error_description: "sensitive-provider-description", redirectUri: request.returnUri };
    expect(value({ outcome: await h.restart().connectStatus(status) })).toEqual({ status: "expired" });
    const denied = await h.service.completeConnect({ callback });
    expect(denied).toMatchObject({ ok: false, error: { code: "unauthenticated" } });
    expect(JSON.stringify(denied)).not.toContain("sensitive-provider-description");
    expect(await h.service.completeConnect({ callback })).toMatchObject({ ok: false, error: { code: "expired" } });
    expect(value({ outcome: await h.service.connectStatus(status) })).toEqual({ status: "expired" });
    expect(await h.pending.size({})).toBe(0);
    const next = value({ outcome: await h.service.beginConnect({ context, request }) });
    h.expire();
    expect(await h.service.completeConnect({ callback: { ...callback, state: new URL(next.authorizationUrl).searchParams.get("state")! } })).toMatchObject({ ok: false, error: { code: "expired" } });
    expect(value({ outcome: await h.service.connectStatus({ context, transactionId: next.transactionId }) })).toEqual({ status: "expired" });
    expect(h.requests).toHaveLength(0);
  });
  it("rejects repository summaries for a different connection or scope", async () => {
    const h = lifecycle();
    const summary = { connectionId: "other", scope: context.scope, pluginId: "plugin", status: "connected" as const };
    h.repo.get = async () => ({ ok: true, value: summary });
    expect(await h.service.connectStatus({ context, transactionId: "expected" })).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
    h.repo.get = async () => ({ ok: true, value: { ...summary, connectionId: "expected", scope: { ...context.scope, workspaceId: "other" } } });
    expect(await h.service.connectStatus({ context, transactionId: "expected" })).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
  });
});

describe("OAuth boundary validation", () => {
  it.each(["plain", "none", ""])('rejects PKCE method "%s"', async method => {
    const h = client({ mutate(input) { input.url.searchParams.set("code_challenge_method", method); } });
    expect((await h.port.begin({ context, request })).ok).toBe(false);
    expect(h.exchanges()).toBe(0);
  });
  it.each(["access_token", "client_secret", "code_verifier", "refresh_token"])('rejects secret URL field "%s"', async field => {
    const h = client({ mutate(input) { input.url.searchParams.set(field, "provider-secret"); } });
    const result = await h.port.begin({ context, request });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("provider-secret");
  });
  it("rejects duplicate state and nonadmitted authorization origins", async () => {
    const duplicate = client({ mutate(input) { input.url.searchParams.append("state", "other-state"); } });
    expect((await duplicate.port.begin({ context, request })).ok).toBe(false);
    const wrong = client({ mutate(input) { input.url.hostname = "evil.example"; } });
    expect((await wrong.port.begin({ context, request })).ok).toBe(false);
  });
  it("does not exchange incorrect state or redirect, including concurrent replays", async () => {
    const h = client({});
    const challenge = value({ outcome: await h.port.begin({ context, request }) });
    const callback = { transactionId: challenge.transactionId, state: "S".repeat(43), code: "code", redirectUri: request.returnUri };
    const results = await Promise.all([h.port.complete({ callback }), h.port.complete({ callback })]);
    expect(results.filter(result => result.ok)).toHaveLength(1);
    expect(h.exchanges()).toBe(1);
    const second = value({ outcome: await h.port.begin({ context, request }) });
    expect((await h.port.complete({ callback: { ...callback, transactionId: second.transactionId, redirectUri: "https://evil.example" } })).ok).toBe(false);
    expect(h.exchanges()).toBe(1);
  });
  it("enforces capacity for concurrent begins and rejects expired challenges", async () => {
    const h = client({ maxPending: 1 });
    const results = await Promise.all([h.port.begin({ context, request }), h.port.begin({ context, request })]);
    expect(results.filter(result => result.ok)).toHaveLength(1);
    expect(results.filter(result => !result.ok && result.error.code === "limit_exceeded")).toHaveLength(1);
    expect((await client({ expired: true }).port.begin({ context, request })).ok).toBe(false);
  });
});

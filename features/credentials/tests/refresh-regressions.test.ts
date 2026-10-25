import { describe, expect, it } from "vitest";
import { createAesGcmSecretSealer, createCredentialBroker, createMemoryCredentialAudit, createMemoryCredentialLock, createMemoryCredentialRepo, createMemorySecretSealer, readCredentialAccess } from "../index.js";
import { createJiniFixture, createTokenRecord, expiredTokens } from "./jini-fixture.js";
import { configuration, context, hostContext, reference, value } from "./fixtures.js";

describe("tagged OAuth storage compatibility", () => {
  it.each([
    { pluginId: "meta-ads", expiresAt: "1970-01-01T00:00:00.000Z", ok: false, status: "reconnect_required" },
    { pluginId: "tiktok-ads", expiresAt: null, ok: true, status: "connected" },
  ])("preserves the existing broker lifecycle for normalized $pluginId tokens without refresh support", async testCase => {
    // Normalized fixtures prove lifecycle behavior, not unverified vendor token lifetimes.
    const h = createJiniFixture({}); const repo = createMemoryCredentialRepo({});
    const plaintext = "om.oauth.v1:" + JSON.stringify({ ...expiredTokens, refreshToken: null, expiresAt: testCase.expiresAt });
    const secret = value({ outcome: await h.sealer.seal({ reference, plaintext }) });
    value({ outcome: await repo.store({ context, reference, secret, pluginId: testCase.pluginId }) });
    const broker = createCredentialBroker({ repo, sealer: h.sealer, refresh: h.refresh, locks: createMemoryCredentialLock({}), audit: createMemoryCredentialAudit({}) });
    const result = await broker.use({ context: hostContext, reference, operationId: "dispatch" });
    expect(result.ok).toBe(testCase.ok);
    if (!testCase.ok) expect(result).toMatchObject({ error: { code: "unauthenticated" } });
    expect(value({ outcome: await repo.get({ context, connectionId: reference.connectionId }) })?.status).toBe(testCase.status);
    expect(h.requests).toHaveLength(0);
  });
  it.each(["pasted-token", "not-json", JSON.stringify(expiredTokens)])("leaves untagged pasted secrets unchanged: %s", async plaintext => {
    const h = createJiniFixture({});
    const record = await createTokenRecord({ sealer: h.sealer });
    const secret = value({ outcome: await h.sealer.seal({ reference, plaintext }) });
    expect(readCredentialAccess({ plaintext })).toEqual({ ok: true, value: { accessToken: plaintext } });
    expect(value({ outcome: await h.refresh.refresh({ context: hostContext, record: { ...record, secret } }) })).toBeNull();
    expect(h.requests).toHaveLength(0);
  });
  it.each(["om.oauth.v2:{}", "om.oauth.v1:broken", "om.oauth.v1:{}", "om.oauth.v1:" + "x".repeat(65536)])("fails closed for malformed/reserved OAuth payloads", plaintext => {
    expect(readCredentialAccess({ plaintext })).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
  });
  it("decodes only access fields, including a token issued without refresh support", async () => {
    const tokens = { ...expiredTokens, refreshToken: null };
    const plaintext = "om.oauth.v1:" + JSON.stringify(tokens);
    expect(value({ outcome: readCredentialAccess({ plaintext }) })).toEqual({ accessToken: tokens.accessToken, expiresAt: 0, scopes: tokens.scopes });
    const h = createJiniFixture({});
    const record = await createTokenRecord({ sealer: h.sealer });
    const secret = value({ outcome: await h.sealer.seal({ reference, plaintext }) });
    expect(await h.refresh.refresh({ context: hostContext, record: { ...record, secret } })).toMatchObject({ ok: false, error: { code: "unauthenticated" } });
    expect(h.requests).toHaveLength(0);
  });
  it.each([
    { deadline: "1970-01-02T00:00:00.000Z", rotation: undefined, lifetime: undefined },
    { deadline: "1970-01-02T00:00:00.000Z", rotation: "rotated", lifetime: 31536000 },
    { deadline: undefined, rotation: "rotated", lifetime: undefined },
    { deadline: "1970-01-02T00:00:00.000Z", rotation: "rotated", lifetime: 1000 },
  ])("preserves omitted/rotated refresh tokens without resetting a known deadline", async testCase => {
    const h = createJiniFixture({ body: { access_token: "new-access", expires_in: 3600, refresh_token: testCase.rotation, refresh_token_expires_in: testCase.lifetime } });
    const record = await createTokenRecord({ sealer: h.sealer });
    const plaintext = "om.oauth.v1:" + JSON.stringify({ ...expiredTokens, refreshExpiresAt: testCase.deadline });
    const secret = value({ outcome: await h.sealer.seal({ reference, plaintext }) });
    const rotated = value({ outcome: await h.refresh.refresh({ context: hostContext, record: { ...record, secret } }) })!;
    const opened = value({ outcome: await h.sealer.open({ reference: { ...reference, version: 2 }, secret: rotated }) });
    const tokens = JSON.parse(opened.slice("om.oauth.v1:".length));
    expect(tokens.refreshToken).toBe(testCase.rotation ?? expiredTokens.refreshToken);
    const expectedDeadline = testCase.lifetime === 1000 ? new Date(1234 + 1000000).toISOString() : testCase.deadline;
    expect(tokens.refreshExpiresAt).toBe(expectedDeadline);
    expect(value({ outcome: readCredentialAccess({ plaintext: opened }) }).accessToken).toBe("new-access");
    expect(h.requests).toHaveLength(1);
  });
  it("marks an expired refresh deadline reconnect_required before HTTP", async () => {
    const h = createJiniFixture({});
    const repo = createMemoryCredentialRepo({});
    const plaintext = "om.oauth.v1:" + JSON.stringify({ ...expiredTokens, refreshExpiresAt: "1970-01-01T00:00:00.000Z" });
    const secret = value({ outcome: await h.sealer.seal({ reference, plaintext }) });
    value({ outcome: await repo.store({ context, reference, secret, pluginId: "plugin" }) });
    const broker = createCredentialBroker({ repo, sealer: h.sealer, refresh: h.refresh, locks: createMemoryCredentialLock({}), audit: createMemoryCredentialAudit({}) });
    expect(await broker.use({ context: hostContext, reference, operationId: "dispatch" })).toMatchObject({ ok: false, error: { code: "unauthenticated" } });
    expect(value({ outcome: await repo.get({ context, connectionId: reference.connectionId }) })?.status).toBe("reconnect_required");
    expect(h.requests).toHaveLength(0);
  });
});

describe("completed refresh cancellation regression", () => {
  it("finishes storing a successful rotation before returning cancellation", async () => {
    const vault = createMemorySecretSealer({});
    const repo = createMemoryCredentialRepo({});
    const secret = value({ outcome: await vault.seal({ reference, plaintext: "old-token" }) });
    value({ outcome: await repo.store({ context, reference, secret, pluginId: "plugin" }) });
    const controller = new AbortController();
    const next = { ...reference, version: 2 };
    const rotated = value({ outcome: await vault.seal({ reference: next, plaintext: "new-token" }) });
    const broker = createCredentialBroker({ repo, locks: createMemoryCredentialLock({}), audit: createMemoryCredentialAudit({}), sealer: vault, refresh: { async refresh() {
      controller.abort();
      return { ok: true, value: rotated };
    } } });
    expect(await broker.use({ context: hostContext, reference, operationId: "dispatch" }, { signal: controller.signal })).toMatchObject({ ok: false, error: { code: "cancelled" } });
    const stored = value({ outcome: await repo.getSecret({ context: hostContext, connectionId: reference.connectionId }) })!;
    expect(stored.reference).toEqual(next);
    expect(value({ outcome: await vault.open({ reference: next, secret: stored.secret }) })).toBe("new-token");
  });
  it("rejects a mismatched secret version before calling the refresh adapter", async () => {
    const vault = createMemorySecretSealer({});
    const repo = createMemoryCredentialRepo({});
    const secret = value({ outcome: await vault.seal({ reference, plaintext: "old-token" }) });
    value({ outcome: await repo.store({ context, reference, secret, pluginId: "plugin" }) });
    const stored = value({ outcome: await repo.getSecret({ context: hostContext, connectionId: reference.connectionId }) })!;
    const taintedRepo = { ...repo, async getSecret() { return { ok: true as const, value: { ...stored, secret: { ...secret, version: 2 } } }; } };
    let refreshCalls = 0;
    const broker = createCredentialBroker({ repo: taintedRepo, locks: createMemoryCredentialLock({}), audit: createMemoryCredentialAudit({}), sealer: vault, refresh: { async refresh() { refreshCalls++; return { ok: true, value: null }; } } });
    expect(await broker.use({ context: hostContext, reference, operationId: "dispatch" })).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
    expect(refreshCalls).toBe(0);
  });
  it("detaches crypto inputs before awaiting an injected key loader", async () => {
    const key = Promise.withResolvers<void>();
    const delayed = createAesGcmSecretSealer({ configuration, randomBytes: input => new Uint8Array(input.size).fill(1), keyring: { async resolve() {
      await key.promise;
      return { ok: true, value: new Uint8Array(32).fill(7) };
    } } });
    const input = { reference: structuredClone(reference), plaintext: "original" };
    const sealed = delayed.seal(input);
    input.reference.scope.ownerId = "other";
    input.plaintext = "tampered";
    key.resolve();
    expect(value({ outcome: await delayed.open({ reference, secret: value({ outcome: await sealed }) }) })).toBe("original");
  });
});

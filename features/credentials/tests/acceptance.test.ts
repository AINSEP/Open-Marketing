import { afterEach, describe, expect, it } from "vitest";
import { createCredentialService, createCredentialBroker, createMemoryCredentialRepo, createMemorySecretSealer, createMemoryCredentialLock, createMemoryCredentialAudit, createMemoryKeyring, createMemoryOAuthClient, createMemoryCredentialRefresh, createMemoryCredentialObserver, createAesGcmSecretSealer, createCredentialKeyring, createSqlCredentialRepo, createSqlCredentialAudit, createBoundOAuthClient } from "../index.js";
import type { CredentialRepoPort, SecretSealerPort } from "../index.js";
import { createSqlFixture } from "./sql-fixture.js";
import { clock, configuration, context, hostContext, reference, request, value } from "./fixtures.js";

const disposers: (() => void)[] = [];
afterEach(() => { for (const dispose of disposers.splice(0)) dispose(); });

/** Run acceptance against owned memory/SQLite compositions, with no provider effects. */
function harness(required: { persistent: boolean }) {
  let sequence = 0;
  let nonce = 0;
  const fixture = required.persistent ? createSqlFixture({}) : undefined;
  if (fixture) disposers.push(fixture.dispose);
  const repo: CredentialRepoPort = fixture ? createSqlCredentialRepo({ db: fixture.db, clock }) : createMemoryCredentialRepo({ clock });
  const keyring = createCredentialKeyring({ loadMaster: async () => ({ ok: true, value: new Uint8Array(32).fill(7) }) });
  const sealer: SecretSealerPort = fixture ? createAesGcmSecretSealer({ keyring, configuration, randomBytes: input => new Uint8Array(input.size).fill(++nonce) }) : createMemorySecretSealer({});
  const audit = fixture ? createSqlCredentialAudit({ db: fixture.db, clock, ids: { next() { return `audit-${++sequence}`; } } }) : createMemoryCredentialAudit({});
  const locks = createMemoryCredentialLock({});
  const oauth = createMemoryOAuthClient({ sealer, clock });
  const observer = createMemoryCredentialObserver({});
  const service = createCredentialService({ repo, sealer, keyring, oauth, audit, locks, clock }, { observer });
  return { repo, sealer, audit, locks, oauth, service, observer, fixture };
}

for (const persistent of [false, true]) {
  describe(persistent ? "SQLite credentials acceptance" : "memory credentials acceptance", () => {
    it("connects, redacts public/audit outputs, and revokes before dispatch", async () => {
      const h = harness({ persistent });
      const challenge = value({ outcome: await h.service.beginConnect({ context, request }) });
      const callback = { transactionId: challenge.transactionId, state: new URL(challenge.authorizationUrl).searchParams.get("state")!, code: "sensitive-code", redirectUri: request.returnUri };
      const connected = value({ outcome: await h.service.completeConnect({ callback }) });
      expect(connected.status).toBe("connected");
      expect(JSON.stringify(connected)).not.toMatch(/token|ciphertext|sensitive-code/);
      expect(JSON.stringify(h.observer.events({}))).not.toMatch(/token|sensitive-code|authorizationUrl/);
      const broker = createCredentialBroker({ repo: h.repo, sealer: h.sealer, locks: h.locks, audit: h.audit });
      const ref = { scope: context.scope, connectionId: connected.connectionId, version: 1 };
      const sealed = value({ outcome: await broker.use({ context: hostContext, reference: ref, operationId: "dispatch" }) });
      expect(JSON.stringify(sealed)).not.toContain("test-access-token");
      value({ outcome: await h.service.revoke({ context, connectionId: connected.connectionId }) });
      expect((await broker.use({ context: hostContext, reference: ref, operationId: "confirmed-dispatch" })).ok).toBe(false);
      if (h.fixture) {
        const rows = await h.fixture.db.query({ text: "SELECT * FROM om_credential_audit" });
        expect(JSON.stringify(rows.rows.map(row => ({ ...row, recorded_at: Number(row.recorded_at) })))).not.toMatch(/token|sensitive-code/);
        const records = await h.fixture.db.query({ text: "SELECT ciphertext FROM om_credential_connection" });
        expect(records.rows[0].ciphertext).toBeNull();
      }
    });
    it("refresh races call the provider once and deny stale callers", async () => {
      const h = harness({ persistent });
      const secret = value({ outcome: await h.sealer.seal({ reference, plaintext: "expired-token" }) });
      value({ outcome: await h.repo.store({ context, reference, secret, pluginId: "plugin" }) });
      const refresh = createMemoryCredentialRefresh({ sealer: h.sealer, dueVersions: [1] });
      const broker = createCredentialBroker({ repo: h.repo, locks: h.locks, audit: h.audit, sealer: h.sealer, refresh });
      const input = { context: hostContext, reference, operationId: "dispatch" };
      const results = await Promise.all([broker.use(input), broker.use(input), broker.use(input)]);
      expect(refresh.calls({})).toBe(1);
      expect(results.filter(result => result.ok)).toHaveLength(1);
      expect(results.filter(result => !result.ok && result.error.code === "conflict")).toHaveLength(2);
      expect(value({ outcome: await h.repo.getSecret({ context: hostContext, connectionId: "connection" }) })?.reference.version).toBe(2);
    });
    it("provider revocation produces reconnect_required and keeps revoked IDs terminal", async () => {
      const h = harness({ persistent });
      const secret = value({ outcome: await h.sealer.seal({ reference, plaintext: "expired-token" }) });
      value({ outcome: await h.repo.store({ context, reference, secret, pluginId: "plugin" }) });
      const broker = createCredentialBroker({ repo: h.repo, locks: h.locks, audit: h.audit, sealer: h.sealer, refresh: createMemoryCredentialRefresh({ sealer: h.sealer, revoked: true }) });
      expect((await broker.use({ context: hostContext, reference, operationId: "dispatch" })).ok).toBe(false);
      expect(value({ outcome: await h.repo.get({ context, connectionId: "connection" }) })?.status).toBe("reconnect_required");
      const fresh = value({ outcome: await h.service.beginConnect({ context, request }) });
      const summary = value({ outcome: await h.service.completeConnect({ callback: { transactionId: fresh.transactionId, state: new URL(fresh.authorizationUrl).searchParams.get("state")!, code: "new-code", redirectUri: request.returnUri } }) });
      expect(summary.status).toBe("connected");
      expect(summary.connectionId).not.toBe("connection");
    });
  });
}

describe("host credential security boundaries", () => {
  it("wrong key denies AES-GCM even when scope/version/digest are correct", async () => {
    const left = createAesGcmSecretSealer({ keyring: createMemoryKeyring({}), configuration, randomBytes: input => new Uint8Array(input.size).fill(1) });
    const right = createAesGcmSecretSealer({ keyring: createMemoryKeyring({ keys: new Map([[1, new Uint8Array(32).fill(9)]]) }), configuration, randomBytes: input => new Uint8Array(input.size).fill(2) });
    const secret = value({ outcome: await left.seal({ reference, plaintext: "protected-token" }) });
    expect(await right.open({ reference, secret })).toMatchObject({ ok: false, error: { code: "forbidden" } });
  });
  it("rejects forged owner and agent connect/revoke requests", async () => {
    const h = harness({ persistent: false });
    const forged = { ...context, principal: { kind: "owner" as const, ownerId: "other-owner" } };
    const agent = { ...context, principal: { kind: "agent" as const, agentInstanceId: "agent", runId: "run" } };
    expect((await h.service.beginConnect({ context: forged, request })).ok).toBe(false);
    expect((await h.service.beginConnect({ context: agent, request })).ok).toBe(false);
    expect((await h.service.revoke({ context: agent, connectionId: "connection" })).ok).toBe(false);
  });
  it("consumes failed state/redirect and expiry without completing a connection", async () => {
    let now = 1234;
    const customClock = { now() { return now; } };
    const h = harness({ persistent: false });
    const service = createCredentialService({ ...h, keyring: createMemoryKeyring({}), clock: customClock });
    const challenge = value({ outcome: await service.beginConnect({ context, request }) });
    const callback = { transactionId: challenge.transactionId, state: "wrong".repeat(9), code: "code", redirectUri: request.returnUri };
    expect((await service.completeConnect({ callback })).ok).toBe(false);
    expect((await service.completeConnect({ callback: { ...callback, state: new URL(challenge.authorizationUrl).searchParams.get("state")! } })).ok).toBe(false);
    const next = value({ outcome: await service.beginConnect({ context, request }) });
    now = next.expiresAt;
    expect(await service.completeConnect({ callback: { ...callback, transactionId: next.transactionId } })).toMatchObject({ ok: false, error: { code: "expired" } });
  });
  it("denies dispatch when revocation occurs during its final audit recheck", async () => {
    const h = harness({ persistent: false });
    const secret = value({ outcome: await h.sealer.seal({ reference, plaintext: "protected-token" }) });
    value({ outcome: await h.repo.store({ context, reference, secret, pluginId: "plugin" }) });
    const audit = { async record() { await h.repo.revoke({ context, connectionId: reference.connectionId }); return { ok: true as const, value: undefined }; } };
    const broker = createCredentialBroker({ repo: h.repo, locks: h.locks, sealer: h.sealer, audit });
    expect((await broker.use({ context: hostContext, reference, operationId: "dispatch" })).ok).toBe(false);
  });
  it("redacts provider errors instead of placing tokens into API results", async () => {
    const h = harness({ persistent: false });
    const oauth = { async begin() { throw new Error("vendor-secret-access-token"); }, complete: h.oauth.complete };
    const service = createCredentialService({ ...h, keyring: createMemoryKeyring({}), oauth, clock });
    const result = await service.beginConnect({ context, request });
    expect(result).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(JSON.stringify(result)).not.toContain("vendor-secret-access-token");
  });
  it("requires successful audit before credential use", async () => {
    const h = harness({ persistent: false });
    const secret = value({ outcome: await h.sealer.seal({ reference, plaintext: "protected-token" }) });
    value({ outcome: await h.repo.store({ context, reference, secret, pluginId: "plugin" }) });
    const broker = createCredentialBroker({ repo: h.repo, locks: h.locks, sealer: h.sealer, audit: { async record() { return { ok: false as const, error: { code: "unavailable" as const, message: "secret-audit-message", retryable: true } }; } } });
    const result = await broker.use({ context: hostContext, reference, operationId: "dispatch" });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("secret-audit-message");
    expect(value({ outcome: await h.repo.get({ context, connectionId: reference.connectionId }) })?.status).toBe("connected");
  });
});

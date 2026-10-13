import { describe, it, expect } from "vitest";
import type { CredentialRepoPort, SecretSealerPort, KeyringPort, OAuthClientPort, CredentialLockPort, CredentialAuditPort, CredentialBrokerPort, CredentialRefreshPort, CredentialObserverPort } from "../../index.js";
import type { CredentialRecord, CredentialReference } from "../../index.js";
import { context, hostContext, reference, configuration, request, storedSecret, value } from "../fixtures.js";

/** One behavioral repository contract for memory and SQL; no adapter-specific expectations. */
export function CredentialRepoPortSuite(required: { create: () => CredentialRepoPort }) {
  describe("CredentialRepoPort", () => {
    it("stores encrypted data and returns only scoped public summaries", async () => {
      const port = required.create();
      expect(value({ outcome: await port.get({ context, connectionId: "missing" }) })).toBeNull();
      const summary = value({ outcome: await port.store({ context, reference, secret: storedSecret, pluginId: "plugin" }) });
      expect(summary).toEqual({ connectionId: "connection", scope: context.scope, pluginId: "plugin", status: "connected" });
      expect(value({ outcome: await port.get({ context, connectionId: "connection" }) })).toEqual(summary);
      expect(value({ outcome: await port.getSecret({ context: hostContext, connectionId: "connection" }) })?.secret).toEqual(storedSecret);
      expect(await port.getSecret({ context, connectionId: "connection" })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    });
    it("rejects cross-scope reads/writes even when connection IDs are reused", async () => {
      const port = required.create();
      value({ outcome: await port.store({ context, reference, secret: storedSecret, pluginId: "plugin" }) });
      const other = { ...hostContext, scope: { ...context.scope, workspaceId: "other" } };
      expect(value({ outcome: await port.get({ context: other, connectionId: "connection" }) })).toBeNull();
      expect(value({ outcome: await port.getSecret({ context: other, connectionId: "connection" }) })).toBeNull();
      expect(await port.store({ context: other, reference, secret: storedSecret, pluginId: "plugin" })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    });
    it("CAS admits one racing refresh and never restores revoked authority", async () => {
      const port = required.create();
      value({ outcome: await port.store({ context, reference, secret: storedSecret, pluginId: "plugin" }) });
      const next = { context, reference: { ...reference, version: 2 }, secret: { ...storedSecret, version: 2 }, pluginId: "plugin" };
      const results = await Promise.all([port.store(next), port.store(next)]);
      expect(results.filter(result => result.ok)).toHaveLength(1);
      const receipt = value({ outcome: await port.revoke({ context, connectionId: "connection" }) });
      expect(value({ outcome: await port.revoke({ context, connectionId: "connection" }) })).toEqual(receipt);
      expect(value({ outcome: await port.get({ context, connectionId: "connection" }) })?.status).toBe("revoked");
      expect(value({ outcome: await port.getSecret({ context: hostContext, connectionId: "connection" }) })).toBeNull();
      expect(await port.store({ ...next, reference: { ...reference, version: 3 }, secret: { ...storedSecret, version: 3 } })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    });
    it("exposes typed reconnect status and rejects malformed boundary data", async () => {
      const port = required.create();
      value({ outcome: await port.store({ context, reference, secret: storedSecret, pluginId: "plugin" }) });
      expect(value({ outcome: await port.requireReconnect({ context, connectionId: "connection" }) }).status).toBe("reconnect_required");
      expect(value({ outcome: await port.getSecret({ context: hostContext, connectionId: "connection" }) })).toBeNull();
      expect(await port.get({ context, connectionId: "" })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    });
  });
}

/** Same binding/ciphertext suite for opaque vault double and AES-GCM. */
export function SecretSealerPortSuite(required: { create: () => SecretSealerPort }) {
  describe("SecretSealerPort", () => {
    it("round trips without plaintext in the sealed envelope", async () => {
      const port = required.create();
      const secret = value({ outcome: await port.seal({ reference, plaintext: "sensitive-access-token" }) });
      expect(JSON.stringify(secret)).not.toContain("sensitive-access-token");
      expect(value({ outcome: await port.open({ reference, secret }) })).toBe("sensitive-access-token");
    });
    it("rejects wrong owner/workspace/connection/version and changed digest or ciphertext", async () => {
      const port = required.create();
      const secret = value({ outcome: await port.seal({ reference, plaintext: "token" }) });
      const wrongReferences: CredentialReference[] = [
        { ...reference, scope: { ...reference.scope, ownerId: "wrong" } },
        { ...reference, scope: { ...reference.scope, workspaceId: "wrong" } },
        { ...reference, connectionId: "wrong" }, { ...reference, version: 2 },
      ];
      for (const wrong of wrongReferences) expect((await port.open({ reference: wrong, secret })).ok).toBe(false);
      expect((await port.open({ reference, secret: { ...secret, aadDigest: "f".repeat(64) } })).ok).toBe(false);
      expect((await port.open({ reference, secret: { ...secret, ciphertext: secret.ciphertext + "tampered" } })).ok).toBe(false);
    });
    it("rejects oversized plaintext and aborted requests", async () => {
      const port = required.create();
      expect(await port.seal({ reference, plaintext: "x".repeat(65537) })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
      expect(await port.seal({ reference, plaintext: "token" }, { signal: AbortSignal.abort() })).toMatchObject({ ok: false, error: { code: "cancelled" } });
    });
  });
}

/** Key loaders return defensive key copies and reject bad configuration/version. */
export function KeyringPortSuite(required: { create: () => KeyringPort }) {
  describe("KeyringPort", () => {
    it("resolves a stable 256-bit key without exposing mutable stored material", async () => {
      const port = required.create();
      const key = value({ outcome: await port.resolve({ configuration, version: 1 }) });
      const snapshot = key.slice();
      expect(key.length).toBe(32);
      key.fill(0);
      expect(value({ outcome: await port.resolve({ configuration, version: 1 }) })).toEqual(snapshot);
      expect((await port.resolve({ configuration: { ...configuration, hkdfSalt: "" }, version: 1 })).ok).toBe(false);
      expect((await port.resolve({ configuration, version: 0 })).ok).toBe(false);
    });
  });
}

/** Run against the memory OAuth client and host adapter with controlled Jini-shaped bindings. */
export function OAuthClientPortSuite(required: { create: () => OAuthClientPort }) {
  describe("OAuthClientPort", () => {
    it("requires S256 and validates one-shot state plus exact redirect", async () => {
      const port = required.create();
      const challenge = value({ outcome: await port.begin({ context, request }) });
      const url = new URL(challenge.authorizationUrl);
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const callback = { transactionId: challenge.transactionId, state: url.searchParams.get("state")!, code: "code", redirectUri: request.returnUri };
      expect((await port.complete({ callback })).ok).toBe(true);
      expect(await port.complete({ callback })).toMatchObject({ ok: false, error: { code: "expired" } });
    });
    it("rejects unregistered redirect and incorrect state before exchange", async () => {
      const port = required.create();
      expect((await port.begin({ context, request: { ...request, returnUri: "https://evil.example/callback" } })).ok).toBe(false);
      const challenge = value({ outcome: await port.begin({ context, request }) });
      expect(await port.complete({ callback: { transactionId: challenge.transactionId, state: "z".repeat(43), code: "code", redirectUri: request.returnUri } })).toMatchObject({ ok: false, error: { code: "forbidden" } });
      const second = value({ outcome: await port.begin({ context, request }) });
      expect((await port.complete({ callback: { transactionId: second.transactionId, state: new URL(second.authorizationUrl).searchParams.get("state")!, code: "code", redirectUri: "https://evil.example/callback" } })).ok).toBe(false);
    });
  });
}

/** FIFO locks serialize versions and expose cancellation without unlocking another holder. */
export function CredentialLockPortSuite(required: { create: () => CredentialLockPort }) {
  describe("CredentialLockPort", () => {
    it("serializes same connection across versions and frees it on release", async () => {
      const port = required.create();
      const first = value({ outcome: await port.acquire({ reference }) });
      let resolved = false;
      const second = port.acquire({ reference: { ...reference, version: 2 } }).then(result => { resolved = true; return result; });
      await Promise.resolve();
      expect(resolved).toBe(false);
      value({ outcome: await port.release(first) });
      const next = value({ outcome: await second });
      expect(next.lockId).not.toBe(first.lockId);
      value({ outcome: await port.release(next) });
      expect((await port.release(first)).ok).toBe(false);
    });
    it("cancels a queued waiter without releasing the holder", async () => {
      const port = required.create();
      const first = value({ outcome: await port.acquire({ reference }) });
      const abort = new AbortController();
      const waiting = port.acquire({ reference }, { signal: abort.signal });
      abort.abort();
      expect(await waiting).toMatchObject({ ok: false, error: { code: "cancelled" } });
      value({ outcome: await port.release(first) });
      const next = value({ outcome: await port.acquire({ reference }) });
      value({ outcome: await port.release(next) });
    });
  });
}

/** Shared metadata append contract; storage adapter remains replaceable. */
export function CredentialAuditPortSuite(required: { create: () => CredentialAuditPort }) {
  describe("CredentialAuditPort", () => {
    it("accepts correlated fixed metadata and rejects unknown secret-bearing operations", async () => {
      const port = required.create();
      expect((await port.record({ context, operation: "credentials.use", connectionId: "connection" })).ok).toBe(true);
      expect((await port.record({ context, operation: "sensitive-access-token", connectionId: "connection" })).ok).toBe(false);
      expect((await port.record({ context, operation: "credentials.use", connectionId: "" })).ok).toBe(false);
    });
  });
}

export interface BrokerHarness { port: CredentialBrokerPort; repo: CredentialRepoPort; reference: CredentialReference }
/** One broker behavioral suite used with both memory and persistent repository composition. */
export function CredentialBrokerPortSuite(required: { create: () => Promise<BrokerHarness> }) {
  describe("CredentialBrokerPort", () => {
    it("returns sealed data only to a scoped host capability and denies stale version", async () => {
      const harness = await required.create();
      expect((await harness.port.use({ context: hostContext, reference: harness.reference, operationId: "dispatch" })).ok).toBe(true);
      expect((await harness.port.use({ context: { ...hostContext, principal: { kind: "agent", agentInstanceId: "agent", runId: "run" } }, reference: harness.reference, operationId: "dispatch" })).ok).toBe(false);
      expect((await harness.port.use({ context: hostContext, reference: { ...harness.reference, version: 9 }, operationId: "dispatch" })).ok).toBe(false);
      expect((await harness.port.use({ context: { ...hostContext, scope: { ...context.scope, ownerId: "other" } }, reference: harness.reference, operationId: "dispatch" })).ok).toBe(false);
    });
    it("denies revocation between confirmation and dispatch", async () => {
      const harness = await required.create();
      const confirmed = harness.reference;
      value({ outcome: await harness.repo.revoke({ context, connectionId: confirmed.connectionId }) });
      expect((await harness.port.use({ context: hostContext, reference: confirmed, operationId: "confirmed-dispatch" })).ok).toBe(false);
    });
  });
}

/** Refresh adapter contract; a fresh token is represented by null, never fake success data. */
export function CredentialRefreshPortSuite(required: { create: () => Promise<{ port: CredentialRefreshPort; record: CredentialRecord }> }) {
  describe("CredentialRefreshPort", () => {
    it("leaves a fresh version alone and respects cancellation", async () => {
      const { port, record } = await required.create();
      expect(value({ outcome: await port.refresh({ context: hostContext, record }) })).toBeNull();
      expect((await port.refresh({ context: hostContext, record }, { signal: AbortSignal.abort() })).ok).toBe(false);
    });
  });
}

/** Observer doubles capture trace metadata without producing effects. */
export function CredentialObserverPortSuite(required: { create: () => CredentialObserverPort }) {
  describe("CredentialObserverPort", () => {
    it("accepts the host event ABI", () => {
      expect(() => required.create().observe({ operation: "credentials.beginConnect", outcome: "succeeded", correlationId: "c", traceId: "t" })).not.toThrow();
    });
  });
}

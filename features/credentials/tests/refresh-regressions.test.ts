import { describe, expect, it } from "vitest";
import { createAesGcmSecretSealer, createCredentialBroker, createMemoryCredentialAudit, createMemoryCredentialLock, createMemoryCredentialRepo, createMemorySecretSealer } from "../index.js";
import { configuration, context, hostContext, reference, value } from "./fixtures.js";

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

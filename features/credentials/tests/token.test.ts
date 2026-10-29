/** Written-only paste-token acceptance; shared cases exercise memory and native SQLite repositories. */
import { describe, expect, it } from "vitest";
import { connectCredentialToken, createAesGcmSecretSealer, createCredentialKeyring, createMemoryCredentialAudit,
  createMemoryCredentialLock, createMemoryCredentialRepo, createSqlCredentialRepo, listCredentialConnections, createCredentialBroker, readCredentialAccess, readCredentialOAuthClient, setCredentialPluginSecret, readCredentialPluginSecrets, credentialPluginSecretStatus } from "../index.js";
import type { CredentialRepoPort } from "../index.js";
import { clock, configuration, context, hostContext, value } from "./fixtures.js";
import { createSqlFixture } from "./sql-fixture.js";

/** Deterministic AES-GCM with unique fixture nonces, an injected key and owned repository lifetime. */
function fixture(required: { kind: "memory" | "sql" }) {
  const sql = required.kind === "sql" ? createSqlFixture({}) : undefined;
  const repo = sql ? createSqlCredentialRepo({ db: sql.db, clock }) : createMemoryCredentialRepo({ clock });
  const keyring = createCredentialKeyring({ loadMaster: async () => ({ ok: true, value: new Uint8Array(32).fill(7) }) });
  let nonce = 0;
  const sealer = createAesGcmSecretSealer({ keyring, configuration, randomBytes: ({ size }) => new Uint8Array(size).fill(++nonce) });
  const audit = createMemoryCredentialAudit({});
  const locks = createMemoryCredentialLock({});
  return { repo, sealer, audit, locks, sql, dispose() { sql?.dispose(); } };
}
const request = { context, connectionId: "token-connection", pluginId: "test-plugin", plaintext: "fixture-token-never-live" };

describe.each(["memory", "sql"] as const)("declared OAuth client configuration via %s", kind => {
  it("seals declared extras under the existing purpose, replaces/clears and returns secret-free DTOs", async () => {
    const f = fixture({ kind }); const broker = createCredentialBroker(f);
    const client = { clientId: "fixture-client", clientSecret: "sensitive-client-secret", configId: "fixture-config" };
    const write = { ...f, context, connectionId: "oauth-client.test-plugin", pluginId: "test-plugin", purpose: "oauth-client" as const, clientFields: ["configId"], plaintext: JSON.stringify(client) };
    const read = { ...f, broker, context: hostContext, pluginId: "test-plugin", clientFields: ["configId"] };
    try {
      const summary = value({ outcome: await connectCredentialToken(write) });
      const record = value({ outcome: await f.repo.getSecret({ context: hostContext, connectionId: write.connectionId }) })!;
      const opened = value({ outcome: await f.sealer.open({ reference: record.reference, secret: record.secret }) });
      expect(opened.startsWith("om.oauth.client.v1:")).toBe(true);
      expect(JSON.parse(opened.slice("om.oauth.client.v1:".length))).toEqual(client);
      expect(JSON.stringify([summary, record.secret, f.audit.entries({})])).not.toMatch(/fixture-config|sensitive-client-secret/);
      expect(await readCredentialOAuthClient(read)).toEqual({ ok: true, value: client });
      expect((await readCredentialOAuthClient({ ...read, context })).ok).toBe(false);
      expect(await readCredentialOAuthClient({ ...read, context: { ...hostContext, scope: { ...hostContext.scope, workspaceId: "other" } } })).toEqual({ ok: true, value: null });
      value({ outcome: await connectCredentialToken({ ...write, plaintext: JSON.stringify({ ...client, configId: "replacement" }) }) });
      expect(await readCredentialOAuthClient(read)).toEqual({ ok: true, value: { ...client, configId: "replacement" } });
      value({ outcome: await connectCredentialToken({ ...write, plaintext: JSON.stringify({ clientId: "client" }) }) });
      expect(await readCredentialOAuthClient(read)).toEqual({ ok: true, value: { clientId: "client" } });
      value({ outcome: await connectCredentialToken({ ...write, plaintext: "null" }) });
      expect(await readCredentialOAuthClient(read)).toEqual({ ok: true, value: null });
      if (f.sql) expect(value({ outcome: await listCredentialConnections({ db: f.sql.db, context, query: { limit: 10 } }) }).items).toEqual([]);
    } finally { f.dispose(); }
  });
  it("drops undeclared fields on write and on read, including old stored extra keys", async () => {
    const f = fixture({ kind }); const broker = createCredentialBroker(f);
    const client = { clientId: "client", configId: "fixture-extra", ignored: 42 };
    const write = { ...f, context, connectionId: "oauth-client.test-plugin", pluginId: "test-plugin", purpose: "oauth-client" as const, plaintext: JSON.stringify(client) };
    const read = { ...f, broker, context: hostContext, pluginId: "test-plugin" };
    try {
      value({ outcome: await connectCredentialToken(write) });
      const record = value({ outcome: await f.repo.getSecret({ context: hostContext, connectionId: write.connectionId }) })!;
      expect(value({ outcome: await f.sealer.open({ reference: record.reference, secret: record.secret }) })).toBe('om.oauth.client.v1:{"clientId":"client"}');
      expect(await readCredentialOAuthClient({ ...read, clientFields: ["configId"] })).toEqual({ ok: true, value: { clientId: "client" } });
      const reference = { ...record.reference, version: record.reference.version + 1 };
      const secret = value({ outcome: await f.sealer.seal({ reference, plaintext: "om.oauth.client.v1:" + JSON.stringify(client) }) });
      value({ outcome: await f.repo.store({ context, reference, secret, pluginId: write.pluginId }) });
      expect(await readCredentialOAuthClient(read)).toEqual({ ok: true, value: { clientId: "client" } });
      expect(await readCredentialOAuthClient({ ...read, clientFields: ["configId"] })).toEqual({ ok: true, value: { clientId: "client", configId: "fixture-extra" } });
    } finally { f.dispose(); }
  });
  it("bounds declared fields and retained values, refusing base-field collisions", async () => {
    const f = fixture({ kind }); const broker = createCredentialBroker(f);
    const write = { ...f, context, connectionId: "oauth-client.test-plugin", pluginId: "test-plugin", purpose: "oauth-client" as const, clientFields: ["extra"], plaintext: '{"clientId":"client"}' };
    try {
      for (const extra of ["", "x".repeat(2049), 1234]) {
        expect(await connectCredentialToken({ ...write, plaintext: JSON.stringify({ clientId: "client", extra }) })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
      }
      for (const clientFields of [["clientId"], ["clientSecret"], Array(33).fill("extra")]) {
        expect(await connectCredentialToken({ ...write, clientFields })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
        expect(await readCredentialOAuthClient({ ...f, broker, context: hostContext, pluginId: "test-plugin", clientFields })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
      }
      expect(f.audit.entries({})).toEqual([]);
      value({ outcome: await connectCredentialToken({ ...write, plaintext: JSON.stringify({ clientId: "client", extra: "x".repeat(2048), clientSecret: "s".repeat(8192) }) }) });
      const clientFields = Array.from({ length: 32 }, (_, index) => "field" + index);
      const client = { clientId: "client", ...Object.fromEntries(clientFields.map(field => [field, "é".repeat(2048)])) };
      expect(await connectCredentialToken({ ...write, clientFields, plaintext: JSON.stringify(client) })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    } finally { f.dispose(); }
  });
});

describe.each(["memory", "sql"] as const)("paste-token via %s", kind => {
  it("reserves every purpose ID and secret payload tag against ordinary paste", async () => {
    const f = fixture({ kind });
    try {
      for (const prefix of ["oauth-client", "developer-token", "plugin-secret"]) {
        expect(await connectCredentialToken({ ...f, ...request, connectionId: prefix + ".test-plugin" })).toMatchObject({ ok: false, error: { code: "forbidden" } });
      }
      for (const plaintext of ["om.oauth.client.v1:null", "om.developer-token.v1:null", "om.plugin-secret.v1:null", "om.plugin-secret.v2:null"]) {
        expect(await connectCredentialToken({ ...f, ...request, plaintext })).toMatchObject({ ok: false, error: { code: "forbidden" } });
        expect(readCredentialAccess({ plaintext }).ok).toBe(false);
      }
      expect(f.audit.entries({})).toEqual([]);
    } finally { f.dispose(); }
  });

  it("seals at rest, binds AAD and returns no plaintext or ciphertext", async () => {
    const f = fixture({ kind });
    try {
      const summary = value({ outcome: await connectCredentialToken({ ...f, ...request }) });
      expect(summary).toEqual({ connectionId: request.connectionId, pluginId: request.pluginId, scope: context.scope, status: "connected" });
      const record = value({ outcome: await f.repo.getSecret({ context: hostContext, connectionId: request.connectionId }) });
      expect(record).not.toBeNull();
      if (!record) throw new Error("Missing saved connection");
      expect(record.secret.ciphertext).toMatch(/^gcm1\./);
      expect(record.secret.ciphertext).not.toContain(request.plaintext);
      expect(await f.sealer.open({ reference: record.reference, secret: record.secret })).toEqual({ ok: true, value: request.plaintext });
      expect(await f.sealer.open({ reference: { ...record.reference, scope: { ...context.scope, workspaceId: "other" } }, secret: record.secret })).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(JSON.stringify({ summary, audit: f.audit.entries({}) })).not.toContain(request.plaintext);
      expect(JSON.stringify(summary)).not.toContain(record.secret.ciphertext);
      if (f.sql) expect(JSON.stringify(f.sql.database.prepare("SELECT * FROM om_credential_connection").all())).not.toContain(request.plaintext);
    } finally { f.dispose(); }
  });

  it("rejects mismatched owners and agent/service writes before storing", async () => {
    const f = fixture({ kind });
    try {
      const contexts = [hostContext, { ...context, principal: { kind: "owner" as const, ownerId: "other-owner" } },
        { ...context, principal: { kind: "agent" as const, agentInstanceId: "agent", runId: "run" } }];
      for (const deniedContext of contexts) {
        expect(await connectCredentialToken({ ...f, ...request, context: deniedContext })).toMatchObject({ ok: false, error: { code: "forbidden" } });
      }
      expect(await f.repo.get({ context, connectionId: request.connectionId })).toEqual({ ok: true, value: null });
      expect(f.audit.entries({})).toEqual([]);
    } finally { f.dispose(); }
  });

  it("serializes duplicate saves and never restores a revoked ID", async () => {
    const f = fixture({ kind });
    try {
      const results = await Promise.all([connectCredentialToken({ ...f, ...request }), connectCredentialToken({ ...f, ...request, plaintext: "second-fixture-token" })]);
      expect(results.filter(result => result.ok)).toHaveLength(1);
      expect(results.filter(result => !result.ok)).toEqual([expect.objectContaining({ error: expect.objectContaining({ code: "conflict" }) })]);
      value({ outcome: await f.repo.revoke({ context, connectionId: request.connectionId }) });
      expect(await connectCredentialToken({ ...f, ...request })).toMatchObject({ ok: false, error: { code: "conflict" } });
      expect(await f.repo.get({ context, connectionId: request.connectionId })).toMatchObject({ ok: true, value: { status: "revoked" } });
      expect(await connectCredentialToken({ ...f, ...request, connectionId: "reconnected" })).toMatchObject({ ok: true, value: { status: "connected" } });
    } finally { f.dispose(); }
  });

  it("enforces UTF-8 byte bounds and cancellation", async () => {
    const f = fixture({ kind });
    try {
      expect(await connectCredentialToken({ ...f, ...request, plaintext: "a".repeat(65536) })).toMatchObject({ ok: true });
      expect(await connectCredentialToken({ ...f, ...request, connectionId: "oversized", plaintext: "é".repeat(32769) })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
      expect(await connectCredentialToken({ ...f, ...request, connectionId: "empty", plaintext: "" })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
      expect(await connectCredentialToken({ ...f, ...request, connectionId: "cancelled" }, { signal: AbortSignal.abort() })).toMatchObject({ ok: false, error: { code: "cancelled" } });
    } finally { f.dispose(); }
  });

  it("audit failure prevents storage and foreign errors are redacted", async () => {
    const f = fixture({ kind });
    try {
      const audit = { async record() { return { ok: false as const, error: { code: "unavailable" as const, message: request.plaintext, retryable: false } }; } };
      const denied = await connectCredentialToken({ ...f, ...request, audit });
      expect(denied).toMatchObject({ ok: false, error: { code: "unavailable" } });
      expect(JSON.stringify(denied)).not.toContain(request.plaintext);
      expect(await f.repo.get({ context, connectionId: request.connectionId })).toEqual({ ok: true, value: null });
    } finally { f.dispose(); }
  });
});

it("rejects extra secret fields in a replacement repository summary", async () => {
  const f = fixture({ kind: "memory" });
  const repo: CredentialRepoPort = { ...f.repo, async store(input, options) {
    const stored = await f.repo.store(input, options);
    if (!stored.ok) return stored;
    return { ok: true, value: { ...stored.value, plaintext: request.plaintext } };
  } };
  expect(await connectCredentialToken({ ...f, ...request, repo })).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
});

it("lists a stable bounded SQLite page with scope and optional plugin/status filtering", async () => {
  const f = fixture({ kind: "sql" });
  if (!f.sql) throw new Error("Missing SQL fixture");
  try {
    for (const connectionId of ["c", "a", "b"]) value({ outcome: await connectCredentialToken({ ...f, ...request, connectionId }) });
    const other = { ...context, scope: { ...context.scope, workspaceId: "other" } };
    value({ outcome: await connectCredentialToken({ ...f, ...request, context: other, connectionId: "foreign" }) });
    value({ outcome: await f.repo.revoke({ context, connectionId: "b" }) });
    const first = value({ outcome: await listCredentialConnections({ db: f.sql.db, context, query: { limit: 2 } }) });
    expect(first.items.map(item => item.connectionId)).toEqual(["a", "b"]);
    expect(first.cursor).toBe("b");
    const second = value({ outcome: await listCredentialConnections({ db: f.sql.db, context, query: { limit: 2, cursor: "b" } }) });
    expect(second.items.map(item => item.connectionId)).toEqual(["c"]);
    expect(second.cursor).toBeNull();
    const saved = value({ outcome: await listCredentialConnections({ db: f.sql.db, context: hostContext, query: { limit: 100, pluginId: request.pluginId, status: "connected" } }) });
    expect(saved.items.map(item => item.connectionId)).toEqual(["a", "c"]);
    expect(JSON.stringify(first)).not.toMatch(/ciphertext|aadDigest|fixture-token/);
    expect(await listCredentialConnections({ db: f.sql.db, context, query: { limit: 101 } })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(await listCredentialConnections({ db: f.sql.db, context: { ...context, principal: { kind: "agent", agentInstanceId: "agent", runId: "run" } }, query: { limit: 1 } })).toMatchObject({ ok: false, error: { code: "forbidden" } });
  } finally { f.dispose(); }
});

it("fails the whole list on malformed or foreign-scope storage rows", async () => {
  const rows = [
    { owner_id: context.scope.ownerId, workspace_id: context.scope.workspaceId, connection_id: "a", plugin_id: "plugin", status: "connected" },
    { owner_id: "foreign-owner", workspace_id: context.scope.workspaceId, connection_id: "b", plugin_id: "plugin", status: "connected" },
  ];
  const db = { async query<Row extends Record<string, unknown>>() { return { rows: rows as unknown as Row[], rowCount: rows.length }; } };
  expect(await listCredentialConnections({ db, context, query: { limit: 2 } })).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
  rows[1].status = "unexpected";
  expect(await listCredentialConnections({ db, context, query: { limit: 2 } })).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
});

describe.each(["memory", "sql"] as const)("plugin-secret purpose via %s", kind => {
  it("denies populated secrets after revocation without decrypting or restoring them", async () => {
    const f = fixture({ kind }); const broker = createCredentialBroker(f);
    const write = { ...f, context, request: { pluginId: "test-plugin", values: { apiKey: "fixture-secret" } } };
    const read = { ...f, broker, context: hostContext, pluginId: "test-plugin", secretFields: ["apiKey"] };
    try {
      value({ outcome: await setCredentialPluginSecret(write) });
      expect(await readCredentialPluginSecrets(read)).toEqual({ ok: true, value: write.request.values });
      const connectionId = "plugin-secret.test-plugin";
      const reference = value({ outcome: await f.repo.getSecret({ context: hostContext, connectionId }) })!.reference;
      value({ outcome: await f.repo.revoke({ context, connectionId }) });
      f.sealer.open = async () => { throw new Error("Revoked credentials must never be decrypted"); };
      expect(await readCredentialPluginSecrets(read)).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect((await credentialPluginSecretStatus(read)).ok).toBe(false);
      expect(await f.repo.getSecret({ context: hostContext, connectionId })).toEqual({ ok: true, value: null });
      expect((await broker.use({ context: hostContext, reference, operationId: "after-revoke" })).ok).toBe(false);
      expect((await setCredentialPluginSecret(write)).ok).toBe(false);
    } finally { f.dispose(); }
  });
  it("seals, replaces, clears and sets again, skips refresh and excludes ordinary listing/access", async () => {
    const f = fixture({ kind }); let refreshes = 0;
    try {
      const broker = createCredentialBroker({ ...f, refresh: { async refresh() { refreshes++; return { ok: true, value: null }; } } });
      const write = { ...f, context, request: { pluginId: "test-plugin", values: { apiKey: "fixture-first", extraKey: "fixture-second" } } };
      const read = { ...f, broker, context: hostContext, pluginId: "test-plugin", secretFields: ["apiKey", "missing", "toString"] };
      expect(await readCredentialPluginSecrets(read)).toEqual({ ok: true, value: null });
      expect(await credentialPluginSecretStatus(read)).toEqual({ ok: true, value: { configured: false } });
      const status = value({ outcome: await setCredentialPluginSecret(write) });
      expect(status).toEqual({ configured: true });
      const record = value({ outcome: await f.repo.getSecret({ context: hostContext, connectionId: "plugin-secret.test-plugin" }) })!;
      expect(record.secret.ciphertext).not.toContain("fixture-first");
      // Follow the host's current broker -> decrypt -> access decoder chain.
      const used = value({ outcome: await broker.use({ context: hostContext, reference: record.reference, operationId: "ordinary-access" }) });
      const opened = value({ outcome: await f.sealer.open({ reference: record.reference, secret: used }) });
      expect(readCredentialAccess({ plaintext: opened })).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
      expect(await readCredentialPluginSecrets(read)).toEqual({ ok: true, value: { apiKey: "fixture-first" } });
      expect(await readCredentialPluginSecrets({ ...read, pluginId: "other-plugin" })).toEqual({ ok: true, value: null });
      expect(await credentialPluginSecretStatus(read)).toEqual({ ok: true, value: { configured: true } });
      value({ outcome: await setCredentialPluginSecret({ ...write, request: { pluginId: "test-plugin", values: { apiKey: "replacement" } } }) });
      expect(await readCredentialPluginSecrets({ ...read, secretFields: ["apiKey", "extraKey"] })).toEqual({ ok: true, value: { apiKey: "replacement" } });
      const replacement = value({ outcome: await f.repo.getSecret({ context: hostContext, connectionId: record.reference.connectionId }) })!;
      expect(replacement.reference.version).toBe(record.reference.version + 1);
      value({ outcome: await setCredentialPluginSecret({ ...write, request: { pluginId: "test-plugin", values: null } }) });
      expect(await readCredentialPluginSecrets(read)).toEqual({ ok: true, value: null });
      expect(await credentialPluginSecretStatus(read)).toEqual({ ok: true, value: { configured: false } });
      value({ outcome: await setCredentialPluginSecret(write) });
      expect(await readCredentialPluginSecrets(read)).toEqual({ ok: true, value: { apiKey: "fixture-first" } });
      expect(refreshes).toBe(0);
      expect(JSON.stringify([status, f.audit.entries({})])).not.toMatch(/fixture-first|fixture-second|replacement/);
      if (f.sql) expect(value({ outcome: await listCredentialConnections({ db: f.sql.db, context, query: { limit: 10 } }) }).items).toEqual([]);
    } finally { f.dispose(); }
  });
  it("denies non-owner writes, non-service reads, foreign records and scopes", async () => {
    const f = fixture({ kind }); const broker = createCredentialBroker(f);
    const write = { ...f, context, request: { pluginId: "test-plugin", values: { apiKey: "bad\r\nheader" } } };
    const read = { ...f, broker, context: hostContext, pluginId: "test-plugin", secretFields: ["apiKey"] };
    try {
      for (const deniedContext of [hostContext, { ...context, principal: { kind: "owner" as const, ownerId: "other-owner" } }]) {
        expect(await setCredentialPluginSecret({ ...write, context: deniedContext })).toMatchObject({ ok: false, error: { code: "forbidden" } });
      }
      expect(f.audit.entries({})).toEqual([]);
      // Value formats belong to the declaring plugin; storage accepts the contract's strings.
      value({ outcome: await setCredentialPluginSecret(write) });
      expect(await readCredentialPluginSecrets(read)).toEqual({ ok: true, value: write.request.values });
      expect(await readCredentialPluginSecrets({ ...read, context })).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(await readCredentialPluginSecrets({ ...read, secretFields: Array(33).fill("apiKey") })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
      expect(await readCredentialPluginSecrets({ ...read, context: { ...hostContext, scope: { ...context.scope, workspaceId: "other" } } })).toEqual({ ok: true, value: null });
      const repo: CredentialRepoPort = { ...f.repo, async getSecret(input, options) {
        const loaded = await f.repo.getSecret(input, options);
        return loaded.ok && loaded.value ? { ok: true, value: { ...loaded.value, summary: { ...loaded.value.summary, pluginId: "other-plugin" } } } : loaded;
      } };
      expect(await readCredentialPluginSecrets({ ...read, repo })).toMatchObject({ ok: false, error: { code: "forbidden" } });
      const oversized = Object.fromEntries(Array.from({ length: 9 }, (_, index) => ["field" + index, "é".repeat(8192)]));
      expect(await setCredentialPluginSecret({ ...write, request: { pluginId: "oversized", values: oversized } })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    } finally { f.dispose(); }
  });
  it("rejects the removed purpose and keeps historical developer-token rows reserved", async () => {
    const f = fixture({ kind }); const broker = createCredentialBroker(f);
    const legacy = { ...f, context, connectionId: "developer-token.test-plugin", pluginId: "test-plugin", purpose: "developer-token" as never, plaintext: JSON.stringify("legacy-fixture-secret") };
    const read = { ...f, broker, context: hostContext, pluginId: "test-plugin", secretFields: ["apiKey"] };
    try {
      const rejected = await connectCredentialToken(legacy);
      expect(rejected).toMatchObject({ ok: false, error: { code: "invalid_input" } });
      expect(JSON.stringify(rejected)).not.toContain("legacy-fixture-secret");
      expect(await f.repo.get({ context, connectionId: legacy.connectionId })).toEqual({ ok: true, value: null });
      expect(f.audit.entries({})).toEqual([]);
      // Historical rows never supply the generic plugin-secret reader or public connection list.
      const reference = { scope: context.scope, connectionId: legacy.connectionId, version: 1 };
      const secret = value({ outcome: await f.sealer.seal({ reference, plaintext: 'om.developer-token.v1:"old-fixture"' }) });
      value({ outcome: await f.repo.store({ context, reference, secret, pluginId: legacy.pluginId }) });
      expect(await readCredentialPluginSecrets(read)).toEqual({ ok: true, value: null });
      if (f.sql) expect(value({ outcome: await listCredentialConnections({ db: f.sql.db, context, query: { limit: 10 } }) }).items).toEqual([]);
    } finally { f.dispose(); }
  });
  it.each(["throw", "return"] as const)("never echoes secret-bearing dependency failures (%s) or malformed JSON", async mode => {
    const f = fixture({ kind }); const broker = createCredentialBroker(f);
    const sentinel = "sentinel-plugin-secret-value";
    const write = { ...f, context, request: { pluginId: "test-plugin", values: { apiKey: sentinel } } };
    const read = { ...f, broker, context: hostContext, pluginId: "test-plugin" };
    async function fail() {
      if (mode === "throw") throw new Error(sentinel);
      return { ok: false as const, error: { code: "unavailable" as const, message: sentinel, retryable: false } };
    }
    try {
      const outcome = await setCredentialPluginSecret({ ...write, sealer: { ...f.sealer, seal: fail } });
      expect(outcome).toMatchObject({ ok: false, error: { code: "unavailable" } });
      const saved = await setCredentialPluginSecret(write);
      expect(saved).toEqual({ ok: true, value: { configured: true } });
      const status = await credentialPluginSecretStatus({ ...read, sealer: { ...f.sealer, open: fail } });
      expect(status).toMatchObject({ ok: false, error: { code: "unavailable" } });
      const configured = await credentialPluginSecretStatus(read);
      expect(configured).toEqual({ ok: true, value: { configured: true } });
      const malformed = await credentialPluginSecretStatus({ ...read, sealer: { ...f.sealer, async open() { return { ok: true, value: "om.plugin-secret.v1:" + sentinel + "{" }; } } });
      expect(malformed).toMatchObject({ ok: false, error: { code: "unavailable" } });
      expect(JSON.stringify([outcome, status, configured, saved, malformed, f.audit.entries({})])).not.toContain(sentinel);
    } finally { f.dispose(); }
  });

});

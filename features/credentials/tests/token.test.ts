/** Written-only paste-token acceptance; shared cases exercise memory and native SQLite repositories. */
import { describe, expect, it } from "vitest";
import { connectCredentialToken, createAesGcmSecretSealer, createCredentialKeyring, createMemoryCredentialAudit,
  createMemoryCredentialLock, createMemoryCredentialRepo, createSqlCredentialRepo, listCredentialConnections, createCredentialBroker, readCredentialDeveloperToken, readCredentialAccess } from "../index.js";
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

describe.each(["memory", "sql"] as const)("paste-token via %s", kind => {
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

describe.each(["memory", "sql"] as const)("Google developer-token purpose via %s", kind => {
  it("seals, replaces and clears independently, skips OAuth refresh and excludes ordinary listing/access", async () => {
    const f = fixture({ kind }); let refreshes = 0;
    try {
      const broker = createCredentialBroker({ ...f, refresh: { async refresh() { refreshes++; return { ok: true, value: null }; } } });
      const write = { ...f, context, connectionId: "developer-token.google-ads", pluginId: "google-ads", purpose: "developer-token" as const, plaintext: JSON.stringify("abcdefghijklmnopqrstuv") };
      const read = { ...f, broker, context: hostContext, pluginId: "google-ads" };
      expect(await readCredentialDeveloperToken(read)).toEqual({ ok: true, value: null });
      const summary = value({ outcome: await connectCredentialToken(write) }); expect(JSON.stringify(summary)).not.toContain("abcdefghijklmnopqrstuv");
      const record = value({ outcome: await f.repo.getSecret({ context: hostContext, connectionId: write.connectionId }) }); if (!record) throw new Error("Missing sealed config");
      expect(record.secret.ciphertext).not.toContain("abcdefghijklmnopqrstuv");
      const opened = value({ outcome: await f.sealer.open({ reference: record.reference, secret: record.secret }) }); expect(readCredentialAccess({ plaintext: opened }).ok).toBe(false);
      expect(await readCredentialDeveloperToken(read)).toEqual({ ok: true, value: "abcdefghijklmnopqrstuv" });
      value({ outcome: await connectCredentialToken({ ...write, plaintext: JSON.stringify("1234567890123456789012") }) });
      expect(await readCredentialDeveloperToken(read)).toEqual({ ok: true, value: "1234567890123456789012" });
      value({ outcome: await connectCredentialToken({ ...write, plaintext: "null" }) }); expect(await readCredentialDeveloperToken(read)).toEqual({ ok: true, value: null });
      expect(refreshes).toBe(0); expect(JSON.stringify(f.audit.entries({}))).not.toMatch(/abcdefghijklmnopqrstuv|1234567890123456789012/);
      if (f.sql) expect(value({ outcome: await listCredentialConnections({ db: f.sql.db, context, query: { limit: 10 } }) }).items).toEqual([]);
      value({ outcome: await f.repo.revoke({ context, connectionId: write.connectionId }) });
      expect((await readCredentialDeveloperToken(read)).ok).toBe(false); expect((await connectCredentialToken(write)).ok).toBe(false);
    } finally { f.dispose(); }
  });
  it("reserves purpose ID/prefix, denies foreign plugins/owners/scopes and ordinary decoding", async () => {
    const f = fixture({ kind }); const broker = createCredentialBroker(f);
    try {
      const write = { ...f, context, connectionId: "developer-token.google-ads", pluginId: "google-ads", purpose: "developer-token" as const, plaintext: JSON.stringify("abcdefghijklmnopqrstuv") };
      expect((await connectCredentialToken({ ...write, purpose: undefined })).ok).toBe(false);
      expect((await connectCredentialToken({ ...write, pluginId: "meta-ads" })).ok).toBe(false);
      expect((await connectCredentialToken({ ...write, plaintext: JSON.stringify("bad\r\nheader") })).ok).toBe(false);
      expect((await connectCredentialToken({ ...write, context: hostContext })).ok).toBe(false);
      value({ outcome: await connectCredentialToken(write) });
      expect((await readCredentialDeveloperToken({ ...f, broker, context: hostContext, pluginId: "meta-ads" })).ok).toBe(false);
      expect((await readCredentialDeveloperToken({ ...f, broker, context, pluginId: "google-ads" })).ok).toBe(false);
      expect(await readCredentialDeveloperToken({ ...f, broker, context: { ...hostContext, scope: { ...context.scope, workspaceId: "other" } }, pluginId: "google-ads" })).toEqual({ ok: true, value: null });
      expect((await connectCredentialToken({ ...f, ...request, plaintext: "om.developer-token.v1:null" })).ok).toBe(false);
      expect(readCredentialAccess({ plaintext: "om.developer-token.v2:null" }).ok).toBe(false);
    } finally { f.dispose(); }
  });
});

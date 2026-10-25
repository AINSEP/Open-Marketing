import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqlAuditRepo, createMemoryAuditObserver } from "../index.js";
import { dependencies, context, entry, value } from "./fixtures.js";
import { sqliteHarness, memorySqlHarness } from "./sqlite-fixture.js";

/** Restart proof uses a disposable file and closes the original connection, not a shared JS store. */
describe("durable SQL audit", () => {
  it("intent receipt and correction lineage survive a complete database reopen", async () => {
    const directory = mkdtempSync(join(tmpdir(), "om-audit-"));
    const filename = join(directory, "audit.sqlite");
    const first = sqliteHarness({ filename });
    let second: ReturnType<typeof sqliteHarness> | undefined;
    try {
      const repo = createSqlAuditRepo({ ...dependencies(), db: first.db, observer: createMemoryAuditObserver({}) });
      const receipt = value({ outcome: await repo.append({ context: context(), entry: entry() }) });
      first.native.close();
      second = sqliteHarness({ filename, migrate: false });
      const reopened = createSqlAuditRepo({ clock: { now() { return 2000; } }, ids: { next() { return "after-restart"; } }, db: second.db, observer: createMemoryAuditObserver({}) });
      expect(value({ outcome: await reopened.list({ context: context(), query: { limit: 10 } }) }).items).toEqual([entry()]);
      expect(second.native.prepare("SELECT entry_id, recorded_at FROM audit_entry WHERE entry_id = ?").get(receipt.entryId)).toEqual({ entry_id: receipt.entryId, recorded_at: receipt.recordedAt });
      const correction = entry({ kind: "correction", correctionOf: receipt.entryId, argumentsDigest: "b".repeat(64) });
      expect(value({ outcome: await reopened.append({ context: context(), entry: correction }) })).toEqual({ entryId: "after-restart", recordedAt: 2000 });
      expect(value({ outcome: await reopened.list({ context: context(), query: { limit: 10 } }) }).items).toEqual([entry(), correction]);
    } finally {
      if (first.native.open) first.native.close();
      second?.native.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("database guards reject direct UPDATE and DELETE, retaining original evidence", async () => {
    const fixture = sqliteHarness();
    try {
      const repo = createSqlAuditRepo({ ...dependencies(), db: fixture.db, observer: createMemoryAuditObserver({}) });
      value({ outcome: await repo.append({ context: context(), entry: entry() }) });
      expect(() => fixture.native.prepare("UPDATE audit_entry SET payload = '{}' WHERE entry_id = ?").run("audit-1")).toThrow("append-only");
      expect(() => fixture.native.prepare("DELETE FROM audit_entry WHERE entry_id = ?").run("audit-1")).toThrow("append-only");
      expect(value({ outcome: await repo.list({ context: context(), query: { limit: 10 } }) }).items).toEqual([entry()]);
    } finally { fixture.native.close(); }
  });

  it("links approval, dispatch and outcome to the same digest and caller-supplied evidence references", async () => {
    const fixture = sqliteHarness();
    try {
      const repo = createSqlAuditRepo({ ...dependencies(), db: fixture.db, observer: createMemoryAuditObserver({}) });
      const references = ["secured-evidence-1", "provider-result-1"];
      const approval = { response: { cardId: "card", operationId: "operation-1", argumentsDigest: "a".repeat(64), choice: "allow" as const },
        approver: { kind: "local_token" as const, ownerId: "owner-1", deviceId: "device", tokenId: "reference" } };
      const entries = [{ ...entry({ kind: "approval", references }), approval }, entry({ kind: "dispatch", references }), entry({ kind: "outcome", references })];
      for (const input of entries) value({ outcome: await repo.append({ context: context(), entry: input }) });
      expect(value({ outcome: await repo.list({ context: context(), query: { limit: 10, operationId: "operation-1" } }) }).items).toEqual(entries);
      const rows = fixture.native.prepare("SELECT context_json FROM audit_entry ORDER BY sequence").all() as { context_json: string }[];
      expect(rows.map(row => JSON.parse(row.context_json))).toEqual([context(), context(), context()]);
    } finally { fixture.native.close(); }
  });

  it("rejects colliding receipt IDs without replacing existing SQL rows", async () => {
    const fixture = sqliteHarness();
    try {
      const repo = createSqlAuditRepo({ clock: { now() { return 1234; } }, ids: { next() { return "duplicate"; } }, db: fixture.db, observer: createMemoryAuditObserver({}) });
      value({ outcome: await repo.append({ context: context(), entry: entry() }) });
      expect(await repo.append({ context: context(), entry: entry({ kind: "outcome" }) })).toMatchObject({ ok: false, error: { code: "conflict" } });
      expect(value({ outcome: await repo.list({ context: context(), query: { limit: 10 } }) }).items).toEqual([entry()]);
    } finally { fixture.native.close(); }
  });

  it("rolls back partial writes when the injected transaction body fails", async () => {
    const fixture = sqliteHarness();
    try {
      await expect(fixture.db.transaction({ context: context(), execute: async ({ session }) => {
        await session.query({
          text: "INSERT INTO audit_entry (entry_id, owner_id, workspace_id, sequence, operation_id, kind, arguments_digest, recorded_at, payload, context_json) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
          values: ["failed-write", "owner-1", "workspace-1", 1, "operation-1", "intent", "a".repeat(64), 1234, JSON.stringify(entry()), JSON.stringify(context())],
        });
        throw new Error("failure after insert");
      } })).rejects.toThrow("failure after insert");
      expect(fixture.native.prepare("SELECT COUNT(*) AS count FROM audit_entry").get()).toEqual({ count: 0 });
    } finally { fixture.native.close(); }
  });
});

function storedRow(required: { sequence?: number; context?: ReturnType<typeof context>; payload?: string } = {}) {
  const storedContext = required.context ?? context();
  return {
    entry_id: "audit-1", recorded_at: 1234, sequence: required.sequence ?? 1,
    owner_id: storedContext.scope.ownerId, workspace_id: storedContext.scope.workspaceId,
    operation_id: "operation-1", kind: "intent", arguments_digest: "a".repeat(64), correction_of: null,
    payload: required.payload ?? JSON.stringify(entry()), context_json: JSON.stringify(storedContext),
  };
}

describe("tainted SQL seam", () => {
  it("does not return a page cancelled during the final SQL read", async () => {
    const controller = new AbortController();
    const harness = memorySqlHarness({ respond() { controller.abort(); return { rows: [] }; } });
    const repo = createSqlAuditRepo({ ...dependencies(), db: harness.db, observer: createMemoryAuditObserver({}) });
    expect(await repo.list({ context: context(), query: { limit: 1 } }, { signal: controller.signal }))
      .toEqual({ ok: false, error: { code: "cancelled", message: "Audit cancelled", retryable: false } });
  });
  it("maps transaction failure and emits correlated status without leaking driver data", async () => {
    const observer = createMemoryAuditObserver({});
    const repo = createSqlAuditRepo({ ...dependencies(), observer, db: { async transaction() { throw new Error("person@example.com password=secret"); } } });
    const result = await repo.append({ context: context(), entry: entry() });
    expect(result).toEqual({ ok: false, error: { code: "unavailable", message: "Audit unavailable", retryable: false } });
    expect(observer.events({})).toEqual([{ operation: "audit.sql.append", outcome: "unavailable", correlationId: "correlation-1", traceId: "trace-1", runId: "run-1" }]);
  });
  it("does not retry an uncertain commit", async () => {
    let transactions = 0;
    const fixture = sqliteHarness();
    try {
      const repo = createSqlAuditRepo({ ...dependencies(), observer: createMemoryAuditObserver({}), db: { async transaction(input, optional) {
        transactions += 1;
        await fixture.db.transaction(input, optional);
        throw new Error("uncertain commit acknowledgement");
      } } });
      expect(await repo.append({ context: context(), entry: entry() })).toMatchObject({ ok: false, error: { code: "unavailable" } });
      expect(transactions).toBe(1);
      expect(fixture.native.prepare("SELECT COUNT(*) AS count FROM audit_entry").get()).toEqual({ count: 1 });
    } finally { fixture.native.close(); }
  });
  it("rejects malformed durable JSON instead of replacing history", async () => {
    const harness = memorySqlHarness({ respond() { return { rows: [storedRow({ payload: "{" })] }; } });
    const repo = createSqlAuditRepo({ ...dependencies(), db: harness.db, observer: createMemoryAuditObserver({}) });
    expect(await repo.list({ context: context(), query: { limit: 10 } })).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
    expect(harness.committed({})).toEqual([]);
  });
  it("rejects cross-scope persisted metadata and out-of-order results", async () => {
    const other = context({ scope: { ownerId: "owner-1", workspaceId: "other" } });
    const crossScope = memorySqlHarness({ respond() { return { rows: [storedRow({ context: other })] }; } });
    const repo = createSqlAuditRepo({ ...dependencies(), db: crossScope.db, observer: createMemoryAuditObserver({}) });
    expect(await repo.list({ context: context(), query: { limit: 10 } })).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
    const unordered = memorySqlHarness({ respond() { return { rows: [storedRow({ sequence: 2 }), storedRow({ sequence: 1 })] }; } });
    const unorderedRepo = createSqlAuditRepo({ ...dependencies(), db: unordered.db, observer: createMemoryAuditObserver({}) });
    expect(await unorderedRepo.list({ context: context(), query: { limit: 10 } })).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
  });
  it("rejects wrong INSERT evidence and rolls back the callback", async () => {
    const harness = memorySqlHarness({ respond({ text }) {
      if (text.startsWith("SELECT sequence")) return { rows: [] };
      return { rows: [{ entry_id: "not-the-allocated-id", recorded_at: 1234 }] };
    } });
    const repo = createSqlAuditRepo({ ...dependencies(), db: harness.db, observer: createMemoryAuditObserver({}) });
    expect(await repo.append({ context: context(), entry: entry() })).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
    expect(harness.committed({})).toEqual([]);
  });

  it.each([
    { mutation: { owner_id: "other-owner" } },
    { mutation: { workspace_id: "other-workspace" } },
    { mutation: { operation_id: "other-operation" } },
    { mutation: { kind: "outcome" } },
    { mutation: { arguments_digest: "b".repeat(64) } },
    { mutation: { correction_of: "other-receipt" } },
  ])("rejects indexed metadata that disagrees with JSON: $mutation", async ({ mutation }) => {
    const harness = memorySqlHarness({ respond() { return { rows: [{ ...storedRow(), ...mutation }] }; } });
    const repo = createSqlAuditRepo({ ...dependencies(), db: harness.db, observer: createMemoryAuditObserver({}) });
    expect(await repo.list({ context: context(), query: { limit: 1 } }))
      .toEqual({ ok: false, error: { code: "protocol_mismatch", message: "Audit protocol_mismatch", retryable: false } });
    expect(harness.committed({})).toEqual([]);
  });

  it("rejects repeated receipt IDs at different sequences instead of exporting duplicate evidence", async () => {
    const harness = memorySqlHarness({ respond() {
      return { rows: [storedRow({ sequence: 1 }), storedRow({ sequence: 2 })] };
    } });
    const repo = createSqlAuditRepo({ ...dependencies(), db: harness.db, observer: createMemoryAuditObserver({}) });
    expect(await repo.list({ context: context(), query: { limit: 2 } }))
      .toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
    expect(harness.committed({})).toEqual([]);
  });

  it("rejects malformed SQL row containers as protocol errors", async () => {
    const harness = memorySqlHarness({ respond() {
      const result = { rows: [] };
      Reflect.set(result, "rows", null);
      return result;
    } });
    const repo = createSqlAuditRepo({ ...dependencies(), db: harness.db, observer: createMemoryAuditObserver({}) });
    expect(await repo.list({ context: context(), query: { limit: 1 } }))
      .toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
    expect(harness.committed({})).toEqual([]);
  });

  it("detects inconsistent evidence actually persisted in a disposable SQLite database", async () => {
    const fixture = sqliteHarness();
    try {
      fixture.native.prepare("INSERT INTO audit_entry (entry_id, owner_id, workspace_id, sequence, operation_id, kind, arguments_digest, recorded_at, payload, context_json) VALUES (?,?,?,?,?,?,?,?,?,?)")
        .run("audit-1", "owner-1", "workspace-1", 1, "operation-1", "intent", "b".repeat(64), 1234, JSON.stringify(entry()), JSON.stringify(context()));
      const repo = createSqlAuditRepo({ ...dependencies(), db: fixture.db, observer: createMemoryAuditObserver({}) });
      expect(await repo.list({ context: context(), query: { limit: 1 } }))
        .toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
      expect(fixture.native.prepare("SELECT arguments_digest FROM audit_entry WHERE entry_id = ?").get("audit-1"))
        .toEqual({ arguments_digest: "b".repeat(64) });
    } finally { fixture.native.close(); }
  });
});

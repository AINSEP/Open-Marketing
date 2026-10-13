import { describe, it, expect, afterEach } from "vitest";
import type { AuditRepoPort, AuditRedactorPort, AuditObserverPort, AuditEntry, AuditSqlDatabase, AuditSqlSession } from "../../index.js";
import { context, entry, value } from "../fixtures.js";

type RepoFixture = { repo: AuditRepoPort; dispose(required: Record<string, never>): void };

/** B1 behavioral contract; identical suite for memory and the injected real SQL repository. */
export function AuditRepoPortSuite(required: { name: string; create(required: Record<string, never>): RepoFixture }): void {
  describe(`AuditRepoPort: ${required.name}`, () => {
    const fixtures: RepoFixture[] = [];
    function create(input: Record<string, never> = {}): AuditRepoPort {
      const fixture = required.create(input);
      fixtures.push(fixture);
      return fixture.repo;
    }
    afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.dispose({}); });

    it("appends distinct receipts and keeps earlier evidence unchanged", async () => {
      const repo = create();
      const intent = entry();
      const first = value({ outcome: await repo.append({ context: context(), entry: intent }) });
      const second = value({ outcome: await repo.append({ context: context(), entry: intent }) });
      expect(first).toEqual({ entryId: "audit-1", recordedAt: 1234 });
      expect(second).toEqual({ entryId: "audit-2", recordedAt: 1234 });
      expect(value({ outcome: await repo.list({ context: context(), query: { limit: 10 } }) })).toEqual({ items: [intent, intent], cursor: null });
    });

    it("isolates both owner and workspace, even for identical operation IDs", async () => {
      const repo = create();
      await repo.append({ context: context(), entry: entry() });
      const otherWorkspace = context({ scope: { ownerId: "owner-1", workspaceId: "other" } });
      const otherOwner = context({ scope: { ownerId: "other", workspaceId: "workspace-1" }, principal: { kind: "owner", ownerId: "other" } });
      expect(value({ outcome: await repo.list({ context: otherWorkspace, query: { limit: 10 } }) }).items).toEqual([]);
      expect(value({ outcome: await repo.list({ context: otherOwner, query: { limit: 10 } }) }).items).toEqual([]);
      await repo.append({ context: otherOwner, entry: entry({ kind: "outcome" }) });
      expect(value({ outcome: await repo.list({ context: context(), query: { limit: 10 } }) }).items).toEqual([entry()]);
    });

    it("snapshots caller input and returned pages", async () => {
      const repo = create();
      const input = { context: context(), entry: { ...entry(), references: ["evidence-1"] } };
      const append = repo.append(input);
      input.entry.references[0] = "mutated-after-call";
      value({ outcome: await append });
      const page = value({ outcome: await repo.list({ context: context(), query: { limit: 10 } }) });
      (page.items[0].references as string[])[0] = "mutated-after-read";
      expect(value({ outcome: await repo.list({ context: context(), query: { limit: 10 } }) }).items).toEqual([entry()]);
    });

    it("appends corrections without replacing intent and requires same-operation lineage", async () => {
      const repo = create();
      const receipt = value({ outcome: await repo.append({ context: context(), entry: entry() }) });
      const correction = entry({ kind: "correction", correctionOf: receipt.entryId, argumentsDigest: "b".repeat(64) });
      value({ outcome: await repo.append({ context: context(), entry: correction }) });
      expect(value({ outcome: await repo.list({ context: context(), query: { limit: 10 } }) }).items).toEqual([entry(), correction]);
      const wrongOperation = entry({ ...correction, operationId: "operation-2" });
      expect(await repo.append({ context: context(), entry: wrongOperation })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
      expect(value({ outcome: await repo.list({ context: context(), query: { limit: 10 } }) }).items).toHaveLength(2);
    });

    it("does not permit missing or cross-scope correction targets", async () => {
      const repo = create();
      const receipt = value({ outcome: await repo.append({ context: context(), entry: entry() }) });
      const other = context({ scope: { ownerId: "owner-1", workspaceId: "other" } });
      expect(await repo.append({ context: other, entry: entry({ kind: "correction", correctionOf: receipt.entryId }) })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
      expect(await repo.append({ context: context(), entry: entry({ kind: "correction", correctionOf: "missing" }) })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
      expect(value({ outcome: await repo.list({ context: other, query: { limit: 10 } }) }).items).toEqual([]);
    });

    it("bounds pages and cursors by scope and filter, with deterministic equal-time order", async () => {
      const repo = create();
      const inputs = [entry(), entry({ operationId: "other-operation" }), entry({ kind: "dispatch" }), entry({ kind: "outcome" })];
      for (const input of inputs) value({ outcome: await repo.append({ context: context(), entry: input }) });
      const first = value({ outcome: await repo.list({ context: context(), query: { limit: 2, operationId: "operation-1" } }) });
      expect(first).toEqual({ items: [inputs[0], inputs[2]], cursor: "audit-3" });
      const last = value({ outcome: await repo.list({ context: context(), query: { limit: 2, operationId: "operation-1", cursor: first.cursor! } }) });
      expect(last).toEqual({ items: [inputs[3]], cursor: null });
      expect(await repo.list({ context: context(), query: { limit: 2, operationId: "other-operation", cursor: first.cursor! } })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
      const otherScope = context({ scope: { ownerId: "owner-1", workspaceId: "other" } });
      expect(await repo.list({ context: otherScope, query: { limit: 2, cursor: first.cursor! } })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    });

    it("rejects invalid boundaries and aborted writes without changing history", async () => {
      const repo = create();
      const invalid = entry({ references: Array.from({ length: 65 }, () => "ref") });
      expect(await repo.append({ context: context(), entry: invalid })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
      expect(await repo.append({ context: context(), entry: { ...entry(), rawArguments: "secret" } as AuditEntry })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
      expect(await repo.append({ context: context(), entry: entry({ kind: "correction" }) })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
      expect(await repo.append({ context: context(), entry: entry() }, { signal: AbortSignal.abort() })).toMatchObject({ ok: false, error: { code: "cancelled" } });
      expect(value({ outcome: await repo.list({ context: context(), query: { limit: 10 } }) }).items).toEqual([]);
      expect(await repo.list({ context: context(), query: { limit: 101 } })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
      expect(await repo.list({ context: context(), query: { limit: 0 } })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
      expect(await repo.list({ context: context(), query: { limit: 10, cursor: "missing" } })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    });

    it("rejects an owner principal claiming someone else's scope", async () => {
      const repo = create();
      const forged = context({ scope: { ownerId: "other-owner", workspaceId: "workspace-1" } });
      expect(await repo.append({ context: forged, entry: entry() })).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(await repo.list({ context: forged, query: { limit: 10 } })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    });

    it("rejects JSON escaping expansion before it creates unreadable durable evidence", async () => {
      const repo = create();
      const expandingReferences = Array.from({ length: 64 }, () => "\u0000".repeat(256));
      expect(await repo.append({ context: context(), entry: entry({ references: expandingReferences }) })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
      expect(value({ outcome: await repo.list({ context: context(), query: { limit: 10 } }) }).items).toEqual([]);
    });

    it("concurrent appends cannot overwrite or lose evidence", async () => {
      const repo = create();
      const operations = Array.from({ length: 8 }, (_, index) => entry({ operationId: `operation-${index}` }));
      const results = await Promise.all(operations.map(input => repo.append({ context: context(), entry: input })));
      expect(results.every(result => result.ok)).toBe(true);
      expect(new Set(results.map(outcome => value({ outcome }).entryId)).size).toBe(8);
      expect(value({ outcome: await repo.list({ context: context(), query: { limit: 10 } }) }).items).toEqual(operations);
    });

    it("accepts the exact 100-entry export-page cap and continues without duplication", async () => {
      const repo = create();
      for (let index = 0; index < 101; index += 1) value({ outcome: await repo.append({ context: context(), entry: entry({ operationId: `export-${index}` }) }) });
      const first = value({ outcome: await repo.list({ context: context(), query: { limit: 100 } }) });
      expect(first.items).toHaveLength(100);
      expect(first.cursor).toBe("audit-100");
      const last = value({ outcome: await repo.list({ context: context(), query: { limit: 100, cursor: first.cursor! } }) });
      expect(last).toEqual({ items: [entry({ operationId: "export-100" })], cursor: null });
    });
  });
}

/** Shared output contract for the conservative double and injected Jini adapter. */
export function AuditRedactorPortSuite(required: { name: string; create(required: Record<string, never>): AuditRedactorPort }): void {
  describe(`AuditRedactorPort: ${required.name}`, () => {
    it("redacts operational references while preserving exact evidence identity", async () => {
      const port = required.create({});
      const input = entry({ kind: "correction", correctionOf: "audit-1", references: ["person@example.com", "sk-abcdefghijklmnopqrstuvwxyz0123456789"] });
      const redacted = value({ outcome: await port.redact({ context: context(), entry: input }) });
      expect(redacted).toMatchObject({ operationId: input.operationId, kind: input.kind, argumentsDigest: input.argumentsDigest, correctionOf: input.correctionOf });
      expect(JSON.stringify(redacted)).not.toContain("person@example.com");
      expect(JSON.stringify(redacted)).not.toContain("sk-abcdefghijklmnopqrstuvwxyz0123456789");
      expect(input.references[0]).toBe("person@example.com");
    });
    it("does not corrupt lineage to hide a sensitive identity", async () => {
      const result = await required.create({}).redact({ context: context(), entry: entry({ operationId: "person@example.com" }) });
      expect(result).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(JSON.stringify(result)).not.toContain("person@example.com");
    });
    it("fails explicitly for invalid or cancelled input", async () => {
      const port = required.create({});
      expect(await port.redact({ context: context(), entry: entry({ argumentsDigest: "secret" }) })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
      expect(await port.redact({ context: context(), entry: entry() }, { signal: AbortSignal.abort() })).toMatchObject({ ok: false, error: { code: "cancelled" } });
    });
  });
}

/** Observer ABI shared by the capture double and a composition-owned forwarding adapter. */
export function AuditObserverPortSuite(required: {
  name: string; create(required: Record<string, never>): { observer: AuditObserverPort; events(required: Record<string, never>): readonly unknown[] };
}): void {
  describe(`AuditObserverPort: ${required.name}`, () => {
    it("propagates operation/outcome and run/correlation/trace IDs", () => {
      const fixture = required.create({});
      const event = { operation: "audit.record", outcome: "ok", correlationId: "correlation-1", traceId: "trace-1", runId: "run-1" };
      fixture.observer.observe(event);
      expect(fixture.events({})).toEqual([event]);
    });
  });
}

/** Low-level DB seam contract; real SQL semantics are covered by the repository suite above. */
export function AuditSqlPortSuite(required: {
  name: string; create(required: Record<string, never>): {
    db: AuditSqlDatabase; session: AuditSqlSession; dispose(required: Record<string, never>): void;
  };
}): void {
  describe(`AuditSqlDatabase/AuditSqlSession: ${required.name}`, () => {
    it("returns a bound value from a session through a committed transaction", async () => {
      const fixture = required.create({});
      try {
        const result = await fixture.db.transaction({ context: context(), execute: ({ session }) => session.query({ text: "SELECT $1 AS value", values: ["opaque-value"] }) });
        expect(result.rows).toEqual([{ value: "opaque-value" }]);
      } finally { fixture.dispose({}); }
    });
    it("propagates callback failure without claiming transaction success", async () => {
      const fixture = required.create({});
      try {
        await expect(fixture.db.transaction({ context: context(), execute: async () => { throw new Error("test rollback"); } })).rejects.toThrow("test rollback");
        expect((await fixture.session.query({ text: "SELECT $1 AS value", values: ["after-failure"] })).rows).toEqual([{ value: "after-failure" }]);
      } finally { fixture.dispose({}); }
    });
    it("does not execute a transaction cancelled before acquisition", async () => {
      const fixture = required.create({});
      let executed = false;
      try {
        await expect(fixture.db.transaction({ context: context(), execute: async () => { executed = true; return "unexpected"; } }, { signal: AbortSignal.abort() }))
          .rejects.toThrow("Cancelled acquisition");
        expect(executed).toBe(false);
      } finally { fixture.dispose({}); }
    });
    it("serializes concurrent transaction callbacks until the first completes", async () => {
      const fixture = required.create({});
      const started: string[] = [];
      let release = (): void => {};
      const barrier = new Promise<void>(resolve => { release = resolve; });
      const first = fixture.db.transaction({ context: context(), execute: async () => { started.push("first"); await barrier; return 1; } });
      const second = fixture.db.transaction({ context: context(), execute: async () => { started.push("second"); return 2; } });
      try {
        await Promise.resolve();
        expect(started).toEqual(["first"]);
        release();
        expect(await Promise.all([first, second])).toEqual([1, 2]);
        expect(started).toEqual(["first", "second"]);
      } finally {
        release();
        await Promise.allSettled([first, second]);
        fixture.dispose({});
      }
    });
  });
}

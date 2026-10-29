import { afterEach, describe, expect, it } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteFixture } from "@open-marketing/om-db/testing";
import type { CallContext, Outcome } from "@open-marketing/contracts";
import { createMemoryBrandRepo, createSqlBrandRepo } from "../index.js";
import type { BrandKit, BrandRepoPort, BrandRevision } from "../index.js";

const migration = readFileSync(new URL("../migrations/0001_brand.sql", import.meta.url), "utf8");
const context: CallContext = { scope: { ownerId: "owner", workspaceId: "workspace" }, principal: { kind: "owner", ownerId: "owner" }, correlationId: "correlation", traceId: "trace", runId: "run" };
const kit: BrandKit = { business: { name: "Acme", facts: ["Locally owned"] }, offers: [{ name: "Service", facts: ["Available online"] }], audience: { pains: ["Time"], goals: ["Simplicity"] }, voice: { use: ["Clear"], avoid: ["Miracle"] }, colours: [{ hex: "#00C896", role: "accent" }], fonts: [{ family: "Inter", role: "body" }], logoAssetIds: ["logo"], assetIds: ["photo"], prohibitedClaims: ["Guaranteed results"] };

/** Deterministic complete snapshots with no authority fields taken from kit content. */
function record(required: { revision: number; status?: BrandRevision["status"]; context?: CallContext }): BrandRevision {
  const ctx = required.context ?? context;
  return { scope: ctx.scope, actor: ctx.principal, revision: required.revision, status: required.status ?? "draft", kit: structuredClone(kit), at: 123, correlationId: ctx.correlationId, traceId: ctx.traceId, runId: ctx.runId };
}
/** Fail fixture setup explicitly before asserting subsequent state. */
function unwrap<T>(required: { result: Outcome<T> }): T {
  if (!required.result.ok) throw new Error(required.result.error.code);
  return required.result.value;
}

/** The same behavioral assertions exercise the in-memory double and real SQLite adapter. */
function repositorySuite(required: { name: string; create: (required: Record<string, never>) => { repo: BrandRepoPort; close(): void } }): void {
  describe(required.name, () => {
    let harness: ReturnType<typeof required.create>;
    afterEach(() => harness?.close());
    it("keeps immutable history and confirmed projection across later drafts", async () => {
      harness = required.create({});
      const { repo } = harness;
      expect(unwrap({ result: await repo.read({ context }) })).toBeNull();
      expect(unwrap({ result: await repo.readConfirmed({ context }) })).toBeNull();
      const draft = record({ revision: 1 });
      const saved = unwrap({ result: await repo.append({ context, expectedRevision: 0, revision: draft }) });
      draft.kit.business.name = "Caller mutation";
      saved.kit.business.name = "Output mutation";
      expect(unwrap({ result: await repo.read({ context, revision: 1 }) })?.kit.business.name).toBe("Acme");
      expect(unwrap({ result: await repo.readConfirmed({ context }) })).toBeNull();
      unwrap({ result: await repo.append({ context, expectedRevision: 1, revision: record({ revision: 2, status: "confirmed" }) }) });
      const next = record({ revision: 3 }); next.kit.business.name = "New draft";
      unwrap({ result: await repo.append({ context, expectedRevision: 2, revision: next }) });
      const confirmed = unwrap({ result: await repo.readConfirmed({ context }) });
      expect(confirmed).toEqual(record({ revision: 2, status: "confirmed" }));
      confirmed!.kit.business.name = "Read mutation";
      expect(unwrap({ result: await repo.readConfirmed({ context }) })?.kit.business.name).toBe("Acme");
      expect(unwrap({ result: await repo.read({ context }) })).toEqual(next);
      expect(unwrap({ result: await repo.read({ context, revision: 1 }) })).toEqual(record({ revision: 1 }));
      expect(unwrap({ result: await repo.read({ context, revision: 99 }) })).toBeNull();
    });
    it("isolates both owner and workspace even when IDs contain separators", async () => {
      harness = required.create({});
      const scopes = [{ ownerId: "a:b", workspaceId: "c" }, { ownerId: "a", workspaceId: "b:c" }, { ownerId: "a:b", workspaceId: "d" }];
      for (const scope of scopes) {
        const ctx: CallContext = { ...context, scope, principal: { kind: "owner", ownerId: scope.ownerId } };
        expect(unwrap({ result: await harness.repo.read({ context: ctx }) })).toBeNull();
        unwrap({ result: await harness.repo.append({ context: ctx, expectedRevision: 0, revision: record({ revision: 1, context: ctx }) }) });
        expect(unwrap({ result: await harness.repo.read({ context: ctx }) })?.scope).toEqual(scope);
      }
      expect(unwrap({ result: await harness.repo.read({ context }) })).toBeNull();
    });
    it("arbitrates concurrent stale writers and preserves projection on rejection", async () => {
      harness = required.create({});
      const input = { context, expectedRevision: 0, revision: record({ revision: 1 }) };
      const results = await Promise.all([harness.repo.append(input), harness.repo.append(input)]);
      expect(results.filter(result => result.ok)).toHaveLength(1);
      expect(results.find(result => !result.ok)).toMatchObject({ ok: false, error: { code: "conflict" } });
      expect(await harness.repo.append({ context, expectedRevision: 0, revision: record({ revision: 2, status: "confirmed" }) })).toMatchObject({ ok: false, error: { code: "conflict" } });
      expect(unwrap({ result: await harness.repo.read({ context }) })?.revision).toBe(1);
      expect(unwrap({ result: await harness.repo.readConfirmed({ context }) })).toBeNull();
    });
    it("rejects forged evidence, invalid versions, changed confirmation and reconfirmation", async () => {
      harness = required.create({}); const { repo } = harness;
      for (const revision of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) expect((await repo.read({ context, revision })).ok).toBe(false);
      const first = record({ revision: 1 });
      expect((await repo.append({ context, expectedRevision: 0, revision: record({ revision: 1, status: "confirmed" }) })).ok).toBe(false);
      for (const principal of [{ kind: "service", serviceId: "extractor" }, { kind: "agent", agentInstanceId: "extractor", runId: "run" }] as const) {
        const untrusted: CallContext = { ...context, principal };
        expect((await repo.append({ context: untrusted, expectedRevision: 0, revision: record({ revision: 1, status: "confirmed", context: untrusted }) })).ok).toBe(false);
      }
      expect((await repo.append({ context, expectedRevision: -1, revision: first })).ok).toBe(false);
      expect((await repo.append({ context, expectedRevision: 0, revision: { ...first, revision: 2 } })).ok).toBe(false);
      expect((await repo.append({ context, expectedRevision: 0, revision: { ...first, scope: { ...context.scope, workspaceId: "other" } } })).ok).toBe(false);
      expect((await repo.append({ context, expectedRevision: 0, revision: { ...first, actor: { kind: "service", serviceId: "extractor" } } })).ok).toBe(false);
      expect((await repo.append({ context, expectedRevision: 0, revision: { ...first, traceId: "forged" } })).ok).toBe(false);
      unwrap({ result: await repo.append({ context, expectedRevision: 0, revision: first }) });
      const changed = record({ revision: 2, status: "confirmed" }); changed.kit.business.name = "Injected fact";
      expect((await repo.append({ context, expectedRevision: 1, revision: changed })).ok).toBe(false);
      unwrap({ result: await repo.append({ context, expectedRevision: 1, revision: record({ revision: 2, status: "confirmed" }) }) });
      expect((await repo.append({ context, expectedRevision: 2, revision: record({ revision: 3, status: "confirmed" }) })).ok).toBe(false);
      expect(unwrap({ result: await repo.read({ context }) })?.revision).toBe(2);
    });
    it("cancels reads and appends without changing state", async () => {
      harness = required.create({}); const options = { signal: AbortSignal.abort() };
      expect(await harness.repo.read({ context }, options)).toMatchObject({ ok: false, error: { code: "cancelled" } });
      expect(await harness.repo.readConfirmed({ context }, options)).toMatchObject({ ok: false, error: { code: "cancelled" } });
      expect(await harness.repo.append({ context, expectedRevision: 0, revision: record({ revision: 1 }) }, options)).toMatchObject({ ok: false, error: { code: "cancelled" } });
      expect(unwrap({ result: await harness.repo.read({ context }) })).toBeNull();
    });
  });
}
repositorySuite({ name: "memory brand repository", create: () => ({ repo: createMemoryBrandRepo({}), close() {} }) });
repositorySuite({ name: "SQL brand repository", create: () => {
  const fixture = createSqliteFixture({ migrations: [migration] });
  return { repo: createSqlBrandRepo({ db: fixture.database }), close: fixture.close };
} });

describe("SQL faults and durability", () => {
  it("rolls back a failed projection write and a cancelled transaction", async () => {
    let failProjection = true;
    const controller = new AbortController(); let cancel = false;
    const fixture = createSqliteFixture({ migrations: [migration] }, { beforeQuery: input => {
      if (failProjection && input.text.includes("INSERT INTO brand_current")) throw new Error("disk fault");
      if (cancel && input.text.includes("INSERT INTO brand_current")) controller.abort();
    } });
    try {
      const repo = createSqlBrandRepo({ db: fixture.database });
      const input = { context, expectedRevision: 0, revision: record({ revision: 1 }) };
      expect(await repo.append(input)).toMatchObject({ ok: false, error: { code: "unavailable" } });
      expect(fixture.native.prepare("SELECT * FROM brand_revision").all()).toEqual([]);
      expect(fixture.native.prepare("SELECT * FROM brand_current").all()).toEqual([]);
      failProjection = false; cancel = true;
      expect(await repo.append(input, { signal: controller.signal })).toMatchObject({ ok: false, error: { code: "cancelled" } });
      expect(fixture.native.prepare("SELECT * FROM brand_revision").all()).toEqual([]);
      cancel = false;
      unwrap({ result: await repo.append(input) });
      expect(() => fixture.native.prepare("UPDATE brand_revision SET record_json = '{}' ").run()).toThrow();
      expect(() => fixture.native.prepare("DELETE FROM brand_revision").run()).toThrow();
    } finally { fixture.close(); }
  });
  it("fails closed on malformed or mismatched persisted records", async () => {
    const fixture = createSqliteFixture({ migrations: [migration] });
    try {
      const repo = createSqlBrandRepo({ db: fixture.database });
      fixture.native.prepare("INSERT INTO brand_revision VALUES (?, ?, ?, ?)").run("owner", "workspace", 1, "{bad");
      fixture.native.prepare("INSERT INTO brand_current VALUES (?, ?, ?, ?)").run("owner", "workspace", 1, 1);
      expect(await repo.read({ context })).toMatchObject({ ok: false, error: { code: "unavailable" } });
      expect(await repo.readConfirmed({ context })).toMatchObject({ ok: false, error: { code: "unavailable" } });
      fixture.native.prepare("INSERT INTO brand_revision VALUES (?, ?, ?, ?)").run("owner", "workspace", 2, JSON.stringify(record({ revision: 3 })));
      expect((await repo.read({ context, revision: 2 })).ok).toBe(false);
      fixture.native.prepare("INSERT INTO brand_revision VALUES (?, ?, ?, ?)").run("owner", "workspace", 3, JSON.stringify(record({ revision: 3 })));
      fixture.native.prepare("UPDATE brand_current SET latest_revision = 3, confirmed_revision = 3").run();
      expect((await repo.readConfirmed({ context })).ok).toBe(false);
    } finally { fixture.close(); }
  });
  it("reopens confirmed and draft state without applying migrations again", async () => {
    const directory = mkdtempSync(join(tmpdir(), "om-brand-")); const filename = join(directory, "brand.sqlite");
    const first = createSqliteFixture({ migrations: [migration] }, { filename });
    try {
      const repo = createSqlBrandRepo({ db: first.database });
      unwrap({ result: await repo.append({ context, expectedRevision: 0, revision: record({ revision: 1 }) }) });
      unwrap({ result: await repo.append({ context, expectedRevision: 1, revision: record({ revision: 2, status: "confirmed" }) }) });
      unwrap({ result: await repo.append({ context, expectedRevision: 2, revision: record({ revision: 3 }) }) });
      first.close();
      const reopened = createSqliteFixture({ migrations: [] }, { filename });
      try {
        const persisted = createSqlBrandRepo({ db: reopened.database });
        expect(unwrap({ result: await persisted.read({ context }) })?.revision).toBe(3);
        expect(unwrap({ result: await persisted.readConfirmed({ context }) })?.revision).toBe(2);
        expect(unwrap({ result: await persisted.read({ context, revision: 1 }) })?.status).toBe("draft");
      } finally { reopened.close(); }
    } finally { first.close(); rmSync(directory, { recursive: true, force: true }); }
  });
});

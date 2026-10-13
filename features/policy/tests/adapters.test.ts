import { describe, expect, it } from "vitest";
import { createMemoryCanonicalIdentity, createMemoryPolicyRepo, createSqlPolicyRepo } from "../index.js";
import type { PolicySqlClient, PolicySqlPool } from "../index.js";
import { context, grant, merge, otherWorkspace, subject } from "./fixtures.js";
import { sqliteFixture } from "./sql-fixture.js";

/** Shared repository behavior for the configurable bound, on memory and actual SQLite. */
function capacitySuite(required: { name: string; create: () => { repo: ReturnType<typeof createMemoryPolicyRepo>; close?: () => void } }) {
  describe(required.name + " bounded evidence", () => {
    it("allows exact retries at capacity and rejects new records without losing prior evidence", async () => {
      const fixture = required.create();
      try {
        expect((await fixture.repo.appendEvidence({ context, evidence: grant })).ok).toBe(true);
        expect(await fixture.repo.appendEvidence({ context, evidence: grant })).toEqual({ ok: true, value: grant });
        expect(await fixture.repo.appendEvidence({ context, evidence: { ...grant, id: "new" } })).toMatchObject({ ok: false, error: { code: "limit_exceeded" } });
        expect(await fixture.repo.snapshot({ context, subjectId: "subject" })).toEqual({ ok: true, value: { consents: [grant.consent], suppressions: [], holdout: false } });
      } finally { fixture.close?.(); }
    });
  });
}
capacitySuite({ name: "memory", create: () => ({ repo: createMemoryPolicyRepo({ maxEvidence: 1 }) }) });
capacitySuite({ name: "SQLite", create: () => {
  const fixture = sqliteFixture();
  return { repo: createSqlPolicyRepo({ pool: fixture.pool, maxEvidence: 1 }), close: fixture.close };
} });

describe("adapter defenses", () => {
  it("validates fixture bounds, duplicate IDs, cyclic and cross-workspace seeds", () => {
    expect(() => createMemoryPolicyRepo({ maxEvidence: 0 })).toThrow("Invalid policy evidence limit");
    expect(() => createMemoryPolicyRepo({ evidence: [grant, grant] })).toThrow("Duplicate seed evidence");
    expect(() => createMemoryPolicyRepo({ evidence: [merge, { ...merge, id: "cycle", subjectId: "survivor", target: subject }] })).toThrow("Invalid seed evidence graph or capacity");
    expect(() => createMemoryPolicyRepo({ evidence: [{ ...merge, target: { ...merge.target, scope: otherWorkspace.scope } }] })).toThrow("Invalid seed merge scope");
  });
  it("fails closed on ambiguous identifier bindings and follows a transitive merge chain", async () => {
    const bindings = [{ identifier: "email:subject", subject }];
    const ambiguous = createMemoryCanonicalIdentity({ bindings: [...bindings, ...bindings] });
    expect(await ambiguous.resolve({ context, identifier: "email:subject" })).toMatchObject({ ok: false, error: { code: "unavailable" } });
    const identity = createMemoryCanonicalIdentity({ bindings, evidence: [merge, { ...merge, id: "second", subjectId: "survivor", target: { ...subject, subjectId: "final" } }] });
    expect(await identity.resolve({ context, identifier: "email:subject" })).toEqual({ ok: true, value: { ...subject, subjectId: "final" } });
  });
  it("rejects invalid and cross-workspace persisted evidence", async () => {
    const fixture = sqliteFixture();
    try {
      const repo = createSqlPolicyRepo({ pool: fixture.pool });
      expect((await repo.appendEvidence({ context, evidence: grant })).ok).toBe(true);
      fixture.db.prepare("UPDATE policy_evidence SET payload = ?").run(JSON.stringify({ ...grant, scope: otherWorkspace.scope }));
      expect(await repo.snapshot({ context, subjectId: "subject" })).toMatchObject({ ok: false, error: { code: "unavailable" } });
      fixture.db.prepare("UPDATE policy_evidence SET payload = ?").run("not-json");
      expect(await repo.snapshot({ context, subjectId: "subject" })).toMatchObject({ ok: false, error: { code: "unavailable" } });
    } finally { fixture.close(); }
  });
  it("refreshes persisted changes and fails instead of truncating over-cap snapshots", async () => {
    const fixture = sqliteFixture();
    try {
      const writer = createSqlPolicyRepo({ pool: fixture.pool });
      const reader = createSqlPolicyRepo({ pool: fixture.pool, maxEvidence: 1 });
      expect((await writer.appendEvidence({ context, evidence: grant })).ok).toBe(true);
      expect((await reader.snapshot({ context, subjectId: "subject" })).ok).toBe(true);
      expect((await writer.appendEvidence({ context, evidence: { ...grant, id: "more" } })).ok).toBe(true);
      expect(await reader.snapshot({ context, subjectId: "subject" })).toMatchObject({ ok: false, error: { code: "limit_exceeded" } });
    } finally { fixture.close(); }
  });
  it("is inert and delegates failures to the injected transaction owner", async () => {
    const events: string[] = [];
    const client: PolicySqlClient = {
      async query(input) { events.push(input.text); throw new Error("driver private detail"); },
      async transaction({ work }) { return work({ session: this }); },
    };
    const pool: PolicySqlPool = { async transaction({ work }) { events.push("transaction"); return work({ session: client }); } };
    const repo = createSqlPolicyRepo({ pool });
    expect(events).toEqual([]);
    expect(await repo.snapshot({ context, subjectId: "subject" })).toEqual({ ok: false, error: { code: "unavailable", message: "Policy database unavailable", retryable: true } });
    expect(events[0]).toBe("transaction");
    expect(events.slice(1)).toHaveLength(1);
    expect(events[1]).toMatch(/^SELECT payload/);
  });
  it("participates in an outer rollback through its supplied session", async () => {
    const fixture = sqliteFixture();
    const denied = { ok: false as const, error: { code: "denied" } };
    try {
      expect(await fixture.pool.transaction({ work: async ({ session }) => {
        const repo = createSqlPolicyRepo({ pool: session });
        expect(await repo.appendEvidence({ context, evidence: grant })).toEqual({ ok: true, value: grant });
        return denied;
      } })).toBe(denied);
      expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM policy_evidence").get()).toEqual({ count: 0 });
    } finally { fixture.close(); }
  });
  it("cancellation after insert returns failure before the owner commits", async () => {
    const fixture = sqliteFixture();
    const controller = new AbortController();
    const pool: PolicySqlPool = { transaction({ work }) {
      return fixture.pool.transaction({ work: ({ session }) => work({ session: {
        ...session,
        async query<Row extends Record<string, unknown>>(input: { text: string; values?: unknown[] }) {
          const result = await session.query<Row>(input);
          if (input.text.startsWith("INSERT")) controller.abort();
          return result;
        },
      } }) });
    } };
    try {
      expect(await createSqlPolicyRepo({ pool }).appendEvidence({ context, evidence: grant }, { signal: controller.signal })).toMatchObject({ ok: false, error: { code: "cancelled" } });
      expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM policy_evidence").get()).toEqual({ count: 0 });
    } finally { fixture.close(); }
  });
});

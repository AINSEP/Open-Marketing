import { describe, expect, it } from "vitest";
import type { SqlSession } from "@open-marketing/contracts";
import { createMemoryContactRepo, createSqlContactRepo } from "../../index.js";
import { createSqlFixture } from "../sql-fixture.js";
import { contactRepoSuite, context, identifier, subject } from "./port-suites.js";

contactRepoSuite({ name: "memory contacts repository", create: () => ({ repo: createMemoryContactRepo({}), close: () => undefined }) });
contactRepoSuite({ name: "SQLite contacts repository", create: () => {
  const fixture = createSqlFixture({});
  return { repo: createSqlContactRepo({ uow: fixture.uow }), close: fixture.close };
} });

describe("SQL transaction and storage boundaries", () => {
  it("rolls back subject plus first identifier after an actual second insert failure", async () => {
    const fixture = createSqlFixture({});
    try {
      fixture.db.exec("CREATE TRIGGER fixture_deny_phone BEFORE INSERT ON contact_identifier WHEN NEW.kind='phone' BEGIN SELECT RAISE(ABORT, 'fixture secret failure'); END;");
      const repo = createSqlContactRepo({ uow: fixture.uow });
      const output = await repo.upsert({ context, subject: subject({ id: "one" }), identifiers: [identifier({ subjectId: "one", id: "email" }), identifier({ subjectId: "one", id: "phone", kind: "phone", digest: "b".repeat(64) })] });
      expect(output).toMatchObject({ ok: false, error: { code: "conflict" } });
      expect(JSON.stringify(output)).not.toContain("fixture secret failure");
      expect(fixture.db.prepare("SELECT * FROM contact_subject").all()).toHaveLength(0);
      expect(fixture.db.prepare("SELECT * FROM contact_identifier").all()).toHaveLength(0);
    } finally { fixture.close(); }
  });
  it("joins a leased session and rolls back returned failures and throws", async () => {
    const fixture = createSqlFixture({});
    try {
      const failed = await fixture.uow.transaction({ work: async ({ session }) => {
        const repo = createSqlContactRepo({ uow: session });
        expect(await repo.upsert({ context, subject: subject({ id: "one" }), identifiers: [identifier({ subjectId: "one", id: "email" })] })).toMatchObject({ ok: true });
        return { ok: false, error: { code: "forbidden", message: "fixture denial", retryable: false } };
      } });
      expect(failed.ok).toBe(false);
      expect(fixture.db.prepare("SELECT * FROM contact_subject").all()).toHaveLength(0);
      await expect(fixture.uow.transaction({ work: async ({ session }) => {
        await createSqlContactRepo({ uow: session }).upsert({ context, subject: subject({ id: "one" }), identifiers: [identifier({ subjectId: "one", id: "email" })] });
        throw new Error("fixture throw");
      } })).rejects.toMatchObject({ code: "transaction_failed", cause: { message: "fixture throw" } });
      expect(fixture.db.prepare("SELECT * FROM contact_identifier").all()).toHaveLength(0);
    } finally { fixture.close(); }
  });
  it("rejects expired sessions and redacts injected transport failures", async () => {
    const fixture = createSqlFixture({});
    try {
      const leased: { session?: SqlSession } = {};
      await fixture.uow.transaction({ work: async ({ session }) => { leased.session = session; return undefined; } });
      await expect(leased.session!.query({ text: "SELECT 1" })).rejects.toMatchObject({ code: "connection_released" });
      expect(await createSqlContactRepo({ uow: leased.session! }).get({ context, subjectId: "one" })).toMatchObject({ ok: false, error: { code: "unavailable" } });
      const broken = createSqlContactRepo({ uow: { async transaction() { throw new Error("secret driver detail"); } } });
      expect(await broken.get({ context, subjectId: "one" })).toEqual({ ok: false, error: { code: "unavailable", message: "Contacts storage unavailable", retryable: false } });
    } finally { fixture.close(); }
  });
  it.each(["transaction_failed", "commit_failed", "rollback_failed", "release_after_failure", "release_after_commit"])("preserves constraint redaction without unwrapping uncertain %s", async code => {
    const native = Object.assign(new Error("private constraint detail"), { code: "SQLITE_CONSTRAINT_UNIQUE" });
    const query = Object.assign(new Error("Checked query failed"), { code: "query_failed", cause: native });
    const failure = Object.assign(new Error("Checked transaction failed"), { code, cause: query });
    const repo = createSqlContactRepo({ uow: { async transaction() { throw failure; } } });
    const output = await repo.get({ context, subjectId: "one" });
    expect(output).toEqual({ ok: false, error: {
      code: code === "transaction_failed" ? "conflict" : "unavailable",
      message: code === "transaction_failed" ? "Contacts storage conflict" : "Contacts storage unavailable",
      retryable: false,
    } });
    expect(JSON.stringify(output)).not.toContain("private constraint detail");
  });
  it("persists tombstone key versions and pointers across repository instances", async () => {
    const fixture = createSqlFixture({});
    try {
      let repo = createSqlContactRepo({ uow: fixture.uow });
      await repo.upsert({ context, subject: subject({ id: "one" }), identifiers: [identifier({ subjectId: "one", id: "email" }), identifier({ subjectId: "one", id: "click", kind: "gclid", digest: "c".repeat(64) })] });
      await repo.upsert({ context, subject: subject({ id: "two" }), identifiers: [identifier({ subjectId: "two", id: "phone", kind: "phone", digest: "b".repeat(64) })] });
      await repo.merge({ context, sourceSubjectId: "two", targetSubjectId: "one", mergedAt: 200 });
      await repo.purgeIdentifiers({ context, subjectId: "two" });
      repo = createSqlContactRepo({ uow: fixture.uow });
      expect(await repo.findByDigest({ context, kind: "email", identifierDigest: "a".repeat(64) })).toMatchObject({ ok: true, value: { subjectId: "one", lineage: [{ sourceSubjectId: "two", targetSubjectId: "one", mergedAt: 200 }] } });
      expect(fixture.db.prepare("SELECT kind,normalized_value,key_version FROM contact_identifier ORDER BY kind").all()).toEqual([{ kind: "email", normalized_value: null, key_version: "v1" }, { kind: "phone", normalized_value: null, key_version: "v1" }]);
      expect(fixture.db.prepare("SELECT subject_id,timezone,erased FROM contact_subject ORDER BY subject_id").all()).toEqual([{ subject_id: "one", timezone: null, erased: 1 }, { subject_id: "two", timezone: null, erased: 1 }]);
      expect(() => fixture.db.prepare("DELETE FROM contact_merge").run()).toThrow();
      expect(() => fixture.db.prepare("UPDATE contact_merge SET merged_at=999").run()).toThrow();
    } finally { fixture.close(); }
  });
  it("fails closed on cyclic, broken and malformed stored subjects/identifiers", async () => {
    const fixture = createSqlFixture({});
    try {
      const repo = createSqlContactRepo({ uow: fixture.uow });
      for (const [index, id] of ["one", "two"].entries()) await repo.upsert({ context, subject: subject({ id }), identifiers: [identifier({ subjectId: id, id, digest: String(index + 1).repeat(64) })] });
      fixture.db.prepare("UPDATE contact_subject SET merged_into='two' WHERE subject_id='one'").run();
      fixture.db.prepare("UPDATE contact_subject SET merged_into='one' WHERE subject_id='two'").run();
      expect(await repo.get({ context, subjectId: "one" })).toMatchObject({ ok: false, error: { code: "conflict" } });
      fixture.db.prepare("UPDATE contact_subject SET merged_into=NULL").run();
      fixture.db.pragma("foreign_keys = OFF");
      fixture.db.prepare("UPDATE contact_subject SET merged_into='missing' WHERE subject_id='one'").run();
      expect(await repo.get({ context, subjectId: "one" })).toMatchObject({ ok: false, error: { code: "conflict" } });
      fixture.db.prepare("UPDATE contact_subject SET merged_into=NULL,created_at='tainted' WHERE subject_id='one'").run();
      expect(await repo.get({ context, subjectId: "one" })).toMatchObject({ ok: false, error: { code: "unavailable" } });
      fixture.db.prepare("UPDATE contact_identifier SET identifier_digest='bad' WHERE subject_id='two'").run();
      expect(await repo.identifiersFor({ context, subjectId: "two" })).toMatchObject({ ok: false, error: { code: "unavailable" } });
    } finally { fixture.close(); }
  });
});

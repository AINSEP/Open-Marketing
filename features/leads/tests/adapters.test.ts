import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryLeadsRepo, createSqlLeadsRepo } from "../index.js";
import { context, record, sqliteFixture, stage, value } from "./fixtures.js";
import { leadsRepoSuite } from "./port-suite.js";

leadsRepoSuite({ name: "memory", create: () => ({ repo: createMemoryLeadsRepo({}) }) });
leadsRepoSuite({ name: "SQLite", create: () => { const fixture = sqliteFixture(); return { repo: createSqlLeadsRepo({ unitOfWork: fixture.database }), close: fixture.close }; } });

describe("SQL durability", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); });
  function setup(required: Parameters<typeof sqliteFixture>[0] = {}) { const fixture = sqliteFixture(required); cleanups.push(fixture.close); return fixture; }
  it("rolls capture and CAS updates back when the ledger insert fails", async () => {
    const fixture = setup();
    const repo = createSqlLeadsRepo({ unitOfWork: fixture.database });
    fixture.native.exec("CREATE TRIGGER fail_event BEFORE INSERT ON lead_stage_event BEGIN SELECT RAISE(ABORT,'private diagnostic'); END");
    expect(await repo.capture(record())).toMatchObject({ ok: false });
    expect(fixture.native.prepare("SELECT * FROM lead").all()).toEqual([]);
    fixture.native.exec("DROP TRIGGER fail_event");
    const lead = value(await repo.capture(record()));
    fixture.native.exec("CREATE TRIGGER fail_event BEFORE INSERT ON lead_stage_event BEGIN SELECT RAISE(ABORT,'private diagnostic'); END");
    const failed = await repo.appendStage(stage({ lead }));
    expect(failed).toMatchObject({ ok: false });
    expect(JSON.stringify(failed)).not.toContain("private diagnostic");
    expect(value(await repo.get({ context, leadId: lead.leadId }))).toEqual(lead);
    expect(fixture.native.prepare("SELECT * FROM lead_stage_event").all()).toHaveLength(1);
  });
  it("joins caller transactions and rolls erasure back with a failed acceptance Outcome", async () => {
    const fixture = setup();
    const repo = createSqlLeadsRepo({ unitOfWork: fixture.database });
    const lead = value(await repo.capture(record()));
    await fixture.database.transaction({ work: async ({ session }) => {
      const joined = createSqlLeadsRepo({ unitOfWork: session });
      expect(value(await joined.purgeSubject({ context, subjectId: "subject" }))).toBeUndefined();
      expect(value(await joined.get({ context, leadId: lead.leadId }))?.erased).toBe(true);
      return { ok: false as const, error: { code: "unavailable" as const, message: "fixture", retryable: false } };
    } });
    expect(value(await repo.get({ context, leadId: lead.leadId }))).toEqual(lead);
    await fixture.database.transaction({ work: async ({ session }) => {
      value(await createSqlLeadsRepo({ unitOfWork: session }).capture(record({ lead: { leadId: "rollback", lastEventId: "rollback-event", source: { kind: "manual", ref: "rollback" } } })));
      return { ok: false as const };
    } });
    expect(value(await repo.get({ context, leadId: "rollback" }))).toBeNull();
  });
  it("rejects ledger updates/deletes and preserves replay/erasure across a physical reopen", async () => {
    const directory = mkdtempSync(join(tmpdir(), "om-leads-"));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const filename = join(directory, "fixture.sqlite");
    const fixture = setup({ filename });
    const repo = createSqlLeadsRepo({ unitOfWork: fixture.database });
    const lead = value(await repo.capture(record()));
    const won = value(await repo.appendStage(stage({ lead, to: "won" })));
    expect(() => fixture.native.exec("UPDATE lead_stage_event SET payload='{}'")).toThrow("immutable");
    expect(() => fixture.native.exec("DELETE FROM lead_stage_event")).toThrow("immutable");
    fixture.close();
    const reopened = setup({ filename, migrations: false });
    const restarted = createSqlLeadsRepo({ unitOfWork: reopened.database });
    expect(value(await restarted.capture(record()))).toEqual(won);
    value(await restarted.purgeSubject({ context, subjectId: "subject" }));
    expect(await restarted.capture(record())).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(value(await restarted.history({ context, leadId: lead.leadId, page: { limit: 100 } })).items).toHaveLength(2);
    reopened.close();
    const erased = setup({ filename, migrations: false });
    expect(await createSqlLeadsRepo({ unitOfWork: erased.database }).capture(record())).toMatchObject({ ok: false, error: { code: "forbidden" } });
  });
  it("returns redacted failures on malformed stored attribution and cancels mid-write atomically", async () => {
    const abort = new AbortController();
    const fixture = setup({ beforeQuery: input => { if (input.text.startsWith("INSERT INTO lead_stage_event")) abort.abort(); } });
    const repo = createSqlLeadsRepo({ unitOfWork: fixture.database });
    expect(await repo.capture(record(), { signal: abort.signal })).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(fixture.native.prepare("SELECT * FROM lead").all()).toEqual([]);
    value(await repo.capture(record()));
    fixture.native.prepare("INSERT INTO lead_stage_event(owner_id,workspace_id,event_id,lead_id,revision,payload) VALUES(?,?,?,?,?,?)").run("owner", "workspace", "drift", "lead-1", 2, JSON.stringify({ ...record().event, revision: 2 }));
    expect(await repo.history({ context, leadId: "lead-1", page: { limit: 100 } })).toMatchObject({ ok: false, error: { code: "unavailable" } });
    fixture.native.prepare("UPDATE lead SET attribution=?").run("private invalid json");
    expect(await repo.get({ context, leadId: "lead-1" })).toMatchObject({ ok: false, error: { code: "unavailable" } });
  });
  /** Native bulk rows (fixture-only); campaign identity is a SQL expression over the row number. */
  function insertBulk(required: { native: ReturnType<typeof sqliteFixture>["native"]; total: number; campaign: string }): void {
    required.native.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<${required.total})
      INSERT INTO lead(owner_id,workspace_id,lead_id,subject_id,source_kind,source_ref,occurred_at,created_at,attribution,stage,revision,last_event_id,erased)
      SELECT 'owner','workspace','bulk-'||i,'subject-'||i,'form','bulk-'||i,200,1500,
        json_object('campaign',json_object('pluginId','google-ads','accountId','account','vendorCampaignId',${required.campaign}),'touchId','touch','touchedAt',100,'modelVersion','last_paid_touch_30d.v1'),
        'new',1,'event-'||i,0 FROM n`);
  }
  const cohortQuery = { context, pluginId: "google-ads", accountId: "account", createdAt: { start: 1000, end: 2000 } };
  it("counts more than 5,000 leads in one campaign exactly inside SQL", async () => {
    const fixture = setup();
    insertBulk({ native: fixture.native, total: 5001, campaign: "'campaign'" });
    expect(value(await createSqlLeadsRepo({ unitOfWork: fixture.database }).readCohort(cohortQuery))).toEqual({ counts: [{ vendorCampaignId: "campaign", count: 5001 }], unattributed: 0 });
  });
  it("fails 5,001 campaign groups with limit_exceeded instead of truncating", async () => {
    const fixture = setup();
    insertBulk({ native: fixture.native, total: 5001, campaign: "'campaign-'||i" });
    expect(await createSqlLeadsRepo({ unitOfWork: fixture.database }).readCohort(cohortQuery)).toMatchObject({ ok: false, error: { code: "limit_exceeded" } });
  });
  it("returns redacted unavailable for a malformed stored campaign identity", async () => {
    const fixture = setup();
    insertBulk({ native: fixture.native, total: 1, campaign: "5" });
    const result = await createSqlLeadsRepo({ unitOfWork: fixture.database }).readCohort(cohortQuery);
    expect(result).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(JSON.stringify(result)).not.toContain("bulk-1");
  });
});

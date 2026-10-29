import { afterEach, describe, expect, it } from "vitest";
import type { Outcome, SqlSession, UnitOfWork } from "@open-marketing/contracts";
import { createMemoryWebEventRepo, createSqlWebEventRepo } from "../index.js";
import { clockFixture, context, destinationUrl, encodedCampaign, event, otherWorkspace, sqliteFixture, touch, visit } from "./fixtures.js";
import { webEventRepoSuite } from "./port-suite.js";

webEventRepoSuite({ name: "memory", create: ({ clock }) => ({ repo: createMemoryWebEventRepo({ clock }) }) });
webEventRepoSuite({ name: "SQLite", create: ({ clock }) => { const fixture = sqliteFixture(); return { ...fixture, repo: createSqlWebEventRepo({ pool: fixture.pool, clock }) }; } });

describe("SQL storage and transactions", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => { for (const close of cleanups.splice(0)) close(); });
  function setup() { const fixture = sqliteFixture(); cleanups.push(fixture.close); return { ...fixture, ...clockFixture() }; }
  it("stores ID-only immutable envelopes, scoped monotonic cursors and receipt time", async () => {
    const fixture = setup();
    const repo = createSqlWebEventRepo(fixture);
    await repo.recordTouch({ context, event: event(), touch: touch() });
    const second = event({ eventId: "second", receivedAt: 9999, cursor: 9999 });
    await repo.recordTouch({ context, event: second, touch: touch({ event: second, touchId: "second-touch" }) });
    await repo.recordTouch({ context: otherWorkspace, event: event(), touch: touch() });
    const rows = fixture.db.prepare("SELECT cursor, payload, semantic_digest FROM web_event WHERE workspace_id = ? ORDER BY cursor").all(context.scope.workspaceId) as { cursor: number; payload: string; semantic_digest: string }[];
    expect(rows.map(row => row.cursor)).toEqual([1, 2]);
    expect(JSON.parse(rows[0].payload)).toMatchObject({ properties: { linkId: "link", campaignId: encodedCampaign() }, receivedAt: 1000, cursor: 1, traceId: "trace" });
    expect(rows[0].payload).not.toContain("google-click");
    expect(rows[0].payload).not.toContain("meta-click");
    expect(rows[0].semantic_digest).toMatch(/^[a-f0-9]{64}$/);
  });
  it("persists only the destination digest, retaining heartbeat evidence across repository restart", async () => {
    const fixture = setup();
    const repo = createSqlWebEventRepo(fixture);
    const landing = event({ properties: { campaignId: encodedCampaign(), pageUrl: destinationUrl + "?email=secret#private" } });
    const input = { context, event: landing, touch: touch({ event: landing }) };
    expect((await repo.recordTouch(input)).ok).toBe(true);
    const row = fixture.db.prepare("SELECT payload FROM web_event").get() as { payload: string };
    const stored = JSON.parse(row.payload);
    expect(stored.properties).toEqual({ campaignId: encodedCampaign(), destinationId: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(row.payload).not.toContain("site.example.test");
    expect(row.payload).not.toContain("secret");
    const restarted = createSqlWebEventRepo(fixture);
    fixture.time.now = 9999;
    expect((await restarted.recordTouch(input)).ok).toBe(true);
    const query = { context, destinationId: stored.properties.destinationId as string };
    expect(await restarted.lastHeartbeat(query)).toEqual({ ok: true, value: 1000 });
    fixture.db.prepare("UPDATE web_event SET payload = ?").run(JSON.stringify({ ...stored, properties: { ...stored.properties, pageUrl: destinationUrl } }));
    expect(await restarted.lastHeartbeat(query)).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(await restarted.recordTouch(input)).toMatchObject({ ok: false, error: { code: "unavailable" } });
  });
  it("rolls back an envelope and cursor if its touch insert fails", async () => {
    const fixture = setup();
    fixture.db.exec("CREATE TRIGGER fail_touch BEFORE INSERT ON web_touch BEGIN SELECT RAISE(ABORT, 'fixture driver diagnostic'); END");
    const repo = createSqlWebEventRepo(fixture);
    expect(await repo.recordTouch({ context, event: event(), touch: touch() })).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(fixture.db.prepare("SELECT * FROM web_event").all()).toEqual([]);
    expect(fixture.db.prepare("SELECT * FROM web_event_cursor").all()).toEqual([]);
  });
  it("joins the caller session and rolls back on an outer failed Outcome", async () => {
    const fixture = setup();
    await fixture.pool.transaction({ work: async ({ session }) => {
      const repo = createSqlWebEventRepo({ pool: session, clock: fixture.clock });
      expect((await repo.saveVisit({ context, visit })).ok).toBe(true);
      expect((await repo.bindVisitor({ context, visitId: visit.visitId, subjectId: "subject" })).ok).toBe(true);
      return { ok: false, error: { code: "unavailable", message: "fixture", retryable: false } } as Outcome<void>;
    } });
    expect(fixture.db.prepare("SELECT * FROM web_visit").all()).toEqual([]);
  });
  it("rolls back both clicks and visit deletion if purge fails halfway", async () => {
    const fixture = setup();
    const repo = createSqlWebEventRepo(fixture);
    await repo.saveVisit({ context, visit });
    await repo.bindVisitor({ context, visitId: visit.visitId, subjectId: "subject" });
    await repo.recordTouch({ context, event: event(), touch: touch() });
    fixture.db.exec("CREATE TRIGGER fail_purge BEFORE DELETE ON web_visit BEGIN SELECT RAISE(ABORT, 'purge failure'); END");
    expect(await repo.purgeSubject({ context, subjectId: "subject" })).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(await repo.touchesFor({ context, subjectId: "subject", window: { start: 0, end: 500 }, limit: 100 })).toEqual({ ok: true, value: [touch()] });
  });
  it("rolls back cancellation arriving during a write", async () => {
    const fixture = setup();
    const abort = new AbortController();
    const pool: UnitOfWork = { transaction: ({ work }) => fixture.pool.transaction({ work: ({ session }) => work({ session: abortingSession({ session, abort }) }) }) };
    const repo = createSqlWebEventRepo({ pool, clock: fixture.clock });
    expect(await repo.recordTouch({ context, event: event(), touch: touch() }, { signal: abort.signal })).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(fixture.db.prepare("SELECT * FROM web_event").all()).toEqual([]);
  });
  it("rejects malformed persisted payloads and column/payload drift", async () => {
    const fixture = setup();
    const repo = createSqlWebEventRepo(fixture);
    await repo.recordTouch({ context, event: event(), touch: touch() });
    fixture.db.prepare("UPDATE web_event SET payload = ?").run("{bad-json");
    expect(await repo.recordTouch({ context, event: event(), touch: touch() })).toMatchObject({ ok: false, error: { code: "unavailable" } });
    fixture.db.prepare("UPDATE web_event SET payload = ?, occurred_at = 999").run(JSON.stringify({ ...event(), properties: { linkId: "link", campaignId: encodedCampaign() }, cursor: 1, receivedAt: 1000 }));
    expect(await repo.recordTouch({ context, event: event(), touch: touch() })).toMatchObject({ ok: false, error: { code: "unavailable" } });
  });
  it("physically purges mutable click values and visits while preserving immutable envelopes", async () => {
    const fixture = setup();
    const repo = createSqlWebEventRepo(fixture);
    await repo.saveVisit({ context, visit });
    await repo.bindVisitor({ context, visitId: visit.visitId, subjectId: "subject" });
    await repo.recordTouch({ context, event: event(), touch: touch() });
    await repo.recordTouch({ context: otherWorkspace, event: event(), touch: touch() });
    const immutable = fixture.db.prepare("SELECT payload, semantic_digest FROM web_event").all();
    await repo.purgeSubject({ context, subjectId: "subject" });
    expect(fixture.db.prepare("SELECT click_identifiers FROM web_touch WHERE workspace_id = ?").get(context.scope.workspaceId)).toEqual({ click_identifiers: "{}" });
    expect(fixture.db.prepare("SELECT * FROM web_visit").all()).toEqual([]);
    expect(fixture.db.prepare("SELECT payload, semantic_digest FROM web_event").all()).toEqual(immutable);
    expect(await repo.recordTouch({ context: otherWorkspace, event: event(), touch: touch() })).toEqual({ ok: true, value: touch() });
  });
  it("takes a validated input snapshot before the transaction can yield", async () => {
    const fixture = setup();
    const repo = createSqlWebEventRepo(fixture);
    const input = event();
    const projected = touch();
    const pending = repo.recordTouch({ context, event: input, touch: projected });
    Object.assign(input.properties, { gclid: "raw@example.test" });
    Object.assign(projected.clickIdentifiers, { gclid: "raw@example.test" });
    expect(await pending).toEqual({ ok: true, value: touch() });
    expect(await repo.recordTouch({ context, event: event(), touch: touch() })).toEqual({ ok: true, value: touch() });
  });
});
/** Inject cancellation immediately after one SQL insert; preserve generic query/session ABI. */
function abortingSession(required: { session: SqlSession; abort: AbortController }): SqlSession {
  const wrapper: SqlSession = {
    async query<Row extends Record<string, unknown>>(input: { text: string; values?: unknown[] }) {
      const result = await required.session.query<Row>(input);
      if (input.text.startsWith("INSERT INTO web_touch")) required.abort.abort();
      return result;
    },
    transaction: ({ work }) => work({ session: wrapper }),
  };
  return wrapper;
}

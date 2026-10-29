import { describe, expect, it } from "vitest";
import { createFakeClock } from "@open-marketing/om-clock";
import { ConversionVerificationPortSuite, MeasureRepoPortSuite, MeasurePrivacyPortSuite, MeasurementGrantPortSuite, ConversionDeliveryStatePortSuite, MeasureAuditPortSuite, TrackedLinkPortSuite, MeasureJobPortSuite } from "./port-suites.js";
import { createSqlConversionVerification, createSqlMeasurementGrant, createSqlMeasureRepo, createSqlConversionDeliveryState, createSqlMeasureAudit, createSqlTrackedLink, createSqlMeasureJob } from "../../index.js";
import { createSqlFixture } from "../sql-fixture.js";
import { context, createIds, event, grant, resolvedEvent, serviceContext, source } from "../fixtures.js";
MeasureRepoPortSuite({ create: () => { const fixture = createSqlFixture({}); return createSqlMeasureRepo({ database: fixture.database, jobs: fixture.jobs }); } });
ConversionDeliveryStatePortSuite({ create: () => createSqlConversionDeliveryState({ database: createSqlFixture({}).database }) });
MeasurementGrantPortSuite({ create: () => createSqlMeasurementGrant({ database: createSqlFixture({}).database, clock: createFakeClock({ initial: 300 }) }) });
MeasureAuditPortSuite({ create: () => createSqlMeasureAudit({ database: createSqlFixture({}).database, ids: createIds({}), clock: createFakeClock({ initial: 300 }) }) });
TrackedLinkPortSuite({ create: () => createSqlTrackedLink({ database: createSqlFixture({}).database, ids: createIds({}), baseUrl: "https://om.example/l/", allowedOrigins: ["https://shop.example"], allowedQueryKeys: ["click_id"] }) });
MeasureJobPortSuite({ create: () => { const fixture = createSqlFixture({}); return createSqlMeasureJob({ database: fixture.database, jobs: fixture.jobs }); } });

ConversionVerificationPortSuite({ create: async () => {
  const fixture = createSqlFixture({});
  await createSqlMeasureRepo(fixture).appendConversion({ source, event });
  return createSqlConversionVerification({ database: fixture.database });
} });

describe("SQL measurement grant insert arbitration and listing", () => {
  it("returns the identical competing insert instead of a driver failure", async () => {
    const fixture = createSqlFixture({});
    const port = createSqlMeasurementGrant({ database: fixture.database, clock: createFakeClock({ initial: 300 }) });
    fixture.raceNextGrantInsert(grant);
    expect(await port.grant({ context, grant })).toEqual({ ok: true, value: grant });
    expect((await fixture.database.query({ text: "SELECT grant_id FROM measure_grant" })).rows).toHaveLength(1);
  });
  it("reports conflict when the competing insert binds different content", async () => {
    const fixture = createSqlFixture({});
    const port = createSqlMeasurementGrant({ database: fixture.database, clock: createFakeClock({ initial: 300 }) });
    const winner = { ...grant, definitionIds: ["other-definition"] };
    fixture.raceNextGrantInsert(winner);
    expect(await port.grant({ context, grant })).toMatchObject({ ok: false, error: { code: "conflict" } });
  });
  it("pages only the requested scope and includes revoked grants through the final cursor", async () => {
    const fixture = createSqlFixture({});
    const port = createSqlMeasurementGrant({ database: fixture.database, clock: createFakeClock({ initial: 300 }) });
    const first = { ...grant, grantId: "a" }, second = { ...grant, grantId: "b" };
    const foreign = { ...context, scope: { ...context.scope, workspaceId: "foreign" } };
    await port.grant({ context, grant: first });
    await port.grant({ context, grant: second });
    await port.grant({ context: foreign, grant: { ...grant, scope: foreign.scope, grantId: "aa" } });
    await port.revoke({ context, grantId: first.grantId });
    expect(await port.list({ context, query: { limit: 1 } })).toEqual({ ok: true, value: { items: [{ ...first, revoked: true }], cursor: "a" } });
    expect(await port.list({ context, query: { limit: 1, cursor: "a" } })).toEqual({ ok: true, value: { items: [second], cursor: null } });
    expect(await port.list({ context: foreign, query: { limit: 1 } })).toEqual({ ok: true, value: { items: [{ ...grant, scope: foreign.scope, grantId: "aa" }], cursor: null } });
    fixture.handle.prepare("UPDATE measure_grant SET grant_json=? WHERE grant_id=?").run("x".repeat(65537), first.grantId);
    expect(await port.list({ context, query: { limit: 1 } })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });
});

describe("measure subject lookup schema and immutable evidence", () => {
  it("declares non-null typed subjects/definitions/events and both scoped indexes", async () => {
    const fixture = createSqlFixture({});
    const events = await fixture.database.query({ text: "PRAGMA table_info(measure_conversion_event)" });
    const deliveries = await fixture.database.query({ text: "PRAGMA table_info(measure_conversion_delivery)" });
    expect(events.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "subject_id", type: "TEXT", notnull: 1 }),
      expect.objectContaining({ name: "definition_id", type: "TEXT", notnull: 1 }),
    ]));
    expect(deliveries.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "subject_id", type: "TEXT", notnull: 1 }),
      expect.objectContaining({ name: "event_id", type: "TEXT", notnull: 1 }),
    ]));
    const eventIndex = await fixture.database.query({ text: "PRAGMA index_info(measure_conversion_subject)" });
    const deliveryIndex = await fixture.database.query({ text: "PRAGMA index_info(measure_delivery_subject)" });
    expect(eventIndex.rows.map(row => row.name)).toEqual(["scope_key", "subject_id", "definition_id", "occurred_at"]);
    expect(deliveryIndex.rows.map(row => row.name)).toEqual(["scope_key", "subject_id", "event_id"]);
  });
  it("persists digest-only inbox and outbox identity with typed lookup values", async () => {
    const fixture = createSqlFixture({});
    const input = { ...event, definitionId: "purchase", value: { minorUnits: 1234, currency: "USD" }, orderRef: "order-123" };
    expect(await createSqlMeasureRepo(fixture).appendConversion({ source, event: input })).toMatchObject({ ok: true });
    const evidence = await fixture.database.query({ text: "SELECT subject_id,definition_id,event_json,identity FROM measure_conversion_event" });
    expect(evidence.rows).toHaveLength(1);
    expect(evidence.rows[0]).toMatchObject({ subject_id: input.subjectId, definition_id: input.definitionId, identity: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(JSON.parse(String(evidence.rows[0].event_json))).toEqual(input);
    const jobs = await fixture.database.query({ text: "SELECT * FROM fixture_jobs" });
    expect(jobs.rows).toHaveLength(1);
    expect(jobs.rows[0].identity).toBe(evidence.rows[0].identity);
    expect(JSON.stringify([evidence.rows, jobs.rows])).not.toContain(resolvedEvent.identifiers.click_id);
    expect(JSON.parse(String(evidence.rows[0].event_json))).not.toHaveProperty("identifiers");
  });
  it("stores subject and shared event ID on every identifier-free delivery version", async () => {
    const fixture = createSqlFixture({});
    const ledger = createSqlConversionDeliveryState(fixture);
    const record = { deliveryId: "delivery-evidence", subjectId: event.subjectId, eventId: event.eventId, identity: "b".repeat(64), status: "dispatching" as const, recordedAt: 300 };
    expect(await ledger.begin({ context: serviceContext, record })).toMatchObject({ ok: true });
    expect(await ledger.append({ context: serviceContext, record: { ...record, status: "delivered", recordedAt: 301 } })).toMatchObject({ ok: true });
    const rows = await fixture.database.query({ text: "SELECT subject_id,event_id,record_json FROM measure_conversion_delivery ORDER BY version" });
    expect(rows.rows).toHaveLength(2);
    for (const row of rows.rows) {
      expect(row).toMatchObject({ subject_id: event.subjectId, event_id: event.eventId });
      expect(JSON.parse(String(row.record_json))).toMatchObject({ subjectId: event.subjectId, eventId: event.eventId, identity: record.identity });
      expect(JSON.parse(String(row.record_json))).not.toHaveProperty("identifiers");
    }
    expect(JSON.stringify(rows.rows)).not.toContain(resolvedEvent.identifiers.click_id);
  });
});

MeasurePrivacyPortSuite({ create: () => { const fixture = createSqlFixture({}); return createSqlMeasureRepo({ database: fixture.database, jobs: fixture.jobs }); } });

it("privacy clears the reloadable order reference only in the requested scope and keeps the semantic digest", async () => {
  const fixture = createSqlFixture({});
  const repo = createSqlMeasureRepo(fixture);
  const original = { ...event, orderRef: "private-order" };
  expect((await repo.appendConversion({ source, event: original })).ok).toBe(true);
  const before = await fixture.database.query({ text: "SELECT identity FROM measure_conversion_event" });
  expect((await repo.purgeSubject({ context: { ...source.context!, scope: { ...source.scope, workspaceId: "foreign" } }, subjectId: event.subjectId })).ok).toBe(true);
  expect((await fixture.database.query({ text: "SELECT event_json FROM measure_conversion_event" })).rows[0]?.event_json).toContain("private-order");
  expect((await repo.purgeSubject({ context: source.context!, subjectId: event.subjectId })).ok).toBe(true);
  expect((await fixture.database.query({ text: "SELECT event_json FROM measure_conversion_event" })).rows[0]?.event_json).not.toContain("private-order");
  expect((await fixture.database.query({ text: "SELECT identity FROM measure_conversion_event" })).rows).toEqual(before.rows);
});

import { describe, expect, expectTypeOf, it } from "vitest";
import { createServiceFixture } from "./service-fixture.js";
import { createMeasureService, createMemoryMeasureRepo, createMemoryMeasurementShareability, createMemoryConversionDelivery, createMemoryPlatformReporting, createMemoryMeasureJob, createMemoryTrackedLink, createMemoryMeasureAudit, createMemoryConversionSourceAuthentication, createSqlMeasureRepo } from "../index.js";
import { consent, context, createIds, event, scope, snapshot, source } from "./fixtures.js";
import { createSqlFixture } from "./sql-fixture.js";
import type { LeadOutcomeInput, MeasureRepoPort, MeasureService } from "../index.js";

/** Drive the real intake and inbox/outbox against both repository implementations. */
function leadIntakeSuite(required: { name: string; create: () => { repo: MeasureRepoPort; counts: () => { events: number; jobs: number } } }): void {
  describe(required.name, () => {
    it.each([
      ["qualified", "disqualified", "qualified"],
      ["won", "qualified", "won"],
    ] as const)("does not queue another conversion across %s → %s → %s", async (first, middle, last) => {
      const storage = required.create(), dependencies = createServiceFixture({});
      const service = createMeasureService({ ...dependencies, repo: storage.repo }, { authentication: dependencies.authentication });
      const evidence = { ...event, definitionId: first, value: { currency: "USD", minorUnits: 100 } };
      const { eventId: _unused, ...outcome } = evidence;
      const accepted = await service.ingestLeadOutcome({ source, leadId: "lead-1", event: outcome });
      expect(accepted).toMatchObject({ ok: true, value: { eventId: "lead-1:" + first, status: "accepted" } });
      // Corrections supply no new sharing intent; a different qualifying definition is independent.
      const expectedCount = middle === "qualified" ? 2 : 1;
      if (middle === "qualified") expect(await service.ingestLeadOutcome({ source, leadId: "lead-1", event: { ...outcome, definitionId: middle } })).toMatchObject({ ok: true, value: { status: "accepted" } });
      const retry = await service.ingestLeadOutcome({ source, leadId: "lead-1", event: { ...outcome, definitionId: last } });
      expect(retry).toMatchObject({ ok: true, value: { status: "duplicate" } });
      if (accepted.ok && retry.ok) expect(retry.value.jobId).toBe(accepted.value.jobId);
      for (const change of [{ occurredAt: 200 }, { value: { currency: "USD", minorUnits: 200 } }]) {
        expect(await service.ingestLeadOutcome({ source, leadId: "lead-1", event: { ...outcome, ...change } })).toMatchObject({ ok: false, error: { code: "conflict" } });
      }
      expect(storage.counts()).toEqual({ events: expectedCount, jobs: expectedCount });
      expect(await service.ingestLeadOutcome({ source, leadId: "lead-2", event: outcome })).toMatchObject({ ok: true, value: { eventId: "lead-2:" + first, status: "accepted" } });
      expect(storage.counts()).toEqual({ events: expectedCount + 1, jobs: expectedCount + 1 });
    });
    it.each(["qualified", "won"])("rejects generic %s events under arbitrary IDs and sources before effects", async definitionId => {
      const storage = required.create(), dependencies = createServiceFixture({});
      let effects = 0;
      const service = createMeasureService({ ...dependencies, repo: storage.repo,
        policy: { async assess() { effects++; return { ok: true, value: { allowed: true } }; } },
      }, { authentication: { async verify() { effects++; return { ok: true, value: { authenticated: true } }; } } });
      for (const sourceId of ["form", "crm"]) {
        expect(await service.ingestConversion({ source: { ...source, sourceId }, event: { ...event, definitionId, eventId: sourceId + "-arbitrary" } }))
          .toMatchObject({ ok: false, error: { code: "invalid_input" } });
      }
      expect(effects).toBe(0);
      expect(storage.counts()).toEqual({ events: 0, jobs: 0 });
    });
    it("rejects non-outcomes, caller event IDs and oversized derived IDs before commit", async () => {
      const storage = required.create(), dependencies = createServiceFixture({});
      const service = createMeasureService({ ...dependencies, repo: storage.repo }, { authentication: dependencies.authentication });
      const { eventId: _unused, ...outcome } = event;
      for (const definitionId of ["signup", "spam", "disqualified"]) expect(await service.ingestLeadOutcome({ source, leadId: "lead-1", event: { ...outcome, definitionId } } as unknown as LeadOutcomeInput)).toMatchObject({ ok: false, error: { code: "invalid_input" } });
      expect(await service.ingestLeadOutcome({ source, leadId: "lead-1", event: { ...event, definitionId: "qualified" } })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
      expect(await service.ingestLeadOutcome({ source, leadId: "x".repeat(256), event: { ...outcome, definitionId: "qualified" } })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
      expect(await service.ingestLeadOutcome({ source: { ...source, authenticationRevision: 0 }, leadId: "lead-1", event: { ...outcome, definitionId: "qualified" } })).toMatchObject({ ok: false, error: { code: "unauthenticated" } });
      expect(await service.ingestLeadOutcome({ source, leadId: "lead-1", event: { ...outcome, definitionId: "qualified", purpose: "other" } })).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(storage.counts()).toEqual({ events: 0, jobs: 0 });
    });
  });
}
leadIntakeSuite({ name: "memory lead outcome intake", create() {
  const repo = createMemoryMeasureRepo({});
  return { repo, counts() { const state = repo.inspect({ scope }); return { events: state.events.length, jobs: state.jobs.length }; } };
} });
leadIntakeSuite({ name: "SQL lead outcome intake", create() {
  const fixture = createSqlFixture({});
  return { repo: createSqlMeasureRepo(fixture), counts: fixture.counts };
} });

describe("verified ingestion", () => {
  it("commits one event/job and returns the original job on retry", async () => {
    const fixture = createServiceFixture({});
    expect(await fixture.service.ingestConversion({ source, event })).toMatchObject({ ok: true, value: { status: "accepted" } });
    expect(await fixture.service.ingestConversion({ source, event })).toMatchObject({ ok: true, value: { status: "duplicate" } });
    expect(fixture.repo.inspect({ scope }).events).toHaveLength(1);
    expect(fixture.repo.inspect({ scope }).jobs).toHaveLength(1);
  });
  it("denies missing authentication and stale source revision before commit", async () => {
    const fixture = createServiceFixture({});
    const unconfigured = createMeasureService(fixture);
    expect(await unconfigured.ingestConversion({ source, event })).toMatchObject({ ok: false, error: { code: "unauthenticated" } });
    expect(await fixture.service.ingestConversion({ source: { ...source, authenticationRevision: 0 }, event })).toMatchObject({ ok: false, error: { code: "unauthenticated" } });
    expect(fixture.repo.inspect({ scope }).events).toHaveLength(0);
  });
  it("rejects forged scope and future event schema before storage", async () => {
    const fixture = createServiceFixture({});
    expect(await fixture.service.ingestConversion({ source: { ...source, context: { ...context, scope: { ...scope, workspaceId: "forged" } } }, event })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(await fixture.service.ingestConversion({ source, event: { ...event, occurredAt: 301 } })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(fixture.repo.inspect({ scope }).jobs).toHaveLength(0);
  });
  it("malformed transport input returns a typed failure before deriving trace context", async () => {
    const fixture = createServiceFixture({});
    const malformed = { event } as unknown as Parameters<typeof fixture.service.ingestConversion>[0];
    expect(await fixture.service.ingestConversion(malformed)).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(fixture.repo.inspect({ scope }).events).toHaveLength(0);
  });
  it("purpose/destination/identifier changes cannot borrow consent", async () => {
    const fixture = createServiceFixture({});
    expect(await fixture.service.ingestConversion({ source, event: { ...event, purpose: "audience" } })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(await fixture.service.ingestConversion({ source, event: { ...event, destination: "other" } })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(await fixture.service.ingestConversion({ source, event: { ...event, identifierDigests: { email: "b".repeat(64) } } })).toMatchObject({ ok: false, error: { code: "forbidden" } });
  });
  it("accepts open definitions with Money and an opaque order reference", async () => {
    const fixture = createServiceFixture({});
    const purchase = { ...event, definitionId: "purchase_v2", value: { currency: "USD", minorUnits: 1299 }, orderRef: "order-123" };
    expect(await fixture.service.ingestConversion({ source, event: purchase })).toMatchObject({ ok: true, value: { status: "accepted" } });
    expect(fixture.repo.inspect({ scope }).events).toEqual([purchase]);
    expect(JSON.stringify(fixture.repo.inspect({ scope }))).not.toContain("click-1");
  });
  it.each(["identifiers", "eventType", "adjustment", "adjustments"])("rejects forbidden durable field %s", async field => {
    const fixture = createServiceFixture({});
    expect(await fixture.service.ingestConversion({ source, event: { ...event, [field]: { click_id: "raw-click" } } })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(fixture.repo.inspect({ scope }).events).toHaveLength(0);
  });
  it("rejects malformed digests, empty definitions and invalid money", async () => {
    const fixture = createServiceFixture({});
    for (const invalid of [
      { ...event, identifierDigests: { click_id: "raw-click" } },
      { ...event, definitionId: "" },
      { ...event, value: { currency: "USD", minorUnits: -1 } },
    ]) expect(await fixture.service.ingestConversion({ source, event: invalid })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(fixture.repo.inspect({ scope }).jobs).toHaveLength(0);
  });
  it("keeps identity stable when reserved optional value/order fields are absent", async () => {
    const fixture = createServiceFixture({});
    const first = await fixture.service.ingestConversion({ source, event });
    expect(first).toMatchObject({ ok: true, value: { status: "accepted" } });
    const duplicate = await fixture.service.ingestConversion({ source, event: { ...event, value: undefined, orderRef: undefined } });
    expect(duplicate).toMatchObject({ ok: true, value: { status: "duplicate" } });
    if (first.ok && duplicate.ok) expect(duplicate.value.jobId).toBe(first.value.jobId);
    expect(fixture.repo.inspect({ scope }).jobs).toHaveLength(1);
  });
  it("cancelled ingress cannot commit", async () => {
    const fixture = createServiceFixture({});
    expect(await fixture.service.ingestConversion({ source, event }, { signal: AbortSignal.abort() })).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(fixture.repo.inspect({ scope }).events).toHaveLength(0);
  });
});
describe("atomic SQL inbox/outbox", () => {
  it("rolls back a derived lead event and its job together, then retries the same identity", async () => {
    const storage = createSqlFixture({}), dependencies = createServiceFixture({});
    const service = createMeasureService({ ...dependencies, repo: createSqlMeasureRepo(storage) }, { authentication: dependencies.authentication });
    const { eventId: _unused, ...outcome } = event;
    const input: LeadOutcomeInput = { source, leadId: "lead-1", event: { ...outcome, definitionId: "qualified" } };
    storage.failNextInboxInsert();
    expect(await service.ingestLeadOutcome(input)).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(storage.counts()).toEqual({ events: 0, jobs: 0 });
    expect(await service.ingestLeadOutcome(input)).toMatchObject({ ok: true, value: { eventId: "lead-1:qualified", status: "accepted" } });
    expect(storage.counts()).toEqual({ events: 1, jobs: 1 });
  });
  it("rolls back enqueue when inbox insertion fails, then succeeds on retry", async () => {
    const fixture = createSqlFixture({});
    const repo = createSqlMeasureRepo(fixture);
    fixture.failNextInboxInsert();
    expect(await repo.appendConversion({ source, event })).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(fixture.counts()).toEqual({ events: 0, jobs: 0 });
    expect(await repo.appendConversion({ source, event })).toMatchObject({ ok: true, value: { status: "accepted" } });
    expect(fixture.counts()).toEqual({ events: 1, jobs: 1 });
  });
  it("rolls back a typed enqueue failure without accepting the event", async () => {
    const fixture = createSqlFixture({});
    const repo = createSqlMeasureRepo(fixture);
    fixture.failNextEnqueue();
    expect(await repo.appendConversion({ source, event })).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(fixture.counts()).toEqual({ events: 0, jobs: 0 });
  });
  it("cancellation during enqueue rolls back both participants", async () => {
    const fixture = createSqlFixture({});
    const controller = new AbortController();
    const jobs = { async enqueue(input: Parameters<typeof fixture.jobs.enqueue>[0]) {
      const outcome = await fixture.jobs.enqueue(input);
      controller.abort();
      return outcome;
    } };
    const repo = createSqlMeasureRepo({ database: fixture.database, jobs });
    expect(await repo.appendConversion({ source, event }, { signal: controller.signal })).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(fixture.counts()).toEqual({ events: 0, jobs: 0 });
  });
  it("carries original scope/correlation/trace through the job transaction", async () => {
    const fixture = createSqlFixture({});
    await createSqlMeasureRepo(fixture).appendConversion({ source, event });
    const row = fixture.handle.prepare("SELECT context_json FROM fixture_jobs").get() as { context_json: string };
    expect(JSON.parse(row.context_json)).toEqual(context);
  });
});

it("derives the lead service input from its strict public schema", () => {
  expectTypeOf<Parameters<MeasureService["ingestLeadOutcome"]>[0]>().toEqualTypeOf<LeadOutcomeInput>();
  expectTypeOf<LeadOutcomeInput["event"]["definitionId"]>().toEqualTypeOf<"qualified" | "won">();
});

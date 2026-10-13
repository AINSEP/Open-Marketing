import { describe, expect, it } from "vitest";
import { createServiceFixture } from "./service-fixture.js";
import { createMeasureService, createMemoryMeasureRepo, createMemoryMeasurementShareability, createMemoryConversionDelivery, createMemoryPlatformReporting, createMemoryMeasureJob, createMemoryTrackedLink, createMemoryMeasureAudit, createMemoryConversionSourceAuthentication, createSqlMeasureRepo } from "../index.js";
import { consent, context, createIds, event, scope, snapshot, source } from "./fixtures.js";
import { createSqlFixture } from "./sql-fixture.js";

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

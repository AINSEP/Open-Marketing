import { describe, expect, it } from "vitest";
import { createMeasureService, createMemoryPlatformReporting } from "../index.js";
import { context, event, query, snapshot, source } from "./fixtures.js";
import { createServiceFixture } from "./service-fixture.js";

describe("source-labelled CAC", () => {
  it("uses only declared OM attribution, with fractional minor units preserved", async () => {
    const f = createServiceFixture({});
    await f.service.ingestConversion({ source, event });
    await f.repo.appendAttribution!({ context, sourceId: source.sourceId, result: { resultId: "r", eventId: event.eventId, modelVersion: query.attributionModel, accountId: query.accountId, campaignId: "campaign" } });
    expect(await f.service.reportCac({ context, query })).toEqual({ ok: true, value: { definitionId: query.definitionId, accountId: query.accountId, attributionWindow: query.attributionWindow, spendSource: "platform_report", conversionSource: "om_attribution", spend: snapshot.spend, conversions: 1, cacMinorUnits: 600, modelVersion: query.attributionModel, retrievedAt: 300, watermark: 100 } });
  });
  it("zero denominator is undefined CAC (null), not zero", async () => {
    const f = createServiceFixture({});
    expect(await f.service.reportCac({ context, query })).toMatchObject({ ok: true, value: { conversions: 0, cacMinorUnits: null } });
  });
  it("reports one acquisition per customer for the selected definition", async () => {
    const f = createServiceFixture({});
    const inputs = [
      { source, event },
      { source: { ...source, sourceId: "operator" }, event: { ...event, eventId: "repeat", occurredAt: 199 } },
      { source, event: { ...event, eventId: "trial", definitionId: "trial", occurredAt: 150 } },
    ];
    for (const [index, input] of inputs.entries()) {
      expect(await f.repo.appendConversion(input)).toMatchObject({ ok: true });
      expect(await f.repo.appendAttribution!({ context, sourceId: input.source.sourceId, result: { resultId: "cac-" + index, eventId: input.event.eventId, modelVersion: query.attributionModel, accountId: query.accountId, campaignId: "campaign" } })).toMatchObject({ ok: true });
    }
    expect(await f.service.reportCac({ context, query })).toMatchObject({ ok: true, value: { definitionId: "signup", conversions: 1, cacMinorUnits: 600, watermark: 100 } });
    expect(await f.service.reportCac({ context, query: { ...query, definitionId: "trial" } })).toMatchObject({ ok: true, value: { definitionId: "trial", conversions: 1, cacMinorUnits: 600, watermark: 150 } });
  });
  it("does not reacquire the same customer in a subsequent period", async () => {
    const f = createServiceFixture({});
    for (const [index, occurredAt] of [199, 200].entries()) {
      const input = { ...event, eventId: "period-" + index, occurredAt };
      expect(await f.repo.appendConversion({ source, event: input })).toMatchObject({ ok: true });
      expect(await f.repo.appendAttribution!({ context, sourceId: source.sourceId, result: { resultId: "period-result-" + index, eventId: input.eventId, modelVersion: query.attributionModel, accountId: query.accountId, campaignId: "campaign" } })).toMatchObject({ ok: true });
    }
    expect(await f.service.reportCac({ context, query })).toMatchObject({ ok: true, value: { conversions: 1, watermark: 199 } });
    const window = { start: 200, end: 300 };
    const reports = createMemoryPlatformReporting({ snapshot: { ...snapshot, snapshotId: "next-period", window } });
    const service = createMeasureService({ ...f, reports }, { authentication: f.authentication });
    expect(await service.reportCac({ context, query: { ...query, window } })).toMatchObject({ ok: true, value: { conversions: 0, cacMinorUnits: null, watermark: 200 } });
  });
  it("preserves fractional minor units instead of rounding CAC down", async () => {
    const f = createServiceFixture({});
    for (const index of [1, 2, 3]) {
      const eventId = "fraction-" + index;
      await f.repo.appendConversion({ source, event: { ...event, eventId, subjectId: "subject-" + index } });
      await f.repo.appendAttribution!({ context, sourceId: source.sourceId, result: { resultId: "fraction-result-" + index, eventId, modelVersion: query.attributionModel, accountId: query.accountId, campaignId: "campaign" } });
    }
    const reports = createMemoryPlatformReporting({ snapshot: { ...snapshot, spend: { ...snapshot.spend, minorUnits: 1000 } } });
    const service = createMeasureService({ ...f, reports }, { authentication: f.authentication });
    expect(await service.reportCac({ context, query })).toMatchObject({ ok: true, value: { conversions: 3, cacMinorUnits: 1000 / 3 } });
  });
  it("unmapped conversions do not inflate CAC denominator", async () => {
    const f = createServiceFixture({});
    await f.service.ingestConversion({ source, event });
    await f.repo.appendAttribution!({ context, sourceId: source.sourceId, result: { resultId: "r", eventId: event.eventId, modelVersion: query.attributionModel, accountId: query.accountId, campaignId: null } });
    expect(await f.service.reportCac({ context, query })).toMatchObject({ ok: true, value: { conversions: 0 } });
  });
  it("rejects mixed currency, timezone, and period boundaries", async () => {
    const f = createServiceFixture({});
    expect(await f.service.reportCac({ context, query: { ...query, currency: "EUR" } })).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(await f.service.reportCac({ context, query: { ...query, timezone: "UTC" } })).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(await f.service.reportCac({ context, query: { ...query, window: { start: 101, end: 200 } } })).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(await f.service.reportCac({ context, query: { ...query, timezone: "Imaginary/Zone" } })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(await f.service.reportCac({ context, query: { ...query, accountId: "other-account" } })).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(await f.service.reportCac({ context, query: { ...query, attributionWindow: "7d_view" } })).toMatchObject({ ok: false, error: { code: "conflict" } });
  });
  it("rejects platform total aggregation at the service boundary", async () => {
    const f = createServiceFixture({});
    const service = createMeasureService({ ...f, reports: { async snapshot() { return { ok: true, value: { ...snapshot, platformConversions: 10000 } }; } } }, { authentication: f.authentication });
    expect(await service.reportCac({ context, query })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });
  it("late/restated observations append lineage without overwriting history", async () => {
    const f = createServiceFixture({});
    await f.service.reportCac({ context, query });
    f.clock.set({ value: 400 });
    const restated = { ...snapshot, snapshotId: "snapshot-2", restatementOf: snapshot.snapshotId, spend: { ...snapshot.spend, minorUnits: 900 }, retrievedAt: 400 };
    const service = createMeasureService({ ...f, reports: createMemoryPlatformReporting({ snapshot: restated }) }, { authentication: f.authentication });
    expect(await service.reportCac({ context, query })).toMatchObject({ ok: true, value: { spend: { minorUnits: 900 } } });
    const observations = f.repo.inspect({ scope: context.scope }).snapshots;
    expect(observations).toHaveLength(2);
    expect(observations[0].spend.minorUnits).toBe(600);
    expect(observations[1].restatementOf).toBe(snapshot.snapshotId);
  });
});

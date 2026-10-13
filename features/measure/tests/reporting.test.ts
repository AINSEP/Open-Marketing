import { describe, expect, it } from "vitest";
import { createMeasureService, createMemoryPlatformReporting } from "../index.js";
import { context, event, query, snapshot, source } from "./fixtures.js";
import { createServiceFixture } from "./service-fixture.js";

describe("source-labelled CAC", () => {
  it("uses only declared OM attribution, with fractional minor units preserved", async () => {
    const f = createServiceFixture({});
    await f.service.ingestConversion({ source, event });
    await f.repo.appendAttribution!({ context, sourceId: source.sourceId, result: { resultId: "r", eventId: event.eventId, modelVersion: query.attributionModel, accountId: query.accountId, campaignId: "campaign" } });
    expect(await f.service.reportCac({ context, query })).toEqual({ ok: true, value: { accountId: query.accountId, attributionWindow: query.attributionWindow, spendSource: "platform_report", conversionSource: "om_attribution", spend: snapshot.spend, conversions: 1, cacMinorUnits: 600, modelVersion: query.attributionModel, retrievedAt: 300, watermark: 100 } });
  });
  it("zero denominator is undefined CAC (null), not zero", async () => {
    const f = createServiceFixture({});
    expect(await f.service.reportCac({ context, query })).toMatchObject({ ok: true, value: { conversions: 0, cacMinorUnits: null } });
  });
  it("preserves fractional minor units instead of rounding CAC down", async () => {
    const f = createServiceFixture({});
    for (const index of [1, 2, 3]) {
      const eventId = "fraction-" + index;
      await f.service.ingestConversion({ source, event: { ...event, eventId } });
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

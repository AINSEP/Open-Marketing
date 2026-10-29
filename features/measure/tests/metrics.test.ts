import { describe, expect, it, vi } from "vitest";
import type { MetricBatch, PluginCapability } from "@open-marketing/contracts";
import { campaignResults, campaignResultsSchema, createMemoryMetricsRepo, syncMetrics } from "../index.js";
import { context, metricsBatch, metricsClock, metricsLeads, metricsNow, metricsQuery, metricsRequest } from "./fixtures.js";

/** All provider/lead I/O is a fixture; actual parsing, persistence and aggregation run. */
function setup(required: { batch?: MetricBatch } = {}) {
  const batch = required.batch ?? metricsBatch, repo = createMemoryMetricsRepo({});
  const report = vi.fn<PluginCapability<"report.metrics.v1">>(async () => ({ ok: true, value: batch }));
  const leads = { cohort: vi.fn(metricsLeads.cohort) }, request = metricsRequest({ batch });
  const input = { context, request, report, repo, clock: metricsClock };
  return { repo, report, leads, input, options: { signal: new AbortController().signal }, results: { context, query: metricsQuery, repo, leads, clock: metricsClock } };
}
describe("bounded reporting sync", () => {
  it("invokes once with exact context/account/input and persists before success", async () => {
    const fixture = setup();
    expect(await syncMetrics(fixture.input, fixture.options)).toEqual({ ok: true, value: { syncId: "sync-1", status: "stored" } });
    expect(fixture.report.mock.calls).toEqual([[{ context, connection: { connectionId: "connection-1", accountId: "account-1" }, input: fixture.input.request.input }, fixture.options]]);
    expect(await syncMetrics(fixture.input, fixture.options)).toMatchObject({ ok: true, value: { status: "existing" } });
    expect(await campaignResults(fixture.results)).toMatchObject({ ok: true, value: { complete: true } });
  });
  it.each([undefined, { ok: true, value: { ...metricsBatch, rows: [{ ...metricsBatch.rows[0], metrics: { spend: "1.5" } }] } }, { ok: false, error: { code: "not_implemented" } }])("rejects malformed capability outcomes without persistence: %j", async response => {
    const fixture = setup(); fixture.report.mockResolvedValue(response as never);
    expect(await syncMetrics(fixture.input, fixture.options)).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(await fixture.repo.readDays({ context, query: { ...metricsQuery, grain: "campaign" } })).toEqual({ ok: true, value: [] });
  });
  it.each(["pluginId", "connectionId", "accountId"] as const)("rejects mismatched %s", async key => {
    const fixture = setup(), batch = { ...metricsBatch, [key]: "other" };
    if (key === "pluginId") batch.mapping = { ...batch.mapping, pluginId: "other" };
    fixture.report.mockResolvedValue({ ok: true, value: batch });
    expect(await syncMetrics(fixture.input, fixture.options)).toMatchObject({ ok: false, error: { code: "conflict" } });
  });
  it("rejects a different valid grain or date window", async () => {
    const fixture = setup();
    fixture.report.mockResolvedValue({ ok: true, value: { ...metricsBatch, grain: "account", mapping: { ...metricsBatch.mapping, grains: { account: {} } }, rows: [], reach: undefined } });
    expect(await syncMetrics(fixture.input, fixture.options)).toMatchObject({ ok: false, error: { code: "conflict" } });
    fixture.report.mockResolvedValue({ ok: true, value: { ...metricsBatch, days: { start: "2026-10-01", end: "2026-10-04" } } });
    expect(await syncMetrics(fixture.input, fixture.options)).toMatchObject({ ok: false, error: { code: "conflict" } });
  });
  it("rejects future evidence and requires a bounded request/deadline", async () => {
    const fixture = setup(); fixture.report.mockResolvedValue({ ok: true, value: { ...metricsBatch, retrievedAt: metricsNow + 1 } });
    expect(await syncMetrics(fixture.input, fixture.options)).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    fixture.report.mockClear();
    expect(await syncMetrics(fixture.input)).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(await syncMetrics({ ...fixture.input, request: { ...fixture.input.request, input: { grain: "campaign", days: { start: "2026-10-01", end: "2026-11-02" } } } }, fixture.options)).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(fixture.report).not.toHaveBeenCalled();
  });
  it("does not persist after cancellation during the capability call", async () => {
    const fixture = setup(), controller = new AbortController();
    fixture.report.mockImplementation(async () => { controller.abort(); return { ok: true, value: metricsBatch }; });
    expect(await syncMetrics(fixture.input, { signal: controller.signal })).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(await fixture.repo.readDays({ context, query: { ...metricsQuery, grain: "campaign" } })).toEqual({ ok: true, value: [] });
  });
  it("preserves typed unsupported failures and hides thrown provider details", async () => {
    const fixture = setup(), error = { code: "not_implemented" as const, message: "No reporting", retryable: false };
    fixture.report.mockResolvedValue({ ok: false, error }); expect(await syncMetrics(fixture.input, fixture.options)).toEqual({ ok: false, error });
    fixture.report.mockRejectedValue(new Error("secret provider payload"));
    expect(await syncMetrics(fixture.input, fixture.options)).toEqual({ ok: false, error: { code: "unavailable", message: "Reporting boundary failed", retryable: false } });
  });
  it("fails a sync when persistence fails, and observers cannot undo a committed append", async () => {
    const fixture = setup(), error = { code: "unavailable" as const, message: "Storage unavailable", retryable: false };
    const append = vi.fn(async () => ({ ok: false as const, error }));
    expect(await syncMetrics({ ...fixture.input, repo: { ...fixture.repo, append } }, fixture.options)).toEqual({ ok: false, error }); expect(append).toHaveBeenCalledOnce();
    expect(await fixture.repo.readDays({ context, query: { ...metricsQuery, grain: "campaign" } })).toEqual({ ok: true, value: [] });
    const observer = { observe: vi.fn(() => { throw new Error("telemetry unavailable"); }) };
    expect(await syncMetrics(fixture.input, { ...fixture.options, observer })).toMatchObject({ ok: true, value: { status: "stored" } });
    expect(observer.observe).toHaveBeenCalledWith({ operation: "measure.sync_metrics", outcome: "succeeded", correlationId: context.correlationId, traceId: context.traceId, runId: undefined });
  });
});
describe("source-labelled campaign results", () => {
  it("sums exact micros, derives ratios and joins the creation cohort once", async () => {
    const fixture = setup(); await syncMetrics(fixture.input, fixture.options);
    const result = await campaignResults(fixture.results);
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(campaignResultsSchema.safeParse(result.value).success).toBe(true);
    expect(result.value.campaigns[0]).toMatchObject({ vendorSource: "report.metrics.v1", metrics: { spend: "9007199254741000", impressions: "30", clicks: "5", vendorConversions: "1000000" }, ratios: { ctr: { status: "exact", numerator: "5", denominator: "30" }, cpcMicros: { status: "exact", numerator: "9007199254741000", denominator: "5" } }, verifiedLeads: { status: "available", count: 3 } });
    expect(result.value.periodReach).toEqual([{ syncId: "sync-1", days: metricsBatch.days, reach: metricsBatch.reach }]);
    expect(result.value.observations[0]).toMatchObject({ ageMs: 1000, dataThrough: metricsBatch.dataThrough, finality: "provisional", freshness: "fresh" });
    expect(result.value.mapping).toEqual(metricsBatch.mapping);
    expect(result.value.attributionModel).toBe("last_paid_touch_30d.v1");
    expect(result.value.workspaceUnattributed).toEqual({ status: "available", count: 2 });
    for (const observation of result.value.observations) expect(observation).not.toHaveProperty("mapping");
    expect(fixture.leads.cohort.mock.calls).toEqual([[{ context, pluginId: metricsQuery.pluginId, accountId: metricsQuery.accountId, campaigns: [result.value.campaigns[0]!.campaign], days: metricsQuery.days, timezone: metricsBatch.timezone }, undefined]]);
  });
  it("preserves unsupported, unavailable and exact zero without floating point", async () => {
    const batch = structuredClone(metricsBatch); delete batch.mapping.grains.campaign!.vendorConversionValue;
    for (const row of batch.rows) { delete row.metrics.vendorConversionValue; row.metrics.clicks = "0"; } batch.rows[0]!.metrics.spend = null;
    const fixture = setup({ batch }); await syncMetrics(fixture.input, fixture.options);
    expect(await campaignResults(fixture.results)).toMatchObject({ ok: true, value: { campaigns: [{ metrics: { spend: null, clicks: "0" }, ratios: { vendorRoas: { status: "unsupported" }, cpcMicros: { status: "unavailable" } } }] } });
  });
  it("reports zero denominators and refuses aggregates above the shared contract cap", async () => {
    const batch = structuredClone(metricsBatch); for (const row of batch.rows) row.metrics.clicks = "0";
    const fixture = setup({ batch }); await syncMetrics(fixture.input, fixture.options);
    expect(await campaignResults(fixture.results)).toMatchObject({ ok: true, value: { campaigns: [{ ratios: { cpcMicros: { status: "zero_denominator" } } }] } });
    const overflow = structuredClone(metricsBatch); for (const row of overflow.rows) row.metrics.spend = "9".repeat(38);
    const capped = setup({ batch: overflow }); await syncMetrics(capped.input, capped.options);
    expect(await campaignResults(capped.results)).toMatchObject({ ok: false, error: { code: "limit_exceeded" } });
  });
  it.each(["currency", "timezone", "mapping"] as const)("rejects incompatible %s across days", async dimension => {
    const fixture = setup(); await syncMetrics(fixture.input, fixture.options);
    const batch = structuredClone(metricsBatch); batch.days = { start: "2026-10-02", end: "2026-10-03" }; batch.rows = [batch.rows[1]!]; batch.retrievedAt++;
    if (dimension === "currency") batch.currency = "EUR";
    if (dimension === "timezone") batch.timezone = "UTC";
    if (dimension === "mapping") batch.mapping.grains.campaign!.clicks!.meaning = "link clicks";
    await fixture.repo.append({ context, batch, request: metricsRequest({ batch, syncId: "sync-2" }) });
    expect(await campaignResults(fixture.results)).toMatchObject({ ok: false, error: { code: "conflict" } }); expect(fixture.leads.cohort).not.toHaveBeenCalled();
  });
  it("exposes missing/partial coverage, empty days and absent lead evidence", async () => {
    const batch = { ...metricsBatch, complete: false, rows: [], days: { start: "2026-10-01", end: "2026-10-02" } }, fixture = setup({ batch }); await syncMetrics(fixture.input, fixture.options);
    expect(await campaignResults(fixture.results)).toMatchObject({ ok: true, value: { complete: false, campaigns: [{ verifiedLeads: { status: "available", count: 3 } }], missingDays: ["2026-10-02"] } }); expect(fixture.leads.cohort).toHaveBeenCalledOnce();
  });
  it("returns a null mapping when no observations exist", async () => {
    const fixture = setup();
    expect(await campaignResults(fixture.results)).toMatchObject({ ok: true, value: { mapping: null, observations: [], campaigns: [], workspaceUnattributed: { status: "unavailable", reason: "unavailable" } } });
    expect(fixture.leads.cohort).not.toHaveBeenCalled();
  });
  it("keeps vendor evidence on lead failures, missing keys and explicit zero", async () => {
    const fixture = setup(); await syncMetrics(fixture.input, fixture.options);
    fixture.leads.cohort.mockRejectedValueOnce(new Error("offline"));
    expect(await campaignResults(fixture.results)).toMatchObject({ ok: true, value: { campaigns: [{ metrics: { clicks: "5" }, verifiedLeads: { status: "unavailable", reason: "unavailable" } }], workspaceUnattributed: { status: "unavailable", reason: "unavailable" } } });
    fixture.leads.cohort.mockResolvedValueOnce({ ok: true, value: { counts: [], unattributed: 0 } });
    expect(await campaignResults(fixture.results)).toMatchObject({ ok: true, value: { campaigns: [{ verifiedLeads: { status: "unavailable" } }] } });
    const response = await metricsLeads.cohort({ context, pluginId: metricsQuery.pluginId, accountId: metricsQuery.accountId, campaigns: [], days: metricsQuery.days, timezone: "UTC" });
    if (response.ok) response.value.counts[0]!.count = 0;
    fixture.leads.cohort.mockResolvedValueOnce(response);
    expect(await campaignResults(fixture.results)).toMatchObject({ ok: true, value: { campaigns: [{ verifiedLeads: { status: "available", count: 0 } }] } });
  });
  it("rejects unexpected and duplicate CampaignKeys from the lead port", async () => {
    const fixture = setup(); await syncMetrics(fixture.input, fixture.options);
    const count = { campaign: { pluginId: "ads", accountId: "other", vendorCampaignId: "campaign-1" }, count: 1 };
    for (const counts of [[count], [{ ...count, campaign: { ...count.campaign, pluginId: "foreign", accountId: "account-1" } }], [{ ...count, campaign: { ...count.campaign, accountId: "account-1" } }, { ...count, campaign: { ...count.campaign, accountId: "account-1" } }]]) {
      fixture.leads.cohort.mockResolvedValueOnce({ ok: true, value: { counts, unattributed: 0 } }); expect(await campaignResults(fixture.results)).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    }
  });
  it.each([false, true])("includes lead-only rows with supported null cells, including empty vendor rows: %s", async empty => {
    const batch = structuredClone(metricsBatch);
    delete batch.mapping.grains.campaign!.vendorConversionValue;
    for (const row of batch.rows) delete row.metrics.vendorConversionValue;
    if (empty) batch.rows = [];
    const fixture = setup({ batch }); await syncMetrics(fixture.input, fixture.options);
    const campaign = { pluginId: metricsQuery.pluginId, accountId: metricsQuery.accountId, vendorCampaignId: "lead-only" };
    fixture.leads.cohort.mockResolvedValueOnce({ ok: true, value: { counts: [{ campaign, count: 4 }], unattributed: 0 } });
    const result = await campaignResults(fixture.results);
    expect(result.ok).toBe(true); if (!result.ok) throw new Error("Results failed");
    const leadOnly = result.value.campaigns.find(row => row.campaign.vendorCampaignId === "lead-only");
    expect(leadOnly).toMatchObject({ campaign, vendorSource: "report.metrics.v1", metrics: { spend: null, impressions: null, clicks: null, vendorConversions: null }, ratios: { ctr: { status: "unavailable" }, vendorRoas: { status: "unsupported" } }, verifiedLeads: { status: "available", count: 4 } });
    expect(leadOnly!.metrics).not.toHaveProperty("vendorConversionValue");
    expect(result.value.workspaceUnattributed).toEqual({ status: "available", count: 0 });
    expect(result.value.campaigns).toHaveLength(empty ? 1 : 2);
    expect(campaignResultsSchema.safeParse(result.value).success).toBe(true);
  });
  it("bounds the combined vendor and lead-only campaign union", async () => {
    const fixture = setup(); await syncMetrics(fixture.input, fixture.options);
    fixture.leads.cohort.mockResolvedValueOnce({ ok: true, value: { counts: Array.from({ length: 5000 }, (_, index) => ({ campaign: { pluginId: metricsQuery.pluginId, accountId: metricsQuery.accountId, vendorCampaignId: "lead-" + index }, count: 1 })), unattributed: 0 } });
    expect(await campaignResults(fixture.results)).toMatchObject({ ok: false, error: { code: "limit_exceeded" } });
  });
});

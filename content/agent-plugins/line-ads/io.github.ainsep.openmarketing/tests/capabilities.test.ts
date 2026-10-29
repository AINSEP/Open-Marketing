import { describe, expect, it } from "vitest";
import { campaignStatusOutputSchema, metricBatchSchema, pluginConfigurationSchema } from "@open-marketing/contracts";
import type { PluginCapability, ServiceContext } from "@open-marketing/contracts";
import { createCapabilities } from "../src/index.js";
import { capabilityFixture, context, now, statusPage } from "./fixtures.js";

const connection = { connectionId: "connection", accountId: "123" };
const statusCall: Parameters<PluginCapability<"campaign.status.v1">>[0] = { context, connection, input: { vendorCampaignIds: ["456", "457", "458"] } };
const metricsCall: Parameters<PluginCapability<"report.metrics.v1">>[0] = { context, connection, input: { grain: "campaign", days: { start: "2026-10-20", end: "2026-10-22" } } };

describe("LINE canonical capabilities", () => {
  it("binds status and daily metrics without startup effects", () => {
    const f = capabilityFixture();
    expect(Object.keys(f.capabilities)).toEqual(["campaign.status.v1", "report.metrics.v1"]);
    expect(f.credentialCalls).toEqual([]); expect(f.calls).toEqual([]); expect(f.waits).toEqual([]);
  });
  it("reports two TW days through the real factory with BOM and a quoted comma", async () => {
    const csv = '\uFEFFDay,Campaign ID,Campaign name,Impressions,Clicks\r\n2026-10-20,456,"Campaign, Taiwan",9007199254740993,7\r\n2026-10-21,456,"Campaign, Taiwan",345,0\r\n';
    const f = capabilityFixture({ response: ({ url, requestIndex }) => {
      if (url.pathname.endsWith("/download")) return new Response(csv, { headers: { "Content-Type": "text/csv;charset=utf-8" } });
      if (requestIndex === 2) return Response.json({ id: 77, status: "CREATED" });
      return Response.json({ datas: [{ id: 77, status: requestIndex === 3 ? "PREPARING" : "READY" }] });
    } });
    Object.assign(f.binding, { country: "TW", currency: "TWD", timezone: "Asia/Taipei" });
    const configuration = pluginConfigurationSchema.parse({ scope: context.scope, ...connection, pluginDigest: "a".repeat(64), settings: {} });
    const result = await createCapabilities({ ...f.dependencies, configuration })["report.metrics.v1"]!(metricsCall);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(metricBatchSchema.safeParse(result.value).success).toBe(true);
      expect(result.value).toMatchObject({ timezone: "Asia/Taipei", currency: "TWD", dataThrough: 0, complete: true, freshness: "stale", finality: "provisional", restated: false });
      expect(result.value.rows).toEqual([
        { day: "2026-10-20", entity: { grain: "campaign", vendorCampaignId: "456" }, metrics: { impressions: "9007199254740993", clicks: "7", spend: null } },
        { day: "2026-10-21", entity: { grain: "campaign", vendorCampaignId: "456" }, metrics: { impressions: "345", clicks: "0", spend: null } },
      ]);
      expect(result.value.mapping.grains.campaign?.spend?.meaning).toContain("undocumented");
    }
    expect(f.calls[1].init).toMatchObject({ method: "POST", redirect: "error", headers: { "Content-Type": "application/json" } });
    expect(JSON.parse(String(f.calls[1].init.body))).toEqual({ level: "CAMPAIGN", since: "2026-10-20", until: "2026-10-21", breakdown: { time: "DAY" },
      filtering: { idType: "ADACCOUNT", ids: ["123"] }, includeRemove: true, fileFormat: "CSV", locale: "en" });
    expect(f.calls.map(call => new URL(call.url).pathname + new URL(call.url).search)).toEqual([
      "/api/v3/groups/G1/adaccounts?page=1&size=100&includeRemoved=true", "/api/v3/adaccounts/123/pfreports",
      "/api/v3/adaccounts/123/pfreports?ids=77&page=1&size=1", "/api/v3/adaccounts/123/pfreports?ids=77&page=1&size=1", "/api/v3/adaccounts/123/pfreports/77/download",
    ]);
    expect(f.waits).toEqual([500, 500, 2000, 500]);
    expect(f.observations).toContainEqual({ operation: "line-ads.report.metrics.v1", outcome: "succeeded", correlationId: "correlation", traceId: "trace", runId: "run" });
  });
  it("returns retryable unavailable on budget exhaustion without resubmitting or downloading", async () => {
    const f = capabilityFixture({ response: ({ requestIndex }) => Response.json(requestIndex === 2 ? { id: 77, status: "CREATED" } : { datas: [{ id: 77, status: "PREPARING" }] }) });
    const capabilities = createCapabilities({ ...f.dependencies, wait: async ({ milliseconds }) => { f.state.time += milliseconds; return { ok: true, value: undefined }; } });
    expect(await capabilities["report.metrics.v1"]!(metricsCall)).toEqual({ ok: false, error: { code: "unavailable", message: "LINE report not ready", retryable: true } });
    expect(f.calls.filter(call => call.init.method === "POST")).toHaveLength(1);
    expect(f.calls.some(call => call.url.includes("/download"))).toBe(false);
    expect(f.state.time - now).toBeGreaterThanOrEqual(25000);
    expect(f.calls.length).toBeLessThan(20);
  });
  it("reads only named IDs including removed campaigns; projects rejection and missing evidence", async () => {
    const f = capabilityFixture();
    const result = await f.capabilities["campaign.status.v1"]!(statusCall);
    expect(result).toEqual({ ok: true, value: { observedAt: now, complete: false, campaigns: [
      { vendorCampaignId: "456", status: "disapproved", disapprovalDescriptions: ["CREATIVE_REVIEW_NOT_APPROVED: Ad not approved"] },
      { vendorCampaignId: "457", status: "ended", disapprovalDescriptions: [] },
      { vendorCampaignId: "458", status: "unknown", disapprovalDescriptions: [] },
    ] } });
    if (result.ok) expect(campaignStatusOutputSchema.safeParse(result.value).success).toBe(true);
    const url = new URL(f.calls[1].url);
    expect(url.origin + url.pathname).toBe("https://ads.line.me/api/v3/adaccounts/123/campaigns");
    expect(url.searchParams.getAll("ids")).toEqual(["456", "457", "458"]);
    expect(url.searchParams.get("includeRemoved")).toBe("true");
    expect(f.calls[1].init).toMatchObject({ method: "GET", redirect: "error", headers: { Authorization: expect.stringMatching(/^Bearer /) } });
    expect(f.waits).toEqual([500]);
  });
  it.each([
    ["ACTIVE", [{ code: "ACTIVE" }], "active"],
    ["PAUSED", [], "paused"],
    ["NOT_DELIVERING", [{ code: "CAMPAIGN_ENDED" }], "ended"],
    ["NOT_DELIVERING", [{ code: "CAMPAIGN_SCHEDULED" }], "pending"],
    ["NOT_APPROVED", [{ code: "CREATIVE_REVIEW_IN_REVIEW" }], "pending"],
    ["ACTIVE", [{ code: "NEW_VENDOR_CODE" }], "unknown"],
    ["NOT_APPROVED", [{ code: "NEW_VENDOR_CODE" }], "unknown"],
    [undefined, [], "unknown"],
  ])("uses delivery evidence %s, rather than configured ACTIVE", async (deliveryStatus, deliveryStatusReasons, expected) => {
    const f = capabilityFixture({ response: () => Response.json({ datas: [{ id: 456, configuredStatus: "ACTIVE", deliveryStatus, deliveryStatusReasons }], paging: { page: 1, size: 100, totalElements: 1 } }) });
    expect(await f.capabilities["campaign.status.v1"]!({ ...statusCall, input: { vendorCampaignIds: ["456"] } })).toMatchObject({ ok: true, value: { complete: expected !== "unknown", campaigns: [{ status: expected }] } });
  });
  it.each([
    { ...statusPage, datas: [...statusPage.datas, statusPage.datas[0]], paging: { page: 1, size: 100, totalElements: 3 } },
    { ...statusPage, datas: [{ id: 999 }], paging: { page: 1, size: 100, totalElements: 1 } },
    { ...statusPage, paging: { page: 2, size: 100, totalElements: 2 } },
    { ...statusPage, paging: { page: 1, size: 100, totalElements: 101 } },
  ])("rejects duplicates, unsolicited IDs and inconsistent coverage", async page => {
    const f = capabilityFixture({ response: () => Response.json(page) });
    expect(await f.capabilities["campaign.status.v1"]!(statusCall)).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
  });
  it("preserves service identity and correlation without inventing a run ID", async () => {
    const service: ServiceContext = { scope: context.scope, serviceId: "report-worker", correlationId: "service-correlation", traceId: "service-trace" };
    const f = capabilityFixture();
    expect((await f.capabilities["campaign.status.v1"]!({ ...statusCall, context: service })).ok).toBe(true);
    expect(f.observations).toEqual([{ operation: "line-ads.campaign.status.v1", outcome: "succeeded", correlationId: "service-correlation", traceId: "service-trace" }]);
  });
  it("rejects account, scope, vendor-ID and input inflation before custody", async () => {
    const f = capabilityFixture();
    for (const call of [
      { ...statusCall, connection: { ...connection, accountId: "999" } },
      { ...statusCall, connection: { ...connection, connectionId: "foreign" } },
      { ...statusCall, context: { ...context, scope: { ...context.scope, workspaceId: "foreign" } } },
      { ...statusCall, input: { vendorCampaignIds: ["../foreign"] } },
      { ...statusCall, input: { vendorCampaignIds: ["456", "456"] } },
      { ...statusCall, input: { vendorCampaignIds: ["456"], accountId: "999" } },
    ]) expect(await f.capabilities["campaign.status.v1"]!(call as typeof statusCall)).toMatchObject({ ok: false });
    expect(f.credentialCalls).toEqual([]); expect(f.calls).toEqual([]);
  });
  it.each([
    { country: "TW", currency: "TWD", timezone: "Asia/Taipei" },
    { country: "TH", currency: "THB", timezone: "Asia/Bangkok" },
  ] as const)("reads $country status with exact server configuration and vendor account metadata", async metadata => {
    const f = capabilityFixture(); Object.assign(f.binding, metadata);
    const configuration = pluginConfigurationSchema.parse({ scope: context.scope, ...connection, pluginDigest: "a".repeat(64), settings: {} });
    const result = await createCapabilities({ ...f.dependencies, configuration })["campaign.status.v1"]!(statusCall);
    expect(result.ok).toBe(true);
    if (result.ok) expect(campaignStatusOutputSchema.safeParse(result.value).success).toBe(true);
    expect(new URL(f.calls[0].url).pathname).toBe("/api/v3/groups/G1/adaccounts");
    expect(f.calls).toHaveLength(2); expect(f.waits).toEqual([500]);
  });
  it("uses caller cancellation during custody without a plugin deadline", async () => {
    const f = capabilityFixture(), caller = new AbortController();
    f.dependencies.credentials.access = async () => { caller.abort(); return { ok: true, value: { accessToken: JSON.stringify({ accessKey: "fixture", secretKey: "fixture", groupId: "G1" }) } }; };
    expect(await f.capabilities["campaign.status.v1"]!(statusCall, { signal: caller.signal })).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(f.calls).toEqual([]); expect(f.waits).toEqual([]);
  });
  it("propagates caller cancellation and rejects malformed/oversized response bodies", async () => {
    const aborted = new AbortController(); aborted.abort();
    const f = capabilityFixture();
    expect(await f.capabilities["campaign.status.v1"]!(statusCall, { signal: aborted.signal })).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(f.credentialCalls).toEqual([]);
    for (const response of [() => new Response("{broken"), () => new Response("x".repeat(1048577))]) {
      const bad = capabilityFixture({ response });
      expect(await bad.capabilities["campaign.status.v1"]!(statusCall)).toMatchObject({ ok: false });
    }
  });
});

import { describe, expect, it } from "vitest";
import { campaignStatusOutputSchema, metricBatchSchema, metricMappingSchema, pluginConfigurationSchema } from "@open-marketing/contracts";
import { campaignStatus, reportMetrics, metricMapping, createCapabilities } from "../src/index.js";
import { context, metricsFixture, statusFixture, reportFixture } from "./fixtures.js";
import type { MetricGrain, PluginCapabilityDependencies } from "@open-marketing/contracts";

const connection = { connectionId: "connection", accountId: "123" };
const days = { start: "2026-10-12", end: "2026-10-13" };
const expectedEntities = { account: { grain: "account" }, campaign: { grain: "campaign", vendorCampaignId: "456" }, ad_group: { grain: "ad_group", vendorCampaignId: "456", vendorAdGroupId: "789" }, ad: { grain: "ad", vendorCampaignId: "456", vendorAdGroupId: "789", vendorAdId: "1011" } };
// Generated once with /usr/bin/zip -X from metricsFixture's campaign TSV; no test ZIP encoder.
const metricsZip = "UEsDBBQAAAAIAOyrW10tPo84hwAAAKMAAAAKAAAAcmVwb3J0LnRzdh2Iyw6CMBBF18O/QKbllS4Nbtip6AeQdjQT6ZQUS+LfW7mbe845WRuSfEYHw+zXmV+S8c6eLhQ55JpiJLHfITiCaSVxMPo10rZxkA2Ghe07X5Cd4pGuaV74yeTgRjtJokLpGpq2A426KxWWSsNjOoNB7JUxum36Bo2pK/xPAQJg1R4COkPxA1BLAQIeAxQAAAAIAOyrW10tPo84hwAAAKMAAAAKAAAAAAAAAAEAAACkgQAAAAByZXBvcnQudHN2UEsFBgAAAAABAAEAOAAAAK8AAAAAAA==";
/** Real canonical ABI with one bound credential, routed fetches and an injected step clock. */
function canonicalFixture() {
  const state = { time: Date.parse(days.end), developerToken: "fixture-developer-token" as string | undefined, pending: false, accountStatus: 200 };
  const calls: { url: string; init: RequestInit }[] = [];
  const credentials: { connectionId: string; accountId: string }[] = [];
  const dependencies: PluginCapabilityDependencies = {
    configuration: pluginConfigurationSchema.parse({ scope: context.scope, ...connection, pluginDigest: "a".repeat(64), settings: { currency: "EUR" } }),
    clock: { now: () => state.time }, observer: { observe: () => {} },
    wait: async ({ milliseconds }) => { state.time += milliseconds; return { ok: true, value: undefined }; },
    credentials: { access: async input => { credentials.push(input); return { ok: true, value: { accessToken: "fixture-access-token", ...(state.developerToken === undefined ? {} : { secrets: { developerToken: state.developerToken } }) } }; } },
    fetch: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      if (String(url) === "https://reports.example/report.zip") return new Response(Buffer.from(metricsZip, "base64"));
      if (String(url).endsWith("/Account/Query")) return Response.json(state.accountStatus === 200
        ? { Account: { Id: "123", CurrencyCode: "USD", ParentCustomerId: "999" } }
        : { message: "fixture-access-token " + state.developerToken }, { status: state.accountStatus });
      if (String(url).endsWith("/Submit")) return Response.json({ ReportRequestId: "report-id" });
      if (String(url).endsWith("/Poll")) return Response.json({ ReportRequestStatus: { Status: state.pending ? "Pending" : "Success", ReportDownloadUrl: "https://reports.example/report.zip" } });
      throw new Error("Unexpected fixture URL");
    },
  };
  const capabilities = createCapabilities(dependencies);
  const invoke = () => capabilities["report.metrics.v1"]!({ context, connection, input: { grain: "campaign", days } });
  return { state, calls, credentials, capabilities, invoke };
}

describe("Microsoft canonical factory", () => {
  it("uses vendor account facts, per-RPC credentials and a credential-free real ZIP download", async () => {
    const f = canonicalFixture();
    expect(f.calls).toHaveLength(0); expect(f.credentials).toHaveLength(0);
    expect(Object.keys(f.capabilities)).toEqual(["report.metrics.v1"]);
    const result = await f.invoke();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(metricBatchSchema.safeParse(result.value).success).toBe(true);
    expect(result.value).toMatchObject({ currency: "USD", rows: [{ metrics: { spend: "9007199254740993000001" } }] });
    expect(f.calls).toHaveLength(4);
    for (const call of f.calls.slice(0, 3)) {
      const headers = new Headers(call.init.headers);
      expect(headers.get("Authorization")).toBe("Bearer fixture-access-token");
      expect(headers.get("DeveloperToken")).toBe("fixture-developer-token");
    }
    expect(JSON.parse(String(f.calls[0].init.body))).toEqual({ AccountId: "123" });
    expect(new Headers(f.calls[0].init.headers).has("CustomerId")).toBe(false);
    for (const call of f.calls.slice(1, 3)) {
      expect(new Headers(call.init.headers).get("CustomerAccountId")).toBe("123");
      expect(new Headers(call.init.headers).get("CustomerId")).toBe("999");
    }
    expect(f.calls[3].init).toMatchObject({ method: "GET", redirect: "error" });
    expect(new Headers(f.calls[3].init.headers).has("Authorization")).toBe(false);
    expect(new Headers(f.calls[3].init.headers).has("DeveloperToken")).toBe(false);
    expect(f.credentials).toEqual([connection, connection, connection]);
  });
  it("fails without a developer token before any fetch", async () => {
    const f = canonicalFixture(); f.state.developerToken = undefined;
    const result = await f.invoke();
    expect(result).toMatchObject({ ok: false, error: { code: "unauthenticated" } });
    expect(JSON.stringify(result)).not.toContain("fixture-access-token");
    expect(f.calls).toHaveLength(0); expect(f.credentials).toEqual([connection]);
  });
  it("rejects a malformed plugin secret without echoing it or fetching", async () => {
    const f = canonicalFixture(); f.state.developerToken = "malformed secret sentinel";
    const result = await f.invoke();
    expect(result).toMatchObject({ ok: false, error: { code: "unauthenticated" } });
    expect(JSON.stringify(result)).not.toContain(f.state.developerToken);
    expect(f.credentials).toEqual([connection]); expect(f.calls).toHaveLength(0);
  });
  it("never returns secret-bearing vendor error text", async () => {
    const f = canonicalFixture(); f.state.accountStatus = 401;
    const result = await f.invoke();
    expect(result).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(JSON.stringify(result)).not.toContain("fixture-access-token");
    expect(JSON.stringify(result)).not.toContain("fixture-developer-token");
  });
  it("expires pending polling at 25 seconds instead of returning an empty batch", async () => {
    const f = canonicalFixture(); f.state.pending = true;
    expect(await f.invoke()).toMatchObject({ ok: false, error: { code: "expired" } });
    expect(f.state.time - Date.parse(days.end)).toBe(25000);
    expect(f.calls.filter(call => call.url.endsWith("/Poll"))).toHaveLength(5);
    expect(f.calls.some(call => call.init.method === "GET")).toBe(false);
  });
});
/** Real transport and ZIP lifecycle with synthetic effects, exercised through the public ABI. */
function metricsCall(required: { f: ReturnType<typeof reportFixture>; grain?: MetricGrain }) {
  return reportMetrics({ dependencies: required.f.dependencies, context, connection, input: { grain: required.grain ?? "campaign", days } });
}

describe("Microsoft frozen reporting capabilities", () => {
  it("declares validated support and actual conversion definitions", () => {
    expect(metricMappingSchema.safeParse(metricMapping).success).toBe(true);
    expect(metricMapping.grains.campaign?.vendorConversions?.vendorField).toBe("ConversionsQualified");
  });
  it.each(["account", "campaign", "ad_group", "ad"] as const)("requests and decodes the %s grain", async grain => {
    const f = metricsFixture({ grain });
    const result = await metricsCall({ f, grain });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(metricBatchSchema.safeParse(result.value).success).toBe(true);
    expect(result.value.rows).toEqual([{ day: "2026-10-12", entity: expectedEntities[grain], metrics: { spend: "9007199254740993000001", impressions: "0", clicks: null, vendorConversions: "500000", vendorConversionValue: "2500000" } }]);
    expect(result.value).toMatchObject({ complete: true, dataThrough: Date.parse(days.end), freshness: "stale", finality: "provisional", restated: false, timezone: "UTC" });
    const report = JSON.parse(String(f.calls[0].init.body)).ReportRequest;
    expect(report.Type).toBe(({ account: "Account", campaign: "Campaign", ad_group: "AdGroup", ad: "Ad" })[grain] + "PerformanceReportRequest");
    expect(report.Time.CustomDateRangeEnd).toEqual({ Year: 2026, Month: 10, Day: 12 });
    expect(f.dispatches).toHaveLength(3);
    expect(f.dispatches.every(item => item.effect.effects.join() === "read")).toBe(true);
  });
  it.each(["JPY", "KRW"])("whole %s units are a million micros", async currency => {
    const f = metricsFixture({ grain: "campaign", currency }); f.state.text = f.state.text.replace("9007199254740993.000001", "123");
    expect(await metricsCall({ f })).toMatchObject({ ok: true, value: { currency, rows: [{ metrics: { spend: "123000000" } }] } });
  });
  it("returns UTC buckets without requiring account-timezone metadata", async () => {
    const f = metricsFixture({ grain: "campaign" });
    expect(await metricsCall({ f })).toMatchObject({ ok: true, value: { timezone: "UTC", complete: true, dataThrough: Date.parse(days.end) } });
    expect(f.calls).toHaveLength(2);
  });
  it("does not invent a zero row for a successful empty report", async () => {
    const f = reportFixture(); f.state.responses[1] = { ReportRequestStatus: { Status: "Success", ReportDownloadUrl: null } };
    expect(await metricsCall({ f })).toMatchObject({ ok: true, value: { rows: [], complete: true, freshness: "stale" } });
    expect(f.downloads).toHaveLength(0);
  });
  it.each([
    ["duplicate entity/day", ({ text }: { text: string }) => text + text.split("\n")[1] + "\n", "protocol_mismatch"],
    ["foreign account", ({ text }: { text: string }) => text.replace("123\t456", "999\t456"), "forbidden"],
    ["wrong currency", ({ text }: { text: string }) => text.replace("\tUSD\t", "\tEUR\t"), "forbidden"],
    ["outside date", ({ text }: { text: string }) => text.replace("2026-10-12", "2026-10-13"), "protocol_mismatch"],
    ["fractional precision", ({ text }: { text: string }) => text.replace("0.500000", "0.0000001"), "protocol_mismatch"],
    ["malformed column", ({ text }: { text: string }) => text.replace("Revenue", "Unknown"), "protocol_mismatch"],
    ["row limit", ({ text }: { text: string }) => text.split("\n")[0] + "\n" + (text.split("\n")[1] + "\n").repeat(5001), "limit_exceeded"],
  ] as const)("rejects %s without returning a partial batch", async (_label, transform, code) => {
    const f = metricsFixture({ grain: "campaign" }); f.state.text = transform({ text: f.state.text });
    expect(await metricsCall({ f })).toMatchObject({ ok: false, error: { code } });
  });
  it("rejects wrong binding, invalid input and cancellation before I/O", async () => {
    const f = metricsFixture({ grain: "campaign" });
    expect(await reportMetrics({ dependencies: f.dependencies, context, connection: { ...connection, accountId: "999" }, input: { grain: "campaign", days } })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(await reportMetrics({ dependencies: f.dependencies, context, connection, input: { grain: "campaign", days: { ...days, end: days.start } } })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(await reportMetrics({ dependencies: f.dependencies, context, connection, input: { grain: "campaign", days } }, { signal: AbortSignal.abort() })).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(f.calls).toHaveLength(0); expect(f.credentials).toHaveLength(0);
  });
  it("preserves a service principal and blocks admission withdrawn during credentials", async () => {
    const f = metricsFixture({ grain: "campaign" }); f.state.hook = () => { f.state.admitted = false; };
    const service = { scope: context.scope, serviceId: "measure", correlationId: "correlation", traceId: "trace" };
    expect(await reportMetrics({ dependencies: f.dependencies, context: service, connection, input: { grain: "campaign", days } })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(f.dispatches[0].context.principal).toEqual({ kind: "service", serviceId: "measure" }); expect(f.calls).toHaveLength(0);
  });
  it("fails expired polling without resubmitting", async () => {
    const f = metricsFixture({ grain: "campaign" }); f.state.responses = [{ ReportRequestId: "report-id" }, ...Array.from({ length: 6 }, () => ({ ReportRequestStatus: { Status: "Pending" } }))];
    expect(await metricsCall({ f })).toMatchObject({ ok: false, error: { code: "expired" } });
    expect(f.calls.filter(call => call.url.endsWith("/Submit"))).toHaveLength(1);
  });
});

describe("Microsoft campaign status", () => {
  it("preserves earlier observations when 160 groups exhaust the 25-second soft budget", async () => {
    const f = statusFixture();
    f.state.responses = [{ Campaigns: [{ Id: "456", CampaignType: "Search", Status: "Paused" }, { Id: "777", CampaignType: "Search", Status: "Active" }] }, { AdGroups: [] },
      { AdGroups: Array.from({ length: 160 }, (_, index) => ({ Id: String(index + 1) })) }, ...Array.from({ length: 160 }, () => [{ Ads: [] }, { Keywords: [] }]).flat()];
    f.state.fetchHook = () => f.advanceTime({ milliseconds: 100 });
    const result = await campaignStatus({ dependencies: f.dependencies, context, connection, input: { vendorCampaignIds: ["456", "777"] } });
    expect(result).toMatchObject({ ok: true, value: { complete: false, campaigns: [{ status: "paused" }, { status: "unknown" }] } });
    expect(f.calls).toHaveLength(250);
    expect(f.calls.at(-1)!.init.signal!.aborted).toBe(true);
    expect(f.timeouts[0].controller.signal.aborted).toBe(false);
  });
  it("skips an oversized campaign and still reads a later small campaign", async () => {
    const f = statusFixture();
    f.state.responses = [{ Campaigns: [{ Id: "456", CampaignType: "Search", Status: "Active" }, { Id: "777", CampaignType: "Search", Status: "Paused" }] },
      { AdGroups: Array.from({ length: 1001 }, (_, index) => ({ Id: String(index + 1) })) }, { AdGroups: [] }];
    expect(await campaignStatus({ dependencies: f.dependencies, context, connection, input: { vendorCampaignIds: ["456", "777"] } })).toMatchObject({ ok: true, value: { complete: false, campaigns: [{ status: "unknown" }, { status: "paused" }] } });
    expect(f.calls).toHaveLength(3);
  });
  it("keeps caller cancellation and expired credentials as failures", async () => {
    const cancelled = statusFixture(), controller = new AbortController();
    cancelled.state.fetchHook = () => controller.abort();
    expect(await campaignStatus({ dependencies: cancelled.dependencies, context, connection, input: { vendorCampaignIds: ["456"] } }, { signal: controller.signal })).toMatchObject({ ok: false, error: { code: "cancelled" } });
    const expired = statusFixture();
    const dependencies = { ...expired.dependencies, credentials: { access: async () => ({ ok: true as const, value: { accessToken: "fixture", expiresAt: 0, secrets: { developerToken: "fixture-developer-token" } } }) } };
    expect(await campaignStatus({ dependencies, context, connection, input: { vendorCampaignIds: ["456"] } })).toMatchObject({ ok: false, error: { code: "expired" } });
    expect(expired.calls).toHaveLength(0);
  });
  it("keeps valid Search results when another requested position fails", async () => {
    const f = statusFixture();
    f.state.responses[0] = { Campaigns: [{ Id: "456", CampaignType: "Search", Status: "Active" }, null], PartialErrors: [{ Index: 1, Code: 516, ErrorCode: "EntityIdFilterMismatch" }] };
    expect(await campaignStatus({ dependencies: f.dependencies, context, connection, input: { vendorCampaignIds: ["456", "777"] } })).toMatchObject({ ok: true, value: { complete: false, campaigns: [{ vendorCampaignId: "456", status: "disapproved" }, { vendorCampaignId: "777", status: "unknown" }] } });
  });
  it.each([-1, 2])("rejects invalid partial-error index %s", async Index => {
    const f = statusFixture();
    f.state.responses[0] = { Campaigns: [null], PartialErrors: [{ Index, Code: 516 }] };
    expect(await campaignStatus({ dependencies: f.dependencies, context, connection, input: { vendorCampaignIds: ["456"] } })).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
  });
  it.each([21, 40])("deduplicates and bounds reasons across %s ad groups", async count => {
    const f = statusFixture();
    const groups = Array.from({ length: count }, (_, index) => ({ Id: String(index + 1) }));
    f.state.responses = [{ Campaigns: [{ Id: "456", CampaignType: "Search", Status: "Active" }] }, { AdGroups: groups }, ...groups.flatMap((group, index) => [
      { Ads: [{ Id: "1011", EditorialStatus: "Disapproved" }] },
      { EditorialReasons: [{ AdGroupId: group.Id, AdOrKeywordId: "1011", Reasons: [{ ReasonCode: count === 21 ? 12 : index % 25 }] }] },
      { Keywords: [] },
    ])];
    const result = await campaignStatus({ dependencies: f.dependencies, context, connection, input: { vendorCampaignIds: ["456"] } });
    expect(result).toMatchObject({ ok: true, value: { complete: true, campaigns: [{ status: "disapproved" }] } });
    if (result.ok) {
      const reasons = result.value.campaigns[0].disapprovalDescriptions;
      expect(reasons).toHaveLength(count === 21 ? 1 : 20);
      expect(new Set(reasons).size).toBe(reasons.length);
    }
    expect(f.calls).toHaveLength(2 + 3 * count);
  });
  it("preserves a completed campaign when a later campaign exhausts requests", async () => {
    const f = statusFixture();
    f.state.responses = [{ Campaigns: [{ Id: "456", CampaignType: "Search", Status: "Paused" }, { Id: "777", CampaignType: "Search", Status: "Active" }] }, { AdGroups: [] },
      { AdGroups: Array.from({ length: 1000 }, (_, index) => ({ Id: String(index + 1) })) }, ...Array.from({ length: 1000 }, () => [{ Ads: [] }, { Keywords: [] }]).flat()];
    expect(await campaignStatus({ dependencies: f.dependencies, context, connection, input: { vendorCampaignIds: ["456", "777"] } })).toMatchObject({ ok: true, value: { complete: false, campaigns: [{ vendorCampaignId: "456", status: "paused" }, { vendorCampaignId: "777", status: "unknown" }] } });
    expect(f.calls).toHaveLength(1000);
  });
  it("carries scoped editorial codes and marks missing campaigns unknown", async () => {
    const f = statusFixture();
    const result = await campaignStatus({ dependencies: f.dependencies, context, connection, input: { vendorCampaignIds: ["456", "777"] } });
    expect(result).toMatchObject({ ok: true, value: { complete: false, campaigns: [{ vendorCampaignId: "456", status: "disapproved", disapprovalDescriptions: ["Microsoft editorial reason 12: Title"] }, { vendorCampaignId: "777", status: "unknown", disapprovalDescriptions: [] }] } });
    if (result.ok) expect(campaignStatusOutputSchema.safeParse(result.value).success).toBe(true);
    expect(JSON.parse(String(f.calls[0].init.body))).toEqual({ AccountId: "123", CampaignIds: ["456", "777"] });
  });
  it.each(["foreign", "duplicate", "partial_error", "foreign_reason"])("rejects %s status evidence", async kind => {
    const f = statusFixture();
    if (kind === "foreign") f.state.responses[0] = { Campaigns: [{ Id: "999", CampaignType: "Search", Status: "Active" }] };
    if (kind === "duplicate") f.state.responses[0] = { Campaigns: [{ Id: "456", CampaignType: "Search", Status: "Active" }, { Id: "456", CampaignType: "Search", Status: "Active" }] };
    if (kind === "partial_error") f.state.responses[0] = { Campaigns: [], PartialErrors: [{ Code: 1 }] };
    if (kind === "foreign_reason") f.state.responses[3] = { EditorialReasons: [{ AdGroupId: "999", AdOrKeywordId: "1011", Reasons: [] }] };
    expect(await campaignStatus({ dependencies: f.dependencies, context, connection, input: { vendorCampaignIds: ["456"] } })).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
  });
  it.each(["Active", "Paused", "Deleted", "Suspended"] as const)("does not mistake %s with no ads for editorial approval", async status => {
    const f = statusFixture(); f.state.responses = [{ Campaigns: [{ Id: "456", CampaignType: "Search", Status: status }] }, { AdGroups: [] }];
    expect(await campaignStatus({ dependencies: f.dependencies, context, connection, input: { vendorCampaignIds: ["456"] } })).toMatchObject({ ok: true, value: { campaigns: [{ status: ({ Active: "unknown", Paused: "paused", Deleted: "ended", Suspended: "unknown" })[status] }] } });
  });
  it("preserves partial status at the RPC cap", async () => {
    const f = statusFixture();
    f.state.responses = [{ Campaigns: [{ Id: "456", CampaignType: "Search", Status: "Active" }] }, { AdGroups: Array.from({ length: 1000 }, (_, index) => ({ Id: String(index + 1) })) }, ...Array.from({ length: 1000 }, () => [{ Ads: [] }, { Keywords: [] }]).flat()];
    expect(await campaignStatus({ dependencies: f.dependencies, context, connection, input: { vendorCampaignIds: ["456"] } })).toMatchObject({ ok: true, value: { complete: false, campaigns: [{ vendorCampaignId: "456", status: "unknown" }] } });
    expect(f.calls).toHaveLength(1000);
  });
  it("rejects duplicate input IDs before I/O and leaves unsupported campaign types unknown", async () => {
    const f = statusFixture();
    expect(await campaignStatus({ dependencies: f.dependencies, context, connection, input: { vendorCampaignIds: ["456", "456"] } })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(f.calls).toHaveLength(0);
    f.state.responses[0] = { Campaigns: [{ Id: "456", CampaignType: "Shopping", Status: "Active" }] };
    expect(await campaignStatus({ dependencies: f.dependencies, context, connection, input: { vendorCampaignIds: ["456"] } })).toMatchObject({ ok: true, value: { complete: false, campaigns: [{ vendorCampaignId: "456", status: "unknown" }] } });
  });
});

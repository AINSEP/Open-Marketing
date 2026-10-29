import { describe, expect, it } from "vitest";
import { metricBatchSchema, metricMappingSchema, campaignStatusOutputSchema } from "@open-marketing/contracts";
import type { MetricGrain } from "@open-marketing/contracts";
import { createCapabilities, reportMetrics, campaignStatus, metricMapping, xAdsTools } from "../src/index.js";
import { context, metricsFixture, factoryFixture, pasted } from "./fixtures.js";

const connection = { connectionId: "connection", accountId: "abc1" };
const days = { start: "2026-10-20", end: "2026-10-22" };
describe("X real server factory", () => {
  it("uses distinct OAuth nonces across factories with identical frozen call identity", async () => {
    const first = factoryFixture(), second = factoryFixture();
    const call = { context, connection, input: { vendorCampaignIds: ["camp1"] } };
    const results = await Promise.all([createCapabilities(first.dependencies)["campaign.status.v1"]!(call), createCapabilities(second.dependencies)["campaign.status.v1"]!(call)]);
    expect(results.every(result => result.ok)).toBe(true);
    const nonce = (call: typeof first.calls[number]) => /oauth_nonce="([^"]+)"/.exec(new Headers(call.init.headers).get("Authorization")!)![1];
    expect(nonce(first.calls[0])).not.toBe(nonce(second.calls[0]));
  });
  it("accepts read configuration without legacy binding or admission fields", async () => {
    const f = metricsFixture();
    const { bindingId: _binding, admitted: _admitted, ...configuration } = f.dependencies.configuration;
    expect(await reportMetrics({ dependencies: { ...f.dependencies, configuration }, context, connection, input: { grain: "campaign", days } })).toMatchObject({ ok: true, value: { complete: true } });
  });
  it("returns catalog output using vendor currency and unique signed nonces, cancelling every wait", async () => {
    const f = factoryFixture(), capabilities = createCapabilities(f.dependencies);
    expect(f.calls).toHaveLength(0); expect(f.credentialCalls).toHaveLength(0); expect(f.waits).toHaveLength(0);
    const metrics = await capabilities["report.metrics.v1"]!({ context, connection, input: { grain: "campaign", days } });
    expect(metrics).toMatchObject({ ok: true, value: { currency: "USD", timezone: "UTC", complete: true } });
    if (metrics.ok) expect(metricBatchSchema.safeParse(metrics.value).success).toBe(true);
    const status = await capabilities["campaign.status.v1"]!({ context, connection, input: { vendorCampaignIds: ["camp1"] } });
    expect(status).toMatchObject({ ok: true, value: { campaigns: [{ status: "active" }] } });
    if (status.ok) expect(campaignStatusOutputSchema.safeParse(status.value).success).toBe(true);
    const headers = f.calls.map(call => new Headers(call.init.headers).get("Authorization")!);
    const nonces = headers.map(header => /oauth_nonce="([^"]+)"/.exec(header)![1]);
    expect(new Set(nonces).size).toBe(f.calls.length);
    expect(headers.every(header => header.includes('oauth_signature="'))).toBe(true);
    expect(f.waits.length).toBeGreaterThan(0); expect(f.waits.every(signal => signal.aborted)).toBe(true);
  });
  it("returns typed cancellation and host-denial failures through the real factory", async () => {
    const f = factoryFixture(), controller = new AbortController();
    f.credentialHook = () => controller.abort();
    const handler = createCapabilities(f.dependencies)["campaign.status.v1"]!;
    expect(await handler({ context, connection, input: { vendorCampaignIds: ["camp1"] } }, { signal: controller.signal })).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(f.calls).toHaveLength(0); expect(f.waits.every(signal => signal.aborted)).toBe(true);
    const denied = factoryFixture(); denied.setAdmission({ admitted: false });
    expect(await createCapabilities(denied.dependencies)["campaign.status.v1"]!({ context, connection, input: { vendorCampaignIds: ["camp1"] } })).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(denied.calls).toHaveLength(0); expect(denied.waits.every(signal => signal.aborted)).toBe(true);
  });
  it("rejects foreign bindings and malformed configuration before credentials", async () => {
    const f = factoryFixture();
    expect(await createCapabilities(f.dependencies)["campaign.status.v1"]!({ context, connection: { ...connection, accountId: "foreign" }, input: { vendorCampaignIds: ["camp1"] } })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    const dependencies = { ...f.dependencies, configuration: { ...f.dependencies.configuration, currency: "USD" } };
    expect(await createCapabilities(dependencies)["campaign.status.v1"]!({ context, connection, input: { vendorCampaignIds: ["camp1"] } })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(f.credentialCalls).toHaveLength(0); expect(f.calls).toHaveLength(0);
  });
});
/** Public frozen ABI with the real signed/fenced HTTP adapter and synthetic responses only. */
function metricsCall(required: { f: ReturnType<typeof metricsFixture>; grain?: MetricGrain; days?: typeof days }) {
  return reportMetrics({ dependencies: required.f.dependencies, context, connection, input: { grain: required.grain ?? "campaign", days: required.days ?? days } });
}
/** Independent scoped status page, including unavailable requested IDs when omitted. */
function statusPage(required: { rows?: unknown[]; cursor?: string | null; accountId?: string } = {}) {
  return { request: { params: { account_id: required.accountId ?? "abc1" } }, next_cursor: required.cursor ?? null,
    data: required.rows ?? [{ id: "camp1", currency: "USD", deleted: false, entity_status: "ACTIVE", servable: true, reasons_not_servable: [] }] };
}

describe("X frozen metrics", () => {
  it("keeps earlier entity batches when the 25s budget expires", async () => {
    const f = metricsFixture(), fetch = f.dependencies.fetch;
    f.state.pages.campaigns = statusPage({ rows: Array.from({ length: 21 }, (_, index) => ({ id: "c" + index, currency: "USD", deleted: false, entity_status: "ACTIVE" })) });
    let reads = 0;
    const dependencies = { ...f.dependencies, fetch: (async (value, init) => {
      const response = await fetch(value, init), url = new URL(String(value));
      if (url.searchParams.get("granularity") !== "DAY") return response;
      const body = await response.json();
      body.data = url.searchParams.get("entity_ids")!.split(",").map(id => ({ ...body.data[0], id }));
      if (++reads === 3) f.state.time += 25001;
      return Response.json(body);
    }) as typeof globalThis.fetch };
    const result = await reportMetrics({ dependencies, context, connection, input: { grain: "campaign", days } });
    expect(result).toMatchObject({ ok: true, value: { complete: false, dataThrough: 0 } });
    if (result.ok) {
      expect(result.value.rows).toHaveLength(40);
      expect(result.value.rows.every(row => row.entity.grain === "campaign" && row.entity.vendorCampaignId !== "c20")).toBe(true);
    }
    expect(reads).toBe(3);
  });
  it("maps an in-flight soft deadline to incomplete metrics and preserves caller cancellation", async () => {
    const f = metricsFixture(), soft = new AbortController();
    const fetch = f.dependencies.fetch;
    const dependencies = { ...f.dependencies, timeoutSignal: ({ timeoutMs }: { timeoutMs: number }) => timeoutMs === 25000 ? soft.signal : new AbortController().signal,
      fetch: (async (value, init) => {
        if (!new URL(String(value)).searchParams.has("granularity")) return fetch(value, init);
        soft.abort();
        expect(init?.signal?.aborted).toBe(true);
        throw new Error("fixture abort");
      }) as typeof globalThis.fetch };
    expect(await reportMetrics({ dependencies, context, connection, input: { grain: "campaign", days } })).toMatchObject({ ok: true, value: { complete: false, rows: [] } });
    expect(await reportMetrics({ dependencies, context, connection, input: { grain: "campaign", days } }, { signal: AbortSignal.abort() })).toMatchObject({ ok: false, error: { code: "cancelled" } });
  });
  it("keeps native tools unchanged and declares account impressions separately", () => {
    expect(xAdsTools.map(tool => tool.name)).toEqual(["list_accounts", "list_campaigns", "report"]);
    expect(metricMappingSchema.safeParse(metricMapping).success).toBe(true);
    expect(Object.keys(metricMapping.grains.account!)).toEqual(["impressions"]);
    expect(metricMapping.grains.campaign?.vendorConversions).toBeUndefined();
  });
  it.each(["account", "campaign", "ad_group", "ad"] as const)("preserves daily %s hierarchy and sums each placement exactly once", async grain => {
    const f = metricsFixture(), result = await metricsCall({ f, grain });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(metricBatchSchema.safeParse(result.value).success).toBe(true);
    const entities = { account: { grain }, campaign: { grain, vendorCampaignId: "camp1" }, ad_group: { grain, vendorCampaignId: "camp1", vendorAdGroupId: "line1" }, ad: { grain, vendorCampaignId: "camp1", vendorAdGroupId: "line1", vendorAdId: "post1" } };
    const metrics = grain === "account" ? [{ impressions: "30" }, { impressions: "0" }] : [{ impressions: "30", clicks: "0", spend: "27021597764222979" }, { impressions: "0", clicks: "6", spend: "0" }];
    expect(result.value.rows).toEqual(metrics.map((value, index) => ({ day: ["2026-10-20", "2026-10-21"][index], entity: entities[grain], metrics: value })));
    expect(result.value).toMatchObject({ complete: true, dataThrough: Date.parse(days.end), freshness: "stale", finality: "provisional", restated: false, timezone: "UTC" });
    const analytics = f.calls.filter(call => new URL(call.url).searchParams.get("granularity") === "DAY");
    expect(analytics.map(call => new URL(call.url).searchParams.get("placement"))).toEqual(["ALL_ON_TWITTER", "SPOTLIGHT", "TREND"]);
    expect(analytics.every(call => new URL(call.url).searchParams.get("granularity") === "DAY")).toBe(true);
    expect(f.effects.every(effect => effect.effects.join() === "read")).toBe(true);
  });
  it("preserves unavailable supported cells and omits unsupported conversions", async () => {
    const f = metricsFixture(); f.state.metrics = { impressions: [0, 1], clicks: null };
    const result = await metricsCall({ f });
    expect(result).toMatchObject({ ok: true, value: { rows: [{ metrics: { impressions: "0", clicks: "0", spend: null } }, { metrics: { impressions: "3", clicks: "0", spend: null } }] } });
    if (result.ok) expect(result.value.rows[0].metrics).not.toHaveProperty("vendorConversions");
  });
  it("adds a serving placement to null arrays and null cells without losing spend", async () => {
    const f = metricsFixture();
    f.state.placementMetrics.SPOTLIGHT = { impressions: null, clicks: null, billed_charge_local_micro: null };
    f.state.placementMetrics.TREND = { impressions: [null, null], clicks: [null, null], billed_charge_local_micro: [null, null] };
    expect(await metricsCall({ f })).toMatchObject({ ok: true, value: { complete: true, rows: [
      { metrics: { spend: "9007199254740993", impressions: "10", clicks: "0" } },
      { metrics: { spend: "0", impressions: "0", clicks: "2" } },
    ] } });
  });
  it("samples currency once, then requests active IDs and their declared placements", async () => {
    const f = metricsFixture();
    f.state.active = { CAMPAIGN: [{ entity_id: "camp1", activity_start_time: "2026-10-20T00:00:00Z", activity_end_time: "2026-10-22T00:00:00Z", placements: ["ALL_ON_TWITTER"] }] };
    expect(await metricsCall({ f })).toMatchObject({ ok: true, value: { complete: true, rows: [{ metrics: { spend: "9007199254740993" } }] } });
    const urls = f.calls.map(call => new URL(call.url));
    expect(urls.some(url => url.pathname.endsWith("/active_entities"))).toBe(true);
    expect(urls.filter(url => url.pathname.endsWith("/campaigns") && url.searchParams.has("campaign_ids")).map(url => url.searchParams.get("campaign_ids"))).toEqual(["camp1"]);
    expect(urls.filter(url => url.searchParams.has("granularity")).map(url => url.searchParams.get("placement"))).toEqual(["ALL_ON_TWITTER"]);
  });
  it("filters ad metadata and parent metadata to the active hierarchy", async () => {
    const f = metricsFixture();
    expect((await metricsCall({ f, grain: "ad" })).ok).toBe(true);
    const urls = f.calls.map(call => new URL(call.url));
    expect(urls.find(url => url.pathname.endsWith("/promoted_tweets"))?.searchParams.get("promoted_tweet_ids")).toBe("post1");
    expect(urls.find(url => url.pathname.endsWith("/line_items"))?.searchParams.get("line_item_ids")).toBe("line1");
    expect(urls.find(url => url.pathname.endsWith("/campaigns") && url.searchParams.has("campaign_ids"))?.searchParams.get("campaign_ids")).toBe("camp1");
  });
  it.each(["duplicate", "placement", "foreign_account", "window"])("rejects %s active-entity evidence before metadata or analytics", async defect => {
    const f = metricsFixture(), fetch = f.dependencies.fetch;
    const dependencies = { ...f.dependencies, fetch: (async (value, init) => {
      const url = new URL(String(value));
      const response = await fetch(value, init);
      if (!url.pathname.endsWith("/active_entities")) return response;
      const page = await response.json();
      if (defect === "duplicate") page.data.push(page.data[0]);
      if (defect === "placement") page.data[0].placements = ["PUBLISHER_NETWORK"];
      if (defect === "foreign_account") page.request.params.account_id = "foreign";
      if (defect === "window") page.request.params.end_time = "2026-10-23T00:00:00Z";
      return Response.json(page);
    }) as typeof globalThis.fetch };
    expect(await reportMetrics({ dependencies, context, connection, input: { grain: "campaign", days } })).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
    expect(f.calls).toHaveLength(3);
  });
  it("reports a timezone-adjusted exclusive coverage cutoff capped at retrieval", async () => {
    const f = metricsFixture();
    f.state.pages.account = { data: { id: "abc1", timezone: "Asia/Tokyo", timezone_switch_at: "2020-01-01T00:00:00Z" } };
    expect(await metricsCall({ f })).toMatchObject({ ok: true, value: { dataThrough: Date.parse("2026-10-21T15:00:00Z") } });
    f.state.time = Date.parse("2026-10-20T15:00:00Z");
    expect(await metricsCall({ f })).toMatchObject({ ok: true, value: { dataThrough: f.state.time } });
  });
  it("missing placement coverage becomes incomplete and null, never a smaller total", async () => {
    const f = metricsFixture(); f.state.missingPlacement = "SPOTLIGHT";
    expect(await metricsCall({ f })).toMatchObject({ ok: true, value: { complete: false, dataThrough: 0, rows: [{ metrics: { spend: null, impressions: null, clicks: null } }, { metrics: { spend: null, impressions: null, clicks: null } }] } });
  });
  it("an account with no campaign currency returns an explicit metadata gap", async () => {
    const f = metricsFixture(); f.state.pages.campaigns = statusPage({ rows: [] });
    expect(await metricsCall({ f })).toMatchObject({ ok: false, error: { code: "not_implemented" } });
    expect(f.calls.some(call => new URL(call.url).searchParams.has("granularity"))).toBe(false);
  });
  it.each(["duplicate", "foreign", "wrongEcho"] as const)("rejects %s analytics atomically", async kind => {
    const f = metricsFixture(); f.state[kind] = true;
    expect(await metricsCall({ f })).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
  });
  it.each([
    { impressions: [1], clicks: [1, 2], billed_charge_local_micro: [0, 1] },
    { impressions: [1, 2], clicks: [1, -1], billed_charge_local_micro: [0, 1] },
    { impressions: [1, 2], clicks: [1, 2], billed_charge_local_micro: ["0.1", "0"] },
  ])("rejects malformed array lengths/negative counts/fractional micros", async metrics => {
    const f = metricsFixture(); f.state.metrics = metrics;
    expect(await metricsCall({ f })).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
  });
  it("rejects numeric source that would round a fractional charge into a safe integer", async () => {
    const f = metricsFixture(); f.state.metrics = { impressions: [1, 2], clicks: [0, 0], billed_charge_local_micro: ["9007199254740990.5", "0"] };
    expect(await metricsCall({ f })).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
  });
  it("rejects repeated catalog cursors/IDs and foreign hierarchy links", async () => {
    const f = metricsFixture(); f.state.pages.campaigns = statusPage({ cursor: "again" });
    expect(await metricsCall({ f })).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
    const orphan = metricsFixture(); orphan.state.pages.line_items = statusPage({ rows: [{ id: "line1", campaign_id: "foreign" }] });
    expect(await metricsCall({ f: orphan, grain: "ad_group" })).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
    const ad = metricsFixture(); ad.state.pages.promoted_tweets = statusPage({ rows: [{ id: "post1", line_item_id: "foreign" }] });
    expect(await metricsCall({ f: ad, grain: "ad" })).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
  });
  it("rejects unverified timezone history and cross-DST windows", async () => {
    const f = metricsFixture();
    f.state.pages.account = { data: { id: "abc1", timezone: "UTC", timezone_switch_at: null } };
    expect(await metricsCall({ f })).toMatchObject({ ok: false, error: { code: "not_implemented" } });
    f.state.pages.account = { data: { id: "abc1", timezone: "UTC", timezone_switch_at: "2026-10-21T00:00:00Z" } };
    expect(await metricsCall({ f })).toMatchObject({ ok: false, error: { code: "not_implemented" } });
    f.state.pages.account = { data: { id: "abc1", timezone: "America/Los_Angeles", timezone_switch_at: "2020-01-01T00:00:00Z" } };
    expect(await metricsCall({ f, days: { start: "2026-10-31", end: "2026-11-03" } })).toMatchObject({ ok: false, error: { code: "not_implemented" } });
  });
  it("bounds active entities and output rows before analytics", async () => {
    const f = metricsFixture();
    const active = Array.from({ length: 1000 }, (_, index) => ({ entity_id: "c" + index, activity_start_time: "2026-10-15T00:00:00Z", activity_end_time: "2026-10-22T00:00:00Z", placements: ["ALL_ON_TWITTER"] }));
    f.state.active = { CAMPAIGN: active };
    const fetch = f.dependencies.fetch;
    const dependencies = { ...f.dependencies, fetch: (async (value, init) => {
      const url = new URL(String(value));
      if (!url.pathname.endsWith("/campaigns")) return fetch(value, init);
      const ids = url.searchParams.get("campaign_ids")?.split(",") ?? ["c0"];
      return Response.json(statusPage({ rows: ids.map(id => ({ id, currency: "USD", deleted: false, entity_status: "ACTIVE" })) }));
    }) as typeof globalThis.fetch };
    expect(await reportMetrics({ dependencies, context, connection, input: { grain: "campaign", days: { start: "2026-10-15", end: "2026-10-22" } } })).toMatchObject({ ok: false, error: { code: "limit_exceeded" } });
    expect(f.calls.some(call => new URL(call.url).searchParams.has("granularity"))).toBe(false);
  });
  it("uses current whole-hour account offset without assuming two decimal currency units", async () => {
    const f = metricsFixture();
    f.state.pages.account = { data: { id: "abc1", timezone: "Asia/Tokyo", timezone_switch_at: "2020-01-01T00:00:00Z" } };
    const result = await metricsCall({ f });
    expect(result).toMatchObject({ ok: true, value: { timezone: "Asia/Tokyo", rows: [{ day: "2026-10-20" }] } });
    const call = f.calls.find(call => new URL(call.url).searchParams.has("granularity"))!;
    expect(new URL(call.url).searchParams.get("start_time")).toBe("2026-10-19T15:00:00.000Z");
  });
  it("keeps whole JPY micros exactly as supplied by X", async () => {
    const f = metricsFixture(); f.state.pages.campaigns = statusPage({ rows: [{ id: "camp1", currency: "JPY", deleted: false, entity_status: "PAUSED" }] });
    f.state.pages.account = { data: { id: "abc1", timezone: "UTC", timezone_switch_at: "2020-01-01T00:00:00Z" } };
    const dependencies = f.dependencies;
    expect(await reportMetrics({ dependencies, context, connection, input: { grain: "campaign", days } })).toMatchObject({ ok: true, value: { currency: "JPY", rows: [{ metrics: { spend: "27021597764222979" } }] } });
  });
  it("blocks large windows, foreign connections, duplicate inputs and cancellation before network", async () => {
    const f = metricsFixture();
    expect(await metricsCall({ f, days: { start: "2026-10-01", end: "2026-10-09" } })).toMatchObject({ ok: false, error: { code: "not_implemented" } });
    expect(await reportMetrics({ dependencies: f.dependencies, context, connection: { ...connection, connectionId: "foreign" }, input: { grain: "campaign", days } })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(await metricsCall({ f, days: { ...days, end: days.start } })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(await reportMetrics({ dependencies: f.dependencies, context, connection, input: { grain: "campaign", days } }, { signal: AbortSignal.abort() })).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(f.calls).toHaveLength(0); expect(f.credentialCalls).toHaveLength(0);
  });
  it("preserves service identity and stops when admission is withdrawn", async () => {
    const f = metricsFixture(); const principals: unknown[] = [];
    const dependencies = { ...f.dependencies, gateway: { async dispatch(input: Parameters<typeof f.dependencies.gateway.dispatch>[0]) { principals.push(input.context.principal); return input.execute(); } } };
    const service = { scope: context.scope, serviceId: "measure", correlationId: "correlation", traceId: "trace" };
    expect((await reportMetrics({ dependencies, context: service, connection, input: { grain: "campaign", days } })).ok).toBe(true);
    expect(principals.every(principal => JSON.stringify(principal) === JSON.stringify({ kind: "service", serviceId: "measure" }))).toBe(true);
    const revoked = metricsFixture(); revoked.credentialHook = () => revoked.setAdmission({ admitted: false });
    expect(await metricsCall({ f: revoked })).toMatchObject({ ok: false, error: { code: "forbidden" } }); expect(revoked.calls).toHaveLength(0);
  });
});

describe("X campaign status", () => {
  it("reads only requested IDs, keeps missing IDs unknown and validates output", async () => {
    const f = metricsFixture();
    const result = await campaignStatus({ dependencies: f.dependencies, context, connection, input: { vendorCampaignIds: ["camp1", "missing"] } });
    expect(result).toMatchObject({ ok: true, value: { complete: false, campaigns: [{ vendorCampaignId: "camp1", status: "active", disapprovalDescriptions: [] }, { vendorCampaignId: "missing", status: "unknown", disapprovalDescriptions: [] }] } });
    if (result.ok) expect(campaignStatusOutputSchema.safeParse(result.value).success).toBe(true);
    expect(new URL(f.calls[0].url).searchParams.get("campaign_ids")).toBe("camp1,missing");
  });
  it.each([
    [{ deleted: true, entity_status: "ACTIVE" }, "ended"],
    [{ deleted: false, entity_status: "PAUSED" }, "paused"],
    [{ deleted: false, entity_status: "DRAFT" }, "pending"],
    [{ deleted: false, entity_status: "ACTIVE", servable: false, reasons_not_servable: ["UNVERIFIED_REJECTION"] }, "unknown"],
    [{ deleted: false, entity_status: "FUTURE_VALUE" }, "unknown"],
  ] as const)("maps known lifecycle and leaves unverified rejection taxonomy unknown", async (status, expected) => {
    const f = metricsFixture(); f.state.pages.campaigns = statusPage({ rows: [{ id: "camp1", currency: "USD", ...status }] });
    const result = await campaignStatus({ dependencies: f.dependencies, context, connection, input: { vendorCampaignIds: ["camp1"] } });
    expect(result).toMatchObject({ ok: true, value: { campaigns: [{ status: expected, disapprovalDescriptions: "reasons_not_servable" in status ? status.reasons_not_servable : [] }] } });
    if ("reasons_not_servable" in status) {
      expect(JSON.stringify(result)).not.toContain(pasted.consumerSecret);
      expect(JSON.stringify(result)).not.toContain(pasted.accessTokenSecret);
    }
  });
  it("rejects a campaign page with more than 20 reason descriptions", async () => {
    const f = metricsFixture();
    f.state.pages.campaigns = statusPage({ rows: [{ id: "camp1", currency: "USD", deleted: false, entity_status: "ACTIVE", reasons_not_servable: Array.from({ length: 21 }, () => "UNVERIFIED_REJECTION") }] });
    expect(await campaignStatus({ dependencies: f.dependencies, context, connection, input: { vendorCampaignIds: ["camp1"] } })).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
  });
  it("rejects foreign response IDs and duplicate requested IDs", async () => {
    const f = metricsFixture(); f.state.pages.campaigns = statusPage({ rows: [{ id: "other", currency: "USD", deleted: false, entity_status: "PAUSED" }] });
    expect(await campaignStatus({ dependencies: f.dependencies, context, connection, input: { vendorCampaignIds: ["camp1"] } })).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
    const clean = metricsFixture();
    expect(await campaignStatus({ dependencies: clean.dependencies, context, connection, input: { vendorCampaignIds: ["camp1", "camp1"] } })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(clean.calls).toHaveLength(0);
  });
});

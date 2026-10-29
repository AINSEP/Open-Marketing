import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { metricBatchSchema, pluginConfigurationSchema } from "@open-marketing/contracts";
import type { PluginCapability, ServiceContext } from "@open-marketing/contracts";
import { createCapabilities, metricMapping } from "../src/index.js";
import { ad, campaign, capabilityFixture, context, dailyPage, group, now } from "./fixtures.js";

const connection = { connectionId: "connection", accountId: "222" };
const metricsCall: Parameters<PluginCapability<"report.metrics.v1">>[0] = { context, connection, input: { grain: "campaign", days: { start: "2026-10-01", end: "2026-10-03" } } };
const statusCall: Parameters<PluginCapability<"campaign.status.v1">>[0] = { context, connection, input: { vendorCampaignIds: [campaign.nccCampaignId] } };

/** Independent route dispatcher: unknown fixture routes fail, never reach a network. */
function wireResponse(required: { url: URL; stats?: unknown; campaigns?: unknown; groups?: unknown; ads?: unknown }): Response {
  switch (required.url.pathname) {
    case "/ad-accounts": throw new Error("Fixture metadata handled before dispatcher");
    case "/stats": return Response.json(required.stats ?? dailyPage);
    case "/ncc/campaigns": return Response.json(required.campaigns ?? [campaign]);
    case "/ncc/adgroups": return Response.json(required.groups ?? [group]);
    case "/ncc/ads": return Response.json(required.ads ?? [ad]);
    case "/ncc/campaigns/" + campaign.nccCampaignId: return Response.json(campaign);
    default: return new Response(null, { status: 404 });
  }
}

describe("Naver canonical metrics", () => {
  it.each(["campaign", "ad_group", "ad"] as const)("reports exact daily KRW at %s grain with verified parent identity", async grain => {
    const f = capabilityFixture({ response: ({ url }) => url.pathname === "/stats"
      ? new Response(JSON.stringify(dailyPage).replace('"9007199254740993"', '9007199254740993').replace('"impCnt":"0"', '"impCnt":0'))
      : wireResponse({ url }) });
    expect(f.calls).toEqual([]); expect(f.credentialCalls).toEqual([]);
    const result = await f.capabilities["report.metrics.v1"]!({ ...metricsCall, input: { ...metricsCall.input, grain } });
    const entity = grain === "campaign" ? { grain, vendorCampaignId: campaign.nccCampaignId } : grain === "ad_group"
      ? { grain, vendorCampaignId: campaign.nccCampaignId, vendorAdGroupId: group.nccAdgroupId }
      : { grain, vendorCampaignId: campaign.nccCampaignId, vendorAdGroupId: group.nccAdgroupId, vendorAdId: ad.nccAdId };
    expect(result).toMatchObject({ ok: true, value: { schema: "report.metrics.v1", pluginId: "naver-ads", ...connection,
      currency: "KRW", timezone: "Asia/Seoul", grain, days: metricsCall.input.days, complete: true, freshness: "stale", dataThrough: 0,
      retrievedAt: now, finality: "provisional", restated: false, mapping: metricMapping,
      rows: [{ day: "2026-10-01", entity, metrics: { spend: "9007199254740993000000", impressions: "0", clicks: null, vendorConversions: "2000000" } }] } });
    if (result.ok) {
      expect(metricBatchSchema.safeParse(result.value).success).toBe(true);
      expect(result.value.rows[0].metrics).not.toHaveProperty("vendorConversionValue");
    }
    const stats = f.calls.map(call => new URL(call.url)).find(url => url.pathname === "/stats")!;
    expect(stats.searchParams.get("timeIncrement")).toBe("1");
    expect(stats.searchParams.has("ids")).toBe(false);
    expect(stats.searchParams.get("id")).toBe(grain === "campaign" ? campaign.nccCampaignId : grain === "ad_group" ? group.nccAdgroupId : ad.nccAdId);
    expect(JSON.parse(stats.searchParams.get("timeRange")!)).toEqual({ since: "2026-10-01", until: "2026-10-02" });
    expect(f.waits).toEqual([]);
    for (const call of f.calls) {
      expect(new URL(call.url).origin).toBe("https://api.searchad.naver.com");
      expect(call.init).toMatchObject({ method: "GET", redirect: "error", headers: { "X-Customer": new URL(call.url).pathname === "/ad-accounts" ? "111" : "222", "X-Timestamp": String(now),
        "X-Signature": createHmac("sha256", "fixture-secret").update(`${now}.GET.${new URL(call.url).pathname}`).digest("base64") } });
    }
  });
  it("keeps supported missing/null values distinct from observed zero and unsupported value", async () => {
    const f = capabilityFixture({ response: ({ url }) => wireResponse({ url, stats: { ...dailyPage, data: [{ dateStart: "2026-10-01", dateEnd: "2026-10-01", salesAmt: 0, ccnt: null }] } }) });
    const result = await f.capabilities["report.metrics.v1"]!(metricsCall);
    expect(result).toMatchObject({ ok: true, value: { rows: [{ metrics: { spend: "0", impressions: null, clicks: null, vendorConversions: null } }] } });
    if (result.ok) expect(result.value.rows[0].metrics).not.toHaveProperty("vendorConversionValue");
  });
  it.each([{ campaigns: [] }, { campaigns: [campaign] }])("accepts exhausted empty discovery/report without synthesizing zero rows", async ({ campaigns }) => {
    const f = capabilityFixture({ response: ({ url }) => wireResponse({ url, campaigns, stats: { ...dailyPage, data: [] } }) });
    expect(await f.capabilities["report.metrics.v1"]!(metricsCall)).toMatchObject({ ok: true, value: { complete: true, rows: [], dataThrough: 0, freshness: "stale" } });
  });
  it.each([
    { ...dailyPage, data: [...dailyPage.data, ...dailyPage.data] },
    { ...dailyPage, data: [{ ...dailyPage.data[0], dateStart: "2026-10-03", dateEnd: "2026-10-03" }] },
    { ...dailyPage, data: [{ ...dailyPage.data[0], dateEnd: "2026-10-02" }] },
    { ...dailyPage, data: [{ ...dailyPage.data[0], id: "cmp-foreign" }] },
    { ...dailyPage, data: [{ ...dailyPage.data[0], salesAmt: "-1" }] },
    { ...dailyPage, data: [{ ...dailyPage.data[0], ccnt: "0.1" }] },
    { ...dailyPage, summary: { dateStart: "2026-10-01", dateEnd: "2026-10-03" } },
    { dailyStatResponse: dailyPage },
  ])("rejects invalid daily precision, identity and date boundaries atomically", async stats => {
    const f = capabilityFixture({ response: ({ url }) => wireResponse({ url, stats }) });
    expect(await f.capabilities["report.metrics.v1"]!(metricsCall)).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
  });
  it.each([
    { campaigns: [{ ...campaign, customerId: 333 }], grain: "campaign" },
    { groups: [{ ...group, nccCampaignId: "cmp-foreign" }], grain: "ad_group" },
    { ads: [{ ...ad, nccAdgroupId: "grp-foreign" }], grain: "ad" },
    { groups: [group, group], grain: "ad_group" },
  ] as const)("rejects foreign customers/parents and duplicate entity identities", async input => {
    const f = capabilityFixture({ response: ({ url }) => wireResponse({ url, ...input }) });
    expect(await f.capabilities["report.metrics.v1"]!({ ...metricsCall, input: { ...metricsCall.input, grain: input.grain } })).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
  });
  it("follows NEXT cursors without duplicating a full page; stops reports at 100 reads honestly", async () => {
    const firstPage = Array.from({ length: 100 }, (_, i) => ({ ...campaign, nccCampaignId: "cmp-page-" + i }));
    const f = capabilityFixture({ response: ({ url }) => wireResponse({ url, campaigns: url.searchParams.has("baseSearchId") ? [] : firstPage, stats: { ...dailyPage, data: [] } }) });
    expect(await f.capabilities["report.metrics.v1"]!(metricsCall)).toMatchObject({ ok: true, value: { complete: false, rows: [] } });
    expect(f.calls).toHaveLength(100);
    expect(new URL(f.calls[2].url).searchParams.get("baseSearchId")).toBe("cmp-page-99");
    expect(f.calls.filter(call => new URL(call.url).pathname === "/stats")).toHaveLength(97);
  });
  it("rejects repeated pages instead of silently looping or doubling metrics", async () => {
    const page = Array.from({ length: 100 }, (_, i) => ({ ...campaign, nccCampaignId: "cmp-page-" + i }));
    const f = capabilityFixture({ response: ({ url }) => wireResponse({ url, campaigns: page }) });
    expect(await f.capabilities["report.metrics.v1"]!(metricsCall)).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
    expect(f.calls).toHaveLength(3);
  });
  it("truncates a non-aligned final stats result at 5,000 rows and marks partial coverage", async () => {
    const campaigns = Array.from({ length: 162 }, (_, i) => ({ ...campaign, nccCampaignId: "cmp-many-" + i }));
    // 56 reports cross the row cap within the fixed 100-read budget.
    const longerStats = { summary: { dateStart: "2026-01-01", dateEnd: "2026-03-31" }, data: Array.from({ length: 90 }, (_, i) => {
      const day = new Date(Date.UTC(2026, 0, i + 1)).toISOString().slice(0, 10);
      return { dateStart: day, dateEnd: day, salesAmt: 1 };
    }) };
    const f = capabilityFixture({ response: ({ url }) => wireResponse({ url, campaigns: url.searchParams.has("baseSearchId") ? campaigns.slice(100) : campaigns.slice(0, 100), stats: longerStats }) });
    const result = await f.capabilities["report.metrics.v1"]!({ ...metricsCall, input: { grain: "campaign", days: { start: "2026-01-01", end: "2026-04-01" } } });
    expect(result).toMatchObject({ ok: true, value: { complete: false } });
    if (result.ok) { expect(result.value.rows).toHaveLength(5000); expect(result.value.rows.at(-1)?.entity).toEqual({ grain: "campaign", vendorCampaignId: "cmp-many-55" }); }
    expect(f.calls).toHaveLength(59);
  });
  it("stops before the next entity when a completed stats range exactly fills 5,000 rows", async () => {
    const campaigns = Array.from({ length: 56 }, (_, index) => ({ ...campaign, nccCampaignId: "cmp-cap-" + index }));
    const fullRange = Array.from({ length: 92 }, (_, index) => {
      const day = new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10);
      return { dateStart: day, dateEnd: day, salesAmt: "1" };
    });
    const f = capabilityFixture({ response: ({ url }) => {
      if (url.pathname !== "/stats") return wireResponse({ url, campaigns });
      // 54 full ranges plus 32 rows finish the cap on a completed entity.
      const data = url.searchParams.get("id") === "cmp-cap-54" ? fullRange.slice(0, 32) : fullRange;
      return Response.json({ data, summary: { dateStart: "2026-01-01", dateEnd: "2026-04-02" } });
    } });
    const result = await f.capabilities["report.metrics.v1"]!({ ...metricsCall, input: { grain: "campaign", days: { start: "2026-01-01", end: "2026-04-03" } } });
    expect(result).toMatchObject({ ok: true, value: { complete: false } });
    if (!result.ok) throw new Error("Expected capped fixture metrics");
    expect(result.value.rows).toHaveLength(5000);
    expect(result.value.rows.at(-1)?.entity).toEqual({ grain: "campaign", vendorCampaignId: "cmp-cap-54" });
    const stats = f.calls.map(call => new URL(call.url)).filter(url => url.pathname === "/stats");
    expect(stats).toHaveLength(55);
    expect(stats.some(url => url.searchParams.get("id") === "cmp-cap-55")).toBe(false);
  });
});

describe("Naver canonical status and boundary behavior", () => {
  it("includes documented rejection codes with child IDs; lifecycle eligibility is not approval", async () => {
    const f = capabilityFixture();
    expect(await f.capabilities["campaign.status.v1"]!(statusCall)).toEqual({ ok: true, value: { observedAt: now, complete: true, campaigns: [
      { vendorCampaignId: campaign.nccCampaignId, status: "disapproved", disapprovalDescriptions: ["nad-fixture-1: AD_DISAPPROVED", "nad-fixture-1: DENIED"] },
    ] } });
    const missingReview = capabilityFixture({ response: ({ url }) => url.pathname === "/ncc/campaigns/" + campaign.nccCampaignId ? Response.json({ ...campaign, status: "ELIGIBLE", userLock: false }) : wireResponse({ url, ads: [{ ...ad, status: "ELIGIBLE", inspectStatus: undefined, statusReason: undefined }] }) });
    expect(await missingReview.capabilities["campaign.status.v1"]!(statusCall)).toMatchObject({ ok: true, value: { complete: false, campaigns: [{ status: "unknown" }] } });
  });
  it.each([["APPROVED", "active"], ["UNDER_REVIEW", "pending"], ["FUTURE_CODE", "unknown"]])("projects child review %s without assuming approval", async (inspectStatus, expected) => {
    const f = capabilityFixture({ response: ({ url }) => url.pathname === "/ncc/campaigns/" + campaign.nccCampaignId ? Response.json({ ...campaign, status: "ELIGIBLE", userLock: false }) : wireResponse({ url, ads: [{ ...ad, status: "ELIGIBLE", inspectStatus, statusReason: undefined }] }) });
    expect(await f.capabilities["campaign.status.v1"]!(statusCall)).toMatchObject({ ok: true, value: { campaigns: [{ status: expected }] } });
  });
  it("does not infer active delivery through an unknown or blocked group", async () => {
    const f = capabilityFixture({ response: ({ url }) => url.pathname === "/ncc/campaigns/" + campaign.nccCampaignId ? Response.json({ ...campaign, status: "ELIGIBLE", userLock: false }) : wireResponse({ url,
      groups: [{ ...group, statusReason: "FUTURE_CODE" }], ads: [{ ...ad, status: "ELIGIBLE", inspectStatus: "APPROVED", statusReason: undefined }] }) });
    expect(await f.capabilities["campaign.status.v1"]!(statusCall)).toMatchObject({ ok: true, value: { complete: false, campaigns: [{ status: "unknown" }] } });
  });
  it("retains paused/ended observations, limits descriptions and reports missing campaigns", async () => {
    const ads = Array.from({ length: 30 }, (_, i) => ({ ...ad, nccAdId: "nad-rejected-" + i }));
    const f = capabilityFixture({ response: ({ url }) => wireResponse({ url, ads }) });
    const result = await f.capabilities["campaign.status.v1"]!({ ...statusCall, input: { vendorCampaignIds: [campaign.nccCampaignId, "cmp-missing"] } });
    expect(result).toMatchObject({ ok: true, value: { complete: false, campaigns: [{ status: "disapproved" }, { vendorCampaignId: "cmp-missing", status: "unknown" }] } });
    if (result.ok) expect(result.value.campaigns[0].disapprovalDescriptions).toHaveLength(20);
    const ended = capabilityFixture({ response: ({ url }) => url.pathname.endsWith("/" + campaign.nccCampaignId) ? Response.json({ ...campaign, status: "DELETED" }) : wireResponse({ url, groups: [], ads: [] }) });
    expect(await ended.capabilities["campaign.status.v1"]!(statusCall)).toMatchObject({ ok: true, value: { campaigns: [{ status: "ended" }] } });
  });
  it("preserves completed campaign observations when the request budget runs out", async () => {
    const ids = Array.from({ length: 100 }, (_, i) => "cmp-status-" + i);
    const f = capabilityFixture({ response: ({ url }) => url.pathname.startsWith("/ncc/campaigns/") ? Response.json({ ...campaign, nccCampaignId: url.pathname.split("/").at(-1) }) : Response.json([]) });
    const result = await f.capabilities["campaign.status.v1"]!({ ...statusCall, input: { vendorCampaignIds: ids } });
    expect(result).toMatchObject({ ok: true, value: { complete: false } });
    if (result.ok) { expect(result.value.campaigns).toHaveLength(100); expect(result.value.campaigns[0].status).toBe("paused"); expect(result.value.campaigns.at(-1)?.status).toBe("unknown"); }
    expect(f.calls).toHaveLength(100);
  });
  it("accepts ServiceContext without losing trace identity", async () => {
    const service: ServiceContext = { scope: context.scope, serviceId: "report-worker", correlationId: "service-correlation", traceId: "service-trace" };
    const f = capabilityFixture();
    expect((await f.capabilities["report.metrics.v1"]!({ ...metricsCall, context: service })).ok).toBe(true);
    expect(f.observations).toEqual([{ operation: "naver-ads.report.metrics.v1", outcome: "succeeded", correlationId: "service-correlation", traceId: "service-trace" }]);
  });
  it("rejects inflated, foreign and malformed inputs before custody", async () => {
    const f = capabilityFixture();
    for (const call of [
      { ...statusCall, connection: { ...connection, accountId: "333" } },
      { ...statusCall, context: { ...context, scope: { ...context.scope, workspaceId: "foreign" } } },
      { ...statusCall, input: { vendorCampaignIds: ["../foreign"] } },
      { ...statusCall, input: { vendorCampaignIds: [campaign.nccCampaignId, campaign.nccCampaignId] } },
    ]) expect(await f.capabilities["campaign.status.v1"]!(call)).toMatchObject({ ok: false });
    expect(await f.capabilities["report.metrics.v1"]!({ ...metricsCall, input: { ...metricsCall.input, grain: "account" } })).toMatchObject({ ok: false, error: { code: "not_implemented" } });
    expect(f.calls).toEqual([]); expect(f.credentialCalls).toEqual([]);
  });
  it("checks credential ownership and bounds canonical streaming bodies", async () => {
    const f = capabilityFixture();
    for (const [body, code] of [["{broken", "protocol_mismatch"], ["x".repeat(1048577), "limit_exceeded"]]) {
      const bad = capabilityFixture({ response: () => new Response(body) });
      expect(await bad.capabilities["report.metrics.v1"]!(metricsCall)).toMatchObject({ ok: false, error: { code } });
      expect(bad.calls).toHaveLength(2);
    }
  });
  it("propagates caller cancellation during custody without dispatch or a plugin timer", async () => {
    const f = capabilityFixture();
    const caller = new AbortController();
    f.dependencies.credentials.access = async () => { caller.abort(); return { ok: true, value: { accessToken: JSON.stringify({ apiKey: "fixture", secretKey: "fixture", customerId: "111" }) } }; };
    expect(await f.capabilities["report.metrics.v1"]!(metricsCall, { signal: caller.signal })).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(f.calls).toEqual([]); expect(f.waits).toEqual([]);
  });
  it.each([401, 403, 429, 500])("returns redacted HTTP %s failures without retry", async status => {
    const f = capabilityFixture({ response: () => new Response("fixture-secret", { status }) });
    const result = await f.capabilities["report.metrics.v1"]!(metricsCall);
    expect(result).toMatchObject({ ok: false }); expect(f.calls).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain("fixture-secret");
  });
});

it("calls the real factory with exact server configuration and credential-owned identity", async () => {
  const f = capabilityFixture();
  const configuration = pluginConfigurationSchema.parse({ scope: context.scope, ...connection, pluginDigest: "a".repeat(64), settings: {} });
  const result = await createCapabilities({ ...f.dependencies, configuration })["report.metrics.v1"]!(metricsCall);
  expect(result).toMatchObject({ ok: true, value: { currency: "KRW", timezone: "Asia/Seoul" } });
  if (result.ok) expect(metricBatchSchema.safeParse(result.value).success).toBe(true);
  expect(new Headers(f.calls[0].init.headers).get("X-Customer")).toBe("111");
  expect(new Headers(f.calls[1].init.headers).get("X-Customer")).toBe("222");
});
it.each([92, 93, 366])("chunks %i days into contiguous stats ranges no longer than 92 days", async length => {
  const start = "2024-01-01", end = new Date(Date.parse(start) + length * 86400000).toISOString().slice(0, 10);
  const f = capabilityFixture({ response: ({ url }) => url.pathname === "/stats" ? Response.json({ data: [], summary: { dateStart: JSON.parse(url.searchParams.get("timeRange")!).since, dateEnd: JSON.parse(url.searchParams.get("timeRange")!).until } }) : wireResponse({ url }) });
  expect(await f.capabilities["report.metrics.v1"]!({ ...metricsCall, input: { grain: "campaign", days: { start, end } } })).toMatchObject({ ok: true, value: { complete: true } });
  const ranges = f.calls.filter(call => new URL(call.url).pathname === "/stats").map(call => JSON.parse(new URL(call.url).searchParams.get("timeRange")!) as { since: string; until: string });
  expect(ranges).toHaveLength(Math.ceil(length / 92));
  let next = start;
  for (const range of ranges) {
    expect(range.since).toBe(next);
    expect(Date.parse(range.until) - Date.parse(range.since)).toBeLessThan(92 * 86400000);
    next = new Date(Date.parse(range.until) + 86400000).toISOString().slice(0, 10);
  }
  expect(next).toBe(end);
});
it("rejects a daily row in another chunk even when it lies inside the whole request", async () => {
  const f = capabilityFixture({ response: ({ url }) => url.pathname === "/stats" ? Response.json({ data: [{ dateStart: "2024-04-02", dateEnd: "2024-04-02", salesAmt: "1" }], summary: { dateStart: "2024-01-01", dateEnd: "2024-04-01" } }) : wireResponse({ url }) });
  expect(await f.capabilities["report.metrics.v1"]!({ ...metricsCall, input: { grain: "campaign", days: { start: "2024-01-01", end: "2025-01-01" } } })).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
});
it("preserves completed chunks when the shared request budget is exhausted", async () => {
  const campaigns = Array.from({ length: 30 }, (_, i) => ({ ...campaign, nccCampaignId: "cmp-window-" + i }));
  const f = capabilityFixture({ response: ({ url }) => {
    if (url.pathname !== "/stats") return wireResponse({ url, campaigns });
    const range = JSON.parse(url.searchParams.get("timeRange")!) as { since: string; until: string };
    return Response.json({ data: [{ dateStart: range.since, dateEnd: range.since, salesAmt: "1" }], summary: { dateStart: range.since, dateEnd: range.until } });
  } });
  const result = await f.capabilities["report.metrics.v1"]!({ ...metricsCall, input: { grain: "campaign", days: { start: "2024-01-01", end: "2025-01-01" } } });
  expect(result).toMatchObject({ ok: true, value: { complete: false } });
  if (result.ok) expect(result.value.rows).toHaveLength(98);
  expect(f.calls).toHaveLength(100);
});

it("preserves prior metric rows when the 25s budget expires", async () => {
  const campaigns = [campaign, { ...campaign, nccCampaignId: "cmp-second" }];
  let time = now;
  const f = capabilityFixture({ response: ({ url }) => {
    if (url.pathname === "/stats") time += 25001;
    return wireResponse({ url, campaigns });
  } });
  const result = await createCapabilities({ ...f.dependencies, clock: { now: () => time } })["report.metrics.v1"]!(metricsCall);
  expect(result).toMatchObject({ ok: true, value: { complete: false, rows: [{ entity: { vendorCampaignId: campaign.nccCampaignId } }] } });
  if (result.ok) expect(result.value.rows).toHaveLength(1);
  expect(f.calls.filter(call => new URL(call.url).pathname === "/stats")).toHaveLength(1);
});

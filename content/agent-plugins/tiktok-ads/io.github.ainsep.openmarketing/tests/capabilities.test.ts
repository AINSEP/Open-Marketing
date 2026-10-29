import { describe, expect, it } from "vitest";
import { capabilityCatalog, metricBatchSchema, pluginConfigurationSchema } from "@open-marketing/contracts";
import type { CallContext, PluginCapabilitiesFactory, PluginCapabilityDependencies } from "@open-marketing/contracts";
import { createCapabilities, createTools } from "../src/index.js";
import { digestTikTokArguments } from "../src/commands.js";
import { haltPermit } from "./fixtures.js";
import { accountDayBoundary, decodeTikTokDailyPage } from "../src/reporting.js";

const scope = { ownerId: "owner", workspaceId: "workspace" };
const context: CallContext = { scope, principal: { kind: "owner", ownerId: "owner" }, correlationId: "correlation", traceId: "trace", runId: "run" };
const connection = { connectionId: "connection", accountId: "123" };
const days = { start: "2026-03-07", end: "2026-03-10" };
const now = Date.parse("2026-10-26T10:00:00Z");
const input = { grain: "account" as const, days };
const hostFactory: PluginCapabilitiesFactory = createCapabilities;
function daily(required: { day?: string; advertiser?: string; metrics?: object } = {}) {
  return { dimensions: { advertiser_id: required.advertiser ?? "123", stat_time_day: required.day ?? days.start }, metrics: required.metrics ?? { spend: "12.345678", impressions: "15", clicks: "0" } };
}
function page(required: { list?: object[]; page?: number; total?: number; pageSize?: number } = {}) {
  const list = required.list ?? [];
  const total = required.total ?? list.length;
  return { code: 0, data: { list, page_info: { page: required.page ?? 1, page_size: required.pageSize ?? 1000, total_page: Math.ceil(total / (required.pageSize ?? 1000)), total_number: total } } };
}
function campaign(required: { id: string; advertiser?: string; operation?: string; secondary?: string }) {
  return { campaign_id: required.id, advertiser_id: required.advertiser ?? "123", campaign_name: "Fixture", operation_status: required.operation ?? "DISABLE", secondary_status: required.secondary };
}
function fixture(required: { bodies?: (object | string)[]; timezone?: string; now?: number; configuration?: object; response?: (url: URL) => object } = {}) {
  const requests: { url: URL; init: RequestInit }[] = [];
  const observations: unknown[] = [];
  const metadataRequests: { url: URL; init: RequestInit }[] = [];
  let accesses = 0;
  let onAccess = () => {};
  let denied = false;
  const dependencies: PluginCapabilityDependencies = {
    configuration: pluginConfigurationSchema.parse({ scope, ...connection, pluginDigest: "a".repeat(64), settings: { currency: "UNTRUSTED" }, ...required.configuration }),
    fetch: (async (url, init) => {
      if (denied) throw new Error("Host guarded fetch denied");
      const target = new URL(String(url));
      if (target.pathname.endsWith("advertiser/info/")) { metadataRequests.push({ url: target, init: init! }); return Response.json({ code: 0, data: { list: [{ advertiser_id: "123", currency: "USD", timezone: required.timezone ?? "America/Los_Angeles" }] } }); }
      const index = requests.length;
      requests.push({ url: target, init: init! });
      const body = required.response?.(target) ?? required.bodies?.[index] ?? page();
      return new Response(typeof body === "string" ? body : JSON.stringify(body));
    }) as typeof fetch,
    credentials: { async access() { accesses += 1; onAccess(); return { ok: true, value: { accessToken: "fixture-token" } }; } },
    clock: { now: () => required.now ?? now }, observer: { observe: event => { observations.push(event); } }, wait: async () => ({ ok: true, value: undefined }),
  };
  return { capabilities: hostFactory(dependencies), dependencies, requests, metadataRequests, observations, accessCount: () => accesses, onAccess: ({ work }: { work: () => void }) => { onAccess = work; }, deny: () => { denied = true; } };
}

describe("TikTok canonical host ABI with synthetic HTTP only", () => {
  it("returns callable catalog IDs and daily account metrics with exact major-unit micros", async () => {
    const test = fixture({ bodies: [page({ list: [daily(), daily({ day: "2026-03-08 00:00:00", metrics: { spend: "9007199254740993.123456", impressions: "9007199254740993", clicks: "2" } })] })] });
    expect(Object.keys(test.capabilities).sort()).toEqual(["campaign.halt-stop.v1", "campaign.status.v1", "report.metrics.v1"]);
    const result = await test.capabilities["report.metrics.v1"]!({ context, connection, input });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(metricBatchSchema.safeParse(result.value).success).toBe(true);
    expect(result.value).toMatchObject({ currency: "USD", timezone: "America/Los_Angeles", complete: true, retrievedAt: now, dataThrough: Date.parse("2026-03-10T07:00:00Z"), finality: "provisional" });
    expect(result.value.rows[0]).toEqual({ day: days.start, entity: { grain: "account" }, metrics: { spend: "12345678", impressions: "15", clicks: "0" } });
    expect(result.value.rows[1]!.metrics).toEqual({ spend: "9007199254740993123456", impressions: "9007199254740993", clicks: "2" });
    const request = test.requests[0]!;
    expect(request.url.pathname).toBe("/open_api/v1.3/report/integrated/get/");
    expect(Object.fromEntries(request.url.searchParams)).toMatchObject({ advertiser_id: "123", dimensions: '["advertiser_id","stat_time_day"]', metrics: '["spend","impressions","clicks"]', start_date: days.start, end_date: "2026-03-09", data_level: "AUCTION_ADVERTISER", page_size: "1000" });
    expect(request.init).toMatchObject({ method: "GET", redirect: "error", headers: { "Access-Token": "fixture-token" } });
    expect(test.observations).toContainEqual(expect.objectContaining({ correlationId: "correlation", traceId: "trace", runId: "run" }));
  });
  it("keeps unsupported conversions absent, supported missing/null values null, and observed zero intact", async () => {
    const test = fixture({ bodies: [page({ list: [daily({ metrics: { spend: null, clicks: "0" } }), daily({ day: "2026-03-08", metrics: { spend: "0", impressions: "0", clicks: null } })] })] });
    const result = await test.capabilities["report.metrics.v1"]!({ context, connection, input });
    expect(result).toMatchObject({ ok: true, value: { rows: [{ metrics: { spend: null, impressions: null, clicks: "0" } }, { metrics: { spend: "0", impressions: "0", clicks: null } }] } });
    if (result.ok) {
      expect(result.value.mapping.grains.account?.vendorConversions).toBeUndefined();
      expect(result.value.rows.every(row => !Object.hasOwn(row.metrics, "vendorConversions"))).toBe(true);
      expect(result.value.rows).toHaveLength(2);
    }
  });
  it("completes valid empty reports without synthesizing zero rows", async () => {
    const test = fixture();
    expect(await test.capabilities["report.metrics.v1"]!({ context, connection, input })).toMatchObject({ ok: true, value: { complete: true, rows: [], dataThrough: Date.parse("2026-03-10T07:00:00Z") } });
  });
  it("bounds coverage by retrieval time for an in-progress account-local day", async () => {
    const retrievedAt = Date.parse("2026-03-08T12:00:00Z");
    const test = fixture({ now: retrievedAt });
    expect(await test.capabilities["report.metrics.v1"]!({ context, connection, input })).toMatchObject({ ok: true, value: { complete: true, dataThrough: retrievedAt, freshness: "stale", finality: "provisional" } });
  });
  it("splits a 366-day window into 30-day inclusive ranges without gaps or repeated days", async () => {
    const test = fixture();
    const year = { start: "2024-01-01", end: "2025-01-01" };
    expect(await test.capabilities["report.metrics.v1"]!({ context, connection, input: { grain: "account", days: year } })).toMatchObject({ ok: true, value: { complete: true } });
    expect(test.requests).toHaveLength(13);
    const covered: string[] = [];
    for (const request of test.requests) {
      const start = Date.parse(request.url.searchParams.get("start_date")!);
      const end = Date.parse(request.url.searchParams.get("end_date")!);
      expect((end - start) / 86400000).toBeLessThan(30);
      for (let day = start; day <= end; day += 86400000) covered.push(new Date(day).toISOString().slice(0, 10));
    }
    expect(covered).toHaveLength(366); expect(new Set(covered).size).toBe(366);
    expect(covered[0]).toBe(year.start); expect(covered.at(-1)).toBe("2024-12-31");
  });
  it.each([
    { list: [daily({ advertiser: "999" })], code: "forbidden" },
    { list: [daily({ day: "2026-02-30" })], code: "protocol_mismatch" },
    { list: [daily({ day: days.end })], code: "protocol_mismatch" },
    { list: [daily(), daily()], code: "protocol_mismatch" },
    { list: [daily({ metrics: { spend: "0.0000001" } })], code: "protocol_mismatch" },
    { list: [daily({ metrics: { spend: "-1" } })], code: "protocol_mismatch" },
    { list: [daily({ metrics: { spend: "1", clicks: "-1" } })], code: "protocol_mismatch" },
  ])("rejects tainted daily data atomically", async ({ list, code }) => {
    const test = fixture({ bodies: [page({ list })] });
    expect(await test.capabilities["report.metrics.v1"]!({ context, connection, input })).toMatchObject({ ok: false, error: { code } });
  });
  it("rejects wrong pagination, missing rows, nonzero vendor codes and malformed JSON", async () => {
    const bodies = [page({ page: 2 }), page({ total: 2 }), { code: 1, data: page().data }, "{"];
    for (const body of bodies) {
      const test = fixture({ bodies: [body] });
      expect((await test.capabilities["report.metrics.v1"]!({ context, connection, input })).ok).toBe(false);
      expect(test.requests).toHaveLength(1);
    }
  });
  it.each([11, 100])("reads all %i filtered campaign IDs in order", async count => {
    const ids = Array.from({ length: count }, (_, index) => String(index + 1));
    const test = fixture({ bodies: [page({ pageSize: 100, list: [...ids].reverse().map(id => campaign({ id })) })] });
    const result = await test.capabilities["campaign.status.v1"]!({ context, connection, input: { vendorCampaignIds: ids } });
    expect(result).toMatchObject({ ok: true, value: { complete: true } });
    if (result.ok) expect(result.value.campaigns.map(item => item.vendorCampaignId)).toEqual(ids);
    expect(JSON.parse(test.requests[0]!.url.searchParams.get("filtering")!)).toEqual({ campaign_ids: ids, primary_status: "STATUS_ALL" });
    expect(test.requests).toHaveLength(1);
  });
  it("leaves absent campaigns and ENABLE-only or unfamiliar states unknown", async () => {
    const test = fixture({ bodies: [page({ pageSize: 100, list: [campaign({ id: "11", operation: "ENABLE", secondary: undefined }), campaign({ id: "12", operation: "NEW" })] })] });
    expect(await test.capabilities["campaign.status.v1"]!({ context, connection, input: { vendorCampaignIds: ["11", "12", "13"] } })).toMatchObject({ ok: true, value: { complete: false, campaigns: [{ status: "unknown" }, { status: "unknown" }, { status: "unknown" }] } });
  });
  it.each([
    { list: [campaign({ id: "11", advertiser: "999" })] }, { list: [campaign({ id: "12" })] }, { list: [campaign({ id: "11" }), campaign({ id: "11" })] },
  ])("rejects foreign, unsolicited and duplicate campaigns", async ({ list }) => {
    const test = fixture({ bodies: [page({ list, pageSize: 100 })] });
    expect((await test.capabilities["campaign.status.v1"]!({ context, connection, input: { vendorCampaignIds: ["11"] } })).ok).toBe(false);
  });
  it("propagates cancellation before and after token lookup without sending", async () => {
    const first = fixture(); const cancelled = new AbortController(); cancelled.abort();
    expect(await first.capabilities["report.metrics.v1"]!({ context, connection, input }, { signal: cancelled.signal })).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(first.accessCount()).toBe(0);
    const second = fixture(); const during = new AbortController(); second.onAccess({ work: () => during.abort() });
    expect(await second.capabilities["report.metrics.v1"]!({ context, connection, input }, { signal: during.signal })).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(second.requests).toHaveLength(0);
  });
  it("uses the host guarded fetch and shared service context without any plugin approval hook", async () => {
    const test = fixture(); test.onAccess({ work: test.deny });
    const service = { scope, serviceId: "sync", correlationId: "correlation", traceId: "trace" };
    expect(await test.capabilities["report.metrics.v1"]!({ context: service, connection, input })).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(test.accessCount()).toBe(1); expect(test.requests).toHaveLength(0);
    expect(test.observations).toContainEqual(expect.objectContaining({ correlationId: "correlation", traceId: "trace" }));
  });
  it("validates host scope and timezone before credentials", async () => {
    const foreign = fixture({ configuration: { accountId: "999" } });
    expect(await foreign.capabilities["report.metrics.v1"]!({ context, connection, input })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(foreign.accessCount()).toBe(0);
    const zone = fixture({ timezone: "Vendor-offset-unknown" });
    expect((await zone.capabilities["report.metrics.v1"]!({ context, connection, input })).ok).toBe(false);
    expect(zone.accessCount()).toBe(1);
    expect(zone.requests).toHaveLength(0);
  });
});

it.each([
  { day: "2026-03-08", expected: "2026-03-08T08:00:00Z" },
  { day: "2026-03-09", expected: "2026-03-09T07:00:00Z" },
  { day: "2026-11-01", expected: "2026-11-01T07:00:00Z" },
  { day: "2026-11-02", expected: "2026-11-02T08:00:00Z" },
])("resolves account-local midnight across DST: $day", ({ day, expected }) => {
  expect(accountDayBoundary({ day, timezone: "America/Los_Angeles" })).toEqual({ ok: true, value: Date.parse(expected) });
});
it("rejects impossible page sizes before returning any daily rows", () => {
  expect(decodeTikTokDailyPage({ input: page({ list: Array.from({ length: 1001 }, () => daily()) }), accountId: "123", start: days.start, end: days.end, page: 1 })).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
});

it("can read campaign status without reporting-only currency/timezone configuration", async () => {
  const test = fixture({ bodies: [page({ pageSize: 100, list: [campaign({ id: "11" })] })], configuration: { settings: {} } });
  expect(await test.capabilities["campaign.status.v1"]!({ context, connection, input: { vendorCampaignIds: ["11"] } })).toMatchObject({ ok: true, value: { complete: true, campaigns: [{ status: "paused" }] } });
});

it("rejects expired or denied credentials without HTTP", async () => {
  const test = fixture();
  const expired = createCapabilities({ ...test.dependencies, credentials: { access: async () => ({ ok: true, value: { accessToken: "fixture-token", expiresAt: now } }) } });
  expect(await expired["report.metrics.v1"]({ context, connection, input })).toMatchObject({ ok: false, error: { code: "expired" } });
  const denied = createCapabilities({ ...test.dependencies, credentials: { access: async () => ({ ok: false, error: { code: "forbidden", message: "Denied", retryable: false } }) } });
  expect(await denied["report.metrics.v1"]({ context, connection, input })).toMatchObject({ ok: false, error: { code: "forbidden" } });
  expect(test.requests).toHaveLength(0);
});
it("rejects a campaign request above the catalog's 100-ID bound before credentials", async () => {
  const test = fixture();
  expect(await test.capabilities["campaign.status.v1"]!({ context, connection, input: { vendorCampaignIds: Array.from({ length: 101 }, (_, index) => String(index + 1)) } })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  expect(test.accessCount()).toBe(0);
});

it("uses exact server configuration and authenticated advertiser facts", async () => {
  const f = fixture({ response: url => url.pathname.endsWith("campaign/status/update/") ? { code: 0, data: {} } : page() });
  const dependencies: PluginCapabilityDependencies = { ...f.dependencies, credentials: { async access(connectionInput) {
    expect(connectionInput).toEqual(connection);
    return { ok: true, value: { accessToken: "fixture-token", expiresAt: now + 60000, secrets: { unrelated: "s3cret-fixture" } } };
  } } };
  const capabilities = createCapabilities(dependencies);
  const result = await capabilities["report.metrics.v1"]({ context, connection, input });
  expect(result).toMatchObject({ ok: true, value: { currency: "USD", timezone: "America/Los_Angeles" } });
  if (result.ok) expect(metricBatchSchema.safeParse(result.value).success).toBe(true);
  expect(f.metadataRequests).toHaveLength(1);
  const tool = await createTools(dependencies).invoke({ context, connection, name: "tiktok_ads.get_advertiser", operationId: "tool-read", input: { kind: "get-advertiser" }, moneyExposure: null, requiredLimit: null });
  expect(tool).toMatchObject({ ok: true, value: { status: "succeeded" } });
  expect(f.metadataRequests).toHaveLength(2);
  const halt = capabilities["campaign.halt-stop.v1"];
  for (const action of ["pause", "stop"] as const) {
    const request = { ...haltPermit().request, action, argumentsDigest: digestTikTokArguments({ arguments: { adAccountId: "123", entityIds: ["456"], action } }) };
    const before = f.requests.length;
    const stopped = await halt({ context, connection, input: request });
    expect(stopped).toEqual({ ok: true, value: { status: "acknowledged", entityIds: ["456"] } });
    if (stopped.ok) expect(capabilityCatalog["campaign.halt-stop.v1"].output.safeParse(stopped.value).success).toBe(true);
    const post = f.requests.slice(before);
    expect(post).toHaveLength(1);
    expect(post[0].url.pathname).toBe("/open_api/v1.3/campaign/status/update/");
    expect(post[0].init.method).toBe("POST");
    expect(JSON.parse(String(post[0].init.body))).toEqual({ advertiser_id: "123", campaign_ids: ["456"], operation_status: "DISABLE" });
    expect(JSON.stringify(stopped)).not.toContain("s3cret-fixture");
  }
  const before = f.requests.length;
  expect(await halt({ context, connection, input: { ...haltPermit().request, bindingId: "wrong-binding" } })).toMatchObject({ ok: false, error: { code: "forbidden" } });
  expect(f.requests).toHaveLength(before);
  const unreadable = fixture({ bodies: ["unreadable"] });
  expect(await createCapabilities({ ...dependencies, fetch: unreadable.dependencies.fetch })["campaign.halt-stop.v1"]({ context, connection, input: haltPermit().request })).toEqual({ ok: true, value: { status: "unknown", entityIds: ["456"] } });
  expect(unreadable.requests).toHaveLength(1);
  expect(JSON.stringify([result, tool, f.observations])).not.toContain("s3cret-fixture");
});

it.each([
  { grain: "campaign", dimension: "campaign_id", level: "AUCTION_CAMPAIGN", parents: {}, entity: { vendorCampaignId: "11" } },
  { grain: "ad_group", dimension: "adgroup_id", level: "AUCTION_ADGROUP", parents: { campaign_id: "10" }, entity: { vendorCampaignId: "10", vendorAdGroupId: "11" } },
  { grain: "ad", dimension: "ad_id", level: "AUCTION_AD", parents: { campaign_id: "10", adgroup_id: "20" }, entity: { vendorCampaignId: "10", vendorAdGroupId: "20", vendorAdId: "11" } },
] as const)("reports $grain with distinct entities on one day and verified parent attributes", async ({ grain, dimension, level, parents, entity }) => {
  const list = ["11", "12"].map(id => ({ dimensions: { [dimension]: id, stat_time_day: days.start }, metrics: { spend: "1.000001", impressions: "2", clicks: "0", ...parents } }));
  const f = fixture({ bodies: [page({ list })] });
  const result = await f.capabilities["report.metrics.v1"]!({ context, connection, input: { ...input, grain } });
  expect(result).toMatchObject({ ok: true, value: { grain, complete: true, rows: [{ entity: { grain, ...entity }, metrics: { spend: "1000001" } }, { day: days.start }] } });
  expect(f.requests[0].url.searchParams.get("data_level")).toBe(level);
  expect(JSON.parse(f.requests[0].url.searchParams.get("dimensions")!)).toEqual([dimension, "stat_time_day"]);
});
it("rejects child metrics without parent attributes", async () => {
  const f = fixture({ bodies: [page({ list: [{ dimensions: { ad_id: "11", stat_time_day: days.start }, metrics: { spend: "1" } }] })] });
  expect(await f.capabilities["report.metrics.v1"]!({ context, connection, input: { ...input, grain: "ad" } })).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
});
it.each([
  ["ENABLE", "CAMPAIGN_STATUS_ENABLE", "active"], ["ENABLE", "CAMPAIGN_STATUS_DELETE", "ended"],
  ["ENABLE", "CAMPAIGN_STATUS_BUDGET_EXCEED", "paused"], ["ENABLE", "CAMPAIGN_STATUS_ADVERTISER_AUDIT_DENY", "disapproved"],
  ["ENABLE", "CAMPAIGN_STATUS_ADVERTISER_AUDIT", "pending"], ["DISABLE", "CAMPAIGN_STATUS_ENABLE", "unknown"],
  ["ENABLE", "NEW_CODE", "unknown"],
])("preserves secondary status %s/%s through the real decoder", async (operation, secondary, expected) => {
  const f = fixture({ bodies: [page({ pageSize: 100, list: [campaign({ id: "11", operation, secondary })] })] });
  expect(await f.capabilities["campaign.status.v1"]!({ context, connection, input: { vendorCampaignIds: ["11"] } })).toMatchObject({ ok: true, value: { complete: expected !== "unknown", campaigns: [{ status: expected }] } });
});

it("retains partial metrics at the 5,000-row cap without draining further pages", async () => {
  const f = fixture({ response: url => {
    const number = Number(url.searchParams.get("page"));
    return page({ page: number, total: 16000, list: Array.from({ length: 1000 }, (_, i) => ({ dimensions: { campaign_id: String((number - 1) * 1000 + i + 1), stat_time_day: days.start }, metrics: { spend: "1", impressions: "1", clicks: "0" } })) });
  } });
  const result = await f.capabilities["report.metrics.v1"]!({ context, connection, input: { ...input, grain: "campaign" } });
  expect(result).toMatchObject({ ok: true, value: { complete: false, dataThrough: 0, freshness: "stale" } });
  if (result.ok) expect(result.value.rows).toHaveLength(5000);
  expect(f.requests.length + f.metadataRequests.length).toBe(6);
});
it("rejects a repeated entity/day across report pages", async () => {
  const list = Array.from({ length: 1000 }, (_, i) => ({ dimensions: { campaign_id: String(i + 1), stat_time_day: days.start }, metrics: { spend: "1" } }));
  const f = fixture({ bodies: [page({ list, total: 1001 }), page({ list: [list[0]], total: 1001, page: 2 })] });
  expect(await f.capabilities["report.metrics.v1"]!({ context, connection, input: { ...input, grain: "campaign" } })).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
});

it("drains 5,000 daily rows over five 1,000-row pages with complete coverage", async () => {
  const f = fixture({ response: url => {
    const number = Number(url.searchParams.get("page"));
    return page({ page: number, total: 5000, list: Array.from({ length: 1000 }, (_, i) => ({ dimensions: { campaign_id: String((number - 1) * 1000 + i + 1), stat_time_day: days.start }, metrics: { spend: "1", impressions: "1", clicks: "0" } })) });
  } });
  const result = await f.capabilities["report.metrics.v1"]!({ context, connection, input: { ...input, grain: "campaign" } });
  expect(result).toMatchObject({ ok: true, value: { complete: true } });
  if (result.ok) expect(result.value.rows).toHaveLength(5000);
  expect(f.requests).toHaveLength(5);
  expect(f.requests.every(request => request.url.searchParams.get("page_size") === "1000")).toBe(true);
});

it.each([
  { adAccountId: "999" }, { scope: { ownerId: "foreign", workspaceId: "workspace" } },
  { connectionId: "foreign" }, { pluginDigest: "c".repeat(64) }, { bindingId: "foreign" },
  { entityIds: ["999"] }, haltPermit({ entityIds: ["456", "456"] }).request, { budget: 20 },
])("rejects mutated halt bindings and arguments before credentials or egress: %j", async changes => {
  const f = fixture();
  expect((await f.capabilities["campaign.halt-stop.v1"]!({ context, connection, input: { ...haltPermit().request, ...changes } })).ok).toBe(false);
  expect(f.accessCount()).toBe(0); expect(f.requests).toEqual([]); expect(f.metadataRequests).toEqual([]);
});

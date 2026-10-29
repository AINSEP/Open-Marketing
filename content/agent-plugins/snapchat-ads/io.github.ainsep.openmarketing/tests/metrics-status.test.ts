import { describe, expect, it } from "vitest";
import { metricBatchSchema, pluginConfigurationSchema } from "@open-marketing/contracts";
import type { MetricBatch, Outcome, PluginCapability, PluginCapabilityDependencies, ObserverEvent } from "@open-marketing/contracts";
import { createCapabilities } from "../src/index.js";
import { midnight } from "../src/metrics-status.js";

const accountId = "11111111-1111-1111-1111-111111111111", campaignId = "22222222-2222-2222-2222-222222222222";
const context = { scope: { ownerId: "owner", workspaceId: "workspace" }, principal: { kind: "owner" as const, ownerId: "owner" }, correlationId: "correlation", traceId: "trace", runId: "run" };
const connection = { connectionId: "connection", accountId }, days = { start: "2026-11-01", end: "2026-11-02" };
const input = { context, connection, input: { grain: "account" as const, days } };
const campaignInput = { ...input, input: { grain: "campaign" as const, days } };
const start = "2026-11-01T00:00:00-07:00", end = "2026-11-02T00:00:00-08:00";
const now = Date.parse("2026-11-03T12:00:00Z");
const interval = { start_time: start, end_time: end, stats: { spend: "9007199254740993", impressions: "0", conversion_purchases: "2", conversion_purchases_value: "1000000" } };
function series(required: { campaign?: boolean; intervals?: unknown[]; id?: string; final?: boolean } = {}) {
  return { id: required.id ?? (required.campaign ? campaignId : accountId), type: required.campaign ? "CAMPAIGN" : "AD_ACCOUNT", granularity: "DAY", start_time: start, end_time: end,
    ...(required.final === false ? {} : { finalized_data_end_time: end, conversion_data_processed_end_time: end }), timeseries: required.intervals ?? [interval] };
}
function stats(required: Parameters<typeof series>[0] = {}) {
  return { request_status: "SUCCESS", timeseries_stats: [{ sub_request_status: "SUCCESS", timeseries_stat: series(required) }] };
}
/** Independent nested wire fixture, matching the vendor's DAY breakdown example. */
function breakdown(required: { children?: unknown[]; paging?: object; id?: string; final?: boolean } = {}) {
  return { request_status: "SUCCESS", timeseries_stats: [{ sub_request_status: "SUCCESS", timeseries_stat: {
    id: required.id ?? accountId, type: "AD_ACCOUNT", start_time: start, end_time: end,
    ...(required.final === false ? {} : { finalized_data_end_time: end, conversion_data_processed_end_time: end }),
    breakdown_stats: { campaign: required.children ?? [series({ campaign: true })], ...required.paging },
  } }] };
}
const entity = { id: campaignId, ad_account_id: accountId, status: "ACTIVE", delivery_status: ["DELIVERING"] };
const page = { request_status: "SUCCESS", campaigns: [{ sub_request_status: "SUCCESS", campaign: entity }] };
function fixture(required: { body?: unknown; campaign?: boolean; currency?: string; account?: unknown; credentialHook?: () => void } = {}) {
  const calls: { url: string; init: RequestInit }[] = [], observations: ObserverEvent[] = [];
  const state = { current: true, credentials: 0 };
  const dependencies: PluginCapabilityDependencies = {
    configuration: pluginConfigurationSchema.parse({ scope: context.scope, ...connection, pluginDigest: "a".repeat(64), settings: { version: 1, enabled: false, capabilities: [], currency: "USD", timezone: "UTC" } }),
    credentials: { async access() { state.credentials++; required.credentialHook?.(); return { ok: true, value: { accessToken: "fixture-token", expiresAt: now + 60000 } }; } },
    fetch: async (url, init) => {
      if (!state.current) throw new Error("Host fence revoked");
      calls.push({ url: String(url), init: init ?? {} });
      if (String(url) === "https://adsapi.snapchat.com/v1/adaccounts/" + accountId) return Response.json(required.account ?? { request_status: "SUCCESS", adaccounts: [{ sub_request_status: "SUCCESS", adaccount: { id: accountId, currency: required.currency ?? "KRW", timezone: "America/Los_Angeles" } }] });
      const fallback = String(url).includes("/stats") ? (required.campaign ? breakdown() : stats()) : page;
      return new Response(JSON.stringify(required.body ?? fallback).replaceAll('"9007199254740993"', "9007199254740993"));
    },
    clock: { now: () => now }, observer: { observe(event) { observations.push(event); } }, wait: async () => ({ ok: true, value: undefined }),
  };
  return { capabilities: createCapabilities(dependencies), calls, state, observations, dependencies };
}
function memory(): PluginCapability<"report.metrics.v1"> {
  return async (): Promise<Outcome<MetricBatch>> => ({ ok: true, value: { schema: "report.metrics.v1", pluginId: "snapchat-ads", ...connection, currency: "KRW", timezone: "America/Los_Angeles", grain: "account", days,
    mapping: { pluginId: "snapchat-ads", version: "fixture", grains: { account: { spend: { vendorField: "spend", meaning: "Account micros" } } } },
    retrievedAt: now, dataThrough: Date.parse(end), complete: true, freshness: "stale", finality: "final", restated: false,
    rows: [{ day: days.start, entity: { grain: "account" }, metrics: { spend: "9007199254740993" } }] } });
}
for (const kind of ["memory", "transport"] as const) {
  describe("Snapchat metrics contract: " + kind, () => {
    it("preserves account currency micros and the 25-hour local calendar day", async () => {
      const run = kind === "memory" ? memory() : fixture().capabilities["report.metrics.v1"]!;
      const result = await run(input); expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("Expected fixture metrics");
      expect(metricBatchSchema.safeParse(result.value).success).toBe(true);
      expect(result.value).toMatchObject({ currency: "KRW", timezone: "America/Los_Angeles", complete: true, rows: [{ day: days.start, metrics: { spend: "9007199254740993" } }] });
      expect(result.value.rows[0].metrics).not.toHaveProperty("clicks");
    });
  });
}
it("uses actual DST offsets instead of 24-hour increments", () => {
  expect(midnight({ day: "2026-11-01", timezone: "America/Los_Angeles" })).toBe("2026-11-01T07:00:00.000Z");
  expect(midnight({ day: "2026-11-02", timezone: "America/Los_Angeles" })).toBe("2026-11-02T08:00:00.000Z");
  expect(Date.parse(midnight({ day: "2026-03-09", timezone: "America/Los_Angeles" })!) - Date.parse(midnight({ day: "2026-03-08", timezone: "America/Los_Angeles" })!)).toBe(23 * 3600000);
  expect(midnight({ day: days.start, timezone: "Invalid/Zone" })).toBeNull();
});
it("requests campaign breakdown once with documented attribution and exact values", async () => {
  const f = fixture({ campaign: true });
  const result = await f.capabilities["report.metrics.v1"]!(campaignInput);
  expect(result).toMatchObject({ ok: true, value: { complete: true, finality: "provisional", rows: [{ entity: { grain: "campaign", vendorCampaignId: campaignId }, metrics: { spend: "9007199254740993", impressions: "0", clicks: null, vendorConversions: "2000000", vendorConversionValue: "1000000" } }] } });
  expect(f.calls).toHaveLength(2);
  const url = new URL(f.calls[1].url);
  expect(url.pathname).toBe("/v1/adaccounts/" + accountId + "/stats");
  expect(url.searchParams.get("breakdown")).toBe("campaign"); expect(url.searchParams.get("granularity")).toBe("DAY");
  expect(url.searchParams.get("conversion_source_types")).toBe("total"); expect(url.searchParams.get("swipe_up_attribution_window")).toBe("28_DAY");
  expect(url.searchParams.get("view_attribution_window")).toBe("1_DAY"); expect(url.searchParams.has("engaged_view_attribution_window")).toBe(false);
});
it("handles more than nine campaigns with one fetch and no enumeration", async () => {
  const children = Array.from({ length: 12 }, (_, index) => series({ campaign: true, id: String(index).padStart(8, "0") + "-2222-2222-2222-222222222222" }));
  const f = fixture({ body: breakdown({ children }) });
  const result = await f.capabilities["report.metrics.v1"]!(campaignInput);
  expect(result.ok).toBe(true); if (!result.ok) throw new Error("Expected breakdown");
  expect(result.value.rows).toHaveLength(12); expect(result.value.complete).toBe(true);
  expect(result.value.rows.map(row => row.entity)).toEqual(children.map(child => ({ grain: "campaign", vendorCampaignId: child.id })));
  expect(f.calls).toHaveLength(2); expect(f.state.credentials).toBe(2);
});
it.each(["JPY", "KRW", "USD"])("keeps native micros unchanged for %s", async currency => {
  expect(await fixture({ currency }).capabilities["report.metrics.v1"]!(input)).toMatchObject({ ok: true, value: { currency, rows: [{ metrics: { spend: "9007199254740993" } }] } });
});
it("separates missing watermarks, missing intervals and complete empty campaign breakdowns", async () => {
  expect(await fixture({ body: stats({ final: false }) }).capabilities["report.metrics.v1"]!(input)).toMatchObject({ ok: true, value: { dataThrough: 0, freshness: "stale", finality: "provisional" } });
  expect(await fixture({ body: stats({ intervals: [] }) }).capabilities["report.metrics.v1"]!(input)).toMatchObject({ ok: true, value: { complete: false, rows: [] } });
  expect(await fixture({ body: breakdown({ children: [], final: false }) }).capabilities["report.metrics.v1"]!(campaignInput)).toMatchObject({ ok: true, value: { complete: true, rows: [], dataThrough: 0, freshness: "stale" } });
});
it("rejects duplicate, foreign, overlapping and non-local-midnight data atomically", async () => {
  const child = series({ campaign: true });
  for (const body of [breakdown({ id: campaignId }), breakdown({ children: [child, child] }), breakdown({ children: [child, { ...child, id: accountId, ad_account_id: campaignId }] }), breakdown({ children: [{ ...child, type: "AD_ACCOUNT" }] }), breakdown({ children: [{ ...child, timeseries: [interval, interval] }] }), breakdown({ children: [{ ...child, timeseries: [{ ...interval, start_time: "2026-11-01T00:00:00Z" }] }] }), breakdown({ children: [null] })]) {
    const f = fixture({ body }); expect((await f.capabilities["report.metrics.v1"]!(campaignInput)).ok).toBe(false); expect(f.calls).toHaveLength(2);
  }
});
it.each(["top", "wrapper", "account", "breakdown", "child"] as const)("marks %s pagination incomplete without fetching provider links", async location => {
  const body = breakdown(); const wrapper = body.timeseries_stats[0]; const account = wrapper.timeseries_stat;
  const target = { top: body, wrapper, account, breakdown: account.breakdown_stats, child: account.breakdown_stats.campaign[0] }[location]!;
  Object.assign(target as object, { paging: { next_link: "https://untrusted.test/next" } });
  const f = fixture({ body });
  expect(await f.capabilities["report.metrics.v1"]!(campaignInput)).toMatchObject({ ok: true, value: { complete: false } }); expect(f.calls).toHaveLength(2);
});
for (const kind of ["memory", "transport"] as const) {
  it("Snapchat campaign status contract: " + kind, async () => {
    const memoryStatus: PluginCapability<"campaign.status.v1"> = async () => ({ ok: true, value: { observedAt: now, complete: true, campaigns: [{ vendorCampaignId: campaignId, status: "active", disapprovalDescriptions: [] }] } });
    const run = kind === "memory" ? memoryStatus : fixture().capabilities["campaign.status.v1"]!;
    expect(await run({ context, connection, input: { vendorCampaignIds: [campaignId] } })).toMatchObject({ ok: true, value: { complete: true, campaigns: [{ vendorCampaignId: campaignId, status: "active", disapprovalDescriptions: [] }] } });
  });
}
it("rejects foreign status ownership and leaves unsupported serving evidence unknown", async () => {
  const foreign = fixture({ body: { ...page, campaigns: [{ sub_request_status: "SUCCESS", campaign: { ...entity, ad_account_id: campaignId } }] } });
  expect(await foreign.capabilities["campaign.status.v1"]!({ context, connection, input: { vendorCampaignIds: [campaignId] } })).toMatchObject({ ok: false, error: { code: "forbidden" } });
  const unknown = fixture({ body: { ...page, campaigns: [{ sub_request_status: "SUCCESS", campaign: { ...entity, delivery_status: ["INVALID_CAMPAIGN_HAS_NO_ACTIVE_AD_SQUAD"] } }] } });
  expect(await unknown.capabilities["campaign.status.v1"]!({ context, connection, input: { vendorCampaignIds: [campaignId] } })).toMatchObject({ ok: true, value: { campaigns: [{ status: "unknown" }] } });
});
it("exports canonical keys, bounds inputs before I/O, and uses service context traces", async () => {
  const f = fixture(); expect(Object.keys(f.capabilities)).toEqual(["report.metrics.v1", "campaign.status.v1"]);
  const controller = new AbortController(); controller.abort();
  expect(await f.capabilities["report.metrics.v1"]!(input, { signal: controller.signal })).toMatchObject({ ok: false, error: { code: "cancelled" } });
  expect(await f.capabilities["report.metrics.v1"]!({ ...input, connection: { ...connection, accountId: campaignId } })).toMatchObject({ ok: false, error: { code: "forbidden" } });
  expect(await f.capabilities["report.metrics.v1"]!({ ...input, input: { ...input.input, grain: "ad_group" } })).toMatchObject({ ok: false, error: { code: "not_implemented" } });
  expect(f.state.credentials).toBe(0); expect(f.calls).toHaveLength(0);
  expect((await f.capabilities["report.metrics.v1"]!({ ...input, context: { scope: context.scope, serviceId: "measure", correlationId: "correlation", traceId: "trace" } })).ok).toBe(true);
  expect(f.observations).toContainEqual(expect.objectContaining({ correlationId: "correlation", traceId: "trace" }));
});
it("relies on the host fetch fence after credential resolution", async () => {
  const f = fixture({ credentialHook: () => { f.state.current = false; } });
  expect(await f.capabilities["report.metrics.v1"]!(input)).toMatchObject({ ok: false, error: { code: "unavailable" } }); expect(f.calls).toHaveLength(0);
});

it("rejects tainted factory configuration without effects", async () => {
  const f = fixture(); const capabilities = createCapabilities({ ...f.dependencies, configuration: { unexpected: true } as unknown as PluginCapabilityDependencies["configuration"] });
  expect(await capabilities["report.metrics.v1"]!(input)).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  expect(f.calls).toHaveLength(0); expect(f.state.credentials).toBe(0);
});

it("real factory accepts exact server configuration and uses vendor account facts", async () => {
  const f = fixture();
  const configuration = pluginConfigurationSchema.parse({ scope: context.scope, ...connection, pluginDigest: "a".repeat(64), settings: { version: 1, enabled: false, capabilities: [], currency: "USD", timezone: "UTC" } });
  const capabilities = createCapabilities({ ...f.dependencies, configuration });
  const result = await capabilities["report.metrics.v1"]!(input);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("Expected canonical metrics");
  expect(metricBatchSchema.safeParse(result.value).success).toBe(true);
  expect(result.value).toMatchObject({ currency: "KRW", timezone: "America/Los_Angeles" });
  expect(f.calls[0].url).toBe("https://adsapi.snapchat.com/v1/adaccounts/" + accountId);
  expect(f.calls).toHaveLength(2);
});
it("admits 31 account-local calendar days across DST and rejects 32", async () => {
  for (const window of [
    { days: { start: "2026-09-01", end: "2026-10-02" }, start: "2026-09-01T00:00:00-07:00", end: "2026-10-02T00:00:00-07:00" },
    { days: { start: "2026-10-03", end: "2026-11-03" }, start: "2026-10-03T00:00:00-07:00", end: "2026-11-03T00:00:00-08:00" },
    { days: { start: "2026-02-07", end: "2026-03-10" }, start: "2026-02-07T00:00:00-08:00", end: "2026-03-10T00:00:00-07:00" },
  ]) {
    const f = fixture({ body: { request_status: "SUCCESS", timeseries_stats: [{ sub_request_status: "SUCCESS", timeseries_stat: {
      id: accountId, type: "AD_ACCOUNT", granularity: "DAY", start_time: window.start, end_time: window.end, timeseries: [],
    } }] } });
    const result = await f.capabilities["report.metrics.v1"]!({ ...input, input: { grain: "account", days: window.days } });
    expect(result).toMatchObject({ ok: true, value: { days: window.days, timezone: "America/Los_Angeles", complete: false, rows: [] } });
    if (!result.ok) throw new Error("Expected canonical metrics");
    expect(metricBatchSchema.safeParse(result.value).success).toBe(true);
    expect(f.calls).toHaveLength(2);
    const query = new URL(f.calls[1].url).searchParams;
    expect(query.get("start_time")).toBe(new Date(window.start).toISOString()); expect(query.get("end_time")).toBe(new Date(window.end).toISOString());
  }
  const tooLong = fixture();
  expect(await tooLong.capabilities["report.metrics.v1"]!({ ...input, input: { grain: "account", days: { start: "2026-09-01", end: "2026-10-03" } } })).toMatchObject({ ok: false, error: { code: "limit_exceeded" } });
  expect(tooLong.calls).toHaveLength(0); expect(tooLong.state.credentials).toBe(0);
});
it("rejects future local-day boundaries after metadata and before stats", async () => {
  const f = fixture();
  expect(await f.capabilities["report.metrics.v1"]!({ ...input, input: { ...input.input, days: { start: "2026-11-04", end: "2026-11-05" } } })).toMatchObject({ ok: false, error: { code: "limit_exceeded" } });
  expect(f.calls).toHaveLength(1);
});
it.each([
  { id: campaignId, currency: "USD", timezone: "UTC" },
  { id: accountId, currency: "USD" },
  { id: accountId, currency: "USD", timezone: "Invalid/Zone" },
])("rejects foreign or malformed vendor metadata before stats", async adaccount => {
  const f = fixture({ account: { request_status: "SUCCESS", adaccounts: [{ sub_request_status: "SUCCESS", adaccount }] } });
  expect((await f.capabilities["report.metrics.v1"]!(input)).ok).toBe(false);
  expect(f.calls).toHaveLength(1);
});
it.each([
  { child: { ...series({ campaign: true }), type: "AD_ACCOUNT" }, code: "forbidden" },
  { child: { ...series({ campaign: true }), start_time: "2026-11-01T00:00:00Z" }, code: "protocol_mismatch" },
  { child: { ...series({ campaign: true }), end_time: "2026-11-03T00:00:00Z" }, code: "protocol_mismatch" },
])("retains distinct identity and window failures after projection extraction", async ({ child, code }) => {
  const f = fixture({ body: breakdown({ children: [child] }) });
  expect(await f.capabilities["report.metrics.v1"]!(campaignInput)).toMatchObject({ ok: false, error: { code } });
});

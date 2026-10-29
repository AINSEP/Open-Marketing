import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { CallContext, PluginCapabilityDependencies } from "@open-marketing/contracts";
import { metricBatchSchema, pluginConfigurationSchema } from "@open-marketing/contracts";
import { createCapabilities, createTools, metricMapping } from "../src/index.js";

const scope = { ownerId: "owner", workspaceId: "workspace" };
const context: CallContext = { scope, principal: { kind: "owner", ownerId: "owner" }, correlationId: "correlation", traceId: "trace", runId: "run" };
const connection = { connectionId: "connection", accountId: "123" };
const days = { start: "2026-10-01", end: "2026-10-03" };
const now = Date.parse("2026-10-26T10:00:00Z");
const first = { year: 2026, month: 10, day: 1 };
function row(required: { fields?: object } = {}) {
  return { dateRange: { start: first, end: first }, pivotValues: ["urn:li:sponsoredAccount:123"], costInLocalCurrency: "12.345678", impressions: 15, clicks: 0, externalWebsiteConversions: 2, conversionValueInLocalCurrency: "30.000001", ...required.fields };
}
function fixture(required: { pages: (object | string)[]; statuses?: number[]; currency?: string; now?: number; metadata?: unknown }) {
  const requests: { url: string; init: RequestInit }[] = [];
  const observed: unknown[] = [];
  const metadataRequests: { url: string; init: RequestInit }[] = [];
  let allowed = true;
  let accessCount = 0;
  let onAccess = () => {};
  const dependencies: PluginCapabilityDependencies = {
    configuration: pluginConfigurationSchema.parse({ scope, ...connection, pluginDigest: "a".repeat(64), settings: { currency: "UNTRUSTED" } }),
    credentials: { async access() { accessCount += 1; onAccess(); return { ok: true, value: { accessToken: "fixture-token" } }; } },
    clock: { now: () => required.now ?? now }, observer: { observe: event => { observed.push(event); } },
    wait: async () => ({ ok: true, value: undefined }),
    fetch: (async (url, init) => { if (!allowed) throw new Error("Host guarded fetch denied"); if (String(url) === "https://api.linkedin.com/rest/adAccounts/123") { metadataRequests.push({ url: String(url), init: init! }); return Response.json(required.metadata ?? { id: 123, currency: required.currency ?? "USD" }); } const index = requests.length; requests.push({ url: String(url), init: init! }); const body = required.pages[index] ?? {}; return new Response(required.statuses?.[index] === 204 ? null : typeof body === "string" ? body : JSON.stringify(body), { status: required.statuses?.[index] ?? 200 }); }) as typeof fetch,
  };
  return { dependencies, capabilities: createCapabilities(dependencies), requests, metadataRequests, observed, accessCount: () => accessCount, revoke: () => { allowed = false; }, onAccess: ({ work }: { work: () => void }) => { onAccess = work; } };
}

describe("LinkedIn canonical capabilities (synthetic HTTP fixtures)", () => {
  it.each(["bytes", "elements"])("splits oversized %s reports into disjoint date windows", async limit => {
    const overflow = limit === "bytes" ? " ".repeat(1048577) : { elements: Array.from({ length: 5001 }, (_, index) => ({ dateRange: { start: first, end: first }, pivotValues: ["urn:li:sponsoredCampaign:" + (index + 1)] })) };
    const second = { ...first, day: 2 };
    const test = fixture({ pages: [overflow, { elements: [row({ fields: { pivotValues: ["urn:li:sponsoredCampaign:11"] } })] }, { elements: [row({ fields: { pivotValues: ["urn:li:sponsoredCampaign:12"], dateRange: { start: second, end: second } } })] }] });
    const result = await test.capabilities["report.metrics.v1"]({ context, connection, input: { grain: "campaign", days } });
    expect(result).toMatchObject({ ok: true, value: { complete: true } });
    if (result.ok) expect(result.value.rows.map(value => value.day)).toEqual(["2026-10-01", "2026-10-02"]);
    expect(test.requests).toHaveLength(3);
    expect(test.requests[1].url).toContain("start:(year:2026,month:10,day:1),end:(year:2026,month:10,day:1)");
    expect(test.requests[2].url).toContain("start:(year:2026,month:10,day:2),end:(year:2026,month:10,day:2)");
  });
  it("returns 429 without splitting or retrying analytics", async () => {
    const test = fixture({ pages: [{}], statuses: [429] });
    expect(await test.capabilities["report.metrics.v1"]({ context, connection, input: { grain: "account", days } })).toMatchObject({ ok: false, error: { code: "limit_exceeded" } });
    expect(test.requests).toHaveLength(1);
  });
  it("preserves a completed split window when the 25s budget runs out", async () => {
    const test = fixture({ pages: [" ".repeat(1048577), { elements: [row()] }, { elements: [] }] });
    let time = now;
    const dependencies = { ...test.dependencies, clock: { now: () => time }, fetch: (async (url, init) => {
      const response = await test.dependencies.fetch(url, init);
      if (test.requests.length === 2) time += 25001;
      return response;
    }) as typeof fetch };
    const result = await createCapabilities(dependencies)["report.metrics.v1"]({ context, connection, input: { grain: "account", days } });
    expect(result).toMatchObject({ ok: true, value: { complete: false, dataThrough: 0, rows: [{ day: "2026-10-01" }] } });
    expect(test.requests).toHaveLength(2);
  });
  it("requests DAILY with inclusive provider end and converts five metrics exactly", async () => {
    const test = fixture({ pages: [{ elements: [row(), row({ fields: { dateRange: { start: { ...first, day: 2 }, end: { ...first, day: 2 } } } })] }] });
    const result = await test.capabilities["report.metrics.v1"]({ context, connection, input: { grain: "account", days } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(metricBatchSchema.safeParse(result.value).success).toBe(true);
    expect(result.value).toMatchObject({ timezone: "UTC", currency: "USD", complete: true, freshness: "fresh", finality: "provisional", retrievedAt: now, dataThrough: Date.parse(days.end) });
    expect(result.value.rows).toHaveLength(2);
    expect(result.value.rows[0]).toEqual({ day: "2026-10-01", entity: { grain: "account" }, metrics: { spend: "12345678", impressions: "15", clicks: "0", vendorConversions: "2000000", vendorConversionValue: "30000001" } });
    expect(test.requests[0]!.url).toContain("timeGranularity=DAILY");
    expect(test.requests[0]!.url).toContain("end:(year:2026,month:10,day:2)");
    expect(test.requests[0]!.url).toContain("accounts=List(urn%3Ali%3AsponsoredAccount%3A123)");
    expect(test.requests[0]!.init).toMatchObject({ redirect: "error", method: "GET", headers: { "LinkedIn-Version": "202610" } });
    expect(test.observed).toContainEqual(expect.objectContaining({ correlationId: "correlation", traceId: "trace", runId: "run" }));
    expect(metricMapping.grains.account?.clicks?.meaning).toContain("Chargeable clicks");
    expect(metricMapping.grains.account?.vendorConversions?.meaning).toContain("configured");
  });
  it.each(["JPY", "KRW"])("uses one million micros per major %s unit", async currency => {
    const test = fixture({ currency, pages: [{ elements: [row({ fields: { costInLocalCurrency: "123", conversionValueInLocalCurrency: "0" } })] }] });
    expect(await test.capabilities["report.metrics.v1"]({ context, connection, input: { grain: "account", days } })).toMatchObject({ ok: true, value: { currency, rows: [{ metrics: { spend: "123000000", vendorConversionValue: "0" } }] } });
  });
  it("preserves large decimal strings and fractional conversions without adding overlapping categories", async () => {
    const test = fixture({ pages: [{ elements: [row({ fields: { costInLocalCurrency: "9007199254740993.123456", externalWebsiteConversions: "0.125", externalWebsitePostClickConversions: "8", externalWebsitePostViewConversions: "9" } })] }] });
    expect(await test.capabilities["report.metrics.v1"]({ context, connection, input: { grain: "account", days } })).toMatchObject({ ok: true, value: { rows: [{ metrics: { spend: "9007199254740993123456", vendorConversions: "125000" } }] } });
  });
  it("preserves unsafe JSON integer source tokens and numeric decimal money when the engine supplies source context", async () => {
    const body = JSON.stringify({ elements: [row()] }).replace('"12.345678"', "9007199254740993.123456").replace('"impressions":15', '"impressions":9007199254740993');
    const test = fixture({ pages: [body] });
    const result = await test.capabilities["report.metrics.v1"]({ context, connection, input: { grain: "account", days } });
    // Source-context-free runtimes must reject instead of manufacturing a rounded amount.
    const hasSource = JSON.parse("1", (_key, _value, context?: unknown) => context) !== undefined;
    if (!hasSource) { expect(result.ok).toBe(false); return; }
    expect(result).toMatchObject({ ok: true, value: { rows: [{ metrics: { spend: "9007199254740993123456", impressions: "9007199254740993" } }] } });
  });
  it("keeps missing supported values null and observed zero intact", async () => {
    const test = fixture({ pages: [{ elements: [{ dateRange: { start: first, end: first }, pivotValues: ["urn:li:sponsoredAccount:123"], clicks: 0 }] }] });
    expect(await test.capabilities["report.metrics.v1"]({ context, connection, input: { grain: "account", days } })).toMatchObject({ ok: true, value: { rows: [{ metrics: { spend: null, impressions: null, clicks: "0", vendorConversions: null, vendorConversionValue: null } }] } });
  });
  it("returns a campaign entity without inventing an ad group", async () => {
    const test = fixture({ pages: [{ elements: [row({ fields: { pivotValues: ["urn:li:sponsoredCampaign:99"] } })] }] });
    expect(await test.capabilities["report.metrics.v1"]({ context, connection, input: { grain: "campaign", days } })).toMatchObject({ ok: true, value: { rows: [{ entity: { grain: "campaign", vendorCampaignId: "99" } }] } });
    expect(test.requests[0]!.url).toContain("pivot=CAMPAIGN");
  });
  it.each(["ad_group", "ad"] as const)("leaves %s unsupported before credential/network access", async grain => {
    const test = fixture({ pages: [] });
    expect(await test.capabilities["report.metrics.v1"]({ context, connection, input: { grain, days } })).toMatchObject({ ok: false, error: { code: "not_implemented" } });
    expect(test.accessCount()).toBe(0); expect(test.requests).toHaveLength(0);
  });
  it.each([
    { costInLocalCurrency: "0.0000001" }, { costInLocalCurrency: "99999999999999999999999999999999999999" },
    { dateRange: { start: first, end: { ...first, day: 2 } } },
    { dateRange: { start: { ...first, day: 3 }, end: { ...first, day: 3 } } },
    { pivotValues: ["urn:li:sponsoredAccount:999"] },
  ])("rejects nonrepresentable amounts, invalid daily ranges or a foreign account", async fields => {
    const test = fixture({ pages: [{ elements: [row(), row({ fields })] }] });
    expect((await test.capabilities["report.metrics.v1"]({ context, connection, input: { grain: "account", days } })).ok).toBe(false);
  });
  it("rejects repeated day/entity keys across the response", async () => {
    const test = fixture({ pages: [{ elements: [row(), row()] }] });
    expect(await test.capabilities["report.metrics.v1"]({ context, connection, input: { grain: "account", days } })).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
  });
  it("treats drained empty analytics as complete without inventing zero rows", async () => {
    const test = fixture({ pages: [{ elements: [] }] });
    expect(await test.capabilities["report.metrics.v1"]({ context, connection, input: { grain: "account", days } })).toMatchObject({ ok: true, value: { rows: [], complete: true, dataThrough: Date.parse(days.end) } });
  });
  it("marks a 5,000-row analytics response incomplete at the row ceiling", async () => {
    const elements = Array.from({ length: 5000 }, (_, index) => ({ dateRange: { start: first, end: first }, pivotValues: ["urn:li:sponsoredCampaign:" + (index + 1)] }));
    const test = fixture({ pages: [{ elements }] });
    const result = await test.capabilities["report.metrics.v1"]({ context, connection, input: { grain: "campaign", days } });
    expect(result).toMatchObject({ ok: true, value: { complete: false, dataThrough: 0 } });
    if (result.ok) expect(result.value.rows).toHaveLength(5000);
    expect(test.requests).toHaveLength(1);
  });
  it("maps one account-scoped batch, retaining errors and missing IDs as unknown in requested order", async () => {
    const test = fixture({ pages: [{ results: {
      "11": { id: 11, account: "urn:li:sponsoredAccount:123", status: "ACTIVE", servingStatuses: ["RUNNABLE"] },
      "12": { id: 12, account: "urn:li:sponsoredAccount:123", status: "ACTIVE", servingStatuses: ["FUTURE_UNKNOWN"] },
    }, errors: { "13": { status: 404 } } }] });
    const result = await test.capabilities["campaign.status.v1"]({ context, connection, input: { vendorCampaignIds: ["13", "11", "12", "14"] } });
    expect(result).toMatchObject({ ok: true, value: { complete: false, campaigns: [
      { vendorCampaignId: "13", status: "unknown" }, { vendorCampaignId: "11", status: "active" }, { vendorCampaignId: "12", status: "unknown" }, { vendorCampaignId: "14", status: "unknown" },
    ] } });
    expect(test.requests).toHaveLength(1);
    expect(test.requests[0]!.url).toBe("https://api.linkedin.com/rest/adAccounts/123/adCampaigns?ids=List(13,11,12,14)");
    expect(test.requests[0]!.init.headers).toMatchObject({ "X-RestLi-Method": "BATCH_GET" });
  });
  it.each([11, 100])("fetches all %i requested IDs in one batch", async count => {
    const ids = Array.from({ length: count }, (_, index) => String(index + 1));
    const results = Object.fromEntries(ids.map(id => [id, { id, account: "urn:li:sponsoredAccount:123", status: "PAUSED" }]));
    const test = fixture({ pages: [{ results }] });
    const result = await test.capabilities["campaign.status.v1"]({ context, connection, input: { vendorCampaignIds: ids } });
    expect(result).toMatchObject({ ok: true, value: { complete: true } });
    if (result.ok) expect(result.value.campaigns.map(item => item.vendorCampaignId)).toEqual(ids);
    expect(test.requests).toHaveLength(1);
  });
  it.each(["PAUSED", "DRAFT", "COMPLETED", "UNFAMILIAR"])("maps %s without invented rejection reasons", async state => {
    const test = fixture({ pages: [{ results: { "11": { id: "11", account: "urn:li:sponsoredAccount:123", status: state } } }] });
    const status = { PAUSED: "paused", DRAFT: "pending", COMPLETED: "ended", UNFAMILIAR: "unknown" }[state];
    expect(await test.capabilities["campaign.status.v1"]({ context, connection, input: { vendorCampaignIds: ["11"] } })).toMatchObject({ ok: true, value: { campaigns: [{ status, disapprovalDescriptions: [] }] } });
  });
  it.each([
    { results: { "11": { id: "11", account: "urn:li:sponsoredAccount:999", status: "PAUSED" } }, code: "forbidden" },
    { results: { "12": { id: "12", account: "urn:li:sponsoredAccount:123", status: "PAUSED" } }, code: "protocol_mismatch" },
    { results: { "11": { id: "12", account: "urn:li:sponsoredAccount:123", status: "PAUSED" } }, code: "protocol_mismatch" },
    { results: { "11": { id: "11", account: "urn:li:sponsoredAccount:123", status: "PAUSED" } }, errors: { "11": { status: 404 } }, code: "protocol_mismatch" },
  ])("rejects foreign, unsolicited, conflicting and miskeyed results", async ({ code, ...body }) => {
    const test = fixture({ pages: [body] });
    expect(await test.capabilities["campaign.status.v1"]({ context, connection, input: { vendorCampaignIds: ["11"] } })).toMatchObject({ ok: false, error: { code } });
  });
  it("handles a missing batch independently of numeric parsing", async () => {
    const test = fixture({ pages: [{}], statuses: [404] });
    expect(await test.capabilities["campaign.status.v1"]({ context, connection, input: { vendorCampaignIds: ["11"] } })).toMatchObject({ ok: true, value: { complete: false, campaigns: [{ status: "unknown" }] } });
  });
  it("returns a typed guarded-fetch failure with service context and no per-plugin authority port", async () => {
    const test = fixture({ pages: [] }); test.onAccess({ work: test.revoke });
    const service = { scope, serviceId: "sync", correlationId: "correlation", traceId: "trace" };
    expect(await test.capabilities["report.metrics.v1"]({ context: service, connection, input: { grain: "account", days } })).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(test.accessCount()).toBe(1); expect(test.requests).toHaveLength(0);
    expect(test.observed).toContainEqual(expect.objectContaining({ traceId: "trace", correlationId: "correlation" }));
  });
  it("cancels during token resolution without sending", async () => {
    const cancelled = fixture({ pages: [] }); const controller = new AbortController(); cancelled.onAccess({ work: () => controller.abort() });
    expect(await cancelled.capabilities["report.metrics.v1"]({ context, connection, input: { grain: "account", days } }, { signal: controller.signal })).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(cancelled.requests).toHaveLength(0);
  });
  it("rejects malformed input or another binding before credentials", async () => {
    const test = fixture({ pages: [] });
    expect((await test.capabilities["report.metrics.v1"]({ context, connection: { ...connection, accountId: "999" }, input: { grain: "account", days } })).ok).toBe(false);
    expect((await test.capabilities["campaign.status.v1"]({ context, connection, input: { vendorCampaignIds: ["11", "11"] } })).ok).toBe(false);
    expect(test.accessCount()).toBe(0);
  });
});

// Transport options must not couple exact-number parsing to missing-entity handling.
import { requestLinkedIn } from "../src/transport.js";
it.each([true, undefined] as const)("preserves explicit 404 missingness with numericText=%s", async numericText => {
  const response = await requestLinkedIn({ fetch: (async () => new Response("", { status: 404 })) as typeof fetch, request: { url: "https://api.linkedin.com/rest/adAccounts/123/adCampaigns?ids=List(11)", method: "GET", restliMethod: "BATCH_GET" }, credential: { accessToken: "fixture-token" }, apiVersion: "202610", missingAsNull: true, numericText });
  expect(response).toMatchObject({ ok: true, value: { body: null } });
});
it("does not treat numericText alone as permission to preserve a 404", async () => {
  expect(await requestLinkedIn({ fetch: (async () => new Response("", { status: 404 })) as typeof fetch, request: { url: "https://api.linkedin.com/rest/adAnalytics", method: "GET", restliMethod: "FINDER" }, credential: { accessToken: "fixture-token" }, apiVersion: "202610", numericText: true })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
});

it("reads status without reporting-only currency metadata", async () => {
  const test = fixture({ pages: [{ results: { "11": { id: "11", account: "urn:li:sponsoredAccount:123", status: "PAUSED" } } }] });
  const dependencies = { ...test.dependencies, configuration: pluginConfigurationSchema.parse({ scope, ...connection, pluginDigest: "a".repeat(64), settings: {} }) };
  expect(await createCapabilities(dependencies)["campaign.status.v1"]({ context, connection, input: { vendorCampaignIds: ["11"] } })).toMatchObject({ ok: true, value: { complete: true } });
});

// Real factory regression: server configuration has no account facts; authenticated metadata wins.
it("reads vendor currency with exact server configuration and returns catalog-valid output", async () => {
  const f = fixture({ pages: [{ elements: [row()] }], currency: "TWD" });
  const result = await f.capabilities["report.metrics.v1"]({ context, connection, input: { grain: "account", days } });
  expect(result).toMatchObject({ ok: true, value: { currency: "TWD" } });
  if (result.ok) expect(metricBatchSchema.safeParse(result.value).success).toBe(true);
  expect(f.metadataRequests).toHaveLength(1);
  expect(f.metadataRequests[0].init.headers).not.toHaveProperty("X-RestLi-Method");
});
it("marks a current UTC day stale even when analytics is drained", async () => {
  const f = fixture({ pages: [{ elements: [] }], now: Date.parse("2026-10-02T12:00:00Z") });
  expect(await f.capabilities["report.metrics.v1"]({ context, connection, input: { grain: "account", days } })).toMatchObject({ ok: true, value: { complete: true, freshness: "stale" } });
});
it.each([{ id: "999", currency: "USD" }, { id: "123" }])("rejects foreign or missing account currency before analytics", async metadata => {
  const f = fixture({ pages: [], metadata });
  expect((await f.capabilities["report.metrics.v1"]({ context, connection, input: { grain: "account", days } })).ok).toBe(false);
  expect(f.requests).toHaveLength(0);
});

/** Independent sorted-key digest matches safety, without calling plugin digest code. */
function haltInput() {
  const action = "stop" as const, adAccountId = "123", entityIds = ["567"];
  return { operationId: "halt-stop", scope, connectionId: connection.connectionId, adAccountId, entityIds, action, haltId: "halt", haltEpoch: 1, pluginDigest: "a".repeat(64), bindingId: "linkedin-ads.stop.v1", argumentsDigest: createHash("sha256").update(JSON.stringify({ action, adAccountId, entityIds })).digest("hex") };
}
describe("LinkedIn host halt capability", () => {
  it("accepts safety's sorted digest and emits only the PAUSED partial update", async () => {
    const test = fixture({ pages: [{}], statuses: [204] });
    expect(await test.capabilities["campaign.halt-stop.v1"]({ context, connection, input: haltInput() })).toEqual({ ok: true, value: { status: "acknowledged", entityIds: ["567"] } });
    expect(test.requests).toHaveLength(1);
    expect(test.requests[0].url).toBe("https://api.linkedin.com/rest/adAccounts/123/adCampaigns/567");
    expect(test.requests[0].init).toMatchObject({ method: "POST", body: '{"patch":{"$set":{"status":"PAUSED"}}}', headers: { "X-RestLi-Method": "PARTIAL_UPDATE" } });
    expect(test.metadataRequests).toHaveLength(0);
  });
  it.each([{ entityIds: ["567", "678"] }, { bindingId: "foreign" }, { pluginDigest: "b".repeat(64) }, { adAccountId: "456" }, { scope: { ownerId: "foreign", workspaceId: "workspace" } }, { connectionId: "foreign" }, { argumentsDigest: "c".repeat(64) }])("rejects unbound/batched halts before effects", async changes => {
    const test = fixture({ pages: [] });
    expect((await test.capabilities["campaign.halt-stop.v1"]({ context, connection, input: { ...haltInput(), ...changes } })).ok).toBe(false);
    expect(test.requests).toHaveLength(0); expect(test.metadataRequests).toHaveLength(0); expect(test.accessCount()).toBe(0);
  });
});

describe("LinkedIn fixed tools with the server configuration envelope", () => {
  it("lists campaigns with authenticated currency and the plugin-owned API version", async () => {
    const test = fixture({ pages: [{ elements: [] }] });
    expect(await createTools(test.dependencies).invoke({ context, connection, name: "list_campaigns", operationId: "list", input: { kind: "list_campaigns" }, moneyExposure: null, requiredLimit: null })).toMatchObject({ ok: true });
    expect(test.metadataRequests).toHaveLength(1); expect(test.requests).toHaveLength(1);
    expect(test.metadataRequests[0].url).toBe("https://api.linkedin.com/rest/adAccounts/123");
    expect(test.requests[0].url).toContain("/adAccounts/123/adCampaigns?");
    for (const request of [...test.metadataRequests, ...test.requests]) expect(request.init).toMatchObject({ method: "GET", headers: { "LinkedIn-Version": "202610" } });
  });
  it("refuses another connection before credentials or fetch", async () => {
    const test = fixture({ pages: [] });
    expect(await createTools(test.dependencies).invoke({ context, connection: { ...connection, connectionId: "other" }, name: "list_campaigns", operationId: "list", input: { kind: "list_campaigns" }, moneyExposure: null, requiredLimit: null })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(test.accessCount()).toBe(0); expect(test.requests).toHaveLength(0); expect(test.metadataRequests).toHaveLength(0);
  });
});

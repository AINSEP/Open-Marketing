import { describe, expect, it } from "vitest";
import { pluginConfigurationSchema, metricBatchSchema } from "@open-marketing/contracts";
import type { CallContext, MetricGrain } from "@open-marketing/contracts";
import { createCapabilities, metricMapping } from "../src/index.js";
import type { YandexCapabilityDependencies } from "../src/index.js";

const scope = { ownerId: "owner", workspaceId: "workspace" };
const context: CallContext = { scope, principal: { kind: "owner", ownerId: "owner" }, correlationId: "correlation", traceId: "trace", runId: "run" };
const connection = { connectionId: "connection", accountId: "123" };
const days = { start: "2026-10-01", end: "2026-10-03" };
const options = { signal: new AbortController().signal };
const now = Date.parse("2026-10-26T10:00:00Z");
const header = "Date\tCampaignId\tImpressions\tClicks\tCost\n";
function fixture(required: { pages: string[]; statuses?: number[]; metadata?: object; credential?: string }) {
  const requests: { url: string; init: RequestInit }[] = [];
  const observations: unknown[] = [];
  const metadataRequests: { url: string; init: RequestInit }[] = [];
  let accessCount = 0;
  const dependencies: YandexCapabilityDependencies = {
    configuration: pluginConfigurationSchema.parse({ ...connection, scope, pluginDigest: "a".repeat(64), settings: { clientLogin: "ignored", currency: "USD" } }),
    credentials: { async access() { accessCount += 1; return { ok: true, value: { accessToken: required.credential ?? JSON.stringify({ accessToken: "fixture-token", clientLogin: "client" }) } }; } },
    clock: { now: () => now }, observer: { observe: event => { observations.push(event); } },
    wait: async () => ({ ok: true, value: undefined }),
    fetch: (async (url, init) => { if (String(url).endsWith("/clients")) { metadataRequests.push({ url: String(url), init: init! }); return Response.json(required.metadata ?? { result: { Clients: [{ ClientId: 123, Login: "client", Currency: "RUB" }] } }); } const index = requests.length; requests.push({ url: String(url), init: init! }); return new Response(required.pages[index] ?? "", { status: required.statuses?.[index] ?? 200 }); }) as typeof fetch,
  };
  return { capabilities: createCapabilities(dependencies), dependencies, requests, metadataRequests, observations, accessCount: () => accessCount };
}

describe("Yandex canonical capabilities (synthetic HTTP fixtures)", () => {
  it("uses the credential login and vendor account currency with exact server configuration", async () => {
    const test = fixture({ pages: [header], metadata: { result: { Clients: [{ ClientId: 123, Login: "client", Currency: "JPY" }] } } });
    expect(test.accessCount()).toBe(0); expect(test.metadataRequests).toHaveLength(0);
    expect(await test.capabilities["report.metrics.v1"]!({ context, connection, input: { grain: "campaign", days } }, options)).toMatchObject({ ok: true, value: { currency: "JPY", complete: true } });
    expect(test.accessCount()).toBe(1); expect(test.metadataRequests).toHaveLength(1);
    expect(new Headers(test.metadataRequests[0].init.headers).get("Client-Login")).toBe("client");
    expect(new Headers(test.requests[0].init.headers).get("Authorization")).toBe("Bearer fixture-token");
  });
  it.each(["plain-token", "{", JSON.stringify({ accessToken: "fixture-token" }), JSON.stringify({ accessToken: "bad\nheader", clientLogin: "client" })])("rejects malformed credential bundles before metadata: %s", async credential => {
    const test = fixture({ pages: [], credential });
    expect(await test.capabilities["report.metrics.v1"]!({ context, connection, input: { grain: "campaign", days } }, options)).toMatchObject({ ok: false, error: { code: "unauthenticated" } });
    expect(test.metadataRequests).toHaveLength(0); expect(test.requests).toHaveLength(0);
  });
  it.each([{ ClientId: 999, Login: "client", Currency: "RUB" }, { ClientId: 123, Login: "foreign", Currency: "RUB" }, { ClientId: 123, Login: "client" }])("rejects foreign or incomplete clients.get metadata", async account => {
    const test = fixture({ pages: [], metadata: { result: { Clients: [account] } } });
    expect((await test.capabilities["report.metrics.v1"]!({ context, connection, input: { grain: "campaign", days } }, options)).ok).toBe(false);
    expect(test.requests).toHaveLength(0);
  });
  it.each(["account", "campaign", "ad_group", "ad"] as const)("returns daily %s rows with complete required parents", async grain => {
    const ids = { account: [], campaign: ["11"], ad_group: ["11", "22"], ad: ["11", "22", "33"] }[grain];
    const names = { account: [], campaign: ["CampaignId"], ad_group: ["CampaignId", "AdGroupId"], ad: ["CampaignId", "AdGroupId", "AdId"] }[grain];
    const text = ["Date", ...names, "Impressions", "Clicks", "Cost"].join("\t") + "\n" + ["2026-10-01", ...ids, "9007199254740993", "0", "9007199254740993123"].join("\t") + "\n";
    const test = fixture({ pages: [text] });
    const result = await test.capabilities["report.metrics.v1"]!({ context, connection, input: { grain, days } }, options);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(metricBatchSchema.safeParse(result.value).success).toBe(true);
    expect(result.value).toMatchObject({ timezone: "Europe/Moscow", currency: "RUB", grain, days, complete: true, freshness: "stale", finality: "provisional", retrievedAt: now, dataThrough: Date.parse("2026-10-02T21:00:00Z"), restated: false });
    expect(result.value.rows[0]).toMatchObject({ day: "2026-10-01", entity: { grain }, metrics: { impressions: "9007199254740993", clicks: "0", spend: "9007199254740993123" } });
    expect(result.value.rows[0]?.metrics).not.toHaveProperty("vendorConversions");
    const sent = JSON.parse(test.requests[0]!.init.body as string);
    expect(sent.params.SelectionCriteria).toEqual({ DateFrom: "2026-10-01", DateTo: "2026-10-02" });
    expect(sent.params.FieldNames).toEqual(["Date", ...names, "Impressions", "Clicks", "Cost"]);
    expect(test.requests[0]).toMatchObject({ url: "https://api.direct.yandex.com/json/v501/reports", init: { method: "POST", redirect: "error", headers: { returnMoneyInMicros: "true", "Client-Login": "client" } } });
    expect(test.requests[0].init.signal).toBe(options.signal);
    expect(test.observations).toContainEqual(expect.objectContaining({ correlationId: "correlation", traceId: "trace", runId: "run" }));
  });
  it("distinguishes unavailable, observed zero and unsupported metrics without filling dates", async () => {
    const test = fixture({ pages: [header + "2026-10-01\t11\t--\t0\t--\n"] });
    const result = await test.capabilities["report.metrics.v1"]!({ context, connection, input: { grain: "campaign", days } }, options);
    expect(result).toMatchObject({ ok: true, value: { rows: [{ metrics: { spend: null, impressions: null, clicks: "0" } }] } });
    if (result.ok) { expect(result.value.rows).toHaveLength(1); expect(result.value.rows[0]!.metrics).not.toHaveProperty("vendorConversions"); }
    expect(metricMapping.grains.campaign).not.toHaveProperty("vendorConversions");
  });
  it("marks a valid exhausted empty report complete", async () => {
    const test = fixture({ pages: [header] });
    expect(await test.capabilities["report.metrics.v1"]!({ context, connection, input: { grain: "campaign", days } }, options)).toMatchObject({ ok: true, value: { complete: true, rows: [], dataThrough: Date.parse("2026-10-02T21:00:00Z") } });
  });
  it.each([
    header + "2026-10-01\t11\t1\t0\t10000\n2026-10-01\t11\t1\t0\t10000\n",
    header + "2026-10-01\t11\t1\t0\t10000\n2026-10-03\t11\t1\t0\t10000\n",
    header + "2026-10-01\t11\t1\t0\t10000\n2026-10-02\t11\t1\tbad\t10000\n",
  ])("rejects mixed-invalid, duplicate or exclusive-end rows atomically", async page => {
    const test = fixture({ pages: [page] });
    expect(await test.capabilities["report.metrics.v1"]!({ context, connection, input: { grain: "campaign", days } }, options)).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
  });
  it("caps row traversal at 5,000 without a sixth read", async () => {
    const pages = Array.from({ length: 5 }, (_, page) => header + Array.from({ length: 1000 }, (_, index) => `2026-10-01\t${page * 1000 + index + 1}\t1\t0\t10000`).join("\n") + "\n");
    const test = fixture({ pages });
    const result = await test.capabilities["report.metrics.v1"]!({ context, connection, input: { grain: "campaign", days } }, options);
    expect(result).toMatchObject({ ok: true, value: { complete: false } });
    if (result.ok) expect(result.value.rows).toHaveLength(5000);
    expect(test.requests).toHaveLength(5);
    expect(test.requests.map(request => JSON.parse(request.init.body as string).params.Page.Offset)).toEqual([0, 1000, 2000, 3000, 4000]);
    expect(new Set(test.requests.map(request => JSON.parse(request.init.body as string).params.ReportName)).size).toBe(5);
    if (result.ok) expect(result.value.dataThrough).toBe(0);
  });
  it("bounds the former 4,650-row month plus 1,000-row next month as one partial range", async () => {
    const test = fixture({ pages: [] });
    const requests: Record<string, unknown>[] = [];
    const dependencies = { ...test.dependencies, fetch: (async (_url, init) => {
      if (String(_url).endsWith("/clients")) return Response.json({ result: { Clients: [{ ClientId: 123, Login: "client", Currency: "RUB" }] } });
      const params = JSON.parse(String(init?.body)).params; requests.push(params);
      const monthOnly = params.SelectionCriteria.DateTo === "2026-10-31";
      const limit = monthOnly ? 4650 : 5650;
      const count = Math.min(1000, Math.max(0, limit - params.Page.Offset));
      const text = header + Array.from({ length: count }, (_, index) => `${params.SelectionCriteria.DateFrom}\t${params.Page.Offset + index + 1}\t1\t0\t10000`).join("\n") + "\n";
      return new Response(text);
    }) as typeof fetch };
    const result = await createCapabilities(dependencies)["report.metrics.v1"]!({ context, connection, input: { grain: "campaign", days: { start: "2026-10-01", end: "2026-11-03" } } }, options);
    expect(result).toMatchObject({ ok: true, value: { complete: false, dataThrough: 0 } });
    if (result.ok) expect(result.value.rows).toHaveLength(5000);
    expect(requests).toHaveLength(5);
  });
  it("caps the exhausted coverage cutoff at retrieval time", async () => {
    const test = fixture({ pages: [header] });
    const result = await test.capabilities["report.metrics.v1"]!({ context, connection, input: { grain: "campaign", days: { start: "2026-10-26", end: "2026-10-27" } } }, options);
    expect(result).toMatchObject({ ok: true, value: { complete: true, dataThrough: now } });
  });
  it("honors cancellation after credential resolution before sending", async () => {
    const test = fixture({ pages: [header] }), controller = new AbortController();
    const dependencies = { ...test.dependencies, credentials: { access: async () => {
      controller.abort(); return { ok: true as const, value: { accessToken: JSON.stringify({ accessToken: "fixture-token", clientLogin: "client" }) } };
    } } };
    expect(await createCapabilities(dependencies)["report.metrics.v1"]!({ context, connection, input: { grain: "campaign", days } }, { signal: controller.signal })).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(test.requests).toHaveLength(0);
  });
  it("requests a full-year custom range without calendar chunking", async () => {
    const test = fixture({ pages: Array.from({ length: 10 }, () => "Date\tImpressions\tClicks\tCost\n") });
    const input = { grain: "account" as MetricGrain, days: { start: "2025-10-01", end: "2026-10-01" } };
    expect(await test.capabilities["report.metrics.v1"]!({ context, connection, input }, options)).toMatchObject({ ok: true, value: { days: input.days, complete: true } });
    expect(test.requests).toHaveLength(1);
    expect(JSON.parse(test.requests[0].init.body as string).params.SelectionCriteria).toEqual({ DateFrom: "2025-10-01", DateTo: "2026-09-30" });
  });
  it("rejects duplicate identities across pages", async () => {
    const full = header + Array.from({ length: 1000 }, (_, index) => `2026-10-01\t${index + 1}\t1\t0\t0`).join("\n") + "\n";
    const test = fixture({ pages: [full, header + "2026-10-01\t1\t1\t0\t0\n"] });
    expect(await test.capabilities["report.metrics.v1"]!({ context, connection, input: { grain: "campaign", days } }, options)).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
  });
  it("maps documented status/rejection explanations and marks missing IDs unknown", async () => {
    const test = fixture({ pages: [JSON.stringify({ result: { Campaigns: [
      { Id: 11, Currency: "RUB", Status: "REJECTED", State: "OFF", StatusPayment: "ALLOWED", StatusClarification: "Synthetic rejection explanation" },
      { Id: 12, Currency: "RUB", Status: "NEW_STATUS", State: "ON", StatusPayment: "ALLOWED", StatusClarification: "Synthetic note" },
    ] } })] });
    expect(await test.capabilities["campaign.status.v1"]!({ context, connection, input: { vendorCampaignIds: ["11", "12", "13"] } }, options)).toEqual({ ok: true, value: { observedAt: now, complete: false, campaigns: [
      { vendorCampaignId: "11", status: "disapproved", disapprovalDescriptions: ["Synthetic rejection explanation"] },
      { vendorCampaignId: "12", status: "unknown", disapprovalDescriptions: [] }, { vendorCampaignId: "13", status: "unknown", disapprovalDescriptions: [] },
    ] } });
  });
  it.each(["active", "paused", "ended", "pending"] as const)("maps known %s status", async expected => {
    const fields = { active: { Status: "ACCEPTED", State: "ON" }, paused: { Status: "ACCEPTED", State: "OFF" }, ended: { Status: "ACCEPTED", State: "ENDED" }, pending: { Status: "MODERATION", State: "ON" } }[expected];
    const test = fixture({ pages: [JSON.stringify({ result: { Campaigns: [{ Id: 11, Currency: "RUB", StatusPayment: "ALLOWED", ...fields }] } })] });
    expect(await test.capabilities["campaign.status.v1"]!({ context, connection, input: { vendorCampaignIds: ["11"] } }, options)).toMatchObject({ ok: true, value: { complete: true, campaigns: [{ status: expected }] } });
  });
  it.each([
    [{ Id: 11, Currency: "USD", Status: "ACCEPTED", State: "ON", StatusPayment: "ALLOWED" }],
    [{ Id: 99, Currency: "RUB", Status: "ACCEPTED", State: "ON", StatusPayment: "ALLOWED" }],
    Array.from({ length: 2 }, () => ({ Id: 11, Currency: "RUB", Status: "ACCEPTED", State: "ON", StatusPayment: "ALLOWED" })),
  ].map(Campaigns => ({ Campaigns })))("rejects foreign currency, unexpected IDs and duplicates", async ({ Campaigns }) => {
    const test = fixture({ pages: [JSON.stringify({ result: { Campaigns } })] });
    expect((await test.capabilities["campaign.status.v1"]!({ context, connection, input: { vendorCampaignIds: ["11"] } }, options)).ok).toBe(false);
  });
  it("accepts service context with only the canonical host dependencies", async () => {
    const test = fixture({ pages: [header] });
    const service = { scope, serviceId: "sync", correlationId: "correlation", traceId: "trace" };
    expect(Object.keys(test.capabilities)).toEqual(["report.metrics.v1", "campaign.status.v1"]);
    expect(await test.capabilities["report.metrics.v1"]!({ context: service, connection, input: { grain: "campaign", days } }, options)).toMatchObject({ ok: true, value: { complete: true } });
    expect(test.accessCount()).toBe(1); expect(test.requests).toHaveLength(1);
  });
  it("rejects cancellation, malformed windows and foreign binding before credentials", async () => {
    const test = fixture({ pages: [] });
    const controller = new AbortController(); controller.abort();
    expect(await test.capabilities["report.metrics.v1"]!({ context, connection, input: { grain: "campaign", days } }, { signal: controller.signal })).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect((await test.capabilities["report.metrics.v1"]!({ context, connection: { ...connection, accountId: "99" }, input: { grain: "campaign", days } }, options)).ok).toBe(false);
    expect((await test.capabilities["report.metrics.v1"]!({ context, connection, input: { grain: "campaign", days: { start: "2025-01-01", end: "2026-10-01" } } }, options)).ok).toBe(false);
    expect(test.accessCount()).toBe(0); expect(test.requests).toHaveLength(0);
  });
  it("propagates body limits and vendor failures without retrying", async () => {
    const oversized = fixture({ pages: ["x".repeat(1048577)] });
    expect(await oversized.capabilities["report.metrics.v1"]!({ context, connection, input: { grain: "account", days } }, options)).toMatchObject({ ok: false, error: { code: "limit_exceeded" } });
    const throttled = fixture({ pages: ["not returned"], statuses: [429] });
    expect(await throttled.capabilities["report.metrics.v1"]!({ context, connection, input: { grain: "account", days } }, options)).toMatchObject({ ok: false, error: { code: "limit_exceeded", retryable: false } });
    expect(throttled.requests).toHaveLength(1);
  });
});

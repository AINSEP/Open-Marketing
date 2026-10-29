import { describe, expect, it } from "vitest";
import { metricBatchSchema, pluginConfigurationSchema } from "@open-marketing/contracts";
import type { MetricBatch, Outcome, PluginCapability, PluginCapabilityDependencies } from "@open-marketing/contracts";
import { createCapabilities } from "../src/index.js";
import { context, fixture, configuration } from "./fixtures.js";
import { projectMetrics } from "../src/metrics-status.js";

const connection = { connectionId: "connection", accountId: "123" }, days = { start: "2026-10-20", end: "2026-10-21" };
const input = { context, connection, input: { grain: "account" as const, days } };
const row = { DATE: days.start, AD_ACCOUNT_ID: "123", SPEND_IN_MICRO_DOLLAR: "9007199254740993", TOTAL_IMPRESSION: "0", TOTAL_CONVERSIONS: "1.25" };
const expectedMetrics = { spend: "9007199254740993", impressions: "0", clicks: null, vendorConversions: "1250000" };
function transport(required: { rows?: unknown[]; timezone?: string; currency?: string } = {}) {
  let read = 0;
  return fixture({ configuration: { ...configuration, currency: required.currency ?? "JPY" }, response: () => {
    read++;
    if (read === 1) return Response.json({ id: "123", currency: required.currency ?? "JPY", time_zone: required.timezone ?? "UTC" });
    return new Response(JSON.stringify(required.rows ?? [row]).replace('"9007199254740993"', "9007199254740993"));
  } });
}
function memory(): PluginCapability<"report.metrics.v1"> {
  const definition = { vendorField: "fixture", meaning: "Independent memory data" };
  return async (): Promise<Outcome<MetricBatch>> => ({ ok: true, value: { schema: "report.metrics.v1", pluginId: "pinterest-ads", ...connection, currency: "JPY", timezone: "UTC", grain: "account", days,
    mapping: { pluginId: "pinterest-ads", version: "fixture", grains: { account: { spend: definition, impressions: definition, clicks: definition, vendorConversions: definition } } },
    retrievedAt: 1792800000000, dataThrough: 0, complete: true, freshness: "stale", finality: "provisional", restated: false,
    rows: [{ day: days.start, entity: { grain: "account" }, metrics: expectedMetrics }] } });
}
for (const kind of ["memory", "transport"] as const) {
  describe("Pinterest metrics contract: " + kind, () => {
    it("retains exact micros, null/zero, conversion millionths and unsupported value", async () => {
      const run = kind === "memory" ? memory() : transport().capabilities["report.metrics.v1"]!;
      const result = await run(input); expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("Expected fixture metrics");
      expect(metricBatchSchema.safeParse(result.value).success).toBe(true);
      expect(result.value.rows[0].metrics).toEqual(expectedMetrics);
      expect(result.value).toMatchObject({ currency: "JPY", timezone: "UTC", dataThrough: 0, freshness: "stale", finality: "provisional", complete: true });
      expect(result.value.rows[0].metrics).not.toHaveProperty("vendorConversionValue");
    });
  });
}
it.each(["JPY", "KRW", "USD"])("never applies a two-decimal exponent to %s micros", async currency => {
  expect(await transport({ currency }).capabilities["report.metrics.v1"]!(input)).toMatchObject({ ok: true, value: { currency, rows: [{ metrics: expectedMetrics }] } });
});
it("sends explicit attribution and DAY dates, filters the exclusive end overfetch", async () => {
  const f = transport({ rows: [row, { ...row, DATE: days.end }] });
  expect(await f.capabilities["report.metrics.v1"]!(input)).toMatchObject({ ok: true, value: { rows: [{ day: days.start }] } });
  const url = new URL(f.calls[1].url); expect(url.searchParams.get("granularity")).toBe("DAY");
  expect(url.searchParams.get("end_date")).toBe(days.end); expect(url.searchParams.get("view_window_days")).toBe("1");
  expect(url.searchParams.get("conversion_report_time")).toBe("TIME_OF_AD_ACTION");
});
it.each([{ rows: [row, row] }, { rows: [row, { ...row, AD_ACCOUNT_ID: "999" }] }, { rows: [{ ...row, TOTAL_IMPRESSION: "-1" }] }, { rows: [{ ...row, DATE: "2026-10-19" }] }])("rejects a whole malformed/duplicate/foreign batch", async ({ rows }) => {
  expect((await transport({ rows }).capabilities["report.metrics.v1"]!(input)).ok).toBe(false);
});
it("uses default UTC analytics for a non-UTC account and rejects unsupported grains before I/O", async () => {
  const f = transport({ timezone: "America/Los_Angeles" });
  expect(await f.capabilities["report.metrics.v1"]!(input)).toMatchObject({ ok: true, value: { timezone: "UTC", complete: true, dataThrough: 0 } });
  expect(new URL(f.calls[1].url).searchParams.has("reporting_timezone")).toBe(false);
  const unsupported = transport();
  expect(await unsupported.capabilities["report.metrics.v1"]!({ ...input, input: { ...input.input, grain: "ad" } })).toMatchObject({ ok: false, error: { code: "not_implemented" } });
  expect(unsupported.credentialCalls).toHaveLength(0);
});
it("separates complete empty response coverage from unknown freshness", () => {
  expect(projectMetrics({ input: [], connection, days, currency: "JPY", retrievedAt: 1792800000000 })).toMatchObject({ ok: true, value: { rows: [], complete: true, dataThrough: 0, freshness: "stale" } });
});
it("preserves rejected child descriptions without asserting campaign-wide disapproval", async () => {
  let reads = 0;
  const f = fixture({ response: () => Response.json(++reads === 1 ? { id: "456", ad_account_id: "123", status: "ACTIVE" } : { items: [{ id: "789", campaign_id: "456", ad_account_id: "123", review_status: "REJECTED", rejected_reasons: ["ADULT"], rejection_labels: ["Restricted content"] }], bookmark: "more" }) });
  expect(await f.capabilities["campaign.status.v1"]!({ context, connection, input: { vendorCampaignIds: ["456"] } })).toMatchObject({ ok: true, value: { complete: false, campaigns: [{ status: "unknown", disapprovalDescriptions: ["Ad 789: ADULT", "Ad 789: Restricted content"] }] } });
});
it("uses canonical keys, checks account before credentials and relies on the host fetch fence", async () => {
  const f = transport();
  expect(Object.keys(f.capabilities)).toEqual(["report.metrics.v1", "campaign.status.v1"]);
  expect(await f.capabilities["report.metrics.v1"]!({ ...input, connection: { ...connection, accountId: "999" } })).toMatchObject({ ok: false, error: { code: "forbidden" } });
  expect(f.credentialCalls).toHaveLength(0);
  const revoked = fixture({ credentialHook: () => { revoked.state.current = false; } });
  expect(await revoked.capabilities["report.metrics.v1"]!(input)).toMatchObject({ ok: false, error: { code: "unavailable" } }); expect(revoked.calls).toHaveLength(0);
});
for (const kind of ["memory", "transport"] as const) {
  it("Pinterest campaign status contract: " + kind, async () => {
    let read = 0;
    const real = fixture({ response: () => Response.json(++read === 1 ? { id: "456", ad_account_id: "123", status: "PAUSED" } : { items: [] }) });
    const memoryStatus: PluginCapability<"campaign.status.v1"> = async () => ({ ok: true, value: { observedAt: 1792800000000, complete: true, campaigns: [{ vendorCampaignId: "456", status: "paused", disapprovalDescriptions: [] }] } });
    const run = kind === "memory" ? memoryStatus : real.capabilities["campaign.status.v1"]!;
    expect(await run({ context, connection, input: { vendorCampaignIds: ["456"] } })).toMatchObject({ ok: true, value: { complete: true, campaigns: [{ vendorCampaignId: "456", status: "paused", disapprovalDescriptions: [] }] } });
  });
}
it("rejects foreign/duplicate children and excessive campaign batches before returning partial status", async () => {
  for (const items of [
    [{ id: "789", campaign_id: "999", ad_account_id: "123", review_status: "REJECTED", rejected_reasons: [], rejection_labels: [] }],
    Array.from({ length: 2 }, () => ({ id: "789", campaign_id: "456", ad_account_id: "123", review_status: "APPROVED", rejected_reasons: [], rejection_labels: [] })),
  ]) {
    let read = 0;
    const f = fixture({ response: () => Response.json(++read === 1 ? { id: "456", ad_account_id: "123", status: "ACTIVE" } : { items }) });
    expect((await f.capabilities["campaign.status.v1"]!({ context, connection, input: { vendorCampaignIds: ["456"] } })).ok).toBe(false);
  }
  const f = fixture();
  expect(await f.capabilities["campaign.status.v1"]!({ context, connection, input: { vendorCampaignIds: ["1", "2", "3", "4", "5", "6"] } })).toMatchObject({ ok: false, error: { code: "limit_exceeded" } }); expect(f.calls).toHaveLength(0);
});
it("cancels before broker lookup and accepts a service context without fabricating a principal", async () => {
  const f = transport(), controller = new AbortController(); controller.abort();
  expect(await f.capabilities["report.metrics.v1"]!(input, { signal: controller.signal })).toMatchObject({ ok: false, error: { code: "cancelled" } }); expect(f.credentialCalls).toHaveLength(0);
  expect((await f.capabilities["report.metrics.v1"]!({ ...input, context: { scope: context.scope, serviceId: "measure", correlationId: "correlation", traceId: "trace" } })).ok).toBe(true);
});

it.each([
  { status: 401, code: "unauthenticated" },
  { status: 403, code: "forbidden" },
  { status: 429, code: "limit_exceeded" },
])("preserves HTTP $status errors before parsing a non-JSON capability body", async ({ status, code }) => {
  const f = fixture({ response: () => new Response("Synthetic provider refusal", { status }) });
  expect(await f.capabilities["report.metrics.v1"]!(input)).toMatchObject({ ok: false, error: { code } });
  expect(f.calls).toHaveLength(1);
});

it.each(["APPROVED", "PENDING"])('accepts %s ads without rejection fields and filters with campaign_ids', async review_status => {
  let reads = 0;
  const f = fixture({ response: () => Response.json(++reads === 1 ? { id: "456", ad_account_id: "123", status: "ACTIVE", summary_status: "RUNNING" } : { items: [{ id: "789", ad_account_id: "123", campaign_id: "456", review_status }] }) });
  expect(await f.capabilities["campaign.status.v1"]!({ context, connection, input: { vendorCampaignIds: ["456"] } })).toMatchObject({ ok: true, value: { campaigns: [{ status: "active", disapprovalDescriptions: [] }] } });
  const url = new URL(f.calls[1].url); expect(url.searchParams.get("campaign_ids")).toBe("456"); expect(url.searchParams.has("campaign_id")).toBe(false);
});
it.each([
  ["RUNNING", "active"], ["PAUSED", "paused"], ["NOT_STARTED", "pending"], ["DRAFT", "pending"],
  ["COMPLETED", "ended"], ["ARCHIVED", "ended"], ["DELETED_DRAFT", "ended"], ["ADVERTISER_DISABLED", "unknown"], ["FUTURE_STATUS", "unknown"], ["__proto__", "unknown"], ["constructor", "unknown"],
])("uses summary %s ahead of configured ACTIVE", async (summary_status, expected) => {
  let reads = 0;
  const f = fixture({ response: () => Response.json(++reads === 1 ? { id: "456", ad_account_id: "123", status: "ACTIVE", summary_status } : { items: [{ id: "789", ad_account_id: "123", campaign_id: "456", review_status: "APPROVED", rejected_reasons: null, rejection_labels: null }] }) });
  expect(await f.capabilities["campaign.status.v1"]!({ context, connection, input: { vendorCampaignIds: ["456"] } })).toMatchObject({ ok: true, value: { campaigns: [{ status: expected, disapprovalDescriptions: [] }] } });
});
it.each([{ start: "2026-01-01", end: "2026-01-02" }, { start: "2026-10-24", end: "2026-10-25" }])("returns vendor range limits before I/O", async days => {
  const f = transport(); expect(await f.capabilities["report.metrics.v1"]!({ ...input, input: { grain: "account", days } })).toMatchObject({ ok: false, error: { code: "limit_exceeded" } }); expect(f.calls).toHaveLength(0); expect(f.credentialCalls).toHaveLength(0);
});

it("rejects tainted factory configuration without credential/network effects", async () => {
  const f = fixture();
  const capabilities = createCapabilities({ ...f.dependencies, configuration: { unexpected: true } as unknown as PluginCapabilityDependencies["configuration"], wait: async () => ({ ok: true, value: undefined }) });
  expect(await capabilities["report.metrics.v1"]!(input)).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  expect(f.calls).toHaveLength(0);
});

it("real factory accepts exact server configuration and derives currency from the account API", async () => {
  const f = transport({ currency: "KRW", timezone: "Asia/Seoul" });
  const configuration = pluginConfigurationSchema.parse({ scope: context.scope, ...connection, pluginDigest: "a".repeat(64), settings: { version: 1, enabled: false, capabilities: [], currency: "USD" } });
  const capabilities = createCapabilities({ ...f.dependencies, configuration, wait: async () => ({ ok: true, value: undefined }) });
  const result = await capabilities["report.metrics.v1"]!(input);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("Expected canonical metrics");
  expect(metricBatchSchema.safeParse(result.value).success).toBe(true);
  expect(result.value).toMatchObject({ currency: "KRW", timezone: "UTC", rows: [{ metrics: expectedMetrics }] });
  expect(f.calls).toHaveLength(2);
});
it.each([{ id: "999", currency: "JPY" }, { id: "123" }])("rejects foreign or missing vendor account facts before analytics", async account => {
  const f = fixture({ response: () => Response.json(account) });
  expect((await f.capabilities["report.metrics.v1"]!(input)).ok).toBe(false);
  expect(f.calls).toHaveLength(1);
});

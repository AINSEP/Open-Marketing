import { describe, expect, it } from "vitest";
import type { Outcome, CampaignStatusOutput } from "@open-marketing/contracts";
import { metricBatchSchema, pluginConfigurationSchema } from "@open-marketing/contracts";
import type { MetricBatch, PluginCapabilityDependencies } from "@open-marketing/contracts";
import { createCapabilities } from "../src/index.js";
import { context, fixture, dailyFixture, dailyMetric, accountResponse, type Fixture } from "./fixtures.js";

const connection = { connectionId: "connection", accountId: "a2_fixture" };
const statusInput = { context, connection, input: { vendorCampaignIds: ["456"] } };
const metricsInput = { context, connection, input: { grain: "account" as const, days: { start: "2026-10-20", end: "2026-10-21" } } };
const campaign = { id: "456", account_id: "a2_fixture", configured_status: "ACTIVE", effective_status: "REJECTED" };
function memory() {
  const definition = { vendorField: "fixture", meaning: "Independent daily memory data" };
  return { async "report.metrics.v1"(): Promise<Outcome<MetricBatch>> { return { ok: true, value: {
    schema: "report.metrics.v1", pluginId: "reddit-ads", ...connection, currency: "KRW", timezone: "UTC", grain: "account", days: metricsInput.input.days,
    mapping: { pluginId: "reddit-ads", version: "fixture", grains: { account: { spend: definition, impressions: definition, clicks: definition } } },
    retrievedAt: 1792800000000, dataThrough: 0, complete: true, freshness: "stale", finality: "provisional", restated: false,
    rows: [{ day: "2026-10-20", entity: { grain: "account" }, metrics: { spend: "9007199254740993", impressions: "0", clicks: null } }],
  } }; },
    async "campaign.status.v1"(): Promise<Outcome<CampaignStatusOutput>> { return { ok: true, value: { observedAt: 1792800000000, complete: true, campaigns: [{ vendorCampaignId: "456", status: "disapproved", disapprovalDescriptions: [] }] } }; } };
}
for (const kind of ["memory", "transport"] as const) {
  describe("Reddit capability contract: " + kind, () => {
    it("reports exact UTC daily account metrics with unknown freshness", async () => {
      const adapter = kind === "memory" ? memory() : dailyFixture().capabilities;
      const result = await adapter["report.metrics.v1"]!(metricsInput);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("Expected daily metrics");
      expect(metricBatchSchema.safeParse(result.value).success).toBe(true);
      expect(result.value).toMatchObject({ currency: "KRW", timezone: "UTC", dataThrough: 0, freshness: "stale", finality: "provisional", complete: true,
        rows: [{ day: "2026-10-20", entity: { grain: "account" }, metrics: { spend: "9007199254740993", impressions: "0", clicks: null } }] });
      expect(result.value.rows[0].metrics).not.toHaveProperty("vendorConversions");
      expect(result.value.rows[0].metrics).not.toHaveProperty("vendorConversionValue");
    });
    it("reports effective disapproval", async () => {
      const adapter = kind === "memory" ? memory() : fixture({ response: () => Response.json({ data: campaign }) }).capabilities;
      expect(await adapter["campaign.status.v1"]!(statusInput)).toMatchObject({ ok: true, value: { complete: true, campaigns: [{ vendorCampaignId: "456", status: "disapproved", disapprovalDescriptions: [] }] } });
    });
  });
}
it.each([null, "PENDING_BILLING_INFO", "UNRECOGNIZED"])("never substitutes configured ACTIVE for effective %s", async effective_status => {
  const f = fixture({ response: () => Response.json({ data: { ...campaign, effective_status } }) });
  expect(await f.capabilities["campaign.status.v1"]!(statusInput)).toMatchObject({ ok: true, value: { campaigns: [{ status: "unknown" }] } });
});
it.each([{ id: "999" }, { account_id: "a2_other" }])("rejects foreign campaign/account", async changed => {
  const f = fixture({ response: () => Response.json({ data: { ...campaign, ...changed } }) });
  expect(await f.capabilities["campaign.status.v1"]!(statusInput)).toMatchObject({ ok: false, error: { code: "forbidden" } });
});
it("bounds requested campaigns and rejects repeated IDs before credentials", async () => {
  const f = fixture();
  for (const vendorCampaignIds of [["456", "456"], Array.from({ length: 11 }, (_, index) => String(index))]) expect((await f.capabilities["campaign.status.v1"]!({ ...statusInput, input: { vendorCampaignIds } })).ok).toBe(false);
  expect(f.credentialCalls).toHaveLength(0);
});
it("rechecks authority after credential resolution and supports service contexts", async () => {
  const revoked = fixture({ credentialHook: ({ state }) => { state.admitted = false; } });
  expect(await revoked.capabilities["campaign.status.v1"]!(statusInput)).toMatchObject({ ok: false, error: { code: "unavailable" } }); expect(revoked.calls).toHaveLength(0);
  const f = fixture({ response: () => Response.json({ data: campaign }) });
  const result = await f.capabilities["campaign.status.v1"]!({ ...statusInput, context: { scope: context.scope, serviceId: "measure", correlationId: "correlation", traceId: "trace" } });
  expect(result.ok).toBe(true); expect(f.observations).toContainEqual(expect.objectContaining({ correlationId: "correlation", traceId: "trace" }));
});
it.each(["not json", "x".repeat(1048577)])("rejects malformed/oversized response without retry", async body => {
  const f = fixture({ response: () => new Response(body, { headers: { "Content-Type": "application/json" } }) });
  expect((await f.capabilities["campaign.status.v1"]!(statusInput)).ok).toBe(false); expect(f.calls).toHaveLength(1);
});
it("exports catalog handler keys and denies cancellation/scope before credentials", async () => {
  const f = fixture(); expect(Object.keys(f.capabilities)).toEqual(["report.metrics.v1", "campaign.status.v1"]);
  const controller = new AbortController(); controller.abort();
  expect(await f.capabilities["report.metrics.v1"]!(metricsInput, { signal: controller.signal })).toMatchObject({ ok: false, error: { code: "cancelled" } });
  expect(await f.capabilities["campaign.status.v1"]!({ ...statusInput, connection: { ...connection, accountId: "a2_other" } })).toMatchObject({ ok: false, error: { code: "forbidden" } });
  expect(f.credentialCalls).toHaveLength(0); expect(f.calls).toHaveLength(0);
});

it("rejects tainted factory configuration without credential/network effects", async () => {
  const f = fixture();
  const capabilities = createCapabilities({ ...f.dependencies, configuration: { unexpected: true } as unknown as PluginCapabilityDependencies["configuration"], wait: async () => ({ ok: true, value: undefined }) });
  expect(await capabilities["report.metrics.v1"]!(metricsInput)).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  expect(f.calls).toHaveLength(0);
});

it("real factory accepts exact server configuration and sends a bounded daily report POST", async () => {
  const f = dailyFixture();
  const configuration = pluginConfigurationSchema.parse({ scope: context.scope, ...connection, pluginDigest: "a".repeat(64), settings: { version: 1, enabled: false, capabilities: [], currency: "USD" } });
  const capabilities = createCapabilities({ ...f.dependencies, configuration, wait: async () => ({ ok: true, value: undefined }) });
  const result = await capabilities["report.metrics.v1"]!(metricsInput);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("Expected canonical metrics");
  expect(metricBatchSchema.safeParse(result.value).success).toBe(true);
  expect(result.value.currency).toBe("KRW");
  expect(f.calls).toHaveLength(2);
  expect(f.calls[0].url).toBe("https://ads-api.reddit.com/api/v3/ad_accounts/a2_fixture");
  expect(f.calls[1]).toMatchObject({ url: "https://ads-api.reddit.com/api/v3/ad_accounts/a2_fixture/reports?page.size=100", init: { method: "POST", redirect: "error" } });
  expect(JSON.parse(String(f.calls[1].init.body))).toEqual({ data: { breakdowns: ["AD_ACCOUNT_ID", "DATE"], fields: ["SPEND", "IMPRESSIONS", "CLICKS"], starts_at: "2026-10-20T00:00:00Z", ends_at: "2026-10-21T00:00:00Z", time_zone_id: "UTC" } });
});
it("projects campaign/date rows without requiring an unrequested account breakdown", async () => {
  const f = dailyFixture({ rows: [
    { date: "2026-10-20", campaign_id: "456", spend: "0", impressions: "1", clicks: "0" },
    { date: "2026-10-21T00:00:00Z", campaign_id: "456", spend: null, impressions: null, clicks: null },
    { date: "2026-10-20", campaign_id: "789", spend: "3", impressions: "0", clicks: "0" },
  ] });
  const result = await f.capabilities["report.metrics.v1"]!({ ...metricsInput, input: { grain: "campaign", days: { start: "2026-10-20", end: "2026-10-22" } } });
  expect(result).toMatchObject({ ok: true, value: { grain: "campaign", rows: [
    { day: "2026-10-20", entity: { grain: "campaign", vendorCampaignId: "456" }, metrics: { spend: "0", impressions: "1", clicks: "0" } },
    { day: "2026-10-21", entity: { grain: "campaign", vendorCampaignId: "456" }, metrics: { spend: null, impressions: null, clicks: null } },
    { day: "2026-10-20", entity: { grain: "campaign", vendorCampaignId: "789" } },
  ] } });
  expect(JSON.parse(String(f.calls[1].init.body)).data.breakdowns).toEqual(["CAMPAIGN_ID", "DATE"]);
});
it("filters exclusive-end overfetch and preserves complete empty coverage with unknown freshness", async () => {
  const f = dailyFixture({ rows: [dailyMetric, { ...dailyMetric, date: metricsInput.input.days.end }] });
  expect(await f.capabilities["report.metrics.v1"]!(metricsInput)).toMatchObject({ ok: true, value: { rows: [{ day: "2026-10-20" }] } });
  expect(await dailyFixture({ rows: [] }).capabilities["report.metrics.v1"]!(metricsInput)).toMatchObject({ ok: true, value: { rows: [], complete: true, dataThrough: 0, freshness: "stale" } });
});
it.each([
  [dailyMetric, dailyMetric], [dailyMetric, { ...dailyMetric, account_id: "a2_other" }],
  [dailyMetric, { ...dailyMetric, currency: "USD" }], [{ ...dailyMetric, spend: "-1" }],
  [{ ...dailyMetric, clicks: "1.5" }], [{ ...dailyMetric, impressions: "1e2" }], [{ ...dailyMetric, spend: "1".repeat(39) }],
  [{ ...dailyMetric, date: "2026-02-30" }], [{ ...dailyMetric, date: "2026-10-19" }], [{ ...dailyMetric, date: "2026-10-22" }],
].map(rows => ({ rows })))("rejects an invalid daily page atomically %#", async ({ rows }) => {
  expect((await dailyFixture({ rows }).capabilities["report.metrics.v1"]!(metricsInput)).ok).toBe(false);
});
it("accepts null or absent account identity only on the selected account endpoint", async () => {
  const { account_id: _account, ...withoutAccount } = dailyMetric;
  for (const row of [{ ...dailyMetric, account_id: null }, withoutAccount]) {
    expect(await dailyFixture({ rows: [row] }).capabilities["report.metrics.v1"]!(metricsInput)).toMatchObject({ ok: true, value: { accountId: connection.accountId, complete: true, rows: [{ entity: { grain: "account" } }] } });
  }
  expect(await dailyFixture({ rows: [{ ...dailyMetric, account_id: "a2_other" }] }).capabilities["report.metrics.v1"]!(metricsInput)).toMatchObject({ ok: false, error: { code: "forbidden" } });
});
it("rejects a campaign row without its campaign ID", async () => {
  expect(await dailyFixture().capabilities["report.metrics.v1"]!({ ...metricsInput, input: { ...metricsInput.input, grain: "campaign" } })).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
});
it("follows validated report tokens with the same POST body and completes two pages", async () => {
  const token = "next+token/&";
  const f = dailyFixture({ pages: [
    { rows: [{ ...dailyMetric, campaign_id: "456" }], next: "https://ads-api.reddit.com/api/v3/ad_accounts/a2_fixture/reports?page.token=" + encodeURIComponent(token) },
    { rows: [{ ...dailyMetric, campaign_id: "789" }] },
  ] });
  const result = await f.capabilities["report.metrics.v1"]!({ ...metricsInput, input: { ...metricsInput.input, grain: "campaign" } });
  expect(result).toMatchObject({ ok: true, value: { complete: true, rows: [{ entity: { vendorCampaignId: "456" } }, { entity: { vendorCampaignId: "789" } }] } });
  expect(f.calls).toHaveLength(3);
  expect(f.calls[2].url).toBe("https://ads-api.reddit.com/api/v3/ad_accounts/a2_fixture/reports?page.size=100&page.token=" + encodeURIComponent(token));
  expect(f.calls[2].init.body).toBe(f.calls[1].init.body); expect(f.calls[2].init.method).toBe("POST");
});
it("rejects invalid or self-looping report links without dispatching them", async () => {
  for (const next of ["https://untrusted.test/next", "https://ads-api.reddit.com/api/v3/ad_accounts/a2_other/reports?page.token=next"]) {
    const f = dailyFixture({ next });
    expect(await f.capabilities["report.metrics.v1"]!(metricsInput)).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
    expect(f.calls).toHaveLength(2);
  }
  const f = dailyFixture({ pages: [
    { rows: [], next: "https://ads-api.reddit.com/api/v3/ad_accounts/a2_fixture/reports?page.size=100&page.token=next" },
    { rows: [], next: "https://ads-api.reddit.com/api/v3/ad_accounts/a2_fixture/reports?page.size=100&page.token=next" },
  ] });
  expect(await f.capabilities["report.metrics.v1"]!(metricsInput)).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
  expect(f.calls).toHaveLength(3);
});
it("retains rows with incomplete coverage when the report request cap is reached", async () => {
  const pages = Array.from({ length: 50 }, (_, index) => ({ rows: [{ ...dailyMetric, campaign_id: String(index + 1) }], next: "https://ads-api.reddit.com/api/v3/ad_accounts/a2_fixture/reports?page.size=100&page.token=" + (index + 1) }));
  const f = dailyFixture({ pages });
  const result = await f.capabilities["report.metrics.v1"]!({ ...metricsInput, input: { ...metricsInput.input, grain: "campaign" } });
  expect(result).toMatchObject({ ok: true, value: { complete: false } });
  if (!result.ok) throw new Error("Expected partial metrics");
  expect(result.value.rows).toHaveLength(50); expect(f.calls).toHaveLength(51);
});
it("stops starting report pages after the 25s budget and keeps rows read so far", async () => {
  const next = "https://ads-api.reddit.com/api/v3/ad_accounts/a2_fixture/reports?page.size=100&page.token=next";
  const f: Fixture = fixture({ response: () => {
    f.state.time += f.calls.length === 1 ? 10000 : 15000;
    return Response.json(f.calls.length === 1 ? accountResponse : { data: { metrics: [{ ...dailyMetric, campaign_id: "456" }] }, pagination: { next_url: next } });
  } });
  const result = await f.capabilities["report.metrics.v1"]!({ ...metricsInput, input: { ...metricsInput.input, grain: "campaign" } });
  expect(result).toMatchObject({ ok: true, value: { complete: false, rows: [{ entity: { vendorCampaignId: "456" } }] } });
  if (!result.ok) throw new Error("Expected partial metrics");
  expect(result.value.rows).toHaveLength(1); expect(f.calls).toHaveLength(2);
});
it.each([5000, 5001])("keeps at most 5000 rows with honest terminal coverage for %i rows", async total => {
  const rows = Array.from({ length: total }, (_, index) => ({ ...dailyMetric, campaign_id: String(index + 1) }));
  const f = dailyFixture({ pages: [
    { rows: rows.slice(0, 4900), next: "https://ads-api.reddit.com/api/v3/ad_accounts/a2_fixture/reports?page.size=100&page.token=next" },
    { rows: rows.slice(4900) },
  ] });
  const result = await f.capabilities["report.metrics.v1"]!({ ...metricsInput, input: { ...metricsInput.input, grain: "campaign" } });
  expect(result).toMatchObject({ ok: true, value: { complete: total === 5000 } });
  if (!result.ok) throw new Error("Expected bounded metrics");
  expect(result.value.rows).toHaveLength(5000); expect(f.calls).toHaveLength(3);
});
it("rejects cross-page duplicates and malformed later pages atomically", async () => {
  for (const rows of [[dailyMetric], [{ ...dailyMetric, spend: "-1" }]]) {
    const f = dailyFixture({ pages: [
      { rows: [dailyMetric], next: "https://ads-api.reddit.com/api/v3/ad_accounts/a2_fixture/reports?page.size=100&page.token=next" }, { rows },
    ] });
    expect(await f.capabilities["report.metrics.v1"]!(metricsInput)).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
    expect(f.calls).toHaveLength(3);
  }
});
it.each([{ data: { id: "a2_other", currency: "KRW" } }, { data: { id: "a2_fixture" } }])("rejects foreign/malformed account metadata before reports", async account => {
  const f = dailyFixture({ account });
  expect((await f.capabilities["report.metrics.v1"]!(metricsInput)).ok).toBe(false);
  expect(f.calls).toHaveLength(1);
});
it("bounds daily windows and unsupported grains before I/O", async () => {
  const f = dailyFixture();
  expect(await f.capabilities["report.metrics.v1"]!({ ...metricsInput, input: { grain: "account", days: { start: "2026-09-01", end: "2026-10-03" } } })).toMatchObject({ ok: false, error: { code: "limit_exceeded" } });
  expect(await f.capabilities["report.metrics.v1"]!({ ...metricsInput, input: { ...metricsInput.input, grain: "ad" } })).toMatchObject({ ok: false, error: { code: "not_implemented" } });
  expect(f.calls).toHaveLength(0); expect(f.credentialCalls).toHaveLength(0);
});

it("accepts a vendor page larger than the requested 100 rows", async () => {
  const rows = Array.from({ length: 101 }, (_, index) => ({ ...dailyMetric, campaign_id: String(index + 1) }));
  const f = dailyFixture({ rows });
  const result = await f.capabilities["report.metrics.v1"]!({ ...metricsInput, input: { ...metricsInput.input, grain: "campaign" } });
  expect(result).toMatchObject({ ok: true, value: { complete: true } });
  if (!result.ok) throw new Error("Expected metrics");
  expect(result.value.rows).toHaveLength(101); expect(f.calls).toHaveLength(2);
});
it("accepts exactly 31 UTC days", async () => {
  const f = dailyFixture({ rows: [] });
  expect(await f.capabilities["report.metrics.v1"]!({ ...metricsInput, input: { grain: "account", days: { start: "2026-09-01", end: "2026-10-02" } } })).toMatchObject({ ok: true, value: { rows: [], complete: true } });
  expect(f.calls).toHaveLength(2);
});

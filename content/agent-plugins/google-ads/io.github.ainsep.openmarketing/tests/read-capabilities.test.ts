import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { capabilityCatalog, capabilityEnvelopeSchema, metricBatchSchema, pluginConfigurationSchema } from "@open-marketing/contracts";
import type { CallContext, MetricGrain, Outcome, PluginCapabilitiesFactory, PluginCapabilityDependencies, TrackingTagOutput } from "@open-marketing/contracts";
import { createCapabilities, createReadCapabilities, createGoogleRestTransport, createHttpAdapter, createTools, metricMapping } from "../src/index.ts";
import { createFixtureDependencies } from "../src/fixture.ts";
import type { GoogleTransportPort, VendorRequest } from "../src/types.ts";

const binding = { ...createFixtureDependencies({}).binding, timezone: "America/Los_Angeles" };
const context: CallContext = { scope: binding.scope, principal: { kind: "service", serviceId: "report-sync" }, correlationId: "sync-1", traceId: "trace-1", runId: "run-1" };
const connection = { connectionId: binding.connectionId, accountId: binding.customerId };
const configuration = pluginConfigurationSchema.parse({ scope: binding.scope, ...connection, pluginDigest: "a".repeat(64), settings: { admitted: false, currency: "EUR", timezone: "invalid" } });
const customerMetadata = { results: [{ customer: { id: binding.customerId, currencyCode: binding.currency, timeZone: binding.timezone } }] };
const now = Date.parse("2026-11-05T12:00:00Z");
const days = { start: "2026-03-07", end: "2026-03-09" };
const tagInput = { campaignKey: { pluginId: "google-ads", accountId: binding.customerId, vendorCampaignId: "201" }, destinationUrl: "https://example.test/landing?existing=one%20two#details" };

function row(required: { extra?: Record<string, unknown> } = {}): Record<string, unknown> {
  return { customer: { id: binding.customerId, currencyCode: binding.currency, timeZone: binding.timezone },
    segments: { date: "2026-03-08" }, campaign: { id: "201" }, adGroup: { id: "301" }, adGroupAd: { ad: { id: "401" } },
    metrics: { costMicros: "9007199254740993", impressions: "100", clicks: "0", conversions: "1.25", conversionsValue: "9007199254.123456" }, ...required.extra };
}
function defaultResponse({ query }: { query: string }): unknown {
  if (query.includes("customer.test_account")) return { results: [{ customer: { id: binding.customerId, currencyCode: binding.currency, timeZone: binding.timezone, testAccount: true } }] };
  if (query.includes("remarketing_setting")) return { results: [{ customer: { id: binding.customerId, remarketingSetting: { googleGlobalSiteTag: '<script src="https://fixture.test/tag.js"></script>' } } }] };
  if (query.includes("primary_status")) return { results: [row({ extra: { campaign: { id: "201", status: "ENABLED", primaryStatus: "LIMITED", primaryStatusReasons: ["HAS_ADS_DISAPPROVED"] }, campaignBudget: { period: "DAILY", amountMicros: "50000000", explicitlyShared: false } } })] };
  if (query.includes("policy_summary.approval_status")) {
    assert.match(query, /approval_status = 'DISAPPROVED' AND ad_group_ad.status != 'REMOVED' LIMIT 1001$/);
    return { results: [row(), row({ extra: { adGroupAd: { ad: { id: "402" } } } })] };
  }
  return { results: [row()] };
}
/** Same contract assertions exercise the double and both real Google adapters with fake HTTP only. */
function harness(required: { real: boolean; respond?: (required: { query: string }) => unknown }) {
  const calls: VendorRequest[] = [];
  const observations: unknown[] = [];
  const respond = ({ query }: { query: string }): unknown => query === "SELECT customer.id, customer.currency_code, customer.time_zone FROM customer LIMIT 2"
    ? customerMetadata : (required.respond ?? defaultResponse)({ query });
  const fakeFetch: typeof fetch = async (_url, init) => {
    const query = JSON.parse(String(init?.body)).query as string;
    const reply = respond({ query });
    return new Response(typeof reply === "string" ? reply : JSON.stringify(reply), { status: 200 });
  };
  const real = createGoogleRestTransport({ binding, credentials: { async access() { return { ok: true, value: { accessToken: "fixture-only" } }; } },
    http: createHttpAdapter({ fetch: fakeFetch, observer: { observe(event) { observations.push(event); } } }),
  });
  const transport: GoogleTransportPort = { async request(input) {
    calls.push(input);
    if (required.real) return real.request(input);
    return { ok: true, value: respond({ query: String(input.body.query) }) };
  } };
  return { reads: createReadCapabilities({ binding, transport, clock: { now: () => now } }), calls, observations };
}
function value<T>({ outcome }: { outcome: Outcome<T> }): T { if (!outcome.ok) assert.fail(outcome.error.code); return outcome.value; }
function error({ outcome, code }: { outcome: Outcome<unknown>; code: string }): void { assert.equal(outcome.ok, false); if (!outcome.ok) assert.equal(outcome.error.code, code); }

for (const real of [false, true]) {
  const label = real ? "real REST + bounded HTTP" : "transport double";
  for (const grain of ["account", "campaign", "ad_group", "ad"] as const) {
    test(`${label}: exact daily metrics at ${grain} grain`, async () => {
      const fixture = harness({ real });
      const batch = value({ outcome: await fixture.reads["report.metrics.v1"]({ context, connection, input: { grain, days } }) });
      assert.equal(metricBatchSchema.safeParse(batch).success, true);
      assert.deepEqual(batch.rows[0].metrics, { spend: "9007199254740993", impressions: "100", clicks: "0", vendorConversions: "1250000", vendorConversionValue: "9007199254123456" });
      assert.equal(batch.rows[0].entity.grain, grain);
      assert.equal(batch.dataThrough, Date.parse("2026-03-09T07:00:00Z"));
      assert.equal(batch.complete, true); assert.equal(batch.finality, "provisional"); assert.equal(batch.freshness, "fresh"); assert.equal(batch.restated, false);
      assert.equal(batch.retrievedAt, now); assert.equal(batch.timezone, binding.timezone); assert.equal(batch.currency, binding.currency);
      assert.equal(batch.mapping.reach, undefined); assert.equal(batch.rows[0].metrics.clicks, "0");
      assert.equal(fixture.calls.length, 2); assert.equal(fixture.calls[0].method, "search");
      assert.deepEqual(fixture.calls[0].context, context);
      const query = String(fixture.calls[1].body.query);
      assert.match(query, /LIMIT 1001$/); assert.match(query, /segments.date < '2026-03-09'/);
      const resources: Record<MetricGrain, string> = { account: "customer", campaign: "campaign", ad_group: "ad_group", ad: "ad_group_ad" };
      assert.ok(query.includes("FROM " + resources[grain] + " WHERE"));
      if (real) assert.deepEqual(fixture.observations, Array.from({ length: 2 }, () => ({ operation: "google-ads.http", outcome: "received", correlationId: context.correlationId, traceId: context.traceId, runId: context.runId })));
    });
  }
  test(`${label}: missing supported metrics are null and absent reach is unsupported`, async () => {
    const fixture = harness({ real, respond: () => ({ results: [row({ extra: { metrics: {} } })] }) });
    const batch = value({ outcome: await fixture.reads["report.metrics.v1"]({ context, connection, input: { grain: "account", days } }) });
    assert.deepEqual(batch.rows[0].metrics, { spend: null, impressions: null, clicks: null, vendorConversions: null, vendorConversionValue: null });
    assert.equal(batch.reach, undefined); assert.equal(metricMapping.reach, undefined);
  });
  test(`${label}: partial child disapproval stays active and missing campaigns stay incomplete`, async () => {
    const fixture = harness({ real });
    const result = value({ outcome: await fixture.reads["campaign.status.v1"]({ context, connection, input: { vendorCampaignIds: ["201", "202"] } }) });
    assert.equal(result.complete, false); assert.equal(result.observedAt, now);
    assert.deepEqual(result.campaigns, [
      { vendorCampaignId: "201", status: "active", disapprovalDescriptions: ["HAS_ADS_DISAPPROVED"], rejectedChildAds: 2, currentBudget: { kind: "daily", amountMicros: "50000000", currency: binding.currency } },
      { vendorCampaignId: "202", status: "unknown", disapprovalDescriptions: [] },
    ]);
  });
  test(`${label}: lifetime flight and unavailable budgets preserve checked zero child counts`, async () => {
    for (const scenario of [
      { budget: { period: "CUSTOM_PERIOD", totalAmountMicros: "90000000" }, endDateTime: "2026-10-03 00:00:00", expected: { kind: "lifetime", amountMicros: "90000000", currency: binding.currency, flight: { start: Date.parse("2026-10-01T07:00:00Z"), end: Date.parse("2026-10-03T07:00:00Z") } } },
      { budget: { period: "DAILY", amountMicros: "50000000", explicitlyShared: true }, expected: undefined },
      { budget: { period: "CUSTOM_PERIOD", totalAmountMicros: "90000000" }, expected: undefined },
    ]) {
      const fixture = harness({ real, respond: ({ query }) => query.includes("primary_status") ? { results: ["201", "202"].map(id => row({ extra: { campaign: { id, status: "ENABLED", primaryStatus: "ELIGIBLE", startDateTime: "2026-10-01 00:00:00", endDateTime: scenario.endDateTime }, campaignBudget: scenario.budget } })) } : defaultResponse({ query }) });
      const result = value({ outcome: await fixture.reads["campaign.status.v1"]({ context, connection, input: { vendorCampaignIds: ["201", "202"] } }) });
      assert.deepEqual(result.campaigns.map(c => c.rejectedChildAds), [2, 0]); assert.equal(result.complete, true);
      assert.deepEqual(result.campaigns[0].currentBudget, scenario.expected); assert.equal(result.campaigns[0].status, "active");
    }
  });
  test(`${label}: saturated children omit counts and foreign children fail`, async () => {
    for (const foreign of [false, true]) {
      const fixture = harness({ real, respond: ({ query }) => query.includes("policy_summary.approval_status") ? { results: Array.from({ length: foreign ? 1 : 1001 }, () => row({ extra: { customer: { id: foreign ? "9999999999" : binding.customerId } } })) } : defaultResponse({ query }) });
      const result = await fixture.reads["campaign.status.v1"]({ context, connection, input: { vendorCampaignIds: ["201"] } });
      if (foreign) error({ outcome: result, code: "forbidden" });
      else { const observed = value({ outcome: result }); assert.equal(observed.campaigns[0].rejectedChildAds, undefined); assert.equal(observed.campaigns[0].status, "active"); assert.equal(observed.complete, true); }
    }
  });
  test(`${label}: tag text stays inert and fragment URLs retain query and literal macros`, async () => {
    const fixture = harness({ real });
    const tag = value({ outcome: await fixture.reads["tracking.tag.v1"]({ context, connection, input: tagInput }) });
    assert.match(tag.snippet, /^<script/);
    const url = new URL(tag.campaignUrlTemplate);
    assert.equal(url.hash, "#details"); assert.equal(url.searchParams.get("existing"), "one two");
    assert.equal(url.searchParams.get("om_a"), binding.customerId); assert.equal(url.searchParams.get("utm_source"), "google-ads");
    assert.ok(tag.campaignUrlTemplate.includes("utm_id={campaignid}"));
    const ordinary = value<TrackingTagOutput>({ outcome: await fixture.reads["tracking.tag.v1"]({ context, connection, input: { ...tagInput, destinationUrl: "https://example.test/?x=1" } }) });
    assert.equal(ordinary.campaignUrlTemplate, `{lpurl}?utm_source=google-ads&utm_medium=paid&om_a=${binding.customerId}&utm_id={campaignid}`);
    const existing = value({ outcome: await fixture.reads["tracking.tag.v1"]({ context, connection, input: { ...tagInput, destinationUrl: "https://example.test/?existing=%7Bcampaignid%7D&utm_id=old" } }) });
    assert.ok(existing.campaignUrlTemplate.includes("existing=%7Bcampaignid%7D"));
    assert.deepEqual(new URL(existing.campaignUrlTemplate).searchParams.getAll("utm_id"), ["{campaignid}"]);
    assert.ok(existing.campaignUrlTemplate.includes("utm_id={campaignid}"));
  });
  test(`${label}: invalid input, foreign binding and cancellation perform no I/O`, async () => {
    const fixture = harness({ real });
    const input = { grain: "account" as const, days };
    error({ outcome: await fixture.reads["report.metrics.v1"]({ context, connection: { ...connection, accountId: "9999999999" }, input }), code: "forbidden" });
    error({ outcome: await fixture.reads["report.metrics.v1"]({ context: { ...context, scope: { ...context.scope, ownerId: "other" } }, connection, input }), code: "forbidden" });
    error({ outcome: await fixture.reads["report.metrics.v1"]({ context, connection, input: { ...input, days: { start: days.end, end: days.start } } }), code: "invalid_input" });
    error({ outcome: await fixture.reads["campaign.status.v1"]({ context, connection, input: { vendorCampaignIds: ["1 OR 1=1"] } }), code: "invalid_input" });
    error({ outcome: await fixture.reads["tracking.tag.v1"]({ context, connection, input: { ...tagInput, campaignKey: { ...tagInput.campaignKey, accountId: "foreign" } } }), code: "forbidden" });
    error({ outcome: await fixture.reads["report.metrics.v1"]({ context, connection, input }, { signal: AbortSignal.abort() }), code: "cancelled" });
    assert.equal(fixture.calls.length, 0);
  });
  for (const scenario of [
    { name: "duplicate day/entity", reply: { results: [row(), row()] }, code: "invalid_input" },
    { name: "mixed foreign account", reply: { results: [row(), row({ extra: { customer: { id: "9999999999" } } })] }, code: "forbidden" },
    { name: "5001 rows", reply: { results: Array.from({ length: 5001 }, () => ({})) }, code: "limit_exceeded" },
    { name: "decimal overflow", reply: { results: [row({ extra: { metrics: { conversions: "1e100" } } })] }, code: "invalid_input" },
    { name: "lost decimal source", reply: { results: [row({ extra: { metrics: { conversions: 1.25 } } })] }, code: "invalid_input", doubleOnly: true },
    { name: "non-object metrics", reply: { results: [row({ extra: { metrics: [] } })] }, code: "invalid_input" },
    { name: "out-of-window row", reply: { results: [row({ extra: { segments: { date: days.end } } })] }, code: "invalid_input" },
    { name: "malformed envelope", reply: { results: "wrong" }, code: "invalid_input" },
  ]) {
    if (real && scenario.doubleOnly) continue;
    test(`${label}: rejects ${scenario.name}`, async () => {
      const fixture = harness({ real, respond: () => scenario.reply });
      error({ outcome: await fixture.reads["report.metrics.v1"]({ context, connection, input: { grain: "campaign", days } }), code: scenario.code });
    });
  }
  test(`${label}: empty reports, service contexts and unavailable tags are explicit`, async () => {
    const fixture = harness({ real, respond: () => ({}) });
    const service = { scope: context.scope, serviceId: "worker", correlationId: context.correlationId, traceId: context.traceId };
    const batch = value({ outcome: await fixture.reads["report.metrics.v1"]({ context: service, connection, input: { grain: "account", days } }) });
    assert.deepEqual(batch.rows, []); assert.equal(batch.complete, true);
    assert.deepEqual(fixture.calls[0].context, { scope: context.scope, principal: { kind: "service", serviceId: "worker" }, correlationId: context.correlationId, traceId: context.traceId });
    error({ outcome: await fixture.reads["tracking.tag.v1"]({ context, connection, input: tagInput }), code: "unavailable" });
  });
  test(`${label}: campaign serving states and unknown vendor enums stay explicit`, async () => {
    for (const state of [{ status: "PAUSED", primaryStatus: "PAUSED", expected: "paused" }, { status: "REMOVED", primaryStatus: "REMOVED", expected: "ended" }, { status: "ENABLED", primaryStatus: "PENDING", expected: "pending" }, { status: "ENABLED", primaryStatus: "FUTURE_ENUM", expected: "unknown" }]) {
      const fixture = harness({ real, respond: () => ({ results: [{ customer: { id: binding.customerId }, campaign: { id: "201", status: state.status, primaryStatus: state.primaryStatus } }] }) });
      const result = value({ outcome: await fixture.reads["campaign.status.v1"]({ context, connection, input: { vendorCampaignIds: ["201"] } }) });
      assert.equal(result.complete, true); assert.equal(result.campaigns[0].status, state.expected);
    }
  });
  test(`${label}: adapter exceptions return sanitized typed failures`, async () => {
    const fixture = harness({ real, respond() { throw new Error("fixture-secret-must-not-escape"); } });
    const outcome = await fixture.reads["report.metrics.v1"]({ context, connection, input: { grain: "account", days } });
    error({ outcome, code: "unavailable" }); assert.ok(!JSON.stringify(outcome).includes("fixture-secret"));
  });
  test(`${label}: a continuation token marks metrics partial and rejects partial status/tag evidence`, async () => {
    const fixture = harness({ real, respond: () => ({ results: [row()], nextPageToken: "more" }) });
    const batch = value({ outcome: await fixture.reads["report.metrics.v1"]({ context, connection, input: { grain: "campaign", days: { start: "2026-03-08", end: "2026-03-09" } } }) });
    assert.equal(batch.rows.length, 1); assert.equal(batch.complete, false); assert.equal(batch.dataThrough, 0); assert.equal(batch.freshness, "stale");
    error({ outcome: await fixture.reads["campaign.status.v1"]({ context, connection, input: { vendorCampaignIds: ["201"] } }), code: "limit_exceeded" });
    error({ outcome: await fixture.reads["tracking.tag.v1"]({ context, connection, input: tagInput }), code: "limit_exceeded" });
  });
  for (const [decimal, expected] of [["0.3333333333333333", "333333"], ["0.0000005", "0"], ["0.0000015", "2"], ["1.2345665", "1234566"], ["1.2345675", "1234568"], ["9.9999995", "10000000"], ["5e-7", "0"]]) {
    test(`${label}: rounds ${decimal} half-even without dropping spend`, async () => {
      const fixture = harness({ real, respond: () => ({ results: [row({ extra: { metrics: { costMicros: "17", conversions: decimal, conversionsValue: decimal } } })] }) });
      const batch = value({ outcome: await fixture.reads["report.metrics.v1"]({ context, connection, input: { grain: "account", days } }) });
      assert.equal(batch.rows[0].metrics.spend, "17"); assert.equal(batch.rows[0].metrics.vendorConversions, expected); assert.equal(batch.rows[0].metrics.vendorConversionValue, expected);
      assert.match(batch.mapping.grains.account!.vendorConversions!.meaning, /half-even/);
    });
  }
}
test("real HTTP preserves raw conversion decimal tokens beyond double precision, including exponents", async () => {
  const raw = JSON.stringify({ results: [row()] }).replace('"conversions":"1.25"', '"conversions":1.234567e1').replace('"conversionsValue":"9007199254.123456"', '"conversionsValue":9007199254.123456');
  const fixture = harness({ real: true, respond: () => raw });
  const batch = value({ outcome: await fixture.reads["report.metrics.v1"]({ context, connection, input: { grain: "ad", days } }) });
  assert.equal(batch.rows[0].metrics.vendorConversions, "12345670");
  assert.equal(batch.rows[0].metrics.vendorConversionValue, "9007199254123456");
});
test("raw data-driven fractional tokens round to millionths without losing spend", async () => {
  const raw = JSON.stringify({ results: [row()] }).replace('"conversions":"1.25"', '"conversions":0.3333333333333333').replace('"conversionsValue":"9007199254.123456"', '"conversionsValue":1.2345675').replace('"costMicros":"9007199254740993"', '"costMicros":9007199254740993');
  const fixture = harness({ real: true, respond: () => raw });
  const batch = value({ outcome: await fixture.reads["report.metrics.v1"]({ context, connection, input: { grain: "ad", days } }) });
  assert.equal(batch.rows[0].metrics.vendorConversions, "333333"); assert.equal(batch.rows[0].metrics.vendorConversionValue, "1234568"); assert.equal(batch.rows[0].metrics.spend, "9007199254740993");
});
for (const count of [1000, 1001]) test(`${count} realistic ad rows return bounded metrics and truthful completeness`, async () => {
  const rows = Array.from({ length: count }, (_, index) => ({ ...row(),
    customer: { id: binding.customerId, currencyCode: binding.currency, timeZone: binding.timezone, resourceName: `customers/${binding.customerId}` },
    campaign: { id: "201", resourceName: `customers/${binding.customerId}/campaigns/201` },
    adGroup: { id: "301", resourceName: `customers/${binding.customerId}/adGroups/301` },
    adGroupAd: { resourceName: `customers/${binding.customerId}/adGroupAds/301~${index + 1}`, ad: { id: String(index + 1), resourceName: `customers/${binding.customerId}/ads/${index + 1}` } },
  }));
  assert.ok(Buffer.byteLength(JSON.stringify({ results: rows })) < 1048576);
  const fixture = harness({ real: true, respond: () => ({ results: rows }) });
  const batch = value({ outcome: await fixture.reads["report.metrics.v1"]({ context, connection, input: { grain: "ad", days: { start: "2026-03-08", end: "2026-03-09" } } }) });
  assert.equal(batch.rows.length, 1000); assert.equal(batch.complete, count === 1000);
  assert.equal(batch.dataThrough, count === 1000 ? Date.parse("2026-03-09T07:00:00Z") : 0); assert.equal(batch.freshness, count === 1000 ? "fresh" : "stale");
});
test("Google manifests declare exactly the four unadmitted read bindings with source fingerprints", () => {
  const root = new URL("../../", import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL("plugin.json", root), "utf8"));
  const declarations = JSON.parse(readFileSync(new URL("io.github.ainsep.openmarketing/capabilities.json", root), "utf8"));
  const fingerprint = createHash("sha256").update(readFileSync(new URL("../src/read-capabilities.ts", import.meta.url))).digest("hex");
  for (const id of ["report.metrics.v1", "campaign.status.v1", "tracking.tag.v1", "campaign.validate.v1"]) {
    assert.deepEqual(declarations.capabilities, manifest.extensions["io.github.ainsep.openmarketing"].capabilities);
    const envelope = declarations.capabilities.find((value: { capabilityId: string }) => value.capabilityId === id);
    assert.equal(capabilityEnvelopeSchema.safeParse({ ...envelope, pluginDigest: "a".repeat(64) }).success, true);
    assert.deepEqual(envelope, { capabilityId: id, version: 1, pluginId: "google-ads", schemaFingerprint: fingerprint, admitted: false, effects: ["read"] });
  }
});

test("canonical factory is inert and calls all three handlers through shared credentials/fetch", async () => {
  const factory: PluginCapabilitiesFactory = createCapabilities;
  let accesses = 0; let fetches = 0; let credentialSignal: AbortSignal | undefined; let fetchSignal: AbortSignal | null | undefined;
  const controller = new AbortController();
  const headers: Headers[] = [];
  const serverConfiguration = pluginConfigurationSchema.parse({ scope: binding.scope, ...connection, pluginDigest: "a".repeat(64), settings: { loginCustomerId: "1234567890" } });
  const dependencies: PluginCapabilityDependencies = { configuration: serverConfiguration, clock: { now: () => now }, observer: { observe() {} }, wait: async () => ({ ok: true, value: undefined }),
    credentials: { async access(input, options) { accesses++; assert.deepEqual(input, connection); credentialSignal = options?.signal; return { ok: true, value: { accessToken: "fixture-only", secrets: { developerToken: "a".repeat(22) } } }; } },
    fetch: async (_url, options) => { fetches++; headers.push(new Headers(options?.headers)); fetchSignal = options?.signal; const query = JSON.parse(String(options?.body)).query; return Response.json(query === "SELECT customer.id, customer.currency_code, customer.time_zone FROM customer LIMIT 2" ? customerMetadata : defaultResponse({ query })); },
  };
  const reads = factory(dependencies);
  const hostedTools = createTools(dependencies);
  assert.equal(accesses, 0); assert.equal(fetches, 0);
  assert.deepEqual(Object.keys(reads).sort(), ["campaign.halt-stop.v1", "campaign.status.v1", "campaign.validate.v1", "report.metrics.v1", "tracking.tag.v1"]);
  const report = reads["report.metrics.v1"]!;
  const batch = value({ outcome: await report({ context, connection, input: { grain: "account", days } }, { signal: controller.signal }) });
  assert.equal(batch.rows[0].metrics.spend, "9007199254740993"); assert.equal(metricBatchSchema.safeParse(batch).success, true);
  controller.abort(); assert.equal(fetchSignal?.aborted, true); assert.equal(credentialSignal?.aborted, true);
  const status = value({ outcome: await reads["campaign.status.v1"]!({ context, connection, input: { vendorCampaignIds: ["201"] } }) });
  assert.equal(capabilityCatalog["campaign.status.v1"].output.safeParse(status).success, true); assert.equal(status.campaigns[0].rejectedChildAds, 2); assert.equal(status.campaigns[0].currentBudget?.amountMicros, "50000000"); assert.equal(status.campaigns[0].status, "active");
  assert.match(value({ outcome: await reads["tracking.tag.v1"]!({ context, connection, input: tagInput }) }).snippet, /^<script/);
  const account = value({ outcome: await hostedTools.invoke({ context, connection, name: "list_accounts", operationId: "op-1", input: {}, moneyExposure: null, requiredLimit: null }) });
  assert.deepEqual(account, { customerId: binding.customerId, currency: binding.currency, timezone: binding.timezone, testAccount: true });
  assert.equal(fetches, 7); assert.equal(accesses, 7);
  for (const header of headers) {
    assert.equal(header.get("developer-token"), "a".repeat(22));
    assert.equal(header.get("login-customer-id"), "1234567890");
  }
});

test("canonical factory rejects invalid config, foreign calls and cancellation without I/O", async () => {
  let accesses = 0; let fetches = 0;
  const host = { clock: { now: () => now }, observer: { observe() {} }, wait: async (): Promise<Outcome<void>> => ({ ok: true, value: undefined }),
    credentials: { async access(): Promise<Outcome<{ accessToken: string }>> { accesses++; throw new Error("must not access"); } },
    fetch: (async () => { fetches++; throw new Error("must not fetch"); }) as typeof fetch };
  for (const invalid of [null, {}, { binding: {} }, { ...configuration, authority: true }]) {
    const dependencies = { ...host, configuration }; Reflect.set(dependencies, "configuration", invalid);
    const reads = createCapabilities(dependencies);
    error({ outcome: await reads["report.metrics.v1"]({ context, connection, input: { grain: "account", days } }), code: "invalid_input" });
  }
  const reads = createCapabilities({ ...host, configuration });
  error({ outcome: await reads["report.metrics.v1"]({ context, connection: { ...connection, accountId: "9999999999" }, input: { grain: "account", days } }), code: "forbidden" });
  error({ outcome: await reads["report.metrics.v1"]({ context, connection, input: { grain: "account", days } }, { signal: AbortSignal.abort() }), code: "cancelled" });
  const hostedTools = createTools({ ...host, configuration });
  error({ outcome: await hostedTools.invoke({ context, connection: { ...connection, connectionId: "foreign-connection" }, name: "list_accounts", operationId: "op-1", input: {}, moneyExposure: null, requiredLimit: null }), code: "forbidden" });
  assert.equal(accesses, 0); assert.equal(fetches, 0);
  error({ outcome: await hostedTools.invoke({ context, connection, name: "activate", operationId: "op-1", input: { campaignId: "201" }, moneyExposure: null, requiredLimit: null }), code: "unavailable" });
  assert.equal(accesses, 0); assert.equal(fetches, 0);
});

test("hosted tools reject invalid operation IDs before credential access or fetch", async () => {
  for (const operationId of ["", "x".repeat(257), 42]) {
    let accesses = 0; let fetches = 0;
    const hostedTools = createTools({ configuration, clock: { now: () => now }, observer: { observe() {} }, wait: async () => ({ ok: true, value: undefined }),
      credentials: { async access() { accesses++; return { ok: true, value: { accessToken: "fixture" } }; } },
      fetch: async () => { fetches++; return Response.json(customerMetadata); } });
    const call = { context, connection, name: "list_accounts", operationId: "valid", input: {}, moneyExposure: null, requiredLimit: null };
    Reflect.set(call, "operationId", operationId);
    error({ outcome: await hostedTools.invoke(call), code: "invalid_input" });
    assert.equal(accesses, 0); assert.equal(fetches, 0);
  }
});

/** Fixture rows follow the actual queried date window; parent sentinel results must be discarded. */
function windowRows({ query, perDay }: { query: string; perDay: number }): unknown {
  const dates = [...query.matchAll(/'(\d{4}-\d{2}-\d{2})'/g)].map(match => match[1]);
  const count = (Date.parse(dates[1]) - Date.parse(dates[0])) / 86400000;
  const rows = Array.from({ length: Math.min(1001, count * perDay) }, (_, index) => row({ extra: {
    segments: { date: new Date(Date.parse(dates[0]) + Math.floor(index / perDay) * 86400000).toISOString().slice(0, 10) },
    campaign: { id: String(index % perDay + 1) },
  } }));
  return { results: rows };
}
for (const real of [false, true]) {
  test(`${real ? "REST" : "double"}: twelve campaigns over ninety days are complete`, async () => {
    const setup = harness({ real, respond: input => windowRows({ ...input, perDay: 12 }) });
    const batch = value({ outcome: await setup.reads["report.metrics.v1"]({ context, connection, input: { grain: "campaign", days: { start: "2026-01-01", end: "2026-04-01" } } }) });
    assert.equal(batch.rows.length, 1080); assert.equal(batch.complete, true); assert.equal(setup.calls.length, 4);
    assert.equal(new Set(batch.rows.map(row => row.day + ":" + (row.entity.grain === "campaign" ? row.entity.vendorCampaignId : ""))).size, 1080);
  });
  test(`${real ? "REST" : "double"}: split saturated windows without counting their parent rows`, async () => {
    const setup = harness({ real, respond: input => windowRows({ ...input, perDay: 40 }) });
    const batch = value({ outcome: await setup.reads["report.metrics.v1"]({ context, connection, input: { grain: "campaign", days: { start: "2026-03-01", end: "2026-03-31" } } }) });
    assert.equal(batch.rows.length, 1200); assert.equal(batch.complete, true); assert.equal(setup.calls.length, 4);
  });
  for (const dayCount of [50, 51]) test(`${real ? "REST" : "double"}: ${dayCount} dense days respect the 5000-row ceiling`, async () => {
    const setup = harness({ real, respond: input => windowRows({ ...input, perDay: 100 }) });
    const range = { start: "2026-01-01", end: new Date(Date.parse("2026-01-01") + dayCount * 86400000).toISOString().slice(0, 10) };
    const batch = value({ outcome: await setup.reads["report.metrics.v1"]({ context, connection, input: { grain: "campaign", days: range } }) });
    assert.equal(batch.rows.length, 5000); assert.equal(batch.complete, dayCount === 50);
    assert.equal(batch.freshness, dayCount === 50 ? "fresh" : "stale"); if (dayCount > 50) assert.equal(batch.dataThrough, 0);
  });
  test(`${real ? "REST" : "double"}: stop splitting at the report request budget`, async () => {
    const setup = harness({ real, respond: ({ query }) => {
      const dates = [...query.matchAll(/'(\d{4}-\d{2}-\d{2})'/g)].map(match => match[1]);
      return { results: [], ...((Date.parse(dates[1]) - Date.parse(dates[0])) > 86400000 ? { nextPageToken: "saturated" } : {}) };
    } });
    const batch = value({ outcome: await setup.reads["report.metrics.v1"]({ context, connection, input: { grain: "campaign", days: { start: "2026-01-01", end: "2026-04-01" } } }) });
    assert.equal(batch.complete, false); assert.equal(batch.dataThrough, 0); assert.equal(setup.calls.length, 32); assert.equal(batch.rows.length, 0);
  });
}
test("canonical token-only credentials produce valid catalog output", async () => {
  const reads = createCapabilities({ configuration, clock: { now: () => now }, observer: { observe() {} }, wait: async () => ({ ok: true, value: undefined }),
    credentials: { access: async () => ({ ok: true, value: { accessToken: "fixture" } }) },
    fetch: async (_url, init) => Response.json(JSON.parse(String(init?.body)).query.includes("FROM customer LIMIT 2") ? customerMetadata : { results: [] }) });
  const batch = value({ outcome: await reads["report.metrics.v1"]({ context, connection, input: { grain: "account", days } }) });
  assert.equal(metricBatchSchema.safeParse(batch).success, true);
});
test("canonical secrets and settings supply headers; top-level credential fields are ignored", async () => {
  for (const canonical of [true, false]) {
    const headers: Headers[] = [];
    const reads = createCapabilities({ configuration: pluginConfigurationSchema.parse({ ...configuration, settings: canonical ? { loginCustomerId: "1234567890" } : {} }),
      clock: { now: () => now }, observer: { observe() {} }, wait: async () => ({ ok: true, value: undefined }),
      credentials: { access: async () => ({ ok: true, value: { accessToken: "fixture", developerToken: "b".repeat(22), loginCustomerId: "1111111111", ...(canonical ? { secrets: { developerToken: "a".repeat(22) } } : {}) } }) },
      fetch: async (_url, init) => { headers.push(new Headers(init?.headers)); return Response.json(JSON.parse(String(init?.body)).query.includes("FROM customer LIMIT 2") ? customerMetadata : { results: [] }); } });
    value({ outcome: await reads["report.metrics.v1"]({ context, connection, input: { grain: "account", days } }) });
    assert.equal(headers.length, 2);
    for (const header of headers) {
      assert.equal(header.get("developer-token"), canonical ? "a".repeat(22) : null);
      assert.equal(header.get("login-customer-id"), canonical ? "1234567890" : null);
    }
  }
});
test("malformed developer credentials return a sanitized typed failure before fetch", async () => {
  const sentinel = "a".repeat(21); let fetches = 0;
  const reads = createCapabilities({ configuration, clock: { now: () => now }, observer: { observe() {} }, wait: async () => ({ ok: true, value: undefined }),
    credentials: { access: async () => ({ ok: true, value: { accessToken: "fixture", secrets: { developerToken: sentinel } } }) },
    fetch: async () => { fetches++; return Response.json({}); } });
  const result = await reads["report.metrics.v1"]({ context, connection, input: { grain: "account", days } });
  error({ outcome: result, code: "invalid_input" });
  assert.equal(JSON.stringify(result).includes(sentinel), false); assert.equal(fetches, 0);
});
test("malformed manager settings fail before credentials or fetch without echoing the value", async () => {
  const sentinel = "123-456-7890"; let effects = 0;
  const reads = createCapabilities({ configuration: pluginConfigurationSchema.parse({ ...configuration, settings: { loginCustomerId: sentinel } }),
    clock: { now: () => now }, observer: { observe() {} }, wait: async () => ({ ok: true, value: undefined }),
    credentials: { access: async () => { effects++; return { ok: true, value: { accessToken: "fixture" } }; } },
    fetch: async () => { effects++; return Response.json({}); } });
  const result = await reads["report.metrics.v1"]({ context, connection, input: { grain: "account", days } });
  error({ outcome: result, code: "invalid_input" });
  assert.equal(JSON.stringify(result).includes(sentinel), false); assert.equal(effects, 0);
});
test("Google metadata is required even for empty reports and foreign vendor accounts fail", async () => {
  for (const response of [{}, { results: [{ customer: { id: binding.customerId, currencyCode: "USD" } }] }, { results: [{ customer: { id: "9999999999", currencyCode: "USD", timeZone: "UTC" } }] }]) {
    const reads = createCapabilities({ configuration, clock: { now: () => now }, observer: { observe() {} }, wait: async () => ({ ok: true, value: undefined }),
      credentials: { access: async () => ({ ok: true, value: { accessToken: "fixture" } }) }, fetch: async () => Response.json(response) });
    assert.equal((await reads["report.metrics.v1"]({ context, connection, input: { grain: "account", days } })).ok, false);
  }
});

for (const real of [false, true]) test(`${real ? "REST" : "double"}: status rows reject foreign, malformed, unexpected and duplicate campaigns`, async () => {
  const valid = { customer: { id: binding.customerId }, campaign: { id: "201", status: "PAUSED", primaryStatus: "PAUSED" } };
  for (const [rows, code] of [
    [[{ ...valid, customer: { id: "9999999999" } }], "forbidden"],
    [[{ ...valid, campaign: { id: "201" } }], "invalid_input"],
    [[{ ...valid, campaign: { ...valid.campaign, id: "202" } }], "invalid_input"],
    [[valid, valid], "invalid_input"],
  ] as const) {
    const setup = harness({ real, respond: () => ({ results: rows }) });
    error({ outcome: await setup.reads["campaign.status.v1"]({ context, connection, input: { vendorCampaignIds: ["201"] } }), code });
  }
});
test("Google cancellation between windows stops all later fetches", async () => {
  const controller = new AbortController(); let fetches = 0; let searches = 0;
  const reads = createCapabilities({ configuration, clock: { now: () => now }, observer: { observe() {} }, wait: async () => ({ ok: true, value: undefined }),
    credentials: { access: async () => ({ ok: true, value: { accessToken: "fixture" } }) },
    fetch: async (_url, options) => {
      fetches++; const query = JSON.parse(String(options?.body)).query;
      if (query === "SELECT customer.id, customer.currency_code, customer.time_zone FROM customer LIMIT 2") return Response.json(customerMetadata);
      searches++; controller.abort(); return Response.json(windowRows({ query, perDay: 12 }));
    },
  });
  error({ outcome: await reads["report.metrics.v1"]({ context, connection, input: { grain: "campaign", days: { start: "2026-01-01", end: "2026-04-01" } } }, { signal: controller.signal }), code: "cancelled" });
  assert.equal(fetches, 2); assert.equal(searches, 1);
});

test("REST: split a response over 1 MiB into successful child windows without parent rows", async () => {
  const setup = harness({ real: true, respond: ({ query }) => {
    if (query.includes("'2026-03-01'") && query.includes("'2026-03-31'")) return JSON.stringify({ results: [row({ extra: { campaign: { id: "999" } } })], padding: "x".repeat(1048577) });
    return windowRows({ query, perDay: 40 });
  } });
  const batch = value({ outcome: await setup.reads["report.metrics.v1"]({ context, connection, input: { grain: "campaign", days: { start: "2026-03-01", end: "2026-03-31" } } }) });
  assert.equal(batch.complete, true); assert.equal(batch.rows.length, 1200); assert.equal(setup.calls.length, 4);
  assert.equal(batch.rows.some(row => row.entity.grain === "campaign" && row.entity.vendorCampaignId === "999"), false);
});
test("REST: single-day response overflow remains a typed limit failure", async () => {
  const setup = harness({ real: true, respond: () => "x".repeat(1048577) });
  error({ outcome: await setup.reads["report.metrics.v1"]({ context, connection, input: { grain: "campaign", days: { start: "2026-03-01", end: "2026-03-02" } } }), code: "limit_exceeded" });
  assert.equal(setup.calls.length, 2);
});
test("REST: failed oversized searches count against the report request budget", async () => {
  const setup = harness({ real: true, respond: ({ query }) => {
    const dates = [...query.matchAll(/'(\d{4}-\d{2}-\d{2})'/g)].map(match => match[1]);
    return Date.parse(dates[1]) - Date.parse(dates[0]) > 86400000 ? "x".repeat(1048577) : { results: [] };
  } });
  const batch = value({ outcome: await setup.reads["report.metrics.v1"]({ context, connection, input: { grain: "campaign", days: { start: "2026-01-01", end: "2026-04-01" } } }) });
  assert.equal(batch.complete, false); assert.equal(batch.dataThrough, 0); assert.equal(setup.calls.length, 32);
});

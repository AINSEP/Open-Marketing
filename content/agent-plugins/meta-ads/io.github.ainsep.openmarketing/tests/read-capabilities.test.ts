import { describe, expect, it } from "vitest";
import type { CallContext, Outcome, PluginCapabilitiesFactory, PluginCapabilityDependencies, PluginConnectionConfiguration } from "@open-marketing/contracts";
import { capabilityCatalog, metricBatchSchema, pluginConfigurationSchema, pluginConnectionConfigurationSchema } from "@open-marketing/contracts";
import { createCapabilities, createTools, createReadCapabilities, createMetaInstagramFetchDispatch, metricMapping } from "../src/index.js";
import type { MetaInstagramDispatch } from "../src/index.js";

const binding = { scope: { ownerId: "owner", workspaceId: "workspace" }, accountId: "1234567890", connectionId: "meta-connection" };
const context: CallContext = { scope: binding.scope, principal: { kind: "service", serviceId: "sync" }, correlationId: "sync-1", traceId: "trace-1", runId: "run-1" };
const connection = { connectionId: binding.connectionId, accountId: binding.accountId };
const configuration = pluginConfigurationSchema.parse({ scope: binding.scope, ...connection, pluginDigest: "a".repeat(64), settings: { admitted: false } });
const days = { start: "2026-03-07", end: "2026-03-09" };
const now = Date.parse("2026-11-05T12:00:00Z");
const tagInput = { campaignKey: { pluginId: "meta-ads", accountId: binding.accountId, vendorCampaignId: "201" }, destinationUrl: "https://example.test/landing?existing=one%20two&utm_id=old#details" };
const metadata = { id: "act_" + binding.accountId, account_id: binding.accountId, currency: "USD", timezone_name: "America/Los_Angeles" };
type ResponseInput = { edge: string; parameters: Record<string, string> };

function row(required: { extra?: Record<string, unknown> } = {}): Record<string, unknown> {
  return { account_id: binding.accountId, account_currency: "USD", date_start: "2026-03-08", date_stop: "2026-03-08", campaign_id: "201", adset_id: "301", ad_id: "401",
    spend: "9007199254.123456", impressions: "100", clicks: "0",
    actions: [{ action_type: "offsite_conversion.fb_pixel_purchase", "7d_click": "1.25" }, { action_type: "omni_purchase", "7d_click": "90" }, { action_type: "purchase", "7d_click": "90" }],
    action_values: [{ action_type: "offsite_conversion.fb_pixel_purchase", "7d_click": "20.000001" }], ...required.extra };
}
function defaultResponse({ edge }: ResponseInput): unknown {
  if (edge === "") return metadata;
  if (edge === "/insights") return { data: [row()] };
  if (edge === "/campaigns") return { data: [{ id: "201", account_id: binding.accountId, effective_status: "ACTIVE", daily_budget: "5000", lifetime_budget: "0", issues_info: [{ error_message: "Review campaign issue" }] }] };
  if (edge === "/ads") return { data: [{ id: "401", account_id: binding.accountId, campaign_id: "201", effective_status: "DISAPPROVED", ad_review_feedback: { global: { policy: "Misleading claims" }, placement_specific: { instagram: { policy: "Placement restriction" } } } }] };
  if (edge === "/adsets") return { data: [{ id: "301", account_id: binding.accountId, campaign_id: "201", promoted_object: { pixel_id: "701" } }] };
  return { data: [{ id: "701", code: '<script>fixturePixel("701")</script>' }] };
}
/** Paired replacement adapters: same assertions through the double and real bounded fetch dispatch. */
function harness(required: { real: boolean; respond?: (required: ResponseInput) => unknown }) {
  const requests: Parameters<MetaInstagramDispatch>[0][] = [];
  const urls: string[] = [];
  const signals: AbortSignal[] = [];
  const respond = required.respond ?? defaultResponse;
  const fakeFetch: typeof fetch = async (input, options) => {
    const url = new URL(String(input)); urls.push(url.toString());
    const edge = url.pathname.replace("/v26.0/act_" + binding.accountId, "");
    expect(options?.method).toBe("GET"); expect(options?.redirect).toBe("error");
    expect(options?.body).toBeUndefined();
    expect(url.searchParams.has("access_token")).toBe(false);
    return new Response(JSON.stringify(respond({ edge, parameters: Object.fromEntries(url.searchParams) })), { status: 200 });
  };
  const real = createMetaInstagramFetchDispatch({ fetch: fakeFetch, credentials: { async access(input) {
    expect(input.accountId).toBe(binding.accountId); expect(input.connectionId).toBe(binding.connectionId);
    return { ok: true, value: { accessToken: "fixture-only" } };
  } } });
  const dispatch: MetaInstagramDispatch = async (input, options) => {
    requests.push(input); if (options?.signal) signals.push(options.signal);
    if (required.real) return real(input, options);
    const edge = input.request.endpoint.replace("https://graph.facebook.com/v26.0/act_" + binding.accountId, "");
    return { ok: true, value: respond({ edge, parameters: input.request.parameters as Record<string, string> }) };
  };
  return { reads: createReadCapabilities({ binding, dispatch, clock: { now: () => now } }), requests, urls, signals, fetch: fakeFetch };
}
function value<T>({ outcome }: { outcome: Outcome<T> }): T { expect(outcome.ok).toBe(true); if (!outcome.ok) throw new Error(outcome.error.code); return outcome.value; }
function error({ outcome, code }: { outcome: Outcome<unknown>; code: string }): void { expect(outcome.ok).toBe(false); if (!outcome.ok) expect(outcome.error.code).toBe(code); }

for (const real of [false, true]) describe(real ? "real bounded Graph fetch" : "dispatch double", () => {
  for (const grain of ["account", "campaign", "ad_group", "ad"] as const) it(`returns exact daily ${grain} metrics with explicit purchase attribution`, async () => {
    const fixture = harness({ real });
    const batch = value({ outcome: await fixture.reads["report.metrics.v1"]({ context, connection, input: { grain, days } }) });
    expect(metricBatchSchema.safeParse(batch).success).toBe(true);
    expect(batch.rows[0].metrics).toEqual({ spend: "9007199254123456", impressions: "100", clicks: "0", vendorConversions: "1250000", vendorConversionValue: "20000001" });
    expect(batch.rows[0].entity.grain).toBe(grain); expect(batch.currency).toBe("USD"); expect(batch.timezone).toBe(metadata.timezone_name);
    expect(batch).toMatchObject({ complete: true, freshness: "fresh", finality: "provisional", restated: false, retrievedAt: now });
    expect(batch.dataThrough).toBe(Date.parse("2026-03-09T07:00:00Z"));
    expect(batch.reach).toBeUndefined(); expect(metricMapping.reach).toBeUndefined();
    const request = fixture.requests[1];
    expect(request.request.parameters).toMatchObject({ level: grain === "ad_group" ? "adset" : grain, time_increment: "1", action_report_time: "impression", action_attribution_windows: '["7d_click"]' });
    expect(JSON.parse(String(request.request.parameters.time_range))).toEqual({ since: days.start, until: "2026-03-08" });
    expect(request.context).toEqual(context); expect(request.effect.effects).toEqual(["read"]);
    expect(request.effect.accountId).toBe(binding.accountId); expect(request.timeoutMs).toBe(15000);
    expect(fixture.requests).toHaveLength(2); expect(fixture.signals.every(signal => !signal.aborted)).toBe(true);
  });
  it("preserves unavailable, exact zero, and unsupported period reach separately", async () => {
    const fixture = harness({ real, respond: input => input.edge === "" ? metadata : { data: [row({ extra: { spend: "0", impressions: undefined, clicks: null, actions: [{ action_type: "purchase", "7d_click": "9" }], action_values: [] } })] } });
    const batch = value({ outcome: await fixture.reads["report.metrics.v1"]({ context, connection, input: { grain: "campaign", days } }) });
    expect(batch.rows[0].metrics).toEqual({ spend: "0", impressions: null, clicks: null, vendorConversions: "0", vendorConversionValue: "0" });
    expect(Object.hasOwn(batch.mapping.grains.campaign ?? {}, "reach")).toBe(false);
  });
  it("does not guess missing attribution or sum duplicate purchase series", async () => {
    const fixture = harness({ real, respond: input => input.edge === "" ? metadata : { data: [row({ extra: {
      actions: [{ action_type: "offsite_conversion.fb_pixel_purchase", value: "15" }],
      action_values: [{ action_type: "offsite_conversion.fb_pixel_purchase", "7d_click": "10" }, { action_type: "offsite_conversion.fb_pixel_purchase", "7d_click": "10" }],
    } })] } });
    const batch = value({ outcome: await fixture.reads["report.metrics.v1"]({ context, connection, input: { grain: "account", days } }) });
    expect(batch.rows[0].metrics.vendorConversions).toBeNull(); expect(batch.rows[0].metrics.vendorConversionValue).toBeNull();
  });
  it("returns child disapproval feedback without marking an active campaign disapproved", async () => {
    const fixture = harness({ real });
    const result = value({ outcome: await fixture.reads["campaign.status.v1"]({ context, connection, input: { vendorCampaignIds: ["201", "202"] } }) });
    expect(result.complete).toBe(false); expect(result.observedAt).toBe(now);
    expect(result.campaigns).toEqual([
      { vendorCampaignId: "201", status: "active", disapprovalDescriptions: ["Review campaign issue", "Misleading claims", "Placement restriction"], rejectedChildAds: 1, currentBudget: { kind: "daily", amountMicros: "50000000", currency: "USD" } },
      { vendorCampaignId: "202", status: "unknown", disapprovalDescriptions: [] },
    ]);
    expect(fixture.requests).toHaveLength(3);
  });
  it("counts disapproved ads without feedback, excludes review/issues states and checks zero", async () => {
    const fixture = harness({ real, respond: input => {
      if (input.edge === "/campaigns") return { data: ["201", "202"].map(id => ({ id, account_id: binding.accountId, effective_status: "ACTIVE" })) };
      if (input.edge !== "/ads") return defaultResponse(input);
      return { data: ["DISAPPROVED", "DISAPPROVED", "PENDING_REVIEW", "WITH_ISSUES"].map((effective_status, i) => ({ id: String(401 + i), account_id: binding.accountId, campaign_id: "201", effective_status })) };
    } });
    const result = value({ outcome: await fixture.reads["campaign.status.v1"]({ context, connection, input: { vendorCampaignIds: ["201", "202"] } }) });
    expect(result.campaigns).toEqual(["201", "202"].map((vendorCampaignId, i) => ({ vendorCampaignId, status: "active", disapprovalDescriptions: [], rejectedChildAds: i === 0 ? 2 : 0 })));
  });
  for (const scenario of [
    { currency: "USD", daily_budget: "5000", expected: { kind: "daily", amountMicros: "50000000", currency: "USD" } },
    { currency: "JPY", daily_budget: "5000", expected: { kind: "daily", amountMicros: "5000000000", currency: "JPY" } },
    { currency: "TWD", daily_budget: "5000", expected: { kind: "daily", amountMicros: "5000000000", currency: "TWD" } },
    { currency: "USD", daily_budget: "0", lifetime_budget: "5000", expected: { kind: "lifetime", amountMicros: "50000000", currency: "USD", flight: { start: Date.parse("2026-10-01T07:00:00Z"), end: Date.parse("2026-10-03T07:00:00Z") } } },
    { currency: "USD", daily_budget: "0", expected: undefined },
    { currency: "USD", daily_budget: "5000", lifetime_budget: "5000", expected: undefined },
    { currency: "USD", daily_budget: 5000, expected: undefined },
  ]) it(`projects current campaign budget ${JSON.stringify(scenario)}`, async () => {
    const fixture = harness({ real, respond: input => {
      if (input.edge === "") return { ...metadata, currency: scenario.currency };
      if (input.edge === "/campaigns") return { data: [{ id: "201", account_id: binding.accountId, effective_status: "ACTIVE", daily_budget: scenario.daily_budget, lifetime_budget: scenario.lifetime_budget, start_time: "2026-10-01T00:00:00-0700", stop_time: "2026-10-03T00:00:00-0700" }] };
      return defaultResponse(input);
    } });
    const result = value({ outcome: await fixture.reads["campaign.status.v1"]({ context, connection, input: { vendorCampaignIds: ["201"] } }) });
    expect(result.campaigns[0].currentBudget).toEqual(scenario.expected); expect(result.campaigns[0].status).toBe("active");
  });
  it("verifies the campaign pixel against account pixels and preserves query/fragment/macros", async () => {
    const fixture = harness({ real });
    const tag = value({ outcome: await fixture.reads["tracking.tag.v1"]({ context, connection, input: tagInput }) });
    expect(tag.snippet).toBe('<script>fixturePixel("701")</script>');
    const url = new URL(tag.campaignUrlTemplate);
    expect(url.searchParams.get("existing")).toBe("one two"); expect(url.hash).toBe("#details");
    expect(url.searchParams.getAll("utm_id")).toEqual(["{{campaign.id}}"]);
    expect(url.searchParams.get("utm_source")).toBe("meta-ads"); expect(url.searchParams.get("om_a")).toBe(binding.accountId);
    expect(tag.campaignUrlTemplate).toContain("utm_id={{campaign.id}}"); expect(fixture.requests).toHaveLength(2);
    const existing = value({ outcome: await fixture.reads["tracking.tag.v1"]({ context, connection, input: { ...tagInput, destinationUrl: "https://example.test/?existing=%7B%7Bcampaign.id%7D%7D" } }) });
    expect(existing.campaignUrlTemplate).toContain("existing=%7B%7Bcampaign.id%7D%7D");
    expect(existing.campaignUrlTemplate).toContain("utm_id={{campaign.id}}");
  });
  it("reconstructs cursor requests and never follows vendor paging.next URLs", async () => {
    const fixture = harness({ real, respond: input => {
      if (input.edge === "") return metadata;
      if (!input.parameters.after) return { data: [row()], paging: { next: "https://attacker.invalid/?access_token=reflected", cursors: { after: "page2" } } };
      expect(input.parameters.after).toBe("page2");
      return { data: [row({ extra: { campaign_id: "202" } })], paging: { cursors: { after: "terminal" } } };
    } });
    const batch = value({ outcome: await fixture.reads["report.metrics.v1"]({ context, connection, input: { grain: "campaign", days } }) });
    expect(batch.rows).toHaveLength(2); expect(batch.complete).toBe(true); expect(fixture.requests).toHaveLength(3);
    expect(fixture.requests.every(request => request.request.endpoint === "https://graph.facebook.com/v26.0/act_" + binding.accountId || request.request.endpoint.endsWith("/insights"))).toBe(true);
    expect(fixture.urls.every(url => new URL(url).hostname === "graph.facebook.com")).toBe(true);
  });
  it("validates binding, scope, inputs, keys and cancellation before I/O", async () => {
    const fixture = harness({ real }); const input = { grain: "account" as const, days };
    error({ outcome: await fixture.reads["report.metrics.v1"]({ context, connection: { ...connection, connectionId: "foreign" }, input }), code: "forbidden" });
    error({ outcome: await fixture.reads["report.metrics.v1"]({ context: { ...context, scope: { ...context.scope, workspaceId: "foreign" } }, connection, input }), code: "forbidden" });
    error({ outcome: await fixture.reads["report.metrics.v1"]({ context, connection, input: { ...input, days: { start: days.end, end: days.start } } }), code: "invalid_input" });
    error({ outcome: await fixture.reads["campaign.status.v1"]({ context, connection, input: { vendorCampaignIds: ["201", "201"] } }), code: "invalid_input" });
    error({ outcome: await fixture.reads["tracking.tag.v1"]({ context, connection, input: { ...tagInput, campaignKey: { ...tagInput.campaignKey, pluginId: "foreign" } } }), code: "forbidden" });
    error({ outcome: await fixture.reads["report.metrics.v1"]({ context, connection, input }, { signal: AbortSignal.abort() }), code: "cancelled" });
    expect(fixture.requests).toHaveLength(0);
  });
  for (const scenario of [
    { name: "duplicate daily identities", response: { data: [row(), row()] }, code: "invalid_input" },
    { name: "mixed foreign accounts", response: { data: [row(), row({ extra: { account_id: "999" } })] }, code: "forbidden" },
    { name: "foreign currency", response: { data: [row({ extra: { account_currency: "EUR" } })] }, code: "forbidden" },
    { name: "overprecision", response: { data: [row({ extra: { spend: "0.0000001" } })] }, code: "invalid_input" },
    { name: "floating-point spend", response: { data: [row({ extra: { spend: 1.23 } })] }, code: "invalid_input" },
    { name: "non-daily row", response: { data: [row({ extra: { date_stop: days.end } })] }, code: "invalid_input" },
    { name: "missing parents", response: { data: [row({ extra: { campaign_id: undefined } })] }, code: "invalid_input" },
    { name: "missing cursor", response: { data: [row()], paging: { next: "https://fixture.test/page" } }, code: "invalid_input" },
    { name: "malformed rows", response: { data: "invalid" }, code: "invalid_input" },
    { name: "overlong response", response: { data: [], padding: "x".repeat(1048576) }, code: "limit_exceeded" },
  ]) it(`rejects ${scenario.name}`, async () => {
    const fixture = harness({ real, respond: input => input.edge === "" ? metadata : scenario.response });
    error({ outcome: await fixture.reads["report.metrics.v1"]({ context, connection, input: { grain: "campaign", days } }), code: scenario.code });
  });
  it("caps request count across all pages and keeps incomplete data from escaping", async () => {
    let page = 0;
    const fixture = harness({ real, respond: input => {
      if (input.edge === "") return metadata;
      page += 1;
      return { data: [], paging: { next: "https://fixture.test/ignored", cursors: { after: String(page) } } };
    } });
    error({ outcome: await fixture.reads["report.metrics.v1"]({ context, connection, input: { grain: "account", days } }), code: "limit_exceeded" });
    expect(fixture.requests).toHaveLength(27);
  });
  it("rejects repeated cursors and duplicate identities across different pages", async () => {
    const repeated = harness({ real, respond: input => input.edge === "" ? metadata : { data: [], paging: { next: "https://fixture.test/ignored", cursors: { after: "same" } } } });
    error({ outcome: await repeated.reads["report.metrics.v1"]({ context, connection, input: { grain: "campaign", days } }), code: "invalid_input" });
    expect(repeated.requests).toHaveLength(3);
    const duplicate = harness({ real, respond: input => input.edge === "" ? metadata : { data: [row()], ...(!input.parameters.after ? { paging: { next: "https://fixture.test/ignored", cursors: { after: "second" } } } : {}) } });
    error({ outcome: await duplicate.reads["report.metrics.v1"]({ context, connection, input: { grain: "campaign", days } }), code: "invalid_input" });
  });
  it("returns unavailable for missing, foreign or ambiguous campaign pixels", async () => {
    for (const data of [[], [{ id: "301", account_id: binding.accountId, campaign_id: "201" }],
      [{ id: "301", account_id: binding.accountId, campaign_id: "201", promoted_object: { pixel_id: "701" } }, { id: "302", account_id: binding.accountId, campaign_id: "201", promoted_object: { pixel_id: "702" } }]]) {
      const fixture = harness({ real, respond: input => input.edge === "/adsets" ? { data } : defaultResponse(input) });
      error({ outcome: await fixture.reads["tracking.tag.v1"]({ context, connection, input: tagInput }), code: "unavailable" });
      expect(fixture.requests).toHaveLength(1);
    }
    const foreign = harness({ real, respond: input => input.edge === "/adspixels" ? { data: [{ id: "999", code: "foreign" }] } : defaultResponse(input) });
    error({ outcome: await foreign.reads["tracking.tag.v1"]({ context, connection, input: tagInput }), code: "unavailable" });
  });
  it("adapts service contexts and returns an honest complete empty report", async () => {
    const fixture = harness({ real, respond: input => input.edge === "" ? metadata : { data: [] } });
    const service = { scope: context.scope, serviceId: "worker", correlationId: context.correlationId, traceId: context.traceId };
    const batch = value({ outcome: await fixture.reads["report.metrics.v1"]({ context: service, connection, input: { grain: "account", days } }) });
    expect(batch.rows).toEqual([]); expect(batch.complete).toBe(true);
    expect(fixture.requests[0].context).toEqual({ scope: context.scope, principal: { kind: "service", serviceId: "worker" }, correlationId: context.correlationId, traceId: context.traceId });
  });
  it("accepts exactly 5000 rows across pages and rejects one more", async () => {
    for (const count of [5000, 5001]) {
      const fixture = harness({ real, respond: input => {
        if (input.edge === "") return metadata;
        expect(input.parameters.limit).toBe("200");
        const start = Number(input.parameters.after ?? 0);
        const data = Array.from({ length: Math.min(200, count - start) }, (_, index) => row({ extra: { date_start: days.start, date_stop: days.start, campaign_id: String(start + index + 1),
          actions: Array.from({ length: 40 }, (_, action) => ({ action_type: "other_action_" + String(action).padStart(35, "0"), value: "12.345678", "7d_click": "1.234567" })),
        } }));
        const next = start + data.length;
        const response = { data, ...(next < count ? { paging: { next: "https://fixture.test/ignored", cursors: { after: String(next) } } } : {}) };
        expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThan(1048576);
        return response;
      } });
      const result = await fixture.reads["report.metrics.v1"]({ context, connection, input: { grain: "campaign", days } });
      if (count === 5000) { expect(value({ outcome: result }).rows).toHaveLength(5000); expect(fixture.requests).toHaveLength(26); }
      else error({ outcome: result, code: "limit_exceeded" });
    }
  });
  it("preserves campaign states, unknown enums and absent feedback", async () => {
    for (const [vendor, expected] of [["ACTIVE", "active"], ["PAUSED", "paused"], ["ARCHIVED", "ended"], ["PENDING_REVIEW", "pending"], ["DISAPPROVED", "disapproved"], ["FUTURE_ENUM", "unknown"]]) {
      const fixture = harness({ real, respond: input => input.edge === "" ? metadata : ({ data: input.edge === "/campaigns" ? [{ id: "201", account_id: binding.accountId, effective_status: vendor }] : [] }) });
      const result = value({ outcome: await fixture.reads["campaign.status.v1"]({ context, connection, input: { vendorCampaignIds: ["201"] } }) });
      expect(result).toMatchObject({ complete: true, campaigns: [{ status: expected, disapprovalDescriptions: [] }] });
    }
  });
  it("rejects foreign/malformed status rows and sanitizes adapter exceptions", async () => {
    for (const account_id of ["999", binding.accountId]) {
      const fixture = harness({ real, respond: input => input.edge === "" ? metadata : ({ data: input.edge === "/campaigns" ? [{ id: "201", account_id, effective_status: account_id === "999" ? "ACTIVE" : 123 }] : [] }) });
      error({ outcome: await fixture.reads["campaign.status.v1"]({ context, connection, input: { vendorCampaignIds: ["201"] } }), code: account_id === "999" ? "forbidden" : "invalid_input" });
    }
    const fixture = harness({ real, respond() { throw new Error("fixture-secret-must-not-escape"); } });
    const outcome = await fixture.reads["report.metrics.v1"]({ context, connection, input: { grain: "account", days } });
    error({ outcome, code: "unavailable" }); expect(JSON.stringify(outcome)).not.toContain("fixture-secret");
  });
});

it("allows more than 8 MiB of pages inside the shared 27-request/27-MiB ceiling", async () => {
  const fixture = harness({ real: true, respond: input => {
    if (input.edge === "") return metadata;
    const page = Number(input.parameters.after ?? 1);
    return { data: [], padding: "x".repeat(950000), ...(page < 12 ? { paging: { next: "https://fixture.test/ignored", cursors: { after: String(page + 1) } } } : {}) };
  } });
  expect(value({ outcome: await fixture.reads["report.metrics.v1"]({ context, connection, input: { grain: "account", days } }) }).rows).toEqual([]);
  expect(fixture.requests).toHaveLength(13);
});
it("preserves account-currency micros across zero/three-decimal currencies without minor-unit rounding", async () => {
  for (const currency of ["JPY", "KWD"]) {
    const fixture = harness({ real: true, respond: input => input.edge === "" ? { ...metadata, currency } : { data: [row({ extra: { account_currency: currency, spend: "1.000001" } })] } });
    const batch = value({ outcome: await fixture.reads["report.metrics.v1"]({ context, connection, input: { grain: "account", days } }) });
    expect(batch.currency).toBe(currency); expect(batch.rows[0].metrics.spend).toBe("1000001");
  }
});
it("the real fetch adapter rejects foreign-account reporting paths before credential lookup", async () => {
  let credentialCalls = 0;
  const dispatch = createMetaInstagramFetchDispatch({ credentials: { async access() { credentialCalls += 1; return { ok: true, value: { accessToken: "fixture" } }; } }, fetch: async () => { throw new Error("must not fetch"); } });
  error({ outcome: await dispatch({ context, connectionId: connection.connectionId, operationId: "read", timeoutMs: 15000,
    effect: { operationId: "read", connectionId: connection.connectionId, accountId: binding.accountId, effects: ["read"], argumentsDigest: "a".repeat(64), moneyExposure: null, requiredLimit: null },
    request: { method: "GET", endpoint: "https://graph.facebook.com/v26.0/act_999/insights", parameters: { fields: "spend" } },
  }), code: "forbidden" });
  expect(credentialCalls).toBe(0);
});

for (const real of [false, true]) {
  for (const grain of ["campaign", "ad_group", "ad"] as const) it(`${real ? "fetch" : "double"}: requests deleted/archived ${grain} spend and retains account totals`, async () => {
    const fixture = harness({ real, respond: input => {
      if (input.edge === "") return metadata;
      if (input.parameters.level === "account") {
        expect(input.parameters.filtering).toBeUndefined();
        return { data: [row({ extra: { spend: "6.00" } })] };
      }
      const filter = JSON.parse(input.parameters.filtering ?? "[]")[0];
      expect(filter).toMatchObject({ field: `${grain === "ad_group" ? "adset" : grain}.effective_status`, operator: "IN" });
      expect(filter.value).toEqual(expect.arrayContaining(["ACTIVE", "PAUSED", "DELETED", "ARCHIVED"]));
      const states = ["ACTIVE", "ARCHIVED", "DELETED"];
      return { data: states.filter(status => filter.value.includes(status)).map((_, index) => row({ extra: { campaign_id: String(201 + index), adset_id: String(301 + index), ad_id: String(401 + index), spend: `${index + 1}.00` } })) };
    } });
    const child = value({ outcome: await fixture.reads["report.metrics.v1"]({ context, connection, input: { grain, days } }) });
    const account = value({ outcome: await fixture.reads["report.metrics.v1"]({ context, connection, input: { grain: "account", days } }) });
    expect(child.rows).toHaveLength(3);
    expect(child.rows.reduce((sum, row) => sum + BigInt(row.metrics.spend!), 0n).toString()).toBe(account.rows[0].metrics.spend);
    expect(child.complete).toBe(true);
  });
  for (const actions of [undefined, [], [{ action_type: "purchase", "7d_click": "1" }], [{ action_type: "offsite_conversion.fb_pixel_purchase", "7d_click": "0" }], null]) {
    it(`${real ? "fetch" : "double"}: omitted purchases are zero, explicit null remains unavailable: ${JSON.stringify(actions)}`, async () => {
      const fixture = harness({ real, respond: input => input.edge === "" ? metadata : { data: [row({ extra: { spend: "1.00", actions, action_values: actions } })] } });
      const batch = value({ outcome: await fixture.reads["report.metrics.v1"]({ context, connection, input: { grain: "account", days } }) });
      expect(batch.rows[0].metrics.vendorConversions).toBe(actions === null ? null : "0");
      expect(batch.rows[0].metrics.vendorConversionValue).toBe(actions === null ? null : "0");
      expect(batch.rows[0].metrics.spend).toBe("1000000");
    });
  }
  it(`${real ? "fetch" : "double"}: rejected filters fail without an unfiltered retry`, async () => {
    const fixture = harness({ real, respond: input => {
      if (input.edge === "") return metadata;
      expect(input.parameters.filtering).toBeDefined();
      return { error: { message: "fixture filter rejected" } };
    } });
    error({ outcome: await fixture.reads["report.metrics.v1"]({ context, connection, input: { grain: "campaign", days } }), code: "invalid_input" });
    expect(fixture.requests).toHaveLength(2);
  });
}

it("canonical factory is inert, exposes catalog keys and binds shared credentials to real fetch", async () => {
  const factory: PluginCapabilitiesFactory = createCapabilities;
  const fixture = harness({ real: true, respond: request => {
    if (request.edge === "/v25.0/me/accounts") return { data: [{ id: "11", name: "Page", instagram_business_account: { id: "22" } }] };
    if (request.edge.endsWith("/content_publishing_limit")) return { data: [{ quota_usage: 0, config: { quota_total: 100, quota_duration: 86400 } }] };
    if (request.edge === "/v25.0/33") return { status_code: "FINISHED" };
    return defaultResponse(request);
  } }); let accesses = 0; let signal: AbortSignal | undefined;
  const dependencies: PluginCapabilityDependencies = { configuration, fetch: fixture.fetch, clock: { now: () => now }, observer: { observe() {} }, wait: async () => ({ ok: true, value: undefined }),
    credentials: { async access(input, options) { accesses++; expect(input).toEqual(connection); signal = options?.signal; return { ok: true, value: { accessToken: "fixture", expiresAt: now + 60000, secrets: { unrelated: "s3cret-fixture" } } }; } },
  };
  const reads = factory(dependencies);
  expect(accesses).toBe(0); expect(fixture.urls).toEqual([]);
  expect(Object.keys(reads).sort()).toEqual(["audience.member.add.v1", "campaign.status.v1", "report.metrics.v1", "tracking.tag.v1"]);
  const controller = new AbortController();
  const report = reads["report.metrics.v1"]!;
  const batch = value({ outcome: await report({ context, connection, input: { grain: "account", days } }, { signal: controller.signal }) });
  expect(metricBatchSchema.safeParse(batch).success).toBe(true); expect(batch.rows[0].metrics.spend).toBe("9007199254123456");
  controller.abort(); expect(signal?.aborted).toBe(true);
  const observed = value({ outcome: await reads["campaign.status.v1"]!({ context, connection, input: { vendorCampaignIds: ["201"] } }) });
  expect(capabilityCatalog["campaign.status.v1"].output.safeParse(observed).success).toBe(true); expect(observed.campaigns[0]).toMatchObject({ status: "active", rejectedChildAds: 1, currentBudget: { kind: "daily", amountMicros: "50000000", currency: "USD" } });
  expect(value({ outcome: await reads["tracking.tag.v1"]!({ context, connection, input: tagInput }) }).snippet).toContain("fixturePixel");
  expect(accesses).toBe(7);
  const boundTools = createTools(dependencies);
  const invocation = { context, connection, operationId: "instagram-read", moneyExposure: null, requiredLimit: null };
  const accounts = await boundTools.invoke({ ...invocation, name: "instagram_accounts", connection: { ...connection, accountId: null }, input: {} });
  expect(accounts).toMatchObject({ ok: true, value: { accounts: [{ pageId: "11", igUserId: "22" }] } });
  expect(fixture.urls.filter(url => new URL(url).pathname === "/v25.0/me/accounts")).toHaveLength(1);
  const status = await boundTools.invoke({ ...invocation, name: "instagram_post_status", input: { igUserId: "22", containerId: "33" } });
  expect(status).toMatchObject({ ok: true, value: { container: { status_code: "FINISHED" } } });
  expect(new URL(fixture.urls.at(-1)!).pathname).toBe("/v25.0/22/content_publishing_limit");
  expect(JSON.stringify([batch, accounts, status])).not.toContain("s3cret-fixture");
  const before = fixture.urls.length;
  error({ outcome: await boundTools.invoke({ ...invocation, name: "instagram_accounts", connection: { ...connection, connectionId: "foreign" }, input: {} }), code: "forbidden" });
  expect(fixture.urls).toHaveLength(before);
});
it("discovers accounts with a null-account binding but refuses account-bound tools before effects", async () => {
  const discoveryConnection = { connectionId: connection.connectionId, accountId: null };
  const discoveryConfiguration = pluginConnectionConfigurationSchema.parse({ scope: binding.scope, ...discoveryConnection, pluginDigest: configuration.pluginDigest, settings: {} });
  const fixture = harness({ real: true, respond: request => {
    expect(request.edge).toBe("/v25.0/me/accounts");
    return { data: [{ id: "11", name: "Page", instagram_business_account: { id: "22" } }] };
  } });
  let accesses = 0;
  const dependencies: PluginCapabilityDependencies<PluginConnectionConfiguration> = { configuration: discoveryConfiguration, fetch: fixture.fetch, clock: { now: () => now }, observer: { observe() {} }, wait: async () => ({ ok: true, value: undefined }),
    credentials: { async access(input) { accesses++; expect(input).toEqual(discoveryConnection); return { ok: true, value: { accessToken: "fixture" } }; } },
  };
  const boundTools = createTools(dependencies);
  const invocation = { context, connection: discoveryConnection, operationId: "instagram-discovery", moneyExposure: null, requiredLimit: null };
  expect(await boundTools.invoke({ ...invocation, name: "instagram_accounts", input: {} })).toMatchObject({ ok: true, value: { accounts: [{ pageId: "11", igUserId: "22" }] } });
  expect(accesses).toBe(1); expect(fixture.urls).toHaveLength(1);
  expect(new URL(fixture.urls[0]).pathname).toBe("/v25.0/me/accounts");
  error({ outcome: await boundTools.invoke({ ...invocation, name: "instagram_post_status", input: { igUserId: "22", containerId: "33" } }), code: "invalid_input" });
  expect(accesses).toBe(1); expect(fixture.urls).toHaveLength(1);
});
it("canonical factory rejects invalid configuration and wrong ownership before credentials", async () => {
  let effects = 0;
  const host = { clock: { now: () => now }, observer: { observe() {} }, wait: async (): Promise<Outcome<void>> => ({ ok: true, value: undefined }),
    credentials: { async access(): Promise<Outcome<{ accessToken: string }>> { effects++; throw new Error("must not access"); } }, fetch: (async () => { effects++; throw new Error("must not fetch"); }) as typeof fetch };
  for (const invalid of [null, {}, { binding: {} }, { ...configuration, authority: true }, { ...configuration, accountId: null }]) {
    const dependencies = { ...host, configuration }; Reflect.set(dependencies, "configuration", invalid);
    const reads = createCapabilities(dependencies);
    error({ outcome: await reads["report.metrics.v1"]({ context, connection, input: { grain: "account", days } }), code: "invalid_input" });
  }
  const reads = createCapabilities({ ...host, configuration });
  error({ outcome: await reads["report.metrics.v1"]({ context, connection: { ...connection, accountId: "999" }, input: { grain: "account", days } }), code: "forbidden" });
  error({ outcome: await reads["report.metrics.v1"]({ context, connection, input: { grain: "account", days } }, { signal: AbortSignal.abort() }), code: "cancelled" });
  expect(effects).toBe(0);
});

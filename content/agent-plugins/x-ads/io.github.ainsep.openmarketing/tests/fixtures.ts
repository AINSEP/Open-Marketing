import { describe, expect, it } from "vitest";
import { pluginConfigurationSchema } from "@open-marketing/contracts";
import type { PluginCapabilityDependencies, CallContext, CallOptions, EffectEnvelope, ObserverEvent, Outcome } from "@open-marketing/contracts";
import { invokeXAds } from "../src/index.js";
import type { XCommand, XConfiguration, XDependencies, XResult } from "../src/index.js";
import type { CampaignTranslationInput, XPausedPlan, XDeploymentReferences } from "../src/index.js";

/** Synthetic secrets and responses only; each fixture owns all mutable state. */
export const now = 1792800000000;
export const context: CallContext = { scope: { ownerId: "owner", workspaceId: "workspace" }, principal: { kind: "owner", ownerId: "owner" }, correlationId: "correlation", traceId: "trace", runId: "run" };
export const pasted = { consumerKey: "consumer", consumerSecret: "consumer-secret", accessToken: "token", accessTokenSecret: "token-secret" };
export const accountPage = { next_cursor: "next+/=", data: [{ id: "abc1", name: "Fixture account", timezone: "UTC", approval_status: "ACCEPTED", deleted: false, untrusted: "discard" }] };
export const campaignPage = { request: { params: { account_id: "abc1" } }, next_cursor: null, data: [{ id: "camp1", name: "Fixture campaign", entity_status: "PAUSED", currency: "USD", deleted: false }] };
export const report = { kind: "report" as const, entity: "CAMPAIGN" as const, entityIds: ["camp1"], window: { start: now, end: now + 3600000 }, placement: "ALL_ON_TWITTER" as const } satisfies XCommand;
export const accountReport = { ...report, entity: "ACCOUNT" as const, entityIds: ["abc1"] } satisfies XCommand;
/** ACCOUNT supports impressions, but not clicks or BILLING; omitted fields are deliberate. */
export function accountAnalyticsPage() { return { data_type: "stats", time_series_length: 1, data: [{ id: "abc1", id_data: [{ segment: null, metrics: { impressions: [321] } }] }], request: { params: { entity: "ACCOUNT", entity_ids: ["abc1"], start_time: new Date(now).toISOString(), end_time: new Date(now + 3600000).toISOString(), granularity: "TOTAL", placement: "ALL_ON_TWITTER", metric_groups: ["ENGAGEMENT"] } } }; }
export function analyticsPage() { return { data_type: "stats", time_series_length: 1, data: [{ id: "camp1", id_data: [{ segment: null, metrics: { impressions: [123], clicks: null, billed_charge_local_micro: [1234567] } }] }], request: { params: { entity: "CAMPAIGN", entity_ids: ["camp1"], start_time: new Date(now).toISOString(), end_time: new Date(now + 3600000).toISOString(), granularity: "TOTAL", placement: "ALL_ON_TWITTER", metric_groups: ["ENGAGEMENT", "BILLING"] } } }; }

/** Reusable acceptance seam: integrator implements this shape around the real host binding. */
export interface DispatchHarness {
  invoke(required?: { command?: XCommand; context?: CallContext }, optional?: CallOptions): Promise<Outcome<XResult>>;
  setAdmission(required: { admitted: boolean }): void;
  credentialHook?: () => void;
  calls: { url: string; init: RequestInit }[];
  credentialCalls: { connectionId: string; accountId: string }[];
  observations: ObserverEvent[];
}
/** Memory policy double around the real plugin HTTP adapter; no duplicate plugin implementation. */
export function fixture(required: { response?: () => Response | Promise<Response>; credential?: string; expiresAt?: number; gateway?: XDependencies["gateway"]; timeoutSignal?: XDependencies["timeoutSignal"] } = {}) {
  const calls: DispatchHarness["calls"] = [], credentialCalls: DispatchHarness["credentialCalls"] = [], observations: ObserverEvent[] = [], effects: EffectEnvelope[] = [];
  let admitted = true;
  const dependencies: XDependencies & { configuration: XConfiguration } = {
    configuration: { scope: context.scope, connectionId: "connection", accountId: "abc1", currency: "USD", pluginDigest: "a".repeat(64), bindingId: "binding", admitted: true },
    credentials: { async access(input) { credentialCalls.push(input); harness.credentialHook?.(); return { ok: true, value: { accessToken: required.credential ?? JSON.stringify(pasted), expiresAt: required.expiresAt } }; } },
    gateway: required.gateway ?? { async dispatch(input) { effects.push(input.effect); if (!admitted) return { ok: false, error: { code: "forbidden", message: "Fixture admission withdrawn", retryable: false } }; return input.execute(); } },
    fetch: async (url, init) => { if (!admitted) throw new Error("Host denied"); calls.push({ url: String(url), init: init ?? {} }); return required.response ? required.response() : Response.json(accountPage); },
    clock: { now: () => now }, timeoutSignal: required.timeoutSignal ?? (() => new AbortController().signal), ids: { next: () => "nonce" }, observer: { observe: event => observations.push(event) },
  };
  const harness: DispatchHarness = { calls, credentialCalls, observations,
    invoke: (input = {}, optional = {}) => invokeXAds({ context: input.context ?? context, operationId: "operation", command: input.command ?? { kind: "list_accounts" }, dependencies }, optional),
    setAdmission(input) { admitted = input.admitted; dependencies.configuration.admitted = input.admitted; },
  };
  return Object.assign(harness, { dependencies, effects });
}

/** ONE suite for fixture adapter and future host binding; host instantiation is an integrator NEEDS. */
export function dispatchSuite(required: { name: string; makeFixture: () => DispatchHarness }): void {
  describe(required.name, () => {
    it("returns one real projected GET and current pagination", async () => {
      const f = required.makeFixture(); const result = await f.invoke();
      expect(result).toMatchObject({ ok: true, value: { data: { cursor: "next+/=", items: [{ id: "abc1", name: "Fixture account" }] } } });
      expect(f.calls.map(call => [call.url, call.init.method])).toEqual([["https://ads-api.x.com/12/accounts?count=100", "GET"]]);
      expect(f.credentialCalls).toEqual([{ connectionId: "connection", accountId: "abc1" }]);
    });
    it("host denial prevents network after credential lookup", async () => {
      const f = required.makeFixture(); f.setAdmission({ admitted: false });
      expect(await f.invoke()).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(f.credentialCalls).toHaveLength(1); expect(f.calls).toEqual([]);
    });
    it("withdrawal during credential resolution prevents network", async () => {
      const f = required.makeFixture(); f.credentialHook = () => f.setAdmission({ admitted: false });
      expect(await f.invoke()).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(f.credentialCalls).toHaveLength(1); expect(f.calls).toEqual([]);
    });
    it("foreign scope and pre-cancelled calls prevent credential access", async () => {
      const f = required.makeFixture();
      expect(await f.invoke({ context: { ...context, scope: { ...context.scope, ownerId: "other" } } })).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(await f.invoke({}, { signal: AbortSignal.abort() })).toMatchObject({ ok: false, error: { code: "cancelled" } });
      expect(f.credentialCalls).toEqual([]); expect(f.calls).toEqual([]);
    });
  });
}

/** Independently specified traffic/account/post evidence; no credentials from a real account. */
export function translationInput(): CampaignTranslationInput {
  return { campaign: { name: "Fixture traffic", objective: "traffic", schedule: { window: { start: now + 3600000, end: now + 7200000 }, timezone: "UTC" }, audience: { countries: ["US"] }, creativeIds: ["creative"], creativeDigest: "b".repeat(64) },
    target: { accountId: "abc1", dailyBudget: { currency: "USD", minorUnits: 1234 } },
    resolved: { accountId: "abc1", currency: "USD", currencyExponent: 2, timezone: "UTC", fundingInstrumentId: "fund1", creativeId: "creative", creativeDigest: "b".repeat(64), tweetId: "1234567890123456789", eligible: true, country: "US", countryId: "country1", unitCost: { currency: "USD", minorUnits: 45 } } };
}
/** Explicit vendor plan/rows are independent fixtures, not generated from the encoder under test. */
export function pausedPlan(): XPausedPlan {
  return { accountId: "abc1", currency: "USD", campaign: { name: "Fixture traffic", funding_instrument_id: "fund1", entity_status: "PAUSED", budget_optimization: "LINE_ITEM", daily_budget_amount_local_micro: 12340000 },
    lineItem: { name: "Fixture traffic", campaign_id: { from: "campaign" }, entity_status: "PAUSED", objective: "WEBSITE_CLICKS", product_type: "PROMOTED_TWEETS", placements: "ALL_ON_TWITTER", bid_strategy: "MAX", goal: "LINK_CLICKS", bid_amount_local_micro: 450000, daily_budget_amount_local_micro: 12340000, standard_delivery: true, start_time: new Date(now + 3600000).toISOString(), end_time: new Date(now + 7200000).toISOString() },
    targeting: { line_item_id: { from: "lineItem" }, targeting_type: "LOCATION", operator_type: "EQ", targeting_value: "country1" }, promotedTweet: { line_item_id: { from: "lineItem" }, tweet_ids: "1234567890123456789" } };
}
export const deploymentRefs: XDeploymentReferences = { campaign: "camp1", lineItem: "line1", targeting: "target1", promotedTweet: "post1" };

/** Same signed HTTP adapter, with a durable checkpoint double and replaceable vendor responses. */
export function deploymentFixture(required: { response?: (input: { url: URL; method: string; data: Record<string, unknown> }) => Response | Promise<Response>; checkpointFault?: (input: { step: string; phase: string }) => boolean } = {}) {
  const f = fixture();
  const journal: { step: string; phase: string; references: XDeploymentReferences }[] = [];
  const dispatched = new Set<string>();
  const rows: Record<string, Record<string, unknown>> = {
    campaigns: { id: "camp1", deleted: false, name: "Fixture traffic", funding_instrument_id: "fund1", entity_status: "PAUSED", budget_optimization: "LINE_ITEM", daily_budget_amount_local_micro: 12340000, currency: "USD" },
    line_items: { id: "line1", deleted: false, name: "Fixture traffic", campaign_id: "camp1", entity_status: "PAUSED", objective: "WEBSITE_CLICKS", product_type: "PROMOTED_TWEETS", placements: ["ALL_ON_TWITTER"], bid_strategy: "MAX", goal: "LINK_CLICKS", bid_amount_local_micro: 450000, daily_budget_amount_local_micro: 12340000, standard_delivery: true, start_time: new Date(now + 3600000).toISOString().replace(".000Z", "Z"), end_time: new Date(now + 7200000).toISOString(), currency: "USD" },
    targeting_criteria: { id: "target1", deleted: false, line_item_id: "line1", targeting_type: "LOCATION", targeting_value: "country1" },
    promoted_tweets: { id: "post1", deleted: false, line_item_id: "line1", tweet_id: "1234567890123456789", entity_status: "ACTIVE" },
  };
  const dependencies = { ...f.dependencies, fetch: (async (url, init) => {
    f.calls.push({ url: String(url), init: init ?? {} });
    const parsed = new URL(String(url)), method = init?.method ?? "GET", resource = parsed.pathname.split("/")[4];
    const row = structuredClone(rows[resource]);
    const data = { request: { params: { account_id: "abc1" } }, data: method === "POST" && resource === "promoted_tweets" ? [row] : row };
    return required.response ? required.response({ url: parsed, method, data }) : Response.json(data);
  }) as typeof fetch };
  async function checkpoint(input: { step: string; phase: "dispatch" | "acknowledged"; references: XDeploymentReferences }): Promise<Outcome<void>> {
    journal.push(structuredClone(input));
    if (required.checkpointFault?.(input) || (input.phase === "dispatch" && dispatched.has(input.step))) return { ok: false, error: { code: "conflict", message: "fixture checkpoint denied", retryable: false } };
    if (input.phase === "dispatch") dispatched.add(input.step);
    return { ok: true, value: undefined };
  }
  return { ...f, journal, rows, checkpoint, plan: pausedPlan(), context, operationId: "deployment", dependencies };
}

/** Synthetic current-v12 catalog and two-day analytics; unsafe micros are literal JSON
 * numbers on the wire so precision tests exercise the real HTTP parser, not just strings.
 */
export function metricsFixture() {
  const page = (required: { data: unknown[] }) => ({ request: { params: { account_id: "abc1" } }, next_cursor: null, data: required.data });
  const state = {
    time: now,
    pages: {
      account: { request: { params: { account_id: "abc1" } }, data: { id: "abc1", timezone: "UTC", timezone_switch_at: "2020-01-01T00:00:00Z" } },
      campaigns: page({ data: [{ id: "camp1", currency: "USD", deleted: false, entity_status: "ACTIVE", servable: true, reasons_not_servable: [] }] }),
      line_items: page({ data: [{ id: "line1", campaign_id: "camp1" }] }),
      promoted_tweets: page({ data: [{ id: "post1", line_item_id: "line1" }] }),
    } as Record<string, unknown>,
    metrics: { impressions: [10, null], clicks: [0, 2], billed_charge_local_micro: ["9007199254740993", "0"] } as Record<string, unknown>,
    placementMetrics: {} as Record<string, Record<string, unknown>>,
    active: null as Record<string, unknown[]> | null,
    missingPlacement: "", duplicate: false, foreign: false, wrongEcho: false, dayCount: 2,
  };
  const f = fixture({ response: () => {
    const url = new URL(f.calls.at(-1)!.url), resource = url.pathname.split("/").at(-1)!;
    if (!url.pathname.includes("/stats/")) return Response.json(state.pages[resource === "abc1" ? "account" : resource]);
    if (resource === "active_entities") {
      const entity = url.searchParams.get("entity")!, resource = ({ CAMPAIGN: "campaigns", LINE_ITEM: "line_items", PROMOTED_TWEET: "promoted_tweets" } as Record<string, string>)[entity];
      const data = state.active?.[entity] ?? (state.pages[resource] as { data: { id: string }[] }).data.map(item => ({ entity_id: item.id, activity_start_time: url.searchParams.get("start_time"), activity_end_time: url.searchParams.get("end_time"), placements: ["ALL_ON_TWITTER", "SPOTLIGHT", "TREND"] }));
      return Response.json({ data, request: { params: { account_id: "abc1", entity, start_time: url.searchParams.get("start_time"), end_time: url.searchParams.get("end_time") } } });
    }
    const query = url.searchParams, entity = query.get("entity"), id = ({ ACCOUNT: "abc1", CAMPAIGN: "camp1", LINE_ITEM: "line1", PROMOTED_TWEET: "post1" } as Record<string, string>)[entity!];
    const record = { id: state.foreign ? "foreign" : id, id_data: [{ segment: null, metrics: state.placementMetrics[query.get("placement")!] ?? state.metrics }] };
    const data = state.missingPlacement === query.get("placement") ? [] : state.duplicate ? [record, record] : [record];
    const body = { data_type: "stats", time_series_length: state.dayCount, data, request: { params: { account_id: "abc1", entity, entity_ids: state.wrongEcho ? ["foreign"] : query.get("entity_ids")!.split(","), granularity: query.get("granularity"), placement: query.get("placement"), start_time: query.get("start_time"), end_time: query.get("end_time"), metric_groups: query.get("metric_groups")!.split(",") } } };
    return new Response(JSON.stringify(body).replace(/"(900719925474099[0-9](?:\.\d+)?)"/g, "$1"), { status: 200 });
  } });
  const dependencies = { ...f.dependencies, clock: { now: () => state.time } };
  return Object.assign(f, { dependencies, state });
}

/** Host-shaped effects with cancellable waits; no real timers or network. */
export function factoryFixture() {
  const f = metricsFixture();
  const waits: AbortSignal[] = [];
  const dependencies: PluginCapabilityDependencies = {
    ...f.dependencies,
    configuration: pluginConfigurationSchema.parse({ scope: context.scope, connectionId: "connection", accountId: "abc1", pluginDigest: "a".repeat(64), settings: { currency: "IGNORED" } }),
    wait: (_input, options) => new Promise(resolve => {
      const signal = options!.signal!; waits.push(signal);
      signal.addEventListener("abort", () => resolve({ ok: false, error: { code: "cancelled", message: "Wait cancelled", retryable: false } }), { once: true });
    }),
  };
  return Object.assign(f, { dependencies, waits });
}

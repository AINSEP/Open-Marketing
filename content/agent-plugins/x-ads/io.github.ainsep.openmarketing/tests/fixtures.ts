import { describe, expect, it } from "vitest";
import type { CallContext, CallOptions, EffectEnvelope, ObserverEvent, Outcome } from "@open-marketing/contracts";
import { invokeXAds } from "../src/index.js";
import type { XCommand, XDependencies, XResult } from "../src/index.js";

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
  const dependencies: XDependencies = {
    configuration: { scope: context.scope, connectionId: "connection", accountId: "abc1", currency: "USD", pluginDigest: "a".repeat(64), bindingId: "binding", admitted: true },
    credentials: { async access(input) { credentialCalls.push(input); harness.credentialHook?.(); return { ok: true, value: { accessToken: required.credential ?? JSON.stringify(pasted), expiresAt: required.expiresAt } }; } },
    gateway: required.gateway ?? { async dispatch(input) { effects.push(input.effect); if (!admitted) return { ok: false, error: { code: "forbidden", message: "Fixture admission withdrawn", retryable: false } }; return input.execute(); } },
    fetch: async (url, init) => { calls.push({ url: String(url), init: init ?? {} }); return required.response ? required.response() : Response.json(accountPage); },
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
    it("admission false prevents credentials and network", async () => {
      const f = required.makeFixture(); f.setAdmission({ admitted: false });
      expect(await f.invoke()).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(f.credentialCalls).toEqual([]); expect(f.calls).toEqual([]);
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

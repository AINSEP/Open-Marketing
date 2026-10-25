import type { CallContext, ObserverEvent } from "@open-marketing/contracts";
import { createLineAdsAdapter } from "../src/index.js";
import type { LineAdsConfiguration, LineAdsDependencies, LineAdsInvocation } from "../src/index.js";

/** Synthetic custody and HTTP fixtures; no real account or credential. */
export const context: CallContext = { scope: { ownerId: "owner", workspaceId: "workspace" }, principal: { kind: "owner", ownerId: "owner" }, correlationId: "correlation", traceId: "trace", runId: "run" };
export const now = 1792800000000;
export const bundle = { accessKey: "LINEADSAMPLE", secretKey: "LINEADSECRETKEYSAMPLE", groupId: "G1" };
export const campaignPage = { datas: [{ id: 456, name: "Fixture campaign", configuredStatus: "PAUSED" }], paging: { page: 1, size: 100, totalElements: 1 } };
export const accountPage = { datas: [{ id: 123, name: "Fixture account", currency: "JPY", timezone: "Asia/Tokyo", country: "JP" }], paging: campaignPage.paging };
export const report = { kind: "report" as const, since: "2026-10-20", until: "2026-10-21" };
export const reportPage = { datas: [{ adaccount: { id: 123 }, campaign: { id: 456 }, statistics: { currency: "JPY", cost: 12.75, imp: 345, click: 7 } }], paging: campaignPage.paging, timeRange: { since: report.since, until: report.until } };
export function invocation(required: { command?: LineAdsInvocation["command"] } = {}): LineAdsInvocation { return { context, operationId: "operation", command: required.command ?? { kind: "list_campaigns" } }; }
export interface Fixture {
  adapter: ReturnType<typeof createLineAdsAdapter>;
  dependencies: LineAdsDependencies;
  binding: { -readonly [K in keyof LineAdsConfiguration]: LineAdsConfiguration[K] };
  state: { admitted: boolean; time: number };
  calls: { url: string; init: RequestInit }[];
  credentialCalls: { connectionId: string; accountId: string | null }[];
  observations: ObserverEvent[];
}
/** Per-test live admission plus actual plugin decoding over synthetic Response streams.
 * The host integrator supplies the second fixture adapter to the SAME dispatch suite.
 */
export function fixture(required: { response?: () => Response | Promise<Response>; token?: unknown; credentialHook?: (input: Pick<Fixture, "state" | "binding">) => void; credentialThrows?: boolean; observerThrows?: boolean } = {}): Fixture {
  const state = { admitted: true, time: now };
  const binding: Fixture["binding"] = { scope: context.scope, connectionId: "connection", accountId: "123", country: "JP", currency: "JPY", timezone: "Asia/Tokyo" };
  const calls: Fixture["calls"] = [], credentialCalls: Fixture["credentialCalls"] = [], observations: ObserverEvent[] = [];
  const dependencies: LineAdsDependencies = {
    get admitted() { return state.admitted; }, configuration: binding,
    credentials: { async access(input) {
      credentialCalls.push(input); required.credentialHook?.({ state, binding });
      if (required.credentialThrows) throw new Error("secret must not escape");
      return { ok: true, value: { accessToken: (required.token ?? JSON.stringify(bundle)) as string } };
    } },
    fetch: async (url, init) => {
      if (!String(url).startsWith("https://ads.line.me/api/v3/") || init?.method !== "GET") throw new Error("Unexpected fixture request");
      calls.push({ url: String(url), init: init ?? {} });
      return required.response ? required.response() : Response.json(campaignPage);
    },
    clock: { now: () => state.time },
    createDeadline: () => new AbortController().signal,
    observer: { observe(event) { if (required.observerThrows) throw new Error("telemetry"); observations.push(event); } },
  };
  return { adapter: createLineAdsAdapter(dependencies), dependencies, binding, state, calls, credentialCalls, observations };
}

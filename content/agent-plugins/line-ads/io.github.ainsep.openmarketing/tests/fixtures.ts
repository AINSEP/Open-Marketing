import { pluginConfigurationSchema } from "@open-marketing/contracts";
import type { PluginCapabilityDependencies, CallContext, ObserverEvent, Outcome } from "@open-marketing/contracts";
import { isDeepStrictEqual } from "node:util";
import { createCapabilities, createLineAdsAdapter } from "../src/index.js";
import type { LineAdsConfiguration, LineAdsDependencies, LineAdsInvocation } from "../src/index.js";
import type { LineAdsPausedPlan } from "../src/index.js";

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
      if (!state.admitted) throw new Error("Host guarded fetch denied");
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

/** Independent documented-wire fixture, including local dates and exact micros, all synthetic. */
export const pausedPlan: LineAdsPausedPlan = {
  metadata: { accountId: "123", country: "TW", currency: "TWD", currencyExponent: 2, timezone: "Asia/Taipei", creativeId: "image", creativeDigest: "a".repeat(64), imageAccountId: "123" },
  campaign: { name: "Traffic", campaignObjective: "VISIT_MY_WEBSITE", configuredStatus: "PAUSED", spendingLimitType: "NONE", activeCbo: false, startDate: "2026-10-25T08:00:00+08:00", endDate: "2026-10-26T08:00:00+08:00" },
  adgroup: { name: "Traffic", campaignId: { from: "campaign" }, configuredStatus: "PAUSED", bidType: "CPC", autoBidType: "MANUAL", bidAmountMicro: 250000, dailyBudgetMicro: 123450000, targeting: { country: "TW", targetingMode: "MANUAL" } },
  ad: { name: "Traffic", adgroupId: { from: "adgroup" }, configuredStatus: "PAUSED", generatedByAi: false, creative: { creativeFormat: "IMAGE", title: "Fixture", description: "Synthetic image", imageHash: "synthetic-hash", callToAction: { landingPageUrl: "https://example.test/traffic" } } },
};
type JournalEntry = { step: string; phase: "dispatch" | "acknowledged"; references: Record<string, string | undefined> };
/** Validate fixed fixture routes, methods and redirect policy; record violations. O(1), no network. */
function deploymentResource(required: { address: string; method: string; redirect: RequestRedirect | undefined; ids: Record<string, number>; violations: string[] }): string {
  const { address, method, ids, violations } = required;
  const resource = address.includes("/groups/") ? "accounts" : address.split("/").at(-1)!.split("?")[0];
  const collection = "https://ads.line.me/api/v3/adaccounts/123/" + resource;
  const expectedUrl = resource === "accounts" ? "https://ads.line.me/api/v3/groups/G1/adaccounts?page=1&size=100" : collection + (method === "GET" ? "?ids=" + ids[resource] + "&page=1&size=1" : "");
  if (address !== expectedUrl || !["GET", "POST"].includes(method) || required.redirect !== "error") violations.push(address);
  return resource;
}
/** Strict finite HTTP double and the owning job's repeated-dispatch fence; never invokes fetch.
 * Response/checkpoint fault hooks exercise partial effects while retaining the same real transport.
 */
export function deploymentFixture(required: { response?: (input: { resource: string; method: string; row: Record<string, unknown> }) => Response | undefined;
  checkpoint?: (input: JournalEntry) => Outcome<void>; credentialHook?: NonNullable<Parameters<typeof fixture>[0]>["credentialHook"] } = {}) {
  const f = fixture({ credentialHook: required.credentialHook });
  Object.assign(f.binding, { country: "TW", currency: "TWD", timezone: "Asia/Taipei" });
  const journal: JournalEntry[] = [], dispatched = new Set<string>(), violations: string[] = [];
  // Independent synthetic response literals follow Management 3.12.0.1 definitions; never echo a POST.
  const readbacks: Record<string, Record<string, unknown>> = {
    accounts: { id: 123, name: "Fixture account", currency: "TWD", timezone: "Asia/Taipei", country: "TW" },
    campaigns: { id: 456, name: "Traffic", campaignObjective: "VISIT_MY_WEBSITE", configuredStatus: "PAUSED", spendingLimitType: "NONE", activeCbo: false,
      startDate: "2026-10-25T08:00:00+08:00", endDate: "2026-10-26T08:00:00+08:00", deliveryStatus: "PAUSED", createdDate: "2026-10-24T08:00:00+08:00" },
    adgroups: { id: 789, name: "Traffic", campaignId: 456, configuredStatus: "PAUSED", bidType: "CPC", autoBidType: "MANUAL", bidAmountMicro: 250000, dailyBudgetMicro: 123450000,
      targeting: { country: "TW", targetingMode: "MANUAL" }, deliveryStatus: "PAUSED", createdDate: "2026-10-24T08:00:00+08:00" },
    ads: { id: 987, name: "Traffic", adgroupId: 789, adaccountId: "123", configuredStatus: "PAUSED", generatedByAi: false, deliveryStatus: "PAUSED",
      creative: { id: 654, creativeFormat: "IMAGE", title: "Fixture", description: "Synthetic image", imageHash: "synthetic-hash", reviewStatus: "APPROVED",
        image: { id: 321, mediaType: "IMAGE", width: 1200, height: 628 }, callToAction: { landingPageUrl: "https://example.test/traffic", type: "SYNTHETIC_LABEL" } } },
  };
  const rows: Record<string, Record<string, unknown>> = { accounts: structuredClone(readbacks.accounts) };
  const expected: Record<string, unknown> = { campaigns: pausedPlan.campaign, adgroups: { ...pausedPlan.adgroup, campaignId: 456 }, ads: { ...pausedPlan.ad, adgroupId: 789 } };
  const ids: Record<string, number> = { campaigns: 456, adgroups: 789, ads: 987 };
  let awaitingRead: string | undefined;
  const dependencies: LineAdsDependencies = { ...f.dependencies, get admitted() { return f.state.admitted; }, fetch: async (url, init) => {
    const address = String(url), method = init?.method ?? "";
    f.calls.push({ url: address, init: init ?? {} });
    const resource = deploymentResource({ address, method, redirect: init?.redirect, ids, violations });
    if (method === "POST") {
      const dispatch = journal.at(-1);
      const valid = dispatch?.step + "s" === resource && dispatch?.phase === "dispatch" && isDeepStrictEqual(JSON.parse(String(init?.body)), expected[resource]);
      if (!valid) violations.push("dispatch/payload:" + resource);
      rows[resource] = structuredClone(readbacks[resource]);
      awaitingRead = resource;
    }
    if (method === "GET" && resource === awaitingRead && journal.at(-1)?.phase !== "acknowledged") violations.push("GET before ack checkpoint:" + resource);
    const overridden = required.response?.({ resource, method, row: rows[resource] });
    if (overridden) return overridden;
    if (method === "POST") return Response.json({ id: ids[resource] });
    const datas = rows[resource] ? [rows[resource]] : [], size = resource === "accounts" ? 100 : 1;
    return Response.json({ datas, paging: { page: 1, size, totalElements: datas.length } });
  } };
  const input = { context, operationId: "deployment", plan: structuredClone(pausedPlan), dependencies, checkpoint: async (entry: JournalEntry): Promise<Outcome<void>> => {
    journal.push(structuredClone(entry));
    const overridden = required.checkpoint?.(entry);
    if (overridden && !overridden.ok) return overridden;
    if (entry.phase === "dispatch" && dispatched.has(entry.step)) return { ok: false, error: { code: "conflict", message: "Already dispatched", retryable: false } };
    if (entry.phase === "dispatch") dispatched.add(entry.step);
    return { ok: true, value: undefined };
  } };
  return { ...f, dependencies, input, rows, journal, violations };
}

/** Independent status wire page, distinct from legacy campaign listing fixtures. */
export const statusPage = { datas: [
  { id: 456, configuredStatus: "ACTIVE", deliveryStatus: "NOT_APPROVED", deliveryStatusReasons: [{ code: "CREATIVE_REVIEW_NOT_APPROVED" }, { code: "CREATIVE_REVIEW_NOT_APPROVED" }] },
  { id: 457, configuredStatus: "REMOVED", deliveryStatus: "REMOVED" },
], paging: { page: 1, size: 100, totalElements: 2 } };

/** Canonical ABI over the same memory custody/HTTP seam. Expiry is manual; no timers/network. */
export function capabilityFixture(required: { response?: (input: { url: URL; requestIndex: number }) => Response | Promise<Response> } = {}) {
  const f = fixture();
  const waits: number[] = [];
  const dependencies: PluginCapabilityDependencies = { ...f.dependencies,
    configuration: pluginConfigurationSchema.parse({ scope: context.scope, connectionId: "connection", accountId: "123", pluginDigest: "a".repeat(64), settings: {} }),
    wait: async input => { waits.push(input.milliseconds); return { ok: true, value: undefined }; },
    fetch: async (url, init) => {
      f.calls.push({ url: String(url), init: init ?? {} });
      if (new URL(String(url)).pathname.includes("/groups/")) return Response.json({ ...accountPage, datas: [{ id: 123, country: f.binding.country, currency: f.binding.currency, timezone: f.binding.timezone }] });
      if (required.response) return required.response({ url: new URL(String(url)), requestIndex: f.calls.length });
      return Response.json(statusPage);
    },
  };
  return { ...f, dependencies, capabilities: createCapabilities(dependencies), waits };
}

import type { CallContext } from "@open-marketing/contracts";
import { createMemoryJournal } from "./memory.ts";
import { asRecord } from "./readback.ts";
import { failure, success } from "./schema.ts";
import { localDate } from "./rules.ts";
import type { AccountBinding, GooglePluginDependencies, GoogleTransportPort, VendorRequest } from "./types.ts";

/** Hand-written non-spending fixture, not evidence of any real Google account. */
export const fixtureTime = Date.parse("2026-10-12T12:00:00Z");
export const fixtureBinding: AccountBinding = {
  scope: { ownerId: "fixture-owner", workspaceId: "fixture-workspace" }, connectionId: "fixture-connection",
  customerId: "1234567890", currency: "USD", timezone: "America/Los_Angeles", mode: "sandbox",
  pluginDigest: "a".repeat(64), schemaFingerprint: "b".repeat(64),
};
export const fixtureContext: CallContext = { scope: fixtureBinding.scope, principal: { kind: "service", serviceId: "fixture-host" }, correlationId: "fixture-correlation", traceId: "fixture-trace" };
/** Fixture authority is ONLY for this local test account; never use it with real transport. */
export function createFixtureDependencies(required: { transport?: GoogleTransportPort } = {}): GooglePluginDependencies {
  return {
    binding: structuredClone(fixtureBinding), transport: required.transport ?? createFixtureTransport({}).transport,
    journal: createMemoryJournal({ maxRecords: 1000 }), clock: { now: () => fixtureTime },
    authority: {
      async dispatch(input) { return input.execute(); },
      async billing() { return success({ value: { evidenceId: "fixture-billing", observedAt: fixtureTime, localDate: localDate({ epoch: fixtureTime, timezone: fixtureBinding.timezone }), historyComplete: true, highestBudgetTodayMicros: "10000000", monthToDateBilledMicros: "0", remainingDaysIncludingToday: 20, productionVerified: false } }); },
    },
  };
}
/** Stateful vendor double emits real REST-shaped fixtures. Fault injection represents
 * ambiguous timeout after commit or partial creation, with no credentials/network.
 * @example createFixtureTransport({ fault: "timeout_after" }) */
export function createFixtureTransport(required: { fault?: "timeout_before" | "timeout_after" | "partial" } = {}): { transport: GoogleTransportPort; writes(): number } {
  const state = { campaign: {} as Record<string, unknown>, budget: {} as Record<string, unknown>, group: {} as Record<string, unknown>, ad: {} as Record<string, unknown>, keywords: [] as Record<string, unknown>[], locations: [] as Record<string, unknown>[] };
  let writes = 0;
  return {
    writes: () => writes,
    transport: { async request(input) {
      if (input.method === "search") return success({ value: fixtureSearch({ state, input }) });
      if (input.method !== "mutate") return failure({ code: "unavailable", message: "Use the dedicated Data Manager conversion fixtures" });
      writes += 1;
      if (required.fault === "timeout_before") return failure({ code: "unavailable", message: "Fixture timeout before commit" });
      const operations = input.body.mutateOperations as Record<string, unknown>[];
      operations.forEach(operation => applyOperation({ state, operation }));
      if (required.fault === "partial") state.ad = {};
      if (required.fault === "timeout_after") return failure({ code: "unavailable", message: "Fixture timeout after commit" });
      return success({ value: { mutateOperationResponses: operations.map(() => ({})) } });
    } },
  };
}
type FixtureState = { campaign: Record<string, unknown>; budget: Record<string, unknown>; group: Record<string, unknown>; ad: Record<string, unknown>; keywords: Record<string, unknown>[]; locations: Record<string, unknown>[] };
function applyOperation(required: { state: FixtureState; operation: Record<string, unknown> }): void {
  const [kind, value] = Object.entries(required.operation)[0];
  const operation = asRecord({ value });
  const create = asRecord({ value: operation.create });
  const update = asRecord({ value: operation.update });
  const { state } = required;
  switch (kind) {
    case "campaignBudgetOperation": state.budget = { ...state.budget, ...create, ...update, id: "101" }; break;
    case "campaignOperation": state.campaign = { ...state.campaign, ...create, ...update, id: "201" }; break;
    case "adGroupOperation": state.group = { ...state.group, ...create, ...update, id: "301" }; break;
    case "adGroupAdOperation": state.ad = { ...state.ad, ...create, ...update }; break;
    case "adGroupCriterionOperation": applyKeyword({ state, create, update }); break;
    case "campaignCriterionOperation": state.locations.push({ ...create, type: "LOCATION" }); break;
    default: break;
  }
}
function applyKeyword(required: { state: FixtureState; create: Record<string, unknown>; update: Record<string, unknown> }): void {
  if (Object.keys(required.create).length) { required.state.keywords.push({ ...required.create, type: "KEYWORD", criterionId: String(501 + required.state.keywords.length) }); return; }
  const id = String(required.update.resourceName).split("~").at(-1);
  required.state.keywords = required.state.keywords.map(keyword => keyword.criterionId === id ? { ...keyword, ...required.update } : keyword);
}
function fixtureSearch(required: { state: FixtureState; input: VendorRequest }): Record<string, unknown> {
  const query = String(required.input.body.query);
  const { state } = required;
  if (query.includes("metrics.cost_micros")) return { results: [{ segments: { date: "2026-10-11" }, metrics: { costMicros: "1234000", clicks: "4", impressions: "20" } }] };
  if (query.endsWith("FROM customer")) return { results: [{ customer: { id: fixtureBinding.customerId, currencyCode: "USD", timeZone: fixtureBinding.timezone, testAccount: true } }] };
  if (!state.campaign.id) return { results: [] };
  if (query.includes("FROM campaign WHERE")) return campaignRows({ state, query });
  if (query.includes("FROM ad_group WHERE")) return { results: [{ adGroup: state.group }] };
  if (query.includes("FROM ad_group_ad WHERE")) return adRows({ state });
  if (query.includes("FROM ad_group_criterion WHERE")) return { results: state.keywords.map(keyword => ({ adGroup: { id: "301" }, adGroupCriterion: { ...keyword, keyword: asRecord({ value: keyword.keyword }) } })) };
  if (query.includes("FROM campaign_criterion WHERE")) return { results: state.locations.map(location => ({ campaignCriterion: location })) };
  return { results: [] };
}
function campaignRows(required: { state: FixtureState; query: string }): Record<string, unknown> {
  const { state, query } = required;
  const match = query.match(/campaign\.name = '([^']+)'/);
  if (match && match[1] !== state.campaign.name) return { results: [] };
  const id = query.match(/campaign\.id = ([0-9]+)/);
  if (id && id[1] !== state.campaign.id) return { results: [] };
  return { results: [{ campaign: state.campaign, campaignBudget: state.budget }] };
}
function adRows(required: { state: FixtureState }): Record<string, unknown> {
  if (!required.state.ad.ad) return { results: [] };
  return { results: [{ adGroup: { id: "301" }, adGroupAd: { ...required.state.ad, ad: { ...asRecord({ value: required.state.ad.ad }), id: "401" } } }] };
}

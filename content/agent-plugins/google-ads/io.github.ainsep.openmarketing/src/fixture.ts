import type { CallContext } from "@open-marketing/contracts";
import { createMemoryJournal } from "./memory.ts";
import { asRecord } from "./readback.ts";
import { failure, success } from "./schema.ts";
import { localDate, objectiveGoal } from "./rules.ts";
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
export function createFixtureTransport(required: { fault?: "timeout_before" | "timeout_after" | "partial"; goals?: { category: string; origin: string }[] } = {}): { transport: GoogleTransportPort; writes(): number } {
  const state: FixtureState = { campaign: {}, budget: {}, group: {}, ads: [], keywords: [], locations: [],
    goals: required.goals ?? [{ category: "SUBMIT_LEAD_FORM", origin: "WEBSITE" }, { category: "PURCHASE", origin: "WEBSITE" }, { category: "PAGE_VIEW", origin: "WEBSITE" }],
    campaignGoals: [], goalConfigLevel: "CUSTOMER",
  };
  let writes = 0;
  return {
    writes: () => writes,
    transport: { async request(input) {
      if (input.method === "search") return success({ value: fixtureSearch({ state, input }) });
      if (input.method !== "mutate") return failure({ code: "unavailable", message: "Use the dedicated Data Manager conversion fixtures" });
      if (input.body.validateOnly === true) return success({ value: {} });
      writes += 1;
      if (required.fault === "timeout_before") return failure({ code: "unavailable", message: "Fixture timeout before commit" });
      const operations = input.body.mutateOperations as Record<string, unknown>[];
      operations.forEach(operation => applyOperation({ state, operation }));
      if (required.fault === "partial") state.ads = [];
      if (required.fault === "timeout_after") return failure({ code: "unavailable", message: "Fixture timeout after commit" });
      return success({ value: { mutateOperationResponses: operations.map(() => ({})) } });
    } },
  };
}
type FixtureState = { campaign: Record<string, unknown>; budget: Record<string, unknown>; group: Record<string, unknown>; ads: Record<string, unknown>[]; keywords: Record<string, unknown>[]; locations: Record<string, unknown>[];
  goals: { category: string; origin: string }[]; campaignGoals: { category: string; origin: string; biddable: boolean }[]; goalConfigLevel: string };
function applyOperation(required: { state: FixtureState; operation: Record<string, unknown> }): void {
  const [kind, value] = Object.entries(required.operation)[0];
  const operation = asRecord({ value });
  const create = asRecord({ value: operation.create });
  const update = asRecord({ value: operation.update });
  const { state } = required;
  switch (kind) {
    case "campaignBudgetOperation": state.budget = { ...state.budget, ...create, ...update, id: "101" }; break;
    case "campaignOperation": applyCampaign({ state, create, update }); break;
    case "adGroupOperation": state.group = { ...state.group, ...create, ...update, id: "301" }; break;
    case "adGroupAdOperation": {
      if (create.ad) { state.ads.push({ ...create, id: String(401 + state.ads.length) }); break; }
      const id = String(update.resourceName).split("~").at(-1);
      state.ads = state.ads.map(ad => ad.id === id ? { ...ad, ...update } : ad);
      break;
    }
    case "adGroupCriterionOperation": applyKeyword({ state, create, update }); break;
    case "campaignCriterionOperation": state.locations.push({ ...create, type: create.proximity ? "PROXIMITY" : "LOCATION" }); break;
    case "campaignConversionGoalOperation": {
      const [, category, origin] = String(update.resourceName).split("~");
      state.campaignGoals = state.campaignGoals.map(goal => goal.category === category && goal.origin === origin ? { ...goal, biddable: update.biddable === true } : goal);
      state.goalConfigLevel = "CAMPAIGN";
      break;
    }
    default: break;
  }
}
/** Mirror Google's initial goal defaults and selected standard strategy on fixture creation. O(g), g<=200. */
function applyCampaign(required: { state: FixtureState; create: Record<string, unknown>; update: Record<string, unknown> }): void {
  const { state, create, update } = required;
  state.campaign = { ...state.campaign, ...create, ...update, id: "201" };
  if (!create.resourceName) return;
  state.campaign.biddingStrategyType = Object.values(objectiveGoal).find(goal => Object.hasOwn(create, goal.field))?.strategy ?? "MANUAL_CPC";
  state.campaignGoals = state.goals.map(goal => ({ ...goal, biddable: true }));
  state.goalConfigLevel = "CUSTOMER";
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
  const goals = fixtureGoalRows({ state, query });
  if (goals) return goals;
  if (!state.campaign.id) return { results: [] };
  if (query.includes("FROM campaign WHERE")) return campaignRows({ state, query });
  if (query.includes("FROM ad_group WHERE")) return { results: [{ adGroup: state.group }] };
  if (query.includes("FROM ad_group_ad WHERE")) return adRows({ state });
  if (query.includes("FROM ad_group_criterion WHERE")) return { results: state.keywords.map(keyword => ({ adGroup: { id: "301" }, adGroupCriterion: { ...keyword, keyword: asRecord({ value: keyword.keyword }) } })) };
  if (query.includes("FROM campaign_criterion WHERE")) return { results: state.locations.map(location => ({ campaignCriterion: location })) };
  return { results: [] };
}
/** Goal query fixtures share creation's state; account goals exist before any campaign. O(g). */
function fixtureGoalRows(required: { state: FixtureState; query: string }): Record<string, unknown> | undefined {
  const { state, query } = required;
  if (query.includes("FROM customer_conversion_goal")) return { results: state.goals.map(goal => ({ customerConversionGoal: goal })) };
  if (!state.campaign.id) return undefined;
  if (query.includes("FROM campaign_conversion_goal WHERE")) return { results: state.campaignGoals.map(goal => ({ campaignConversionGoal: goal })) };
  if (query.includes("FROM conversion_goal_campaign_config WHERE")) return { results: [{ conversionGoalCampaignConfig: { goalConfigLevel: state.goalConfigLevel } }] };
  return undefined;
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
  return { results: required.state.ads.map(ad => ({ adGroup: { id: "301" }, adGroupAd: { ...ad, ad: { ...asRecord({ value: ad.ad }), id: ad.id } } })) };
}

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createCapabilities, createGooglePlugin, deployCampaignPaused, readCampaignDeployment } from "../src/index.ts";
import { campaignDeploymentReceiptSchema, campaignValidateOutputSchema, pluginConfigurationSchema } from "@open-marketing/contracts";
import type { CampaignDeploymentReceipt } from "@open-marketing/contracts";
import { createFixtureDependencies, createFixtureTransport, fixtureContext } from "../src/fixture.ts";
import { createMemoryJournal } from "../src/memory.ts";
import { failure, success } from "../src/schema.ts";
import { asRecord, planDigest } from "../src/readback.ts";
import { hostedDeploymentFixture, plan, value } from "./helpers.ts";
import type { Receipt, SearchPlan } from "../src/index.ts";
import type { VendorRequest } from "../src/types.ts";

const proximity = { latitudeMicroDegrees: -33865143, longitudeMicroDegrees: 151209901, radiusKm: 5.25 };
const references = ["campaignBudgets/101", "campaigns/201", "adGroups/301", "campaignCriteria/201~2840", "adGroupCriteria/301~501", "adGroupAds/301~401"].map(path => "customers/1234567890/" + path);
const multiAdPlan: SearchPlan = { ...plan, additionalAds: [
  { headlines: ["Compare Search Plans", "Choose Your Campaign", "Find Clear Insights"],
    descriptions: ["Compare your next Search campaign.", "Choose a destination for each ad."], finalUrl: "https://example.test/second" },
  { headlines: ["Explore Your Options", "Build Better Campaigns", "Keep Spend In View"],
    descriptions: ["Explore another campaign approach.", "Review your next campaign step."], finalUrl: "https://example.test/third" },
] };

test("hosted three-ad deploy sends one atomic PAUSED batch and acknowledges every ad", async () => {
  const f = hostedDeploymentFixture(); f.required.plan = multiAdPlan;
  const receipt = value<CampaignDeploymentReceipt & Receipt>({ outcome: await deployCampaignPaused(f.required) });
  assert.equal(receipt.status, "acknowledged"); assert.equal(receipt.state, "paused");
  assert.equal(campaignDeploymentReceiptSchema.safeParse(receipt).success, true);
  const mutations = f.calls.filter(call => call.method === "mutate");
  assert.equal(mutations.length, 1); assert.equal(f.writes(), 1);
  assert.equal(mutations[0].body.partialFailure, false); assert.equal(mutations[0].body.validateOnly, false);
  const operations = mutations[0].body.mutateOperations as Record<string, unknown>[];
  const ads = operations.filter(operation => "adGroupAdOperation" in operation).map(operation => asRecord({ value: asRecord({ value: operation.adGroupAdOperation }).create }));
  assert.equal(ads.length, 3);
  assert.deepEqual(ads.map(ad => ad.status), ["PAUSED", "PAUSED", "PAUSED"]);
  assert.deepEqual(ads.map(ad => ad.adGroup), Array(3).fill("customers/1234567890/adGroups/-3"));
  assert.deepEqual(ads.map(ad => asRecord({ value: ad.ad }).finalUrls), [plan, ...multiAdPlan.additionalAds!].map(ad => [ad.finalUrl]));
  assert.deepEqual(ads.map(ad => asRecord({ value: asRecord({ value: ad.ad }).responsiveSearchAd }).headlines),
    [plan, ...multiAdPlan.additionalAds!].map(ad => ad.headlines.map(text => ({ text }))));
  assert.deepEqual(receipt.hierarchy?.childIds.filter(id => id.startsWith("ad:")), ["ad:301~401", "ad:301~402", "ad:301~403"]);
  assert.deepEqual(receipt.hierarchy?.childStatuses, Array(5).fill("PAUSED"));
  assert.deepEqual(receipt.entityIds, [...references, "customers/1234567890/adGroupAds/301~402", "customers/1234567890/adGroupAds/301~403"]);
});

test("hosted leads deploy acknowledges multiple ads with the existing conversion goals", async () => {
  const f = hostedDeploymentFixture(); f.required.plan = { ...optimizedPlan({ objective: "leads" }), additionalAds: [multiAdPlan.additionalAds![0]] };
  const receipt = value<CampaignDeploymentReceipt & Receipt>({ outcome: await deployCampaignPaused(f.required) });
  assert.equal(receipt.status, "acknowledged"); assert.equal(f.writes(), 1);
  assert.deepEqual(receipt.hierarchy?.childIds.filter(id => id.startsWith("ad:")), ["ad:301~401", "ad:301~402"]);
  const operations = f.calls.find(call => call.method === "mutate")!.body.mutateOperations as Record<string, unknown>[];
  assert.equal(operations.filter(operation => "adGroupAdOperation" in operation).length, 2);
  assert.equal(operations.filter(operation => "campaignConversionGoalOperation" in operation).length, 3);
});

test("reversed multi-ad readback still acknowledges the same copy/URL records", async () => {
  const f = hostedDeploymentFixture(); f.required.plan = multiAdPlan;
  const fetch = f.required.dependencies.fetch;
  f.required.dependencies = { ...f.required.dependencies, fetch: async (url, init) => {
    const response = await fetch(url, init);
    if (!String(JSON.parse(String(init?.body)).query).includes("FROM ad_group_ad WHERE")) return response;
    const body = await response.json(); body.results.reverse();
    return Response.json(body);
  } };
  const receipt = value<Receipt>({ outcome: await deployCampaignPaused(f.required) });
  assert.equal(receipt.status, "acknowledged"); assert.equal(f.writes(), 1);
  assert.deepEqual(receipt.hierarchy?.childIds.filter(id => id.startsWith("ad:")), ["ad:301~403", "ad:301~402", "ad:301~401"]);
  assert.equal(receipt.hierarchy?.planDigest, planDigest({ plan: { ...multiAdPlan, name: receipt.hierarchy!.name } }));
});

test("one later-ad URL drift conflicts at activation without another write", async () => {
  const fixture = createFixtureTransport({}); let changed = false;
  const dependencies = createFixtureDependencies({ transport: { async request(input) {
    const result = await fixture.transport.request(input);
    if (!changed || !result.ok || !String(input.body.query).includes("FROM ad_group_ad WHERE")) return result;
    const body = structuredClone(result.value) as DriftBody;
    asRecord({ value: asRecord({ value: body.results[1].adGroupAd }).ad }).finalUrls = ["https://example.test/changed"];
    return success({ value: body });
  } } });
  const plugin = createGooglePlugin(dependencies);
  const receipt = value<Receipt>({ outcome: await plugin.invoke({ context: fixtureContext, name: "create_paused", arguments: { operationId: "multi-drift", plan: multiAdPlan } }) });
  assert.equal(receipt.status, "acknowledged"); changed = true;
  const result = await plugin.invoke({ context: fixtureContext, name: "activate", arguments: { operationId: "multi-drift-activate", campaignId: "201" } });
  assert.equal(result.ok, false); if (result.ok) throw new Error("Expected plan conflict");
  assert.equal(result.error.code, "conflict"); assert.equal(result.error.message, "Remote plan changed; exact review is required");
  assert.equal(fixture.writes(), 1);
});

test("activate and pause update and confirm every multi-ad child", async () => {
  const fixture = createFixtureTransport({}); const calls: VendorRequest[] = [];
  const plugin = createGooglePlugin(createFixtureDependencies({ transport: { async request(input) {
    calls.push(structuredClone(input)); return fixture.transport.request(input);
  } } }));
  const created = value<Receipt>({ outcome: await plugin.invoke({ context: fixtureContext, name: "create_paused", arguments: { operationId: "multi-status", plan: multiAdPlan } }) });
  assert.equal(created.status, "acknowledged");
  for (const [name, status] of [["activate", "ENABLED"], ["pause", "PAUSED"]] as const) {
    calls.length = 0;
    const receipt = value<Receipt>({ outcome: await plugin.invoke({ context: fixtureContext, name, arguments: { operationId: "multi-" + name, campaignId: "201" } }) });
    assert.equal(receipt.status, "acknowledged"); assert.equal(receipt.hierarchy?.status, status);
    assert.deepEqual(receipt.hierarchy?.childStatuses, Array(5).fill(status));
    const mutations = calls.filter(call => call.method === "mutate"); assert.equal(mutations.length, 1);
    const operations = mutations[0].body.mutateOperations as Record<string, unknown>[];
    assert.deepEqual(operations.filter(operation => "adGroupAdOperation" in operation), ["401", "402", "403"].map(id => ({
      adGroupAdOperation: { update: { resourceName: "customers/1234567890/adGroupAds/301~" + id, status }, updateMask: "status" },
    })));
  }
  assert.equal(fixture.writes(), 3);
});

test("mutation references append before failed readback; reconcile and restart never replay creation", async () => {
  const fixture = createFixtureTransport({}); const journal = createMemoryJournal({ maxRecords: 100 }); let mutated = false; let failRead = true;
  const dependencies = createFixtureDependencies({ transport: { async request(input) {
    if (mutated && input.method === "search" && failRead) { assert.deepEqual(journal.records()[0].receipt.references, references); return failure({ code: "unavailable", message: "fixture read failure" }); }
    const response = await fixture.transport.request(input);
    if (input.method !== "mutate") return response;
    assert.equal(input.body.partialFailure, false); mutated = true;
    return success({ value: { mutateOperationResponses: references.map((resourceName, index) => ({ [["campaignBudgetResult", "campaignResult", "adGroupResult", "campaignCriterionResult", "adGroupCriterionResult", "adGroupAdResult"][index]]: { resourceName } })) } });
  } } }); dependencies.journal = journal;
  const request = { context: fixtureContext, name: "create_paused", arguments: { operationId: "launch", plan } };
  const first = value<Receipt>({ outcome: await createGooglePlugin(dependencies).invoke(request) }); assert.equal(first.status, "unknown"); assert.deepEqual(first.references, references);
  await createGooglePlugin(dependencies).invoke(request); assert.equal(fixture.writes(), 1); failRead = false;
  const reconciled = value<Receipt>({ outcome: await createGooglePlugin(dependencies).invoke({ context: fixtureContext, name: "reconcile", arguments: { operationId: "launch" } }) });
  assert.equal(reconciled.status, "acknowledged"); assert.deepEqual(reconciled.references, references); assert.equal(fixture.writes(), 1);
});
for (const checkpoint of ["failure", "throw", "final-throw"] as const) {
test(`${checkpoint} acknowledgement checkpoint preserves references and stops execution`, async () => {
  const fixture = createFixtureTransport({}); const journal = createMemoryJournal({ maxRecords: 100 }); let mutated = false; let readsAfter = 0;
  let appends = 0;
  const dependencies = createFixtureDependencies({ transport: { async request(input) {
    if (mutated && input.method === "search") readsAfter++;
    const response = await fixture.transport.request(input); if (input.method !== "mutate") return response; mutated = true;
    return success({ value: { mutateOperationResponses: references.map((resourceName, index) => ({ [["campaignBudgetResult", "campaignResult", "adGroupResult", "campaignCriterionResult", "adGroupCriterionResult", "adGroupAdResult"][index]]: { resourceName } })) } });
  } } }); dependencies.journal = { ...journal, async append(input) {
    appends++;
    if (checkpoint === "final-throw" && appends === 1) return journal.append(input);
    if (checkpoint !== "failure") throw new Error("opaque journal failure");
    return failure({ code: "unavailable", message: "fixture journal failure" });
  } };
  const receipt = value<Receipt>({ outcome: await createGooglePlugin(dependencies).invoke({ context: fixtureContext, name: "create_paused", arguments: { operationId: "launch", plan } }) });
  assert.equal(receipt.status, "unknown"); assert.deepEqual(receipt.references, references); assert.equal(fixture.writes(), 1);
  assert.equal(readsAfter > 0, checkpoint === "final-throw"); assert.equal(appends, checkpoint === "final-throw" ? 2 : 1);
  assert.ok(!JSON.stringify(receipt).includes("opaque journal failure"));
  await createGooglePlugin(dependencies).invoke({ context: fixtureContext, name: "create_paused", arguments: { operationId: "launch", plan } });
  assert.equal(fixture.writes(), 1);
});
}
test("malformed ACK preserves only valid scoped references and cannot claim completion", async () => {
  const fixture = createFixtureTransport({});
  const dependencies = createFixtureDependencies({ transport: { async request(input) {
    if (input.method === "search") return fixture.transport.request(input);
    return success({ value: { mutateOperationResponses: [{ campaignResult: { resourceName: references[1] } }, { campaignResult: { resourceName: "customers/9999999999/campaigns/9" } }, { campaignResult: { resourceName: "not-a-resource" } }] } });
  } } });
  const result = value<Receipt>({ outcome: await createGooglePlugin(dependencies).invoke({ context: fixtureContext, name: "create_paused", arguments: { operationId: "bad-ack", plan } }) });
  assert.equal(result.status, "unknown"); assert.deepEqual(result.references, [references[1]]);
});

test("hosted deploy retains references after observation checkpoint failure and reconciles without mutate", async () => {
  const f = hostedDeploymentFixture(); f.state.failObservation = true;
  const receipt = value<CampaignDeploymentReceipt>({ outcome: await deployCampaignPaused(f.required) });
  assert.equal(receipt.status, "unknown"); assert.equal(receipt.state, "paused");
  assert.deepEqual(receipt.entityIds, references); assert.equal(campaignDeploymentReceiptSchema.safeParse(receipt).success, true);
  assert.equal(f.writes(), 1); assert.deepEqual(f.checkpoints.map(item => item.phase), ["dispatch", "observation"]);
  assert.notEqual(f.required.saved.record, null);
  f.state.failObservation = false; f.calls.length = 0;
  const reconciled = value<CampaignDeploymentReceipt>({ outcome: await readCampaignDeployment({ ...f.required, saved: { ...f.required.saved } }) });
  assert.equal(reconciled.status, "acknowledged"); assert.equal(reconciled.state, "paused");
  assert.ok(f.calls.length > 0); assert.equal(f.calls.some(call => call.method === "mutate"), false); assert.equal(f.writes(), 1);
});

test("hosted deploy with a saved claim never sends another mutate or checkpoint", async () => {
  const f = hostedDeploymentFixture();
  const first = value<CampaignDeploymentReceipt>({ outcome: await deployCampaignPaused(f.required) });
  assert.equal(first.status, "acknowledged"); assert.equal(f.writes(), 1);
  const checkpointCount = f.checkpoints.length; f.calls.length = 0;
  const repeated = value<CampaignDeploymentReceipt>({ outcome: await deployCampaignPaused({ ...f.required, saved: { ...f.required.saved } }) });
  assert.equal(repeated.status, "acknowledged"); assert.deepEqual(repeated.entityIds, references);
  assert.equal(f.calls.some(call => call.method === "mutate"), false); assert.equal(f.writes(), 1);
  assert.equal(f.checkpoints.length, checkpointCount);
});

test("hosted proximity deployment acknowledges complete readback and ignores Google's address label", async () => {
  const f = hostedDeploymentFixture(); f.required.plan = { ...plan, geoTargetIds: [], proximity };
  const fetch = f.required.dependencies.fetch!;
  f.required.dependencies = { ...f.required.dependencies, fetch: async (url, init) => {
    const response = await fetch(url, init);
    const query = JSON.parse(String(init?.body)).query;
    if (!String(query).includes("FROM campaign_criterion WHERE")) return response;
    assert.match(query, /campaign_criterion.proximity.geo_point.latitude_in_micro_degrees/);
    assert.match(query, /campaign_criterion.proximity.geo_point.longitude_in_micro_degrees/);
    assert.match(query, /campaign_criterion.proximity.radius_units/);
    const body = await response.json();
    body.results[0].campaignCriterion.proximity.address = { cityName: "Descriptive only" };
    return Response.json(body);
  } };
  const receipt = value<CampaignDeploymentReceipt>({ outcome: await deployCampaignPaused(f.required) });
  assert.equal(receipt.status, "acknowledged"); assert.equal(receipt.state, "paused");
  assert.equal(campaignDeploymentReceiptSchema.safeParse(receipt).success, true);
  assert.equal(f.writes(), 1);
});

test("all 200 postal criteria acknowledge even when Google returns them in reverse order", async () => {
  const fixture = createFixtureTransport({});
  const dependencies = createFixtureDependencies({ transport: { async request(input) {
    const result = await fixture.transport.request(input);
    if (!result.ok || !String(input.body.query).includes("FROM campaign_criterion WHERE")) return result;
    const body = structuredClone(result.value) as { results: unknown[] };
    body.results.reverse();
    return success({ value: body });
  } } });
  const postalPlan = { ...plan, geoTargetIds: Array.from({ length: 200 }, (_, index) => String(1000 + index)) };
  const receipt = value<Receipt>({ outcome: await createGooglePlugin(dependencies).invoke({ context: fixtureContext,
    name: "create_paused", arguments: { operationId: "postal", plan: postalPlan },
  }) });
  assert.equal(receipt.status, "acknowledged"); assert.equal(fixture.writes(), 1);
});

for (const drift of ["radius", "country", "miles", "duplicate", "malformed"] as const) {
test(`proximity readback with ${drift} drift cannot acknowledge the deployment`, async () => {
  const f = hostedDeploymentFixture(); f.required.plan = { ...plan, geoTargetIds: [], proximity };
  const fetch = f.required.dependencies.fetch!;
  f.required.dependencies = { ...f.required.dependencies, fetch: async (url, init) => {
    const response = await fetch(url, init);
    if (!String(JSON.parse(String(init?.body)).query).includes("FROM campaign_criterion WHERE")) return response;
    const body = await response.json();
    const criterion = body.results[0].campaignCriterion;
    if (drift === "radius") criterion.proximity.radius = 6.25;
    if (drift === "country") body.results.push({ campaignCriterion: { type: "LOCATION", negative: false, location: { geoTargetConstant: "geoTargetConstants/2840" } } });
    if (drift === "miles") criterion.proximity.radiusUnits = "MILES";
    if (drift === "duplicate") body.results.push(structuredClone(body.results[0]));
    if (drift === "malformed") criterion.proximity.radius = "5.25";
    return Response.json(body);
  } };
  const receipt = value<CampaignDeploymentReceipt>({ outcome: await deployCampaignPaused(f.required) });
  assert.equal(receipt.status, "unknown"); assert.equal(f.writes(), 1);
});
}

test("legacy create_paused rejects empty, mixed or invalid proximity geography before I/O", async () => {
  const fixture = createFixtureTransport({}); let requests = 0;
  const dependencies = createFixtureDependencies({ transport: { async request(input) {
    requests++; return fixture.transport.request(input);
  } } });
  const invalid = [
    { ...plan, geoTargetIds: [] }, { ...plan, proximity },
    ...[0, -1, 20041, NaN, Infinity, "5.25"].map(radiusKm => ({ ...plan, geoTargetIds: [], proximity: { ...proximity, radiusKm } })),
  ];
  for (const [index, candidate] of invalid.entries()) {
    const result = await createGooglePlugin(dependencies).invoke({ context: fixtureContext, name: "create_paused", arguments: { operationId: "invalid-geo-" + index, plan: candidate } });
    assert.equal(result.ok, false); if (result.ok) throw new Error("Expected geography refusal");
    assert.equal(result.error.code, "invalid_input");
  }
  assert.equal(requests, 0); assert.equal(fixture.writes(), 0);
});

/** Keep optimized fixtures free of CPC, matching the translator's exact plan shape. */
function optimizedPlan(required: { objective: "leads" | "sales" }): SearchPlan {
  const candidate = structuredClone(plan);
  delete candidate.cpcBidMicros;
  return { ...candidate, objective: required.objective };
}

test("legacy create_paused rejects objective plus CPC or traffic without CPC before I/O", async () => {
  const fixture = createFixtureTransport({}); let reads = 0;
  const dependencies = createFixtureDependencies({ transport: { async request(input) {
    reads++; return fixture.transport.request(input);
  } } });
  const traffic = structuredClone(plan); delete traffic.cpcBidMicros;
  for (const [index, candidate] of [{ ...plan, objective: "leads" }, { ...plan, objective: "sales" }, traffic].entries()) {
    const result = await createGooglePlugin(dependencies).invoke({ context: fixtureContext, name: "create_paused", arguments: { operationId: "invalid-bidding-" + index, plan: candidate } });
    assert.equal(result.ok, false); if (result.ok) throw new Error("Expected bidding refusal");
    assert.equal(result.error.code, "invalid_input");
  }
  assert.equal(reads, 0); assert.equal(fixture.writes(), 0);
});

for (const [objective, field, category] of [["leads", "maximizeConversions", "SUBMIT_LEAD_FORM"], ["sales", "maximizeConversionValue", "PURCHASE"]] as const) {
test(`${objective} deployment selects standard bidding and explicitly sets every observed goal`, async () => {
  const fixture = createFixtureTransport({}); const calls: VendorRequest[] = [];
  const dependencies = createFixtureDependencies({ transport: { async request(input) {
    calls.push(structuredClone(input)); return fixture.transport.request(input);
  } } });
  const optimized = optimizedPlan({ objective });
  const receipt = value<Receipt>({ outcome: await createGooglePlugin(dependencies).invoke({ context: fixtureContext, name: "create_paused", arguments: { operationId: objective, plan: optimized } }) });
  assert.equal(receipt.status, "acknowledged"); assert.equal(fixture.writes(), 1);
  assert.equal(receipt.hierarchy?.planDigest, planDigest({ plan: { ...optimized, name: receipt.hierarchy!.name } }));
  const body = calls.find(call => call.method === "mutate")!.body;
  assert.equal(body.partialFailure, false); assert.equal(body.validateOnly, false);
  const operations = body.mutateOperations as Record<string, unknown>[];
  const campaign = asRecord({ value: asRecord({ value: operations[1].campaignOperation }).create });
  assert.deepEqual(campaign[field], {}); assert.equal(Object.hasOwn(campaign, "manualCpc"), false);
  const group = asRecord({ value: asRecord({ value: operations[2].adGroupOperation }).create });
  assert.equal(Object.hasOwn(group, "cpcBidMicros"), false);
  assert.deepEqual(operations.slice(-3), ["SUBMIT_LEAD_FORM", "PURCHASE", "PAGE_VIEW"].map(observed => ({ campaignConversionGoalOperation: {
    update: { resourceName: `customers/1234567890/campaignConversionGoals/-2~${observed}~WEBSITE`, biddable: observed === category }, updateMask: "biddable",
  } })));
  const queries = calls.filter(call => call.method === "search").map(call => String(call.body.query));
  assert.equal(queries.filter(query => query.includes("FROM customer_conversion_goal")).length, 1);
  assert.ok(queries.includes("SELECT campaign_conversion_goal.category, campaign_conversion_goal.origin, campaign_conversion_goal.biddable FROM campaign_conversion_goal WHERE campaign_conversion_goal.campaign = 'customers/1234567890/campaigns/201'"));
  assert.ok(queries.includes("SELECT conversion_goal_campaign_config.goal_config_level, conversion_goal_campaign_config.custom_conversion_goal FROM conversion_goal_campaign_config WHERE conversion_goal_campaign_config.campaign = 'customers/1234567890/campaigns/201'"));
  assert.match(queries.find(query => query.includes("FROM campaign WHERE"))!, /campaign.bidding_strategy_type, campaign.bidding_strategy, campaign.maximize_conversions.target_cpa_micros, campaign.maximize_conversion_value.target_roas/);
});
}

test("traffic preserves its digest and makes no conversion-goal reads or writes", async () => {
  const fixture = createFixtureTransport({ goals: [] }); const calls: VendorRequest[] = [];
  const dependencies = createFixtureDependencies({ transport: { async request(input) {
    calls.push(structuredClone(input)); return fixture.transport.request(input);
  } } });
  const receipt = value<Receipt>({ outcome: await createGooglePlugin(dependencies).invoke({ context: fixtureContext, name: "create_paused", arguments: { operationId: "traffic", plan } }) });
  assert.equal(receipt.status, "acknowledged");
  // Goldens transcribed from the pre-B1 singleton digest expression and six-operation body.
  assert.equal(planDigest({ plan }), "8b8401300e947fdae872e6183037d013e7d63e52d09e9f3f8756968c2ae5db2b");
  assert.equal(receipt.hierarchy?.planDigest, "0ae96efebc3012b79719c0a0598c993b6a3d0094b489fc4c62465032292303d3");
  const body = calls.find(call => call.method === "mutate")!.body;
  assert.equal(createHash("sha256").update(JSON.stringify(body)).digest("hex"), "7ad03987cb7156b0da89d22ad638f24fc9f27f7b3cffcaadddc9a6852e48b227");
  assert.equal(receipt.hierarchy?.planDigest, planDigest({ plan: { ...plan, name: receipt.hierarchy!.name } }));
  assert.equal(calls.filter(call => call.method === "search").length, 7);
  assert.equal(JSON.stringify(calls).includes("conversion_goal"), false);
  const operations = calls.find(call => call.method === "mutate")!.body.mutateOperations as Record<string, unknown>[];
  assert.equal(operations.length, 6);
  assert.deepEqual(asRecord({ value: asRecord({ value: operations[1].campaignOperation }).create }).manualCpc, {});
  assert.equal(asRecord({ value: asRecord({ value: operations[2].adGroupOperation }).create }).cpcBidMicros, plan.cpcBidMicros);
});

for (const evidence of ["missing", "truncated", "malformed", "duplicate", "over-limit"] as const) {
test(`${evidence} account conversion goals refuse before mutation`, async () => {
  const fixture = createFixtureTransport({ goals: [{ category: "PURCHASE", origin: "WEBSITE" }] });
  const dependencies = createFixtureDependencies({ transport: { async request(input) {
    if (!String(input.body.query).includes("FROM customer_conversion_goal")) return fixture.transport.request(input);
    const goal = { customerConversionGoal: { category: "SUBMIT_LEAD_FORM", origin: "WEBSITE" } };
    if (evidence === "truncated") return success({ value: { results: [goal], nextPageToken: "more" } });
    if (evidence === "malformed") return success({ value: { results: [{ customerConversionGoal: { category: "SUBMIT_LEAD_FORM", origin: {} } }] } });
    if (evidence === "duplicate") return success({ value: { results: [goal, goal] } });
    if (evidence === "over-limit") return success({ value: { results: Array.from({ length: 201 }, () => goal) } });
    return fixture.transport.request(input);
  } } });
  const result = await createGooglePlugin(dependencies).invoke({ context: fixtureContext, name: "create_paused", arguments: { operationId: evidence, plan: optimizedPlan({ objective: "leads" }) } });
  assert.equal(result.ok, false); if (result.ok) throw new Error("Expected goal refusal");
  assert.equal(result.error.code, { missing: "unavailable", truncated: "limit_exceeded", malformed: "invalid_input", duplicate: "invalid_input", "over-limit": "invalid_input" }[evidence]);
  assert.equal(fixture.writes(), 0);
});
}

type DriftBody = { results: Record<string, unknown>[]; nextPageToken?: string };
/** Mutate goal evidence only; each switch arm is one independently observable fixture fault. */
function goalDrift(required: { drift: string; body: DriftBody }): void {
  const { drift, body } = required;
  switch (drift) {
    case "unrelated": asRecord({ value: body.results[2].campaignConversionGoal }).biddable = true; break;
    case "selected": asRecord({ value: body.results[0].campaignConversionGoal }).biddable = false; break;
    case "missing": body.results.shift(); break;
    case "duplicate": body.results.push(structuredClone(body.results[0])); break;
    case "truncated": body.nextPageToken = "more"; break;
  }
}
/** Change campaign goal configuration without altering the hierarchy or goal rows. */
function configDrift(required: { drift: string; body: DriftBody }): void {
  const { drift, body } = required;
  const config = asRecord({ value: body.results[0].conversionGoalCampaignConfig });
  switch (drift) {
    case "config": config.goalConfigLevel = "CUSTOMER"; break;
    case "custom": config.customConversionGoal = "customers/1234567890/customConversionGoals/1"; break;
    case "extra-config": body.results.push(structuredClone(body.results[0])); break;
  }
}
/** Change only bidding evidence, preserving the acknowledged paused campaign. */
function strategyDrift(required: { drift: string; body: DriftBody }): void {
  const { drift, body } = required;
  const campaign = asRecord({ value: body.results[0].campaign });
  switch (drift) {
    case "strategy": campaign.biddingStrategyType = "TARGET_CPA"; break;
    case "portfolio": campaign.biddingStrategy = "customers/1234567890/biddingStrategies/1"; break;
    case "tcpa": campaign.maximizeConversions = { targetCpaMicros: "1000000" }; break;
    case "troas": campaign.maximizeConversionValue = { targetRoas: 2 }; break;
  }
}

for (const drift of ["unrelated", "selected", "missing", "duplicate", "truncated", "config", "custom", "extra-config", "strategy", "portfolio", "tcpa", "troas"] as const) {
test(`optimized ${drift} drift blocks readback and activation without another write`, async () => {
  const fixture = createFixtureTransport({}); let changed = false;
  const dependencies = createFixtureDependencies({ transport: { async request(input) {
    const result = await fixture.transport.request(input);
    if (!changed || !result.ok || input.method !== "search") return result;
    const body = structuredClone(result.value) as DriftBody;
    const query = String(input.body.query);
    if (query.includes("FROM campaign_conversion_goal WHERE")) goalDrift({ drift, body });
    if (query.includes("FROM conversion_goal_campaign_config WHERE")) configDrift({ drift, body });
    if (query.includes("FROM campaign WHERE")) strategyDrift({ drift, body });
    return success({ value: body });
  } } });
  const plugin = createGooglePlugin(dependencies);
  const receipt = value<Receipt>({ outcome: await plugin.invoke({ context: fixtureContext, name: "create_paused", arguments: { operationId: "drift", plan: optimizedPlan({ objective: "leads" }) } }) });
  assert.equal(receipt.status, "acknowledged"); changed = true;
  assert.equal((await plugin.invoke({ context: fixtureContext, name: "read_campaign", arguments: { operationId: "read", campaignId: "201" } })).ok, false);
  assert.equal((await plugin.invoke({ context: fixtureContext, name: "activate", arguments: { operationId: "activate", campaignId: "201" } })).ok, false);
  assert.equal(fixture.writes(), 1);
});
}

test("200 postal criteria, 50 keywords and three goal updates retain ACK references above 256 responses", async () => {
  const fixture = createFixtureTransport({});
  const dependencies = createFixtureDependencies({ transport: { async request(input) {
    const result = await fixture.transport.request(input);
    if (!result.ok || input.method !== "mutate") return result;
    const body = structuredClone(result.value) as { mutateOperationResponses: Record<string, unknown>[] };
    assert.equal(body.mutateOperationResponses.length, 257);
    body.mutateOperationResponses[1] = { campaignResult: { resourceName: "customers/1234567890/campaigns/201" } };
    return success({ value: body });
  } } });
  const bounded = { ...optimizedPlan({ objective: "leads" }),
    geoTargetIds: Array.from({ length: 200 }, (_, index) => String(1000 + index)),
    keywords: Array.from({ length: 50 }, (_, index) => ({ text: "term " + index, matchType: "EXACT" as const })),
  };
  const receipt = value<Receipt>({ outcome: await createGooglePlugin(dependencies).invoke({ context: fixtureContext, name: "create_paused", arguments: { operationId: "bounded", plan: bounded } }) });
  assert.equal(receipt.status, "acknowledged"); assert.equal(fixture.writes(), 1);
  assert.deepEqual(receipt.references, ["customers/1234567890/campaigns/201"]);
});

for (const [label, candidate] of [
  ["traffic", plan],
  ["multi-ad traffic", multiAdPlan],
  ["postal leads", { ...optimizedPlan({ objective: "leads" }), geoTargetIds: ["101", "102"] }],
  ["proximity sales", { ...optimizedPlan({ objective: "sales" }), geoTargetIds: [], proximity }],
] as const) {
  test(`real validate factory uses the identical ${label} creation body without writes or checkpoints`, async () => {
    const f = hostedDeploymentFixture(); f.required.plan = candidate;
    const fetch = f.required.dependencies.fetch;
    f.required.dependencies = { ...f.required.dependencies, fetch: async (url, init) => {
      const response = await fetch(url, init);
      return JSON.parse(String(init?.body)).validateOnly === true ? Response.json({}) : response;
    } };
    const { scope, connectionId, accountId, pluginDigest, settings } = f.required.dependencies.configuration;
    const dependencies = { ...f.required.dependencies, configuration: pluginConfigurationSchema.parse({ scope, connectionId, accountId, pluginDigest, settings }) };
    const validated = await createCapabilities(dependencies)["campaign.validate.v1"]({ context: f.required.context,
      connection: { connectionId, accountId }, input: { operationId: f.required.operationId, plan: candidate } });
    assert.equal(validated.ok, true); if (!validated.ok) throw new Error("Expected validation success");
    assert.deepEqual(campaignValidateOutputSchema.parse(validated.value), { status: "validated" });
    assert.equal(f.writes(), 0); assert.deepEqual(f.checkpoints, []); assert.equal(f.required.saved.record, null);
    const receipt = value<CampaignDeploymentReceipt>({ outcome: await deployCampaignPaused(f.required) });
    assert.equal(receipt.status, "acknowledged"); assert.equal(f.writes(), 1);
    const bodies = f.calls.filter(call => call.method === "mutate").map(call => call.body);
    assert.equal(bodies.length, 2); assert.equal(bodies[0].validateOnly, true); assert.equal(bodies[1].validateOnly, false);
    assert.deepEqual(bodies[0], { ...bodies[1], validateOnly: true });
  });
}

for (const fault of ["http", "partialFailure", "malformed"] as const) {
  test(`validate ${fault} response fails without exposing credential or vendor text`, async () => {
    const f = hostedDeploymentFixture(); const token = "fixture-validation-token-never-real";
    const fetch = f.required.dependencies.fetch;
    const dependencies = { ...f.required.dependencies,
      credentials: { access: async () => success({ value: { accessToken: token, secrets: { developerToken: "a".repeat(22) } } }) },
      fetch: async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        if (!JSON.parse(String(init?.body)).validateOnly) return fetch(url, init);
        if (fault === "http") return Response.json({ error: { message: token } }, { status: 400 });
        return Response.json(fault === "partialFailure" ? { partialFailureError: { message: token } } : [token]);
      },
    };
    const result = await createCapabilities(dependencies)["campaign.validate.v1"]({ context: f.required.context,
      connection: { connectionId: f.required.connectionId, accountId: f.required.accountId }, input: { operationId: f.required.operationId, plan } });
    assert.equal(result.ok, false); assert.equal(JSON.stringify(result).includes(token), false);
    assert.equal(f.writes(), 0); assert.deepEqual(f.checkpoints, []);
  });
}

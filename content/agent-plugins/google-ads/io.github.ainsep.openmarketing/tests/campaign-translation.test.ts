import assert from "node:assert/strict";
import { test } from "node:test";
import type { Outcome } from "@open-marketing/contracts";
import { translateCampaign } from "../src/index.ts";
import type { CampaignTranslationInput } from "../src/index.ts";
import { createOperations } from "../src/mapping.ts";
import { fixtureBinding } from "../src/fixture.ts";
import { parse } from "../src/schema.ts";
import { planSchema } from "../src/schemas.ts";

const campaign: CampaignTranslationInput["campaign"] = {
  schemaVersion: 2, operationId: "launch",
  targets: [{ pluginId: "google-ads", connectionId: "connection", accountId: "1234567890", dailyBudget: { minorUnits: 4321, currency: "USD" }, expectedExposure: { minorUnits: 10000, currency: "USD" } }],
  name: "Traffic", objective: "traffic",
  schedule: { window: { start: 1791849600000, end: 1792022400000 }, timezone: "UTC" },
  audience: { countries: ["US"], searchTerms: ["marketing tools"] },
  ads: [{ creativeId: "creative", destinationUrl: "https://example.test/landing" }],
  creativeDigest: "a".repeat(64),
};
const target = { accountId: "1234567890", connectionId: "connection", dailyBudget: { minorUnits: 4321, currency: "USD" } };
const resolved = {
  binding: { ...fixtureBinding, connectionId: "connection", timezone: "UTC" }, currencyExponent: 2, creativeId: "creative", creativeDigest: campaign.creativeDigest,
  locations: [{ country: "US", id: "2840" }], cpcBidMicros: "2370000", headlines: ["Open Marketing", "Plan Search Campaigns", "See Clear Reports"],
  descriptions: ["Plan paused Search campaigns.", "Review each exact spend call."], finalUrl: "https://example.test/landing", euPoliticalAdvertising: "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING",
};
const input: CampaignTranslationInput = { campaign, target, resolved };
const secondCreative = { creativeId: "second", headlines: ["Compare Search Plans", "Choose Your Campaign", "Find Clear Insights"],
  descriptions: ["Compare your next Search campaign.", "Choose a destination for each ad."] };
const multiAdInput: CampaignTranslationInput = { ...input,
  campaign: { ...campaign, ads: [...campaign.ads, { creativeId: "second", destinationUrl: "https://example.test/second" }] },
  resolved: { ...resolved, additionalCreatives: [secondCreative] },
};

test("projected plan schema validates decimal radius bounds and rejects unknown schema types", () => {
  const translated = translateCampaign(input);
  assert.equal(translated.ok, true); if (!translated.ok) throw new Error("Expected traffic fixture");
  for (const radiusKm of ["5", 0, 20041, {}, NaN, Infinity, 5.25]) {
    const result: Outcome<unknown> = parse({ schema: planSchema, input: { ...translated.value, geoTargetIds: [], proximity: {
      latitudeMicroDegrees: 0, longitudeMicroDegrees: 0, radiusKm,
    } } });
    assert.equal(result.ok, radiusKm === 5.25);
  }
  assert.equal(parse({ schema: { type: "unsupported" } as unknown as typeof planSchema, input: 5 }).ok, false);
});

test("neutral shape produces the existing Search plan and an entirely PAUSED serving hierarchy", () => {
  const before = JSON.stringify(input);
  const outcome = translateCampaign(input); assert.equal(outcome.ok, true);
  if (!outcome.ok) throw new Error("Expected translated fixture");
  assert.equal(outcome.value.averageDailyBudgetMicros, "43210000");
  assert.equal(outcome.value.cpcBidMicros, "2370000");
  assert.equal(Object.hasOwn(outcome.value, "objective"), false);
  assert.equal(Object.hasOwn(outcome.value, "additionalAds"), false);
  assert.equal(outcome.value.finalUrl, campaign.ads[0].destinationUrl);
  assert.equal(outcome.value.startsAt, campaign.schedule.window.start); assert.equal(outcome.value.endsAt, campaign.schedule.window.end);
  const operations = createOperations({ customerId: target.accountId, plan: outcome.value, marker: "fixture", timezone: "UTC", conversionGoals: [] });
  assert.equal(operations.filter(operation => JSON.stringify(operation).includes('"status":"PAUSED"')).length, 4);
  assert.equal(JSON.stringify(operations).includes('"ENABLED"'), false);
  assert.equal(JSON.stringify(input), before);
});
test("the selected ad destination wins over the URL in resolved metadata", () => {
  const destinationUrl = "https://example.test/requested?campaign=explicit";
  const result = translateCampaign({ ...input, campaign: { ...campaign, ads: [{ ...campaign.ads[0], destinationUrl }] } });
  assert.equal(result.ok, true); if (!result.ok) throw new Error("Expected explicit destination");
  assert.equal(result.value.finalUrl, destinationUrl);
});
test("four ads reject before metadata is read", () => {
  const intent = { ...campaign, ads: [campaign.ads[0], ...["second", "third", "fourth"].map(creativeId => ({ ...campaign.ads[0], creativeId }))] };
  const result = translateCampaign({ ...input, campaign: intent, get resolved() { throw new Error("Unsupported intent must not resolve"); } });
  assert.equal(result.ok, false); if (result.ok) throw new Error("Expected unsupported intent");
  assert.equal(result.error.code, "not_implemented");
});
test("two-ad traffic binds each creative copy to its own intended URL", () => {
  const result = translateCampaign(multiAdInput);
  assert.equal(result.ok, true); if (!result.ok) throw new Error("Expected two-ad translation");
  assert.deepEqual(result.value.headlines, resolved.headlines);
  assert.equal(result.value.finalUrl, campaign.ads[0].destinationUrl);
  assert.deepEqual(result.value.additionalAds, [{ headlines: secondCreative.headlines, descriptions: secondCreative.descriptions, finalUrl: "https://example.test/second" }]);
  assert.equal(result.value.cpcBidMicros, resolved.cpcBidMicros);
});
test("missing, extra, mismatched or duplicated later creative resolutions conflict", () => {
  const thirdAd = { creativeId: "third", destinationUrl: "https://example.test/third" };
  const cases: CampaignTranslationInput[] = [
    { ...multiAdInput, resolved },
    { ...input, resolved: { ...resolved, additionalCreatives: [secondCreative] } },
    { ...multiAdInput, resolved: { ...resolved, additionalCreatives: [secondCreative, { ...secondCreative, creativeId: "third" }] } },
    { ...multiAdInput, resolved: { ...resolved, additionalCreatives: [{ ...secondCreative, creativeId: "unrequested" }] } },
    { ...multiAdInput, campaign: { ...multiAdInput.campaign, ads: [...multiAdInput.campaign.ads, thirdAd] },
      resolved: { ...resolved, additionalCreatives: [secondCreative, secondCreative] } },
  ];
  for (const candidate of cases) {
    const result = translateCampaign(candidate);
    assert.equal(result.ok, false); if (result.ok) throw new Error("Expected resolution conflict");
    assert.equal(result.error.code, "conflict");
    assert.equal(result.error.message, "Google creative resolution differs from intent");
  }
});
test("invalid later-ad URLs and duplicate or oversized copy reject the whole plan", () => {
  const cases: CampaignTranslationInput[] = [
    ...["http://example.test/second", "https://[", "https://user:password@example.test/second"].map(destinationUrl => ({ ...multiAdInput,
      campaign: { ...multiAdInput.campaign, ads: [campaign.ads[0], { creativeId: "second", destinationUrl }] },
    })),
    ...[{ headlines: ["Repeated", "Repeated", "Third headline"] }, { descriptions: ["Repeated", "Repeated"] },
      { headlines: ["x".repeat(31), "Second headline", "Third headline"] }].map(copy => ({ ...multiAdInput,
      resolved: { ...resolved, additionalCreatives: [{ ...secondCreative, ...copy }] },
    })),
  ];
  for (const candidate of cases) {
    const result = translateCampaign(candidate);
    assert.equal(result.ok, false); if (result.ok) throw new Error("Expected invalid later ad");
    assert.equal(result.error.code, "invalid_input");
  }
});
test("website leads and sales translate with objective and no manual CPC", () => {
  for (const objective of ["leads", "sales"] as const) {
    const result = translateCampaign({ ...input, campaign: { ...campaign, objective } });
    assert.equal(result.ok, true); if (!result.ok) throw new Error("Expected optimized plan");
    assert.equal(result.value.objective, objective);
    assert.equal(Object.hasOwn(result.value, "cpcBidMicros"), false);
    assert.equal(result.value.finalUrl, campaign.ads[0].destinationUrl);
  }
});
test("postal targeting uses only country-qualified postal IDs, never the broad country", () => {
  const result = translateCampaign({ ...input,
    campaign: { ...campaign, audience: { ...campaign.audience, localTargeting: { kind: "postal", codes: ["90210", "90001"] } } },
    resolved: { ...resolved, postalCodes: [
      { country: "US", code: "90001", id: "101" }, { country: "US", code: "90210", id: "102" },
      { country: "CA", code: "90210", id: "103" },
    ] },
  });
  assert.equal(result.ok, true); if (!result.ok) throw new Error("Expected postal plan");
  assert.deepEqual(result.value.geoTargetIds, ["102", "101"]);
  assert.equal(result.value.proximity, undefined);
  const criteria = createOperations({ customerId: target.accountId, plan: result.value, marker: "postal", timezone: "UTC", conversionGoals: [] }).filter(operation => "campaignCriterionOperation" in operation);
  assert.deepEqual(criteria, ["102", "101"].map(id => ({ campaignCriterionOperation: { create: {
    campaign: "customers/1234567890/campaigns/-2", location: { geoTargetConstant: "geoTargetConstants/" + id },
  } } })));
});
test("missing, wrong-country or duplicate postal resolution returns invalid_input", () => {
  const postal = { country: "US", code: "90210", id: "101" };
  for (const postalCodes of [undefined, [], [{ ...postal, country: "CA" }], [postal, { ...postal, id: "102" }]]) {
    const metadata = postalCodes === undefined ? resolved : { ...resolved, postalCodes };
    const result = translateCampaign({ ...input, resolved: metadata,
      campaign: { ...campaign, audience: { ...campaign.audience, localTargeting: { kind: "postal", codes: ["90210"] } } },
    });
    assert.equal(result.ok, false); if (result.ok) throw new Error("Expected postal rejection");
    assert.equal(result.error.code, "invalid_input");
  }
});
test("radius translates rounded microdegrees and decimal kilometers with no LOCATION operation", () => {
  const result = translateCampaign({ ...input, campaign: { ...campaign, audience: { ...campaign.audience,
    localTargeting: { kind: "radius", latitude: -33.8651434, longitude: 151.2099006, radiusKm: 5.25 },
  } } });
  assert.equal(result.ok, true); if (!result.ok) throw new Error("Expected radius plan");
  assert.deepEqual(result.value.geoTargetIds, []);
  assert.deepEqual(result.value.proximity, { latitudeMicroDegrees: -33865143, longitudeMicroDegrees: 151209901, radiusKm: 5.25 });
  const criteria = createOperations({ customerId: target.accountId, plan: result.value, marker: "radius", timezone: "UTC", conversionGoals: [] }).filter(operation => "campaignCriterionOperation" in operation);
  assert.deepEqual(criteria, [{ campaignCriterionOperation: { create: { campaign: "customers/1234567890/campaigns/-2", proximity: {
    geoPoint: { latitudeInMicroDegrees: -33865143, longitudeInMicroDegrees: 151209901 }, radius: 5.25, radiusUnits: "KILOMETERS",
  } } } }]);
});
test("explicit zero and three decimal currency metadata convert without floating-point rounding", () => {
  for (const [currency, currencyExponent, micros] of [["JPY", 0, "4321000000"], ["KWD", 3, "4321000"]] as const) {
    const result = translateCampaign({ campaign, target: { ...target, dailyBudget: { minorUnits: 4321, currency } }, resolved: { ...resolved, currencyExponent, binding: { ...resolved.binding, currency } } });
    assert.equal(result.ok, true); if (!result.ok) throw new Error("Expected currency fixture");
    assert.equal(result.value.averageDailyBudgetMicros, micros);
  }
});
test("incomplete resolution and mismatched authority data return typed errors", () => {
  const cases: CampaignTranslationInput[] = [
    { ...input, campaign: { ...campaign, name: "" } },
    { ...input, campaign: { ...campaign, schedule: { ...campaign.schedule, window: { start: 1791849600001, end: 1792022400000 } } } },
    { ...input, campaign: { ...campaign, ads: [{ ...campaign.ads[0], creativeId: "a" }, { ...campaign.ads[0], creativeId: "b" }] } },
    { ...input, campaign: { ...campaign, audience: { countries: ["US"] } } },
    { ...input, target: { ...target, accountId: "9876543210" } },
    { ...input, target: { ...target, dailyBudget: { ...target.dailyBudget, currency: "EUR" } } },
    { ...input, target: { ...target, dailyBudget: { ...target.dailyBudget, minorUnits: 0 } } },
    ...[{ cpcBidMicros: undefined }, { euPoliticalAdvertising: undefined }, { currencyExponent: 4 }, { currencyExponent: 3 }, { creativeDigest: "b".repeat(64) }, { locations: [] }, { locations: [resolved.locations[0], resolved.locations[0]] }].map(change => ({ ...input, resolved: { ...resolved, ...change } })),
  ];
  for (const candidate of cases) { const result = translateCampaign(candidate); assert.equal(result.ok, false); if (result.ok) throw new Error("Expected typed rejection"); assert.equal(result.error.retryable, false); }
});

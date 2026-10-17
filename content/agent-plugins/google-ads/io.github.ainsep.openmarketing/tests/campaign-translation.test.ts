import assert from "node:assert/strict";
import { test } from "node:test";
import { translateCampaign } from "../src/index.ts";
import type { CampaignTranslationInput } from "../src/index.ts";
import { createOperations } from "../src/mapping.ts";
import { fixtureBinding } from "../src/fixture.ts";

const campaign = { name: "Traffic", objective: "traffic", schedule: { window: { start: 1791849600000, end: 1792022400000 }, timezone: "UTC" }, audience: { countries: ["US"], searchTerms: ["marketing tools"] }, creativeIds: ["creative"], creativeDigest: "a".repeat(64) };
const target = { accountId: "1234567890", connectionId: "connection", dailyBudget: { minorUnits: 4321, currency: "USD" } };
const resolved = {
  binding: { ...fixtureBinding, connectionId: "connection", timezone: "UTC" }, currencyExponent: 2, creativeId: "creative", creativeDigest: campaign.creativeDigest,
  locations: [{ country: "US", id: "2840" }], cpcBidMicros: "2370000", headlines: ["Open Marketing", "Plan Search Campaigns", "See Clear Reports"],
  descriptions: ["Plan paused Search campaigns.", "Review each exact spend call."], finalUrl: "https://example.test/landing", euPoliticalAdvertising: "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING",
};
const input: CampaignTranslationInput = { campaign, target, resolved };

test("neutral shape produces the existing Search plan and an entirely PAUSED serving hierarchy", () => {
  const before = JSON.stringify(input);
  const outcome = translateCampaign(input); assert.equal(outcome.ok, true);
  if (!outcome.ok) throw new Error("Expected translated fixture");
  assert.equal(outcome.value.averageDailyBudgetMicros, "43210000");
  assert.equal(outcome.value.cpcBidMicros, "2370000");
  assert.equal(outcome.value.startsAt, campaign.schedule.window.start); assert.equal(outcome.value.endsAt, campaign.schedule.window.end);
  const operations = createOperations({ customerId: target.accountId, plan: outcome.value, marker: "fixture", timezone: "UTC" });
  assert.equal(operations.filter(operation => JSON.stringify(operation).includes('"status":"PAUSED"')).length, 4);
  assert.equal(JSON.stringify(operations).includes('"ENABLED"'), false);
  assert.equal(JSON.stringify(input), before);
});
test("explicit zero and three decimal currency metadata convert without floating-point rounding", () => {
  for (const [currency, currencyExponent, micros] of [["JPY", 0, "4321000000"], ["KWD", 3, "4321000"]] as const) {
    const result = translateCampaign({ campaign, target: { ...target, dailyBudget: { minorUnits: 4321, currency } }, resolved: { ...resolved, currencyExponent, binding: { ...resolved.binding, currency } } });
    assert.equal(result.ok, true); if (!result.ok) throw new Error("Expected currency fixture");
    assert.equal(result.value.averageDailyBudgetMicros, micros);
  }
});
test("incomplete resolution, unsupported objectives and mismatched authority data return typed errors", () => {
  const cases: CampaignTranslationInput[] = [
    { ...input, campaign: { ...campaign, objective: "sales" } },
    { ...input, campaign: { ...campaign, name: "" } },
    { ...input, campaign: { ...campaign, schedule: { ...campaign.schedule, window: { start: 1791849600001, end: 1792022400000 } } } },
    { ...input, campaign: { ...campaign, creativeIds: ["a", "b"] } },
    { ...input, campaign: { ...campaign, audience: { countries: ["US"] } } },
    { ...input, target: { ...target, accountId: "9876543210" } },
    { ...input, target: { ...target, dailyBudget: { ...target.dailyBudget, currency: "EUR" } } },
    { ...input, target: { ...target, dailyBudget: { ...target.dailyBudget, minorUnits: 0 } } },
    ...[{ cpcBidMicros: undefined }, { euPoliticalAdvertising: undefined }, { currencyExponent: 4 }, { currencyExponent: 3 }, { creativeDigest: "b".repeat(64) }, { locations: [] }, { locations: [resolved.locations[0], resolved.locations[0]] }].map(change => ({ ...input, resolved: { ...resolved, ...change } })),
  ];
  for (const candidate of cases) { const result = translateCampaign(candidate); assert.equal(result.ok, false); if (result.ok) throw new Error("Expected typed rejection"); assert.equal(result.error.retryable, false); }
});

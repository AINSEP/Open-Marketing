import { describe, expect, it } from "vitest";
import { encodeCommand, translateCampaign } from "../src/index.js";
import type { CampaignTranslationInput } from "../src/index.js";

const campaign: CampaignTranslationInput["campaign"] = {
  schemaVersion: 2, operationId: "launch",
  targets: [{ pluginId: "meta-ads", connectionId: "connection", accountId: "123", dailyBudget: { minorUnits: 4321, currency: "USD" }, expectedExposure: { minorUnits: 10000, currency: "USD" } }],
  name: "Traffic", objective: "traffic",
  schedule: { window: { start: 1791849600000, end: 1792022400000 }, timezone: "UTC" },
  audience: { countries: ["US"] },
  ads: [{ creativeId: "creative", destinationUrl: "https://example.test/landing" }],
  creativeDigest: "a".repeat(64),
};
const target = { accountId: "123", dailyBudget: { minorUnits: 4321, currency: "USD" } };
const resolved = { accountId: "123", currency: "USD", currencyExponent: 2, timezone: "UTC", creativeId: "creative", creativeDigest: campaign.creativeDigest, vendorCreativeId: "987", ageMin: 18, ageMax: 65, specialAdCategories: [] };
const input: CampaignTranslationInput = { campaign, target, resolved };

describe("Meta neutral translation", () => {
  it("rejects unverified v2 destinations while the explicit vendor commands stay PAUSED", () => {
    const before = JSON.stringify(input);
    expect(translateCampaign(input)).toMatchObject({ ok: false, error: { code: "not_implemented", retryable: false, message: expect.stringContaining("destination URL") } });
    const commands = [
      { kind: "create-campaign", name: "Traffic", objective: "OUTCOME_TRAFFIC", specialAdCategories: [] },
      { kind: "create-adset", name: "Traffic", campaignId: "456", targeting: { countries: ["US"], age_min: 18, age_max: 65 }, billingEvent: "IMPRESSIONS", optimizationGoal: "LINK_CLICKS", dailyBudgetMinor: 4321, schedule: campaign.schedule.window },
      { kind: "create-ad", name: "Traffic", creativeId: "987", adsetId: "567" },
    ];
    const wire = commands.map(command => encodeCommand({ input: command, accountId: "123" }));
    for (const encoded of wire) { expect(encoded.ok).toBe(true); if (!encoded.ok) throw new Error("Expected encoded fixture"); expect(encoded.value.arguments.status).toBe("PAUSED"); }
    expect(wire[1]).toMatchObject({ value: { arguments: { daily_budget: "4321", start_time: "2026-10-13T00:00:00.000Z", end_time: "2026-10-15T00:00:00.000Z" } } });
    expect(JSON.stringify(wire)).not.toContain('"ACTIVE"'); expect(JSON.stringify(input)).toBe(before);
  });
  it.each([
    { ...input, campaign: { ...campaign, objective: "sales" } },
    { ...input, campaign: { ...campaign, name: "" } },
    { ...input, campaign: { ...campaign, audience: { countries: ["US"], searchTerms: ["tools"] } } },
    { ...input, campaign: { ...campaign, ads: [{ ...campaign.ads[0], creativeId: "a" }, { ...campaign.ads[0], creativeId: "b" }] } },
    { ...input, campaign: { ...campaign, schedule: { ...campaign.schedule, window: { start: 1000, end: 1000 } } } },
    { ...input, campaign: { ...campaign, schedule: { ...campaign.schedule, window: { start: 1001, end: 5000 } } } },
    ...[{ specialAdCategories: undefined }, { specialAdCategories: ["HOUSING"] }, { vendorCreativeId: undefined }, { currencyExponent: 0 }, { currency: "JPY" }, { ageMin: 66 }, { ageMin: 65, ageMax: 18 }, { creativeDigest: "b".repeat(64) }, { accountId: "456" }, { timezone: "Asia/Tokyo" }].map(change => ({ ...input, resolved: { ...resolved, ...change } })),
  ] satisfies CampaignTranslationInput[])("returns typed non-retryable failure before producing a partial hierarchy", candidate => {
    expect(translateCampaign(candidate)).toMatchObject({ ok: false, error: { retryable: false } });
  });
  it.each([
    { ...campaign, objective: "leads" }, { ...campaign, objective: "sales" },
    { ...campaign, audience: { countries: ["US"], localTargeting: { kind: "postal", codes: ["90210"] } } },
    { ...campaign, audience: { countries: ["US"], localTargeting: { kind: "radius", latitude: 0, longitude: 0, radiusKm: 5 } } },
    { ...campaign, ads: [{ ...campaign.ads[0], destinationUrl: "https://example.test/other" }] },
  ] satisfies CampaignTranslationInput["campaign"][])("never drops unsupported intent or reads metadata", intent => {
    expect(translateCampaign({ ...input, campaign: intent, get resolved() { throw new Error("Must not resolve"); } })).toMatchObject({ ok: false, error: { code: "not_implemented" } });
  });
  it("keeps existing unscheduled calls and rejects half-schedules/status injection", () => {
    const command = { kind: "create-adset", name: "Traffic", campaignId: "456", targeting: { countries: ["US"], age_min: 18, age_max: 65 }, billingEvent: "IMPRESSIONS", optimizationGoal: "LINK_CLICKS", dailyBudgetMinor: 4321 };
    expect(encodeCommand({ input: command, accountId: "123" })).toMatchObject({ ok: true, value: { arguments: { status: "PAUSED" } } });
    expect(encodeCommand({ input: { ...command, schedule: { start: 1000 } }, accountId: "123" }).ok).toBe(false);
    expect(encodeCommand({ input: { ...command, status: "ACTIVE" }, accountId: "123" }).ok).toBe(false);
  });
});

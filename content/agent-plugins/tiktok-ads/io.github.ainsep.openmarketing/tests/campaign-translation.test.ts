import { expect, it } from "vitest";
import { translateCampaign } from "../src/index.js";
import type { CampaignTranslationInput } from "../src/index.js";

const campaign: CampaignTranslationInput["campaign"] = {
  schemaVersion: 2, operationId: "launch",
  targets: [{ pluginId: "tiktok-ads", connectionId: "connection", accountId: "123", dailyBudget: { minorUnits: 4321, currency: "USD" }, expectedExposure: { minorUnits: 10000, currency: "USD" } }],
  name: "Traffic", objective: "traffic",
  schedule: { window: { start: 1791849600000, end: 1792022400000 }, timezone: "America/Los_Angeles" },
  audience: { countries: ["US"] },
  ads: [{ creativeId: "creative", destinationUrl: "https://example.com/signup" }],
  creativeDigest: "a".repeat(64),
};
const resolved = { accountId: "123", currency: "USD", currencyExponent: 2, timezone: campaign.schedule.timezone, creativeId: "creative", creativeDigest: campaign.creativeDigest, locations: [{ country: "US", id: "6252001" }],
  creative: { adFormat: "SINGLE_IMAGE", identityId: "identity", imageIds: ["image"], text: "Visit us", landingPageUrl: "https://example.com/signup" } };
const input: CampaignTranslationInput = { campaign, target: { accountId: "123", dailyBudget: { minorUnits: 4321, currency: "USD" } }, resolved };

it("binds exact daily money, finite UTC seconds, countries and one image without resolving credentials", () => {
  expect(translateCampaign(input)).toMatchObject({ ok: true, value: {
    campaign: { budget: 43.21 }, adgroup: { budget: 43.21, campaignId: { from: "campaign" }, locationIds: ["6252001"], scheduleStart: "2026-10-13 00:00:00", scheduleEnd: "2026-10-15 00:00:00" },
    ad: { adgroupId: { from: "adgroup" }, adFormat: "SINGLE_IMAGE", imageIds: ["image"], identityType: "CUSTOMIZED_USER", landingPageUrl: "https://example.com/signup" },
  } });
  expect(translateCampaign({ ...input, resolved: { ...resolved, creative: { ...resolved.creative, adFormat: "SINGLE_VIDEO", videoId: "video" } } })).toMatchObject({ ok: true, value: { ad: { adFormat: "SINGLE_VIDEO", videoId: "video", imageIds: ["image"] } } });
});
it("rejects unsupported neutral inputs before consulting metadata", () => {
  const changes: Partial<CampaignTranslationInput["campaign"]>[] = [
    { objective: "leads" }, { objective: "sales" }, { ads: [{ ...campaign.ads[0], creativeId: "one" }, { ...campaign.ads[0], creativeId: "two" }] },
    { audience: { countries: ["US"], searchTerms: ["cannot discard"] } },
    { audience: { countries: ["US"], localTargeting: { kind: "postal", codes: ["90210"] } } },
    { audience: { countries: ["US"], localTargeting: { kind: "radius", latitude: 0, longitude: 0, radiusKm: 5 } } },
  ];
  for (const change of changes) {
    expect(translateCampaign({ ...input, campaign: { ...campaign, ...change }, get resolved() { throw new Error("Unsupported input must not resolve"); } })).toMatchObject({ ok: false, error: { code: "not_implemented" } });
  }
});
it("rejects a different requested destination instead of discarding it", () => {
  const intent = { ...campaign, ads: [{ ...campaign.ads[0], destinationUrl: "https://example.com/other" }] };
  expect(translateCampaign({ ...input, campaign: intent })).toMatchObject({ ok: false, error: { code: "not_implemented", retryable: false } });
});
it.each([
  { accountId: "999" }, { currency: "EUR" }, { timezone: "UTC" }, { creativeId: "other" }, { creativeDigest: "b".repeat(64) },
  { locations: [{ country: "GB", id: "2" }] }, { locations: [{ country: "US", id: "2" }, { country: "US", id: "3" }] },
  { creative: { ...resolved.creative, landingPageUrl: "" } }, { creative: { ...resolved.creative, adFormat: "CAROUSEL" } },
  { creative: { ...resolved.creative, adFormat: "SINGLE_VIDEO" } }, { creative: { ...resolved.creative, imageIds: [] } },
])("rejects incompatible resolved bindings: %j", change => {
  expect(translateCampaign({ ...input, resolved: { ...resolved, ...change } })).toMatchObject({ ok: false });
});
it.each([
  { start: 1791849600001, end: 1792022400000 }, { start: 1792022400000, end: 1791849600000 },
  { start: 1830384000000, end: 1830470400000 }, { start: NaN, end: 1792022400000 },
])("never rounds or drops an unsupported finite window: %j", window => {
  expect(translateCampaign({ ...input, campaign: { ...campaign, schedule: { ...campaign.schedule, window } } })).toMatchObject({ ok: false });
});

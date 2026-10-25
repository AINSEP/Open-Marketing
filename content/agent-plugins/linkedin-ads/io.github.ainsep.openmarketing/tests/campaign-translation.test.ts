import { describe, expect, it } from "vitest";
import { encodeLinkedInCommand, translateCampaign } from "../src/index.js";
import type { CampaignTranslationInput } from "../src/index.js";
import { fixture, invocation } from "./fixtures.js";

const campaign: CampaignTranslationInput["campaign"] = {
  schemaVersion: 2, operationId: "launch",
  targets: [{ pluginId: "linkedin-ads", connectionId: "connection", accountId: "123", dailyBudget: { minorUnits: 4321, currency: "USD" }, expectedExposure: { minorUnits: 10000, currency: "USD" } }],
  name: "Traffic", objective: "traffic",
  schedule: { window: { start: 1791849600000, end: 1792022400000 }, timezone: "UTC" },
  audience: { countries: ["US"] },
  ads: [{ creativeId: "creative", destinationUrl: "https://example.test/landing" }],
  creativeDigest: "a".repeat(64),
};
const target = { accountId: "123", dailyBudget: { minorUnits: 4321, currency: "USD" } };
const resolved = { accountId: "123", currency: "USD", currencyExponent: 2, timezone: "UTC", creativeId: "creative", creativeDigest: campaign.creativeDigest, reference: "urn:li:share:987", organizationId: "789", locale: { country: "US", language: "en" }, politicalIntent: "NOT_POLITICAL", unitCost: { minorUnits: 237, currency: "USD" }, locations: [{ country: "US", id: "103644278" }] };
const input: CampaignTranslationInput = { campaign, target, resolved };

describe("LinkedIn neutral translation", () => {
  it("rejects unverified v2 destinations while the explicit vendor commands stay DRAFT", () => {
    const before = JSON.stringify(input);
    expect(translateCampaign(input)).toMatchObject({ ok: false, error: { code: "not_implemented", retryable: false, message: expect.stringContaining("destination URL") } });
    const commands = [
      { kind: "create_campaign_group_draft", name: "Traffic", runSchedule: campaign.schedule.window },
      { kind: "create_campaign_draft", name: "Traffic", campaignGroupId: "456", organizationId: "789", locale: { country: "US", language: "en" }, geoIds: ["103644278"], dailyBudget: { amount: "43.21", currencyCode: "USD" }, unitCost: { amount: "2.37", currencyCode: "USD" }, costType: "CPC", runSchedule: campaign.schedule.window, politicalIntent: "NOT_POLITICAL" },
      { kind: "create_creative_draft", campaignId: "567", reference: "urn:li:share:987" },
    ];
    for (const command of commands) {
      const encoded = encodeLinkedInCommand({ input: command, accountId: "123", currency: "USD" }); expect(encoded.ok).toBe(true);
      if (!encoded.ok) throw new Error("Expected encoded fixture");
      const body = JSON.parse(encoded.value.request.body ?? ""); expect(body.status ?? body.intendedStatus).toBe("DRAFT"); expect(encoded.value.effect).toBe("write");
    }
    expect(JSON.stringify(input)).toBe(before);
  });
  it.each([["JPY", 0, "4321"], ["KWD", 3, "4.321"]] as const)("rejects %s destinations even with explicit minor-unit metadata", (currency, currencyExponent, _amount) => {
    const result = translateCampaign({ campaign, target: { ...target, dailyBudget: { minorUnits: 4321, currency } }, resolved: { ...resolved, currency, currencyExponent, unitCost: { minorUnits: 237, currency } } });
    expect(result).toMatchObject({ ok: false, error: { code: "not_implemented", retryable: false } });
  });
  it.each([
    { ...input, campaign: { ...campaign, objective: "sales" } },
    { ...input, campaign: { ...campaign, name: "" } },
    { ...input, target: { ...target, dailyBudget: { minorUnits: Number.MAX_SAFE_INTEGER, currency: "USD" } } },
    { ...input, campaign: { ...campaign, audience: { countries: ["US"], searchTerms: ["tools"] } } },
    ...[{ politicalIntent: undefined }, { unitCost: undefined }, { reference: undefined }, { currencyExponent: 4 }, { currencyExponent: 3 }, { locations: [{ country: "CA", id: "1" }] }, { locations: [resolved.locations[0], resolved.locations[0]] }, { accountId: "456" }, { creativeDigest: "b".repeat(64) }, { unitCost: { minorUnits: 237, currency: "EUR" } }].map(change => ({ ...input, resolved: { ...resolved, ...change } })),
  ] satisfies CampaignTranslationInput[])("fails closed on missing metadata, unsupported objectives and partial country mappings", candidate => {
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
  it("decodes the draft creative's URN acknowledgement", async () => {
    const f = fixture({ response: () => new Response(null, { status: 201, headers: { "x-restli-id": "urn:li:sponsoredCreative:678" } }) });
    const request = invocation({ command: { kind: "create_creative_draft", campaignId: "567", reference: "urn:li:share:987" } });
    expect(await f.adapter.invoke(request)).toMatchObject({ ok: true, value: { status: "acknowledged", data: { id: "urn:li:sponsoredCreative:678" } } });
  });
});

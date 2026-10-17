import { describe, expect, it } from "vitest";
import { encodeLinkedInCommand, translateCampaign } from "../src/index.js";
import type { CampaignTranslationInput } from "../src/index.js";
import { fixture, invocation } from "./fixtures.js";

const campaign = { name: "Traffic", objective: "traffic", schedule: { window: { start: 1791849600000, end: 1792022400000 }, timezone: "UTC" }, audience: { countries: ["US"] }, creativeIds: ["creative"], creativeDigest: "a".repeat(64) };
const target = { accountId: "123", dailyBudget: { minorUnits: 4321, currency: "USD" } };
const resolved = { accountId: "123", currency: "USD", currencyExponent: 2, timezone: "UTC", creativeId: "creative", creativeDigest: campaign.creativeDigest, reference: "urn:li:share:987", organizationId: "789", locale: { country: "US", language: "en" }, politicalIntent: "NOT_POLITICAL", unitCost: { minorUnits: 237, currency: "USD" }, locations: [{ country: "US", id: "103644278" }] };
const input: CampaignTranslationInput = { campaign, target, resolved };

describe("LinkedIn neutral translation", () => {
  it("keeps group, campaign and creative DRAFT with exact decimal budgets, schedule and parent slots", () => {
    const before = JSON.stringify(input);
    const result = translateCampaign(input); expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected fixture plan");
    expect(result.value.campaign.campaignGroupId).toEqual({ from: "group" }); expect(result.value.creative.campaignId).toEqual({ from: "campaign" });
    expect(result.value.campaign.dailyBudget).toEqual({ amount: "43.21", currencyCode: "USD" });
    expect(result.value.campaign.unitCost).toEqual({ amount: "2.37", currencyCode: "USD" });
    expect(result.value.campaign.runSchedule).toEqual(campaign.schedule.window);
    const commands = [result.value.group, { ...result.value.campaign, campaignGroupId: "456" }, { ...result.value.creative, campaignId: "567" }];
    for (const command of commands) {
      const encoded = encodeLinkedInCommand({ input: command, accountId: "123", currency: "USD" }); expect(encoded.ok).toBe(true);
      if (!encoded.ok) throw new Error("Expected encoded fixture");
      const body = JSON.parse(encoded.value.request.body ?? ""); expect(body.status ?? body.intendedStatus).toBe("DRAFT"); expect(encoded.value.effect).toBe("write");
    }
    expect(JSON.stringify(input)).toBe(before);
  });
  it.each([["JPY", 0, "4321"], ["KWD", 3, "4.321"]] as const)("uses explicit %s minor-unit metadata without rounding", (currency, currencyExponent, amount) => {
    const result = translateCampaign({ campaign, target: { ...target, dailyBudget: { minorUnits: 4321, currency } }, resolved: { ...resolved, currency, currencyExponent, unitCost: { minorUnits: 237, currency } } });
    expect(result.ok).toBe(true); if (!result.ok) throw new Error("Expected currency fixture"); expect(result.value.campaign.dailyBudget.amount).toBe(amount);
  });
  it.each([
    { ...input, campaign: { ...campaign, objective: "sales" } },
    { ...input, campaign: { ...campaign, name: "" } },
    { ...input, target: { ...target, dailyBudget: { minorUnits: Number.MAX_SAFE_INTEGER, currency: "USD" } } },
    { ...input, campaign: { ...campaign, audience: { countries: ["US"], searchTerms: ["tools"] } } },
    ...[{ politicalIntent: undefined }, { unitCost: undefined }, { reference: undefined }, { currencyExponent: 4 }, { currencyExponent: 3 }, { locations: [{ country: "CA", id: "1" }] }, { locations: [resolved.locations[0], resolved.locations[0]] }, { accountId: "456" }, { creativeDigest: "b".repeat(64) }, { unitCost: { minorUnits: 237, currency: "EUR" } }].map(change => ({ ...input, resolved: { ...resolved, ...change } })),
  ])("fails closed on missing metadata, unsupported objectives and partial country mappings", candidate => {
    expect(translateCampaign(candidate)).toMatchObject({ ok: false, error: { retryable: false } });
  });
  it("decodes the draft creative's URN acknowledgement", async () => {
    const f = fixture({ response: () => new Response(null, { status: 201, headers: { "x-restli-id": "urn:li:sponsoredCreative:678" } }) });
    const request = invocation({ command: { kind: "create_creative_draft", campaignId: "567", reference: "urn:li:share:987" } });
    expect(await f.adapter.invoke(request)).toMatchObject({ ok: true, value: { status: "acknowledged", data: { id: "urn:li:sponsoredCreative:678" } } });
  });
});

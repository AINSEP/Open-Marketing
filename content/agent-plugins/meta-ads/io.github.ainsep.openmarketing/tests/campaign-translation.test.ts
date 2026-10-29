import { describe, expect, it, vi } from "vitest";
import { pluginConfigurationSchema } from "@open-marketing/contracts";
import type { PluginCapabilityDependencies } from "@open-marketing/contracts";
import { clock, context, observer, pluginDigest } from "./fixtures.js";
import { campaignDeploymentPlanSchema, encodeCommand, translateCampaign } from "../src/index.js";
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
const target = { connectionId: "connection", accountId: "123", dailyBudget: { minorUnits: 4321, currency: "USD" } };
const resolved = { accountId: "123", currency: "USD", currencyExponent: 2, timezone: "UTC", creativeId: "creative", creativeDigest: campaign.creativeDigest, vendorCreativeId: "987", ageMin: 18, ageMax: 65, specialAdCategories: [] };
const dependencies: PluginCapabilityDependencies = {
  configuration: pluginConfigurationSchema.parse({ scope: context.scope, connectionId: target.connectionId, accountId: target.accountId, pluginDigest, settings: {} }),
  clock, observer, wait: async () => ({ ok: true, value: undefined }),
  credentials: { access: async () => ({ ok: true, value: { accessToken: "fixture-token" } }) },
  fetch: async () => { throw new Error("Country/radius translation must not fetch"); },
};
const input: CampaignTranslationInput = { campaign, target, resolved, context, dependencies };

describe("Meta neutral translation", () => {
  it("translates countries and binds the v2 destination while vendor commands stay PAUSED", async () => {
    const before = JSON.stringify(input);
    const translated = await translateCampaign(input);
    expect(translated.ok).toBe(true);
    if (!translated.ok) throw new Error("Expected translated fixture");
    expect(campaignDeploymentPlanSchema.safeParse(translated.value).success).toBe(true);
    expect(translated.value.ad.destinationUrl).toBe(campaign.ads[0].destinationUrl);
    expect(translated.value.adset.targeting).toEqual({ countries: ["US"], age_min: 18, age_max: 65 });
    const { destinationUrl: _destinationUrl, ...ad } = translated.value.ad;
    const commands = [
      translated.value.campaign,
      { ...translated.value.adset, campaignId: "456" },
      { ...ad, adsetId: "567" },
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
    { ...input, campaign: { ...campaign, schedule: { ...campaign.schedule, window: { start: 1000, end: 1000 } } } },
    { ...input, campaign: { ...campaign, schedule: { ...campaign.schedule, window: { start: 1001, end: 5000 } } } },
    ...[{ specialAdCategories: undefined }, { specialAdCategories: ["HOUSING"] }, { vendorCreativeId: undefined }, { currencyExponent: 0 }, { currency: "JPY" }, { ageMin: 66 }, { ageMin: 65, ageMax: 18 }, { creativeDigest: "b".repeat(64) }, { accountId: "456" }, { timezone: "Asia/Tokyo" }].map(change => ({ ...input, resolved: { ...resolved, ...change } })),
  ] satisfies CampaignTranslationInput[])("returns typed non-retryable failure before producing a partial hierarchy", async candidate => {
    expect(await translateCampaign(candidate)).toMatchObject({ ok: false, error: { retryable: false } });
  });
  it.each([
    { ...campaign, objective: "leads" }, { ...campaign, objective: "sales" },
    { ...campaign, ads: [{ ...campaign.ads[0], creativeId: "a" }, { ...campaign.ads[0], creativeId: "b" }] },
  ] satisfies CampaignTranslationInput["campaign"][])("never drops unsupported intent or reads metadata", async intent => {
    expect(await translateCampaign({ ...input, campaign: intent, get resolved() { throw new Error("Must not resolve"); } })).toMatchObject({ ok: false, error: { code: "not_implemented" } });
  });
  it("resolves exact postal matches to sorted opaque keys with read-only search and no input mutation", async () => {
    const requests: { url: URL; method: string | undefined }[] = [];
    const candidate: CampaignTranslationInput = { ...input,
      campaign: { ...campaign, audience: { countries: ["US"], localTargeting: { kind: "postal", codes: ["94304", "90210"] } } },
      dependencies: { ...dependencies, async fetch(url, init) {
        const parsed = new URL(String(url));
        requests.push({ url: parsed, method: init?.method });
        const code = parsed.searchParams.get("q");
        return Response.json({ data: [
          { key: "CA:decoy", name: code, type: "zip", country_code: "CA" },
          { key: "US:prefix", name: code + "0", type: "zip", country_code: "US" },
          { key: code === "94304" ? "zip-key-z" : "zip-key-a", name: ` ${code} `, type: "zip", country_code: "US", region: "extra descriptive field" },
        ] });
      } },
    };
    const before = JSON.stringify(candidate);
    const result = await translateCampaign(candidate);
    expect(result).toMatchObject({ ok: true, value: { adset: { targeting: { zips: [{ key: "zip-key-a" }, { key: "zip-key-z" }] } } } });
    if (!result.ok) throw new Error("Expected postal fixture");
    expect(result.value.adset.targeting).not.toHaveProperty("countries");
    expect(JSON.stringify(candidate)).toBe(before);
    expect(requests).toHaveLength(2);
    expect(requests.map(request => request.url.searchParams.get("q"))).toEqual(["94304", "90210"]);
    for (const request of requests) {
      expect(request.method).toBe("GET");
      expect(request.url.origin + request.url.pathname).toBe("https://graph.facebook.com/v26.0/search");
      expect(request.url.searchParams.get("type")).toBe("adgeolocation");
      expect(request.url.searchParams.get("location_types")).toBe('["zip"]');
      expect(request.url.searchParams.get("country_code")).toBe("US");
      expect(request.url.searchParams.get("limit")).toBe("100");
    }
    expect(requests.filter(request => request.method === "POST")).toHaveLength(0);
  });
  it.each([
    { scenario: "not found", data: [], message: "Meta postal code not found" },
    { scenario: "ambiguous", data: [
      { key: "first-key", name: "94304", type: "zip", country_code: "US" },
      { key: "second-key", name: "94304", type: "zip", country_code: "US" },
    ], message: "Meta postal code ambiguous" },
    { scenario: "wrong country", data: [{ key: "CA:94304", name: "94304", type: "zip", country_code: "CA" }], message: "Meta postal code not found" },
  ])("refuses $scenario search results before producing a plan", async ({ data, message }) => {
    expect(await translateCampaign({ ...input,
      campaign: { ...campaign, audience: { countries: ["US"], localTargeting: { kind: "postal", codes: ["94304"] } } },
      dependencies: { ...dependencies, fetch: async () => Response.json({ data }) },
    })).toMatchObject({ ok: false, error: { code: "invalid_input", message, retryable: false } });
  });
  it("rejects supplied postal mappings before fetching", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    expect(await translateCampaign({ ...input,
      campaign: { ...campaign, audience: { countries: ["US"], localTargeting: { kind: "postal", codes: ["94304"] } } },
      resolved: { ...resolved, postalCodes: [{ country: "US", code: "94304", key: "US:94304" }] },
      dependencies: { ...dependencies, fetch },
    })).toMatchObject({ ok: false, error: { code: "invalid_input", retryable: false } });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([1, 5.25, 80])("preserves radius coordinates and kilometers without country targeting: %s", async radiusKm => {
    const result = await translateCampaign({ ...input, campaign: { ...campaign,
      audience: { countries: ["US"], localTargeting: { kind: "radius", latitude: 37.441987, longitude: -122.143019, radiusKm } },
    } });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected radius fixture");
    expect(result.value.adset.targeting).toEqual({ custom_locations: [{ latitude: 37.441987, longitude: -122.143019, radius: radiusKm, distance_unit: "kilometer" }], age_min: 18, age_max: 65 });
  });
  it.each([0.5, 81])("refuses radius outside Meta's documented limits: %s", async radiusKm => {
    expect(await translateCampaign({ ...input, campaign: { ...campaign,
      audience: { countries: ["US"], localTargeting: { kind: "radius", latitude: 0, longitude: 0, radiusKm } },
    } })).toMatchObject({ ok: false, error: { code: "invalid_input", message: "Meta radius must be 1–80 km" } });
  });
  it("keeps existing unscheduled calls and rejects half-schedules/status injection", () => {
    const command = { kind: "create-adset", name: "Traffic", campaignId: "456", targeting: { countries: ["US"], age_min: 18, age_max: 65 }, billingEvent: "IMPRESSIONS", optimizationGoal: "LINK_CLICKS", dailyBudgetMinor: 4321 };
    expect(encodeCommand({ input: command, accountId: "123" })).toMatchObject({ ok: true, value: { arguments: { status: "PAUSED" } } });
    expect(encodeCommand({ input: { ...command, schedule: { start: 1000 } }, accountId: "123" }).ok).toBe(false);
    expect(encodeCommand({ input: { ...command, status: "ACTIVE" }, accountId: "123" }).ok).toBe(false);
  });
});

import { expect, it } from "vitest";
import { translateCampaign } from "../src/index.js";
import type { CampaignTranslationInput } from "../src/index.js";

it("rejects the neutral finite daily-budget fixture without reading resolved data or dropping the end", () => {
  const campaign = { name: "Traffic", objective: "traffic", schedule: { window: { start: 1791849600000, end: 1792022400000 }, timezone: "UTC" }, audience: { countries: ["US"] }, creativeIds: ["creative"], creativeDigest: "a".repeat(64) };
  const input: CampaignTranslationInput = { campaign, target: { dailyBudget: { minorUnits: 4321, currency: "USD" } }, get resolved() { throw new Error("Unsupported preparation must not resolve credentials/assets"); } };
  expect(translateCampaign(input)).toEqual({ ok: false, error: { code: "not_implemented", message: "TikTok manual traffic with daily budget and finite end time is not verified", retryable: false } });
  expect(campaign.schedule.window.end).toBe(1792022400000);
  expect(translateCampaign({ campaign: { ...campaign, objective: "sales" }, target: input.target, resolved: null })).toMatchObject({ ok: false, error: { code: "not_implemented", retryable: false } });
});

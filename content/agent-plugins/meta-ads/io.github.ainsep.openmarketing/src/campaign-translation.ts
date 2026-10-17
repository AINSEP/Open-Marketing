import { z } from "zod";
import type { Money, Outcome, TimeWindow } from "@open-marketing/contracts";
import { digestSchema, idSchema } from "@open-marketing/contracts";
import { commandSchema, vendorIdSchema } from "./commands.js";
import type { MetaCommand } from "./commands.js";
import { parse, failure } from "./boundary.js";

/** Minimal structural neutral subset; the caller first parses the canonical launch schema. */
export interface CampaignTranslationInput {
  campaign: { name: string; objective: string; schedule: { window: TimeWindow; timezone: string }; audience: { countries: readonly string[]; searchTerms?: readonly string[] }; creativeIds: readonly string[]; creativeDigest: string };
  target: { accountId: string; dailyBudget: Money };
  resolved: unknown;
}
type Campaign = Extract<MetaCommand, { kind: "create-campaign" }>;
type Adset = Omit<Extract<MetaCommand, { kind: "create-adset" }>, "campaignId">;
type Ad = Omit<Extract<MetaCommand, { kind: "create-ad" }>, "adsetId">;
/** Fixed parent slots accept only earlier acknowledged IDs; these are not executable commands. */
export interface MetaPausedPlan {
  campaign: Campaign;
  adset: Adset & { campaignId: { from: "campaign" } };
  ad: Ad & { adsetId: { from: "adset" } };
}
const resolvedSchema = z.strictObject({
  accountId: vendorIdSchema, currency: z.literal("USD"), currencyExponent: z.literal(2), timezone: idSchema,
  creativeId: idSchema, creativeDigest: digestSchema, vendorCreativeId: vendorIdSchema,
  ageMin: z.number().int().min(18).max(65), ageMax: z.number().int().min(18).max(65),
  specialAdCategories: z.array(z.never()).max(0),
});

/** Pure website-traffic translation; only explicitly resolved USD offset-100 fixtures are supported.
 * @param required - Parsed neutral intent, target, and account/creative/declaration metadata.
 * @returns A fixed PAUSED hierarchy plan or a non-retryable invalid/unsupported/conflict error.
 * @example translateCampaign({ campaign: parsedLaunch, target, resolved: accountAndCreative })
 * @complexity O(c) time/space for c<=20 countries; no credentials, I/O or activation.
 */
export function translateCampaign(required: CampaignTranslationInput): Outcome<MetaPausedPlan> {
  const { campaign, target } = required;
  if (campaign.objective !== "traffic" || campaign.creativeIds.length !== 1 || campaign.audience.searchTerms !== undefined) return failure({ code: "not_implemented", message: "Meta supports country-only traffic with one existing creative" });
  const metadata = parse({ schema: resolvedSchema, input: required.resolved });
  if (!metadata.ok) return metadata;
  const resolved = metadata.value;
  if (target.accountId !== resolved.accountId || target.dailyBudget.currency !== resolved.currency || campaign.schedule.timezone !== resolved.timezone) return failure({ code: "conflict", message: "Meta account, currency or timezone differs" });
  if (campaign.creativeIds[0] !== resolved.creativeId || campaign.creativeDigest !== resolved.creativeDigest) return failure({ code: "conflict", message: "Meta creative differs from intent" });
  const root = parse({ schema: commandSchema.options[0], input: { kind: "create-campaign", name: campaign.name, objective: "OUTCOME_TRAFFIC", specialAdCategories: resolved.specialAdCategories } });
  if (!root.ok) return root;
  const adset = parse({ schema: commandSchema.options[1].omit({ campaignId: true }), input: {
    kind: "create-adset", name: campaign.name, targeting: { countries: campaign.audience.countries, age_min: resolved.ageMin, age_max: resolved.ageMax },
    billingEvent: "IMPRESSIONS", optimizationGoal: "LINK_CLICKS", dailyBudgetMinor: target.dailyBudget.minorUnits, schedule: campaign.schedule.window,
  } });
  if (!adset.ok) return adset;
  return { ok: true, value: { campaign: root.value, adset: { ...adset.value, campaignId: { from: "campaign" } }, ad: { kind: "create-ad", name: root.value.name, creativeId: resolved.vendorCreativeId, adsetId: { from: "adset" } } } };
}

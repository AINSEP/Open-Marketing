import { z } from "zod";
import { digestSchema, idSchema, moneySchema, parseBoundary } from "@open-marketing/contracts";
import type { Money, Outcome, TimeWindow } from "@open-marketing/contracts";
import { commandSchema, draftCampaignCommandSchema, draftCreativeCommandSchema, vendorIdSchema } from "./commands.js";
import type { LinkedInCommand } from "./commands.js";

/** Structural subset of canonical parsed intent; plugins are not feature workspace members. */
export interface CampaignTranslationInput {
  campaign: { name: string; objective: string; schedule: { window: TimeWindow; timezone: string }; audience: { countries: readonly string[]; searchTerms?: readonly string[] }; creativeIds: readonly string[]; creativeDigest: string };
  target: { accountId: string; dailyBudget: Money };
  resolved: unknown;
}
/** DRAFT parent/child hierarchy with fixed slots for acknowledged parent IDs. */
export interface LinkedInDraftPlan {
  group: Extract<LinkedInCommand, { kind: "create_campaign_group_draft" }>;
  campaign: Omit<z.infer<typeof draftCampaignCommandSchema>, "campaignGroupId"> & { campaignGroupId: { from: "group" } };
  creative: Omit<z.infer<typeof draftCreativeCommandSchema>, "campaignId"> & { campaignId: { from: "campaign" } };
}
const resolvedSchema = z.strictObject({
  accountId: vendorIdSchema, currency: z.string().regex(/^[A-Z]{3}$/), currencyExponent: z.number().int().min(0).max(3), timezone: idSchema,
  creativeId: idSchema, creativeDigest: digestSchema, reference: draftCreativeCommandSchema.shape.reference,
  organizationId: vendorIdSchema, locale: draftCampaignCommandSchema.shape.locale, politicalIntent: z.literal("NOT_POLITICAL"),
  unitCost: moneySchema.refine(value => value.minorUnits > 0),
  locations: z.array(z.strictObject({ country: z.string().regex(/^[A-Z]{2}$/), id: vendorIdSchema })).min(1).max(20),
});

/** Pure country-targeted website-traffic translation with explicit manual CPC bid/declaration.
 * @param required - Parsed neutral intent, selected target and resolved account/assets.
 * @returns Consistent DRAFT commands/parent slots, or a typed non-retryable error.
 * @example translateCampaign({ campaign: parsedLaunch, target, resolved: accountAndPost })
 * @complexity O(c) time/space, c<=20 countries; no I/O or activation.
 */
export function translateCampaign(required: CampaignTranslationInput): Outcome<LinkedInDraftPlan> {
  const { campaign, target } = required;
  if (campaign.objective !== "traffic" || campaign.creativeIds.length !== 1 || campaign.audience.searchTerms !== undefined) return invalid({ code: "not_implemented", message: "LinkedIn supports country-only traffic with one existing post" });
  const metadata = parseBoundary({ schema: resolvedSchema, input: required.resolved });
  if (!metadata.ok) return metadata;
  const resolved = metadata.value;
  if (target.accountId !== resolved.accountId || target.dailyBudget.currency !== resolved.currency || campaign.schedule.timezone !== resolved.timezone) return invalid({ code: "conflict", message: "LinkedIn account, currency or timezone differs" });
  if (campaign.creativeIds[0] !== resolved.creativeId || campaign.creativeDigest !== resolved.creativeDigest) return invalid({ code: "conflict", message: "LinkedIn creative differs from intent" });
  return draftPlan({ campaign, target, resolved });
}

/** Resolve only requested countries and schema-check the complete draft before returning parent slots.
 * @complexity O(c) time/space, c<=20 countries; pure, with no partial plan on failure.
 */
function draftPlan(required: { campaign: CampaignTranslationInput["campaign"]; target: CampaignTranslationInput["target"]; resolved: z.infer<typeof resolvedSchema> }): Outcome<LinkedInDraftPlan> {
  const { campaign, target, resolved } = required;
  if (new Intl.NumberFormat("en", { style: "currency", currency: resolved.currency }).resolvedOptions().maximumFractionDigits !== resolved.currencyExponent) return invalid({ code: "invalid_input", message: "LinkedIn currency exponent differs" });
  const locations = new Map(resolved.locations.map(location => [location.country, location.id]));
  if (locations.size !== resolved.locations.length || campaign.audience.countries.some(country => !locations.has(country))) return invalid({ code: "invalid_input", message: "LinkedIn country identifiers incomplete or duplicated" });
  if (resolved.unitCost.currency !== resolved.currency) return invalid({ code: "conflict", message: "LinkedIn bid currency differs" });
  const group = parseBoundary({ schema: commandSchema.options[5], input: { kind: "create_campaign_group_draft", name: campaign.name, runSchedule: campaign.schedule.window } });
  if (!group.ok) return group;
  const child = parseBoundary({ schema: draftCampaignCommandSchema.omit({ campaignGroupId: true }), input: {
    kind: "create_campaign_draft", name: campaign.name, organizationId: resolved.organizationId, locale: resolved.locale,
    geoIds: campaign.audience.countries.map(country => locations.get(country)), dailyBudget: decimalMoney({ money: target.dailyBudget, exponent: resolved.currencyExponent }),
    unitCost: decimalMoney({ money: resolved.unitCost, exponent: resolved.currencyExponent }), costType: "CPC", runSchedule: campaign.schedule.window, politicalIntent: resolved.politicalIntent,
  } });
  if (!child.ok) return child;
  return { ok: true, value: { group: group.value, campaign: { ...child.value, campaignGroupId: { from: "group" } }, creative: { kind: "create_creative_draft", campaignId: { from: "campaign" }, reference: resolved.reference } } };
}

/** Format schema-validated minor units exactly; never divide money using floating-point arithmetic. */
function decimalMoney(required: { money: Money; exponent: number }): { amount: string; currencyCode: string } {
  const digits = String(required.money.minorUnits).padStart(required.exponent + 1, "0");
  const amount = required.exponent === 0 ? digits : digits.slice(0, -required.exponent) + "." + digits.slice(-required.exponent);
  return { amount, currencyCode: required.money.currency };
}
function invalid(required: { code: "not_implemented" | "invalid_input" | "conflict"; message: string }): Outcome<never> {
  return { ok: false, error: { ...required, retryable: false } };
}

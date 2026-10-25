import type { NeutralCampaignLaunch, Outcome } from "@open-marketing/contracts";
import { array, currency, id, micros, numericId, object, parse, failure, text } from "./schema.ts";
import { bindingSchema, planSchema } from "./schemas.ts";
import { validatePlan } from "./rules.ts";
import type { AccountBinding, SearchPlan } from "./types.ts";

/** Canonical schema-validated v2 intent; plugins depend only on contracts. */
export interface CampaignTranslationInput {
  campaign: NeutralCampaignLaunch;
  target: Pick<NeutralCampaignLaunch["targets"][number], "accountId" | "connectionId" | "dailyBudget">;
  resolved: unknown;
}
type Resolved = {
  binding: AccountBinding; currencyExponent: number; creativeId: string; creativeDigest: string;
  locations: { country: string; id: string }[]; cpcBidMicros: string;
  headlines: string[]; descriptions: string[]; finalUrl: string; euPoliticalAdvertising: SearchPlan["euPoliticalAdvertising"];
};
const resolvedSchema = object({ properties: {
  binding: bindingSchema, currencyExponent: { type: "integer", minimum: 0, maximum: 3 }, creativeId: id,
  creativeDigest: { type: "string", pattern: "^[a-f0-9]{64}$", maxLength: 64 },
  locations: array({ items: object({ properties: { country: { ...currency, pattern: "^[A-Z]{2}$", maxLength: 2 }, id: numericId } }), min: 1, max: 20 }),
  cpcBidMicros: micros, headlines: array({ items: { ...text, maxLength: 30 }, min: 3, max: 15 }),
  descriptions: array({ items: { ...text, maxLength: 90 }, min: 2, max: 4 }),
  finalUrl: { type: "string", minLength: 8, maxLength: 2048, pattern: "^https://" },
  euPoliticalAdvertising: { type: "string", enum: ["CONTAINS_EU_POLITICAL_ADVERTISING", "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING"] },
} });

/** Translate parsed neutral intent and validated account/assets into the existing Search plan.
 * @param required - Parsed v2 intent, selected target, and server-resolved metadata (no I/O).
 * @returns A plan for createOperations' PAUSED hierarchy, or a non-retryable typed failure.
 * @example translateCampaign({ campaign: parsedLaunch, target, resolved: accountAndAssets })
 * @complexity O(c+k) time/space, c<=20 countries, k<=50 terms; no effects or activation.
 */
export function translateCampaign(required: CampaignTranslationInput): Outcome<SearchPlan> {
  const { campaign, target } = required;
  if (campaign.objective !== "traffic" || campaign.ads.length !== 1 || campaign.audience.localTargeting !== undefined) return failure({ code: "not_implemented", message: "Google supports country-only traffic with one responsive search creative" });
  const parsed = parse<Resolved>({ schema: resolvedSchema, input: required.resolved });
  if (!parsed.ok) return parsed;
  const resolved = parsed.value;
  const binding = resolved.binding;
  if (binding.customerId !== target.accountId || binding.connectionId !== target.connectionId) return failure({ code: "conflict", message: "Google target differs from account binding" });
  if (target.dailyBudget.currency !== binding.currency || campaign.schedule.timezone !== binding.timezone) return failure({ code: "conflict", message: "Google currency or timezone differs from account" });
  if (resolved.creativeId !== campaign.ads[0].creativeId || resolved.creativeDigest !== campaign.creativeDigest) return failure({ code: "conflict", message: "Google creative resolution differs from intent" });
  return translateSearch({ campaign, target, resolved });
}

/** Preserve the selected ad destination, exact-match terms, geography and units;
 * missing mappings reject the whole plan.
 * @complexity O(c+k) time/space, c<=20 countries and k<=50 terms; pure.
 */
function translateSearch(required: { campaign: CampaignTranslationInput["campaign"]; target: CampaignTranslationInput["target"]; resolved: Resolved }): Outcome<SearchPlan> {
  const { campaign, target, resolved } = required;
  if (new Intl.NumberFormat("en", { style: "currency", currency: target.dailyBudget.currency }).resolvedOptions().maximumFractionDigits !== resolved.currencyExponent) return failure({ code: "invalid_input", message: "Google currency exponent differs from account currency units" });
  const locations = new Map(resolved.locations.map(location => [location.country, location.id]));
  if (locations.size !== resolved.locations.length || campaign.audience.countries.some(country => !locations.has(country))) return failure({ code: "invalid_input", message: "Google country identifiers are incomplete or duplicated" });
  const terms = campaign.audience.searchTerms;
  if (!terms?.length) return failure({ code: "invalid_input", message: "Google Search requires explicit search terms" });
  if (!Number.isSafeInteger(target.dailyBudget.minorUnits) || target.dailyBudget.minorUnits <= 0) return failure({ code: "invalid_input", message: "Google daily budget must be positive minor units" });
  const plan = parse<SearchPlan>({ schema: planSchema, input: {
    name: campaign.name, currency: target.dailyBudget.currency,
    averageDailyBudgetMicros: (BigInt(target.dailyBudget.minorUnits) * 10n ** BigInt(6 - resolved.currencyExponent)).toString(),
    cpcBidMicros: resolved.cpcBidMicros, startsAt: campaign.schedule.window.start, endsAt: campaign.schedule.window.end,
    geoTargetIds: campaign.audience.countries.map(country => locations.get(country)), keywords: terms.map(text => ({ text, matchType: "EXACT" })),
    headlines: resolved.headlines, descriptions: resolved.descriptions, finalUrl: campaign.ads[0].destinationUrl, euPoliticalAdvertising: resolved.euPoliticalAdvertising,
  } });
  if (!plan.ok) return plan;
  return validatePlan({ plan: plan.value, binding: resolved.binding });
}

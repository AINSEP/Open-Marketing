import type { NeutralCampaignLaunch, Outcome } from "@open-marketing/contracts";
import { z } from "zod";
import { array, currency, id, micros, numericId, object, parse, failure, success } from "./schema.ts";
import type { Schema } from "./schema.ts";
import { bindingSchema, planSchema } from "./schemas.ts";
import { validatePlan } from "./rules.ts";
import type { AccountBinding, SearchPlan } from "./types.ts";

/** Canonical schema-validated v2 intent; plugins depend only on contracts. */
export interface CampaignTranslationInput {
  campaign: NeutralCampaignLaunch;
  target: Pick<NeutralCampaignLaunch["targets"][number], "accountId" | "connectionId" | "dailyBudget">;
  resolved: unknown;
}
const postalCodeSchema = z.strictObject({
  country: z.string().max(2).regex(/^[A-Z]{2}$/), code: z.string().min(1).max(20),
  id: z.string().min(1).max(19).regex(/^[1-9][0-9]*$/),
});
type Resolved = {
  binding: AccountBinding; currencyExponent: number; creativeId: string; creativeDigest: string;
  locations: { country: string; id: string }[]; postalCodes?: z.infer<typeof postalCodeSchema>[]; cpcBidMicros: string;
  headlines: string[]; descriptions: string[]; finalUrl: string; euPoliticalAdvertising: SearchPlan["euPoliticalAdvertising"];
  additionalCreatives?: (Pick<SearchPlan, "headlines" | "descriptions"> & { creativeId: string })[];
};
const creativeCopy = { headlines: planSchema.properties!.headlines, descriptions: planSchema.properties!.descriptions };
const resolvedSchema = object({ properties: {
  binding: bindingSchema, currencyExponent: { type: "integer", minimum: 0, maximum: 3 }, creativeId: id,
  creativeDigest: { type: "string", pattern: "^[a-f0-9]{64}$", maxLength: 64 },
  locations: array({ items: object({ properties: { country: { ...currency, pattern: "^[A-Z]{2}$", maxLength: 2 }, id: numericId } }), min: 1, max: 20 }),
  postalCodes: array({ items: z.toJSONSchema(postalCodeSchema) as Schema, min: 0, max: 200 }),
  cpcBidMicros: micros, ...creativeCopy,
  additionalCreatives: array({ items: object({ properties: { creativeId: id, ...creativeCopy } }), min: 1, max: 2 }),
  finalUrl: { type: "string", minLength: 8, maxLength: 2048, pattern: "^https://" },
  euPoliticalAdvertising: { type: "string", enum: ["CONTAINS_EU_POLITICAL_ADVERTISING", "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING"] },
}, optional: ["postalCodes", "additionalCreatives"] });

/** Translate parsed neutral intent and validated account/assets into the existing Search plan.
 * @param required - Parsed v2 intent, selected target, and server-resolved metadata (no I/O).
 * @returns A plan for createOperations' PAUSED hierarchy, or a non-retryable typed failure.
 * @example translateCampaign({ campaign: parsedLaunch, target, resolved: accountAndAssets })
 * @complexity O(g+k) time/space, g<=200 locations, k<=50 terms; no effects or activation.
 */
export function translateCampaign(required: CampaignTranslationInput): Outcome<SearchPlan> {
  const { campaign, target } = required;
  if (campaign.ads.length > 3) return failure({ code: "not_implemented", message: "Google supports at most three responsive search ads" });
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
 * @complexity O(g+k) time/space, g<=200 locations and k<=50 terms; pure.
 */
function translateSearch(required: { campaign: CampaignTranslationInput["campaign"]; target: CampaignTranslationInput["target"]; resolved: Resolved }): Outcome<SearchPlan> {
  const { campaign, target, resolved } = required;
  if (new Intl.NumberFormat("en", { style: "currency", currency: target.dailyBudget.currency }).resolvedOptions().maximumFractionDigits !== resolved.currencyExponent) return failure({ code: "invalid_input", message: "Google currency exponent differs from account currency units" });
  const geography = translateGeography({ audience: campaign.audience, resolved });
  if (!geography.ok) return geography;
  const ads = additionalAds({ campaign, resolved });
  if (!ads.ok) return ads;
  const terms = campaign.audience.searchTerms;
  if (!terms?.length) return failure({ code: "invalid_input", message: "Google Search requires explicit search terms" });
  if (!Number.isSafeInteger(target.dailyBudget.minorUnits) || target.dailyBudget.minorUnits <= 0) return failure({ code: "invalid_input", message: "Google daily budget must be positive minor units" });
  const plan = parse<SearchPlan>({ schema: planSchema, input: {
    name: campaign.name, currency: target.dailyBudget.currency,
    averageDailyBudgetMicros: (BigInt(target.dailyBudget.minorUnits) * 10n ** BigInt(6 - resolved.currencyExponent)).toString(),
    ...(campaign.objective === "traffic" ? { cpcBidMicros: resolved.cpcBidMicros } : { objective: campaign.objective }),
    startsAt: campaign.schedule.window.start, endsAt: campaign.schedule.window.end,
    ...geography.value, keywords: terms.map(text => ({ text, matchType: "EXACT" })),
    headlines: resolved.headlines, descriptions: resolved.descriptions, finalUrl: campaign.ads[0].destinationUrl, euPoliticalAdvertising: resolved.euPoliticalAdvertising,
    ...(ads.value === undefined ? {} : { additionalAds: ads.value }),
  } });
  if (!plan.ok) return plan;
  return validatePlan({ plan: plan.value, binding: resolved.binding });
}

/** Bind each later creative exactly once; URLs come only from intent. Missing/extra copies conflict.
 * @complexity O(a²) time, O(a) space, a<=2 additional ads; pure, no asset lookup I/O.
 */
function additionalAds(required: { campaign: CampaignTranslationInput["campaign"]; resolved: Resolved }): Outcome<SearchPlan["additionalAds"]> {
  const creatives = required.resolved.additionalCreatives ?? [];
  const requested = required.campaign.ads.slice(1);
  if (creatives.length !== requested.length) return failure({ code: "conflict", message: "Google creative resolution differs from intent" });
  const ads: NonNullable<SearchPlan["additionalAds"]> = [];
  for (const ad of requested) {
    const matches = creatives.filter(creative => creative.creativeId === ad.creativeId);
    if (matches.length !== 1) return failure({ code: "conflict", message: "Google creative resolution differs from intent" });
    ads.push({ headlines: matches[0].headlines, descriptions: matches[0].descriptions, finalUrl: ad.destinationUrl });
  }
  return success({ value: ads.length === 0 ? undefined : ads });
}

/** Local criteria replace country criteria; incomplete or duplicate resolution fails closed.
 * @complexity O(g) time/space, at most 200 resolved locations; pure, no lookup I/O.
 */
function translateGeography(required: { audience: CampaignTranslationInput["campaign"]["audience"]; resolved: Resolved }): Outcome<Pick<SearchPlan, "geoTargetIds" | "proximity">> {
  const { audience, resolved } = required;
  const local = audience.localTargeting;
  if (local?.kind === "radius") return success({ value: { geoTargetIds: [], proximity: {
    latitudeMicroDegrees: Math.round(local.latitude * 1e6), longitudeMicroDegrees: Math.round(local.longitude * 1e6), radiusKm: local.radiusKm,
  } } });
  const entries = local?.kind === "postal"
    ? (resolved.postalCodes ?? []).filter(entry => entry.country === audience.countries[0]).map(entry => [entry.code, entry.id] as const)
    : resolved.locations.map(entry => [entry.country, entry.id] as const);
  const requested = local?.kind === "postal" ? local.codes : audience.countries;
  const locations = new Map(entries);
  if (locations.size !== entries.length || requested.some(key => !locations.has(key))) return failure({ code: "invalid_input", message: "Google location identifiers are incomplete or duplicated" });
  return success({ value: { geoTargetIds: requested.map(key => locations.get(key)!) } });
}

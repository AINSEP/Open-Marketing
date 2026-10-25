import { z } from "zod";
import { digestSchema, idSchema, parseBoundary } from "@open-marketing/contracts";
import type { Money, Outcome, TimeWindow } from "@open-marketing/contracts";
import { failure, vendorIdSchema } from "./commands.js";
import { campaignDeploymentPlanSchema } from "./campaign-deployment.js";
import type { TikTokPausedPlan } from "./campaign-deployment.js";

/** Canonical neutral subset; caller parses the launch before resolving account/creative metadata. */
export interface CampaignTranslationInput {
  campaign: { name: string; objective: string; schedule: { window: TimeWindow; timezone: string }; audience: { countries: readonly string[]; searchTerms?: readonly string[] }; creativeIds: readonly string[]; creativeDigest: string };
  target: { accountId: string; dailyBudget: Money };
  resolved: unknown;
}
const resolvedSchema = z.strictObject({
  accountId: vendorIdSchema, currency: z.literal("USD"), currencyExponent: z.literal(2), timezone: idSchema,
  creativeId: idSchema, creativeDigest: digestSchema,
  locations: z.array(z.strictObject({ country: z.string().regex(/^[A-Z]{2}$/), id: vendorIdSchema })).min(1).max(20),
  creative: z.strictObject({ adFormat: z.enum(["SINGLE_IMAGE", "SINGLE_VIDEO"]), identityId: idSchema, imageIds: z.array(idSchema).length(1), videoId: idSchema.optional(), text: z.string().min(1).max(100), landingPageUrl: z.string().max(2048) }),
});

/** Pure finite daily website-traffic mapping; every country/account/creative binding must match.
 * @param required - Parsed intent and explicitly resolved USD/exponent-2 account and existing media.
 * @returns Fixed DISABLE plan or typed unsupported, invalid or conflicting input; no I/O.
 * @example translateCampaign({ campaign: parsedLaunch, target, resolved: accountAndCreative })
 * @complexity O(c) time/space, c<=20 countries; no credentials or hidden clock reads.
 */
export function translateCampaign(required: CampaignTranslationInput): Outcome<TikTokPausedPlan> {
  const { campaign, target } = required;
  if (campaign.objective !== "traffic" || campaign.creativeIds.length !== 1 || campaign.audience.searchTerms !== undefined) return failure({ code: "not_implemented", message: "TikTok supports country-only website traffic with one existing creative" });
  const metadata = parseBoundary({ schema: resolvedSchema, input: required.resolved });
  if (!metadata.ok) return failure({ code: "not_implemented", message: "TikTok account, country or creative mapping unsupported" });
  const resolved = metadata.value;
  const bindings = resolvedLocations({ campaign, target, resolved });
  if (!bindings.ok) return bindings;
  const locations = bindings.value;
  const budget = target.dailyBudget.minorUnits / 100;
  if (!Number.isSafeInteger(target.dailyBudget.minorUnits) || Math.round(budget * 100) !== target.dailyBudget.minorUnits) return failure({ code: "invalid_input", message: "TikTok budget cannot be represented exactly" });
  const schedule = utcSchedule({ window: campaign.schedule.window });
  if (!schedule.ok) return schedule;
  return parseBoundary({ schema: campaignDeploymentPlanSchema, input: {
    campaign: { kind: "create-campaign-paused", name: campaign.name, budget },
    adgroup: { kind: "create-adgroup-paused", name: campaign.name, campaignId: { from: "campaign" }, budget, locationIds: campaign.audience.countries.map(country => locations.get(country)), ...schedule.value },
    ad: { kind: "create-ad-paused", name: campaign.name, adgroupId: { from: "adgroup" }, identityType: "CUSTOMIZED_USER", ...resolved.creative },
  } });
}
/** Exact account/currency/timezone/creative/country binding; no inferred vendor locations. O(c). */
function resolvedLocations(required: { campaign: CampaignTranslationInput["campaign"]; target: CampaignTranslationInput["target"]; resolved: z.infer<typeof resolvedSchema> }): Outcome<Map<string, string>> {
  const { campaign, target, resolved } = required;
  if (target.accountId !== resolved.accountId || target.dailyBudget.currency !== resolved.currency || campaign.schedule.timezone !== resolved.timezone) return failure({ code: "conflict", message: "TikTok account, currency or timezone differs" });
  if (campaign.creativeIds[0] !== resolved.creativeId || campaign.creativeDigest !== resolved.creativeDigest) return failure({ code: "conflict", message: "TikTok creative differs from intent" });
  const locations = new Map(resolved.locations.map(location => [location.country, location.id]));
  if (locations.size !== resolved.locations.length || !countriesMatch({ countries: campaign.audience.countries, locations })) return failure({ code: "not_implemented", message: "TikTok country mapping must be exact" });
  return { ok: true, value: locations };
}
/** Reject incomplete/extra mappings and duplicate country intent rather than silently widening. O(c). */
function countriesMatch(required: { countries: readonly string[]; locations: Map<string, string> }): boolean {
  return required.countries.length === required.locations.size && new Set(required.countries).size === required.countries.length && required.countries.every(country => required.locations.has(country));
}
/** Vendor accepts UTC seconds; reject precision loss instead of rounding the reviewed window. O(1). */
function utcSchedule(required: { window: TimeWindow }): Outcome<{ scheduleStart: string; scheduleEnd: string }> {
  const times = [required.window.start, required.window.end];
  if (!times.every(time => Number.isSafeInteger(time) && time >= 0 && time % 1000 === 0 && time <= 2145916800000)) return failure({ code: "not_implemented", message: "TikTok finite schedule requires exact UTC seconds before 2038" });
  const [scheduleStart, scheduleEnd] = times.map(time => new Date(time).toISOString().slice(0, 19).replace("T", " "));
  return { ok: true, value: { scheduleStart, scheduleEnd } };
}

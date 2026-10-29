import { z } from "zod";
import type { CallContext, CallOptions, NeutralCampaignLaunch, Outcome, PluginCapabilityDependencies } from "@open-marketing/contracts";
import { digestSchema, idSchema } from "@open-marketing/contracts";
import { vendorIdSchema } from "./commands.js";
import { campaignDeploymentPlanSchema } from "./campaign-deployment.js";
import { digest, failure, parse } from "./boundary.js";
import { adsGraphVersion, createConfiguredDispatch } from "./instagram-fetch.js";
import type { MetaInstagramDispatch } from "./instagram.js";
import { boundContext } from "./read-capabilities.js";

/** Canonical schema-validated v2 intent; plugins depend only on contracts. */
export interface CampaignTranslationInput {
  campaign: NeutralCampaignLaunch;
  target: Pick<NeutralCampaignLaunch["targets"][number], "connectionId" | "accountId" | "dailyBudget">;
  resolved: unknown;
  context: CallContext;
  dependencies: PluginCapabilityDependencies;
}
/** Fixed parent slots accept only earlier acknowledged IDs; these are not executable commands. */
export type MetaPausedPlan = z.infer<typeof campaignDeploymentPlanSchema>;
const resolvedSchema = z.strictObject({
  accountId: vendorIdSchema, currency: z.literal("USD"), currencyExponent: z.literal(2), timezone: idSchema,
  creativeId: idSchema, creativeDigest: digestSchema, vendorCreativeId: vendorIdSchema,
  ageMin: z.number().int().min(18).max(65), ageMax: z.number().int().min(18).max(65),
  specialAdCategories: z.array(z.never()).max(0),
});

/** Website-traffic translation; only explicitly resolved USD offset-100 fixtures are supported.
 * @param required - Parsed v2 intent, target, account/creative metadata and call-scoped guarded dependencies.
 * @param optional - Caller cancellation, shared with every postal lookup.
 * @returns A fixed PAUSED plan or a typed validation, binding or transport failure.
 * The destination is bound into the plan; deployment proves it with a scoped creative GET.
 * @example await translateCampaign({ campaign: parsedLaunch, target, resolved: accountAndCreative, context, dependencies })
 * @complexity ≤200 sequential GETs, ≤30 s, ≤1 MiB each; O(p log p) sorting, O(p) keys; no writes.
 */
export async function translateCampaign(required: CampaignTranslationInput, optional?: CallOptions): Promise<Outcome<MetaPausedPlan>> {
  const { campaign, target } = required;
  if (campaign.objective !== "traffic" || campaign.ads.length !== 1 || campaign.audience.searchTerms !== undefined) return failure({ code: "not_implemented", message: "Meta supports traffic with one existing single-link creative" });
  const metadata = parse({ schema: resolvedSchema, input: required.resolved });
  if (!metadata.ok) return metadata;
  const resolved = metadata.value;
  if (target.accountId !== resolved.accountId || target.dailyBudget.currency !== resolved.currency || campaign.schedule.timezone !== resolved.timezone) return failure({ code: "conflict", message: "Meta account, currency or timezone differs" });
  if (campaign.ads[0].creativeId !== resolved.creativeId || campaign.creativeDigest !== resolved.creativeDigest) return failure({ code: "conflict", message: "Meta creative differs from intent" });
  const geography = await translateGeography(required, optional);
  if (!geography.ok) return geography;
  return parse({ schema: campaignDeploymentPlanSchema, input: {
    campaign: { kind: "create-campaign", name: campaign.name, objective: "OUTCOME_TRAFFIC", specialAdCategories: resolved.specialAdCategories },
    adset: { kind: "create-adset", name: campaign.name, campaignId: { from: "campaign" },
      targeting: { ...geography.value, age_min: resolved.ageMin, age_max: resolved.ageMax },
      billingEvent: "IMPRESSIONS", optimizationGoal: "LINK_CLICKS", dailyBudgetMinor: target.dailyBudget.minorUnits, schedule: campaign.schedule.window },
    ad: { kind: "create-ad", name: campaign.name, creativeId: resolved.vendorCreativeId, adsetId: { from: "adset" }, destinationUrl: campaign.ads[0].destinationUrl },
  } });
}

/** Local criteria replace countries; postal lookup binds the selected scope/account before I/O.
 * @complexity ≤200 sequential GETs, ≤30 s, ≤1 MiB each; O(p log p) sorting, O(p) keys; inputs unchanged.
 */
async function translateGeography(required: CampaignTranslationInput, optional?: CallOptions): Promise<Outcome<
  Required<Pick<MetaPausedPlan["adset"]["targeting"], "countries">> |
  Required<Pick<MetaPausedPlan["adset"]["targeting"], "zips">> |
  Required<Pick<MetaPausedPlan["adset"]["targeting"], "custom_locations">>>> {
  const { audience } = required.campaign;
  const local = audience.localTargeting;
  if (local?.kind === "radius") {
    if (local.radiusKm < 1 || local.radiusKm > 80) return failure({ code: "invalid_input", message: "Meta radius must be 1–80 km" });
    return { ok: true, value: { custom_locations: [{ latitude: local.latitude, longitude: local.longitude, radius: local.radiusKm, distance_unit: "kilometer" }] } };
  }
  if (local?.kind !== "postal") return { ok: true, value: { countries: audience.countries } };
  const configured = createConfiguredDispatch(required.dependencies);
  if (!configured.ok) return configured;
  const { configuration, dispatch } = configured.value;
  const { scope, connectionId, accountId } = configuration;
  const context = boundContext({ binding: { scope, connectionId, accountId }, call: { context: required.context,
    connection: { connectionId: required.target.connectionId, accountId: required.target.accountId } } });
  if (!context.ok) return context;
  const zips = await resolvePostalKeys({ dispatch, context: context.value, connectionId, accountId, codes: local.codes, country: audience.countries[0] }, optional);
  if (!zips.ok) return zips;
  return { ok: true, value: { zips: zips.value.sort((a, b) => a.key.localeCompare(b.key)) } };
}

const postalSearchSchema = z.object({ data: z.array(z.object({
  key: z.string().min(1).max(64), name: z.string(), type: z.string(), country_code: z.string(),
})).max(100) });

/** Resolve every code to exactly one in-country zip; partial results and descriptive fields are discarded.
 * Returns fixed invalid_input messages or the transport failure; guarded fetch owns egress audit.
 * @complexity ≤200 sequential GETs, ≤30 s, ≤1 MiB each, ≤100 rows per response; O(p) retained keys.
 */
async function resolvePostalKeys(required: { dispatch: MetaInstagramDispatch; context: CallContext; connectionId: string; accountId: string; codes: readonly string[]; country: string }, optional?: CallOptions): Promise<Outcome<NonNullable<MetaPausedPlan["adset"]["targeting"]["zips"]>>> {
  const { context, connectionId, accountId, country } = required;
  const signal = AbortSignal.any([AbortSignal.timeout(30000), ...(optional?.signal ? [optional.signal] : [])]);
  const zips: NonNullable<MetaPausedPlan["adset"]["targeting"]["zips"]> = [];
  for (const q of required.codes) {
    const response = await required.dispatch({ context, connectionId, operationId: context.correlationId,
      effect: { operationId: context.correlationId, connectionId, accountId, effects: ["read"], argumentsDigest: digest({ value: { q, country } }), moneyExposure: null, requiredLimit: null },
      request: { method: "GET", endpoint: `https://graph.facebook.com/${adsGraphVersion}/search`,
        parameters: { type: "adgeolocation", location_types: '["zip"]', q, country_code: country, limit: "100" } }, timeoutMs: 15000,
    }, { signal });
    if (!response.ok) return response;
    const result = postalSearchSchema.safeParse(response.value);
    if (!result.success) return failure({ code: "invalid_input", message: "Invalid Meta targeting search response" });
    const matches = result.data.data.filter(row => row.type === "zip" && row.country_code === country && row.name.trim().toUpperCase() === q.toUpperCase());
    if (matches.length === 0) return failure({ code: "invalid_input", message: "Meta postal code not found" });
    if (matches.length !== 1) return failure({ code: "invalid_input", message: "Meta postal code ambiguous" });
    zips.push({ key: matches[0].key });
  }
  return { ok: true, value: zips };
}

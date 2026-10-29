import type { CallContext, Outcome } from "@open-marketing/contracts";
import { z } from "zod";
import { failure, parse, success, bool, currency, numericId, object, text } from "./schema.ts";
import { campaignDeploymentPlanSchema, hierarchySchema, planSchema } from "./schemas.ts";
import { digest, googleDateTime, objectiveGoal, validateHierarchy } from "./rules.ts";
import type { AccountBinding, GooglePluginDependencies, Hierarchy, SearchPlan } from "./types.ts";

type Row = Record<string, unknown>;
const conversionGoalSchema = z.object({ category: z.string().regex(/^[A-Z_]{1,64}$/), origin: z.string().regex(/^[A-Z_]{1,64}$/) });
const campaignGoalsSchema = z.array(conversionGoalSchema.extend({ biddable: z.boolean() })).max(200);
const goalConfigSchema = z.array(z.object({ goalConfigLevel: z.literal("CAMPAIGN"), customConversionGoal: z.literal("").optional() })).length(1);
/** Vendor result envelope is bounded; any pagination/partial failure stays explicit. */
export function searchRows(required: { value: unknown }): Outcome<Row[]> {
  const value = asRecord({ value: required.value });
  if (!required.value || typeof required.value !== "object" || Array.isArray(required.value)) return failure({ code: "invalid_input", message: "Invalid Google response envelope" });
  if (!validSearchEnvelope({ value })) return failure({ code: "invalid_input", message: "Malformed Google response envelope" });
  if (value.nextPageToken || value.partialFailureError) return failure({ code: "limit_exceeded", message: "Search result is incomplete" });
  const rows = value.results ?? [];
  if (!Array.isArray(rows) || rows.length > 200) return failure({ code: "invalid_input", message: "Invalid Google search response" });
  if (rows.some(row => !row || typeof row !== "object" || Array.isArray(row))) return failure({ code: "invalid_input", message: "Invalid Google search row" });
  return success({ value: rows as Row[] });
}
function validSearchEnvelope(required: { value: Row }): boolean {
  const allowed = ["results", "nextPageToken", "fieldMask", "totalResultsCount", "summaryRow", "queryResourceConsumption"];
  if (Object.keys(required.value).some(key => !allowed.includes(key))) return false;
  if (["nextPageToken", "fieldMask"].some(key => required.value[key] !== undefined && typeof required.value[key] !== "string")) return false;
  if (required.value.summaryRow !== undefined) return false;
  return true;
}
/** Fixed GAQL only, never caller query text. IDs/markers originate in validated schemas. */
export async function search(required: { dependencies: GooglePluginDependencies; context: CallContext; operationId: string; query: string }): Promise<Outcome<Row[]>> {
  const result = await required.dependencies.transport.request({ method: "search", body: { query: required.query }, context: required.context, operationId: required.operationId });
  if (!result.ok) return result;
  return searchRows({ value: result.value });
}
/** Scoped account evidence is read from Google, not user configuration. */
export async function readAccount(required: { dependencies: GooglePluginDependencies; context: CallContext; operationId: string }): Promise<Outcome<{ customerId: string; currency: string; timezone: string; testAccount: boolean }>> {
  const rows = await search({ ...required, query: "SELECT customer.id, customer.currency_code, customer.time_zone, customer.test_account FROM customer" });
  if (!rows.ok) return rows;
  if (rows.value.length !== 1) return failure({ code: "conflict", message: "Expected one scoped account" });
  const customer = asRecord({ value: rows.value[0].customer });
  const result = parse<{ customerId: string; currency: string; timezone: string; testAccount: boolean }>({ schema: object({ properties: { customerId: { ...numericId, minLength: 10, maxLength: 10 }, currency, timezone: text, testAccount: bool } }), input: { customerId: String(customer.id), currency: customer.currencyCode, timezone: customer.timeZone, testAccount: customer.testAccount } });
  if (!result.ok) return result;
  if (!accountMatches({ binding: required.dependencies.binding, account: result.value })) return failure({ code: "forbidden", message: "Google account differs from server binding" });
  return result;
}
function accountMatches(required: { binding: AccountBinding; account: { customerId: string; currency: string; timezone: string; testAccount: boolean } }): boolean {
  const { binding, account } = required;
  return binding.customerId === account.customerId && binding.currency === account.currency && binding.timezone === account.timezone;
}
/** Complete account category/origin evidence; malformed or repeated pairs refuse before mutation.
 * @example readConversionGoals({ dependencies, context, operationId })
 * @complexity One bounded search, O(g) time/space, g<=200; no pagination or retries.
 */
export async function readConversionGoals(required: { dependencies: GooglePluginDependencies; context: CallContext; operationId: string }): Promise<Outcome<z.infer<typeof conversionGoalSchema>[]>> {
  const rows = await search({ ...required, query: "SELECT customer_conversion_goal.category, customer_conversion_goal.origin FROM customer_conversion_goal" });
  if (!rows.ok) return rows;
  const goals = z.array(conversionGoalSchema).max(200).safeParse(rows.value.map(row => row.customerConversionGoal));
  if (!goals.success) return failure({ code: "invalid_input", message: "Malformed account conversion goals" });
  if (new Set(goals.data.map(goal => goal.category + "~" + goal.origin)).size !== goals.data.length) return failure({ code: "invalid_input", message: "Duplicate account conversion goals" });
  return success({ value: goals.data });
}
/** Read the entire bounded OM hierarchy and configuration; empty/extra children fail closed.
 * @complexity Six fixed queries, plus two for optimized bidding; up to 200 rows per query, no per-item I/O. */
export async function readHierarchy(required: { dependencies: GooglePluginDependencies; context: CallContext; operationId: string; campaignId?: string; marker?: string }): Promise<Outcome<Hierarchy>> {
  const account = await readAccount(required);
  if (!account.ok) return account;
  const filter = required.campaignId ? "campaign.id = " + required.campaignId : "campaign.name = '" + required.marker + "'";
  const campaigns = await search({ ...required, query: campaignQuery({ filter }) });
  if (!campaigns.ok) return campaigns;
  if (campaigns.value.length !== 1) return failure({ code: "conflict", message: "Campaign missing or stable marker has multiple matches" });
  const row = campaigns.value[0];
  const campaign = asRecord({ value: row.campaign });
  const campaignId = String(campaign.id);
  const idCheck = parse<string>({ schema: numericId, input: campaignId });
  if (!idCheck.ok) return idCheck;
  const children = await readChildren({ ...required, campaignId });
  if (!children.ok) return children;
  const goals = await verifyConversionGoals({ ...required, campaignId, campaign });
  if (!goals.ok) return goals;
  return projectHierarchy({ ...required, row, children: children.value, account: account.value });
}
function campaignQuery(required: { filter: string }): string {
  return "SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign.manual_cpc, campaign.bidding_strategy_type, campaign.bidding_strategy, campaign.maximize_conversions.target_cpa_micros, campaign.maximize_conversion_value.target_roas, campaign.start_date_time, campaign.end_date_time, campaign.contains_eu_political_advertising, campaign.geo_target_type_setting.positive_geo_target_type, campaign.geo_target_type_setting.negative_geo_target_type, campaign.network_settings.target_google_search, campaign.network_settings.target_partner_search_network, campaign.network_settings.target_search_network, campaign.network_settings.target_content_network, campaign_budget.id, campaign_budget.amount_micros, campaign_budget.explicitly_shared, campaign_budget.period FROM campaign WHERE " + required.filter;
}
/** Standard, target-free optimized strategies only; undefined also denotes legacy manual CPC. Pure O(1). */
function optimizedObjective(required: { campaign: Row }): SearchPlan["objective"] {
  const { campaign } = required;
  if (campaign.biddingStrategy) return undefined;
  const targets = [asRecord({ value: campaign.maximizeConversions }).targetCpaMicros, asRecord({ value: campaign.maximizeConversionValue }).targetRoas];
  if (targets.some(target => target !== undefined && target !== 0 && target !== "0")) return undefined;
  return (["leads", "sales"] as const).find(objective => objectiveGoal[objective].strategy === campaign.biddingStrategyType);
}
/** Optimized readback requires explicit campaign goals, including every unrelated pair disabled.
 * Newly auto-created biddable goals block acknowledgement/activation. Traffic makes no extra reads.
 * @complexity Two fixed searches, O(g) time/space, g<=200; incomplete evidence fails closed.
 */
async function verifyConversionGoals(required: { dependencies: GooglePluginDependencies; context: CallContext; operationId: string; campaignId: string; campaign: Row }): Promise<Outcome<undefined>> {
  const objective = optimizedObjective(required);
  if (!objective) return success({ value: undefined });
  const resource = `customers/${required.dependencies.binding.customerId}/campaigns/${required.campaignId}`;
  const rows = await search({ ...required, query: `SELECT campaign_conversion_goal.category, campaign_conversion_goal.origin, campaign_conversion_goal.biddable FROM campaign_conversion_goal WHERE campaign_conversion_goal.campaign = '${resource}'` });
  if (!rows.ok) return rows;
  const config = await search({ ...required, query: `SELECT conversion_goal_campaign_config.goal_config_level, conversion_goal_campaign_config.custom_conversion_goal FROM conversion_goal_campaign_config WHERE conversion_goal_campaign_config.campaign = '${resource}'` });
  if (!config.ok) return config;
  if (!goalConfigSchema.safeParse(config.value.map(row => row.conversionGoalCampaignConfig)).success) return failure({ code: "conflict", message: "Campaign-specific goals without a custom goal are required" });
  const goals = campaignGoalsSchema.safeParse(rows.value.map(row => row.campaignConversionGoal));
  if (!goals.success) return failure({ code: "conflict", message: "Malformed campaign conversion goals" });
  const selected = objectiveGoal[objective];
  const keys = new Set(goals.data.map(goal => goal.category + "~" + goal.origin));
  if (keys.size !== goals.data.length || !keys.has(selected.category + "~" + selected.origin)) return failure({ code: "conflict", message: "Selected conversion goal is missing or goals are duplicated" });
  if (goals.data.some(goal => goal.biddable !== (goal.category === selected.category && goal.origin === selected.origin))) return failure({ code: "conflict", message: "Campaign conversion goal biddability changed" });
  return success({ value: undefined });
}
async function readChildren(required: { dependencies: GooglePluginDependencies; context: CallContext; operationId: string; campaignId: string }): Promise<Outcome<{ groups: Row[]; ads: Row[]; keywords: Row[]; locations: Row[] }>> {
  const filter = " WHERE campaign.id = " + required.campaignId;
  const groups = await search({ ...required, query: "SELECT ad_group.id, ad_group.status, ad_group.cpc_bid_micros FROM ad_group" + filter });
  if (!groups.ok) return groups;
  const ads = await search({ ...required, query: "SELECT ad_group.id, ad_group_ad.status, ad_group_ad.ad.id, ad_group_ad.ad.final_urls, ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.responsive_search_ad.descriptions FROM ad_group_ad" + filter });
  if (!ads.ok) return ads;
  const keywords = await search({ ...required, query: "SELECT ad_group.id, ad_group_criterion.criterion_id, ad_group_criterion.status, ad_group_criterion.type, ad_group_criterion.negative, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type FROM ad_group_criterion" + filter });
  if (!keywords.ok) return keywords;
  const locations = await search({ ...required, query: "SELECT campaign_criterion.type, campaign_criterion.negative, campaign_criterion.location.geo_target_constant, campaign_criterion.proximity.geo_point.latitude_in_micro_degrees, campaign_criterion.proximity.geo_point.longitude_in_micro_degrees, campaign_criterion.proximity.radius, campaign_criterion.proximity.radius_units FROM campaign_criterion" + filter });
  if (!locations.ok) return locations;
  return success({ value: { groups: groups.value, ads: ads.value, keywords: keywords.value, locations: locations.value } });
}
function projectHierarchy(required: { dependencies: GooglePluginDependencies; row: Row; children: { groups: Row[]; ads: Row[]; keywords: Row[]; locations: Row[] }; account: { customerId: string; currency: string; timezone: string; testAccount: boolean } }): Outcome<Hierarchy> {
  const { children, account, row } = required;
  if (children.groups.length !== 1 || children.ads.length < 1 || children.ads.length > 3) return failure({ code: "conflict", message: "Expected one controlled group and one to three RSAs" });
  const campaign = asRecord({ value: row.campaign });
  if (!supportedControls({ campaign, children })) return failure({ code: "unavailable", message: "Unsupported bidding, network or targeting control" });
  const budget = asRecord({ value: row.campaignBudget });
  const group = asRecord({ value: children.groups[0].adGroup });
  const ads = projectAds({ rows: children.ads, groupId: group.id });
  const dates = parseFlight({ campaign, timezone: account.timezone });
  if (!dates.ok) return dates;
  const geography = projectGeography({ rows: children.locations });
  if (!geography.ok) return geography;
  const objective = optimizedObjective({ campaign });
  const plan = parse<SearchPlan>({ schema: planSchema, input: {
    name: campaign.name, currency: account.currency, averageDailyBudgetMicros: budget.amountMicros,
    ...(objective ? { objective } : { cpcBidMicros: group.cpcBidMicros }),
    ...dates.value, ...geography.value,
    keywords: children.keywords.map(row => asRecord({ value: asRecord({ value: row.adGroupCriterion }).keyword })),
    ...ads.plan,
    euPoliticalAdvertising: campaign.containsEuPoliticalAdvertising,
  } });
  if (!plan.ok) return plan;
  const network = asRecord({ value: campaign.networkSettings });
  const hierarchy = parse<Hierarchy>({ schema: hierarchySchema, input: {
    ...account, campaignId: String(campaign.id), budgetId: String(budget.id), name: campaign.name, status: campaign.status,
    channel: campaign.advertisingChannelType, searchPartners: network.targetSearchNetwork ?? false, displayNetwork: network.targetContentNetwork ?? false,
    averageDailyBudgetMicros: budget.amountMicros, sharedBudget: budget.explicitlyShared ?? false, period: budget.period,
    ...dates.value, childIds: ["group:" + group.id, ...ads.childIds, ...children.keywords.map(row => "keyword:" + asRecord({ value: row.adGroup }).id + "~" + asRecord({ value: row.adGroupCriterion }).criterionId)],
    childStatuses: [group.status, ...ads.childStatuses, ...children.keywords.map(row => asRecord({ value: row.adGroupCriterion }).status)],
    observedAt: required.dependencies.clock.now({}), planDigest: planDigest({ plan: plan.value }),
  } });
  if (!hierarchy.ok) return hierarchy;
  return validateHierarchy({ binding: required.dependencies.binding, hierarchy: hierarchy.value });
}
/** Project bounded RSA rows and serving evidence for the owning plan/hierarchy schemas to parse.
 * Single-ad projections omit additionalAds. O(a) time/space, a<=3; no effects.
 */
function projectAds(required: { rows: Row[]; groupId: unknown }) {
  const ads = required.rows.map(row => {
    const adGroupAd = asRecord({ value: row.adGroupAd });
    const ad = asRecord({ value: adGroupAd.ad });
    const rsa = asRecord({ value: ad.responsiveSearchAd });
    return { copy: {
      headlines: assetTexts({ value: rsa.headlines }), descriptions: assetTexts({ value: rsa.descriptions }),
      finalUrl: Array.isArray(ad.finalUrls) && ad.finalUrls.length === 1 ? ad.finalUrls[0] : undefined,
    }, childId: "ad:" + required.groupId + "~" + ad.id, status: adGroupAd.status };
  });
  return {
    plan: { ...ads[0].copy, ...(ads.length > 1 ? { additionalAds: ads.slice(1).map(ad => ad.copy) } : {}) },
    childIds: ads.map(ad => ad.childId), childStatuses: ads.map(ad => ad.status),
  };
}
/** Reconstruct serving geography only; Google's descriptive proximity address is ignored.
 * Malformed/ambiguous proximity or unsupported units fail closed. O(g) time/space, g<=200.
 */
function projectGeography(required: { rows: Row[] }): Outcome<Pick<SearchPlan, "geoTargetIds" | "proximity">> {
  const criteria = required.rows.map(row => asRecord({ value: row.campaignCriterion }));
  const geoTargetIds = criteria.filter(criterion => criterion.type === "LOCATION")
    .map(criterion => String(asRecord({ value: criterion.location }).geoTargetConstant).split("/").at(-1)!).sort();
  const proximities = criteria.filter(criterion => criterion.type === "PROXIMITY");
  if (proximities.length > 1) return failure({ code: "conflict", message: "Multiple proximity criteria are unsupported" });
  if (proximities.length === 0) return success({ value: { geoTargetIds } });
  const proximity = asRecord({ value: proximities[0].proximity });
  if (proximity.radiusUnits !== "KILOMETERS") return failure({ code: "unavailable", message: "Unsupported proximity radius units" });
  const point = asRecord({ value: proximity.geoPoint });
  const parsed = campaignDeploymentPlanSchema.shape.proximity.safeParse({
    latitudeMicroDegrees: point.latitudeInMicroDegrees, longitudeMicroDegrees: point.longitudeInMicroDegrees, radiusKm: proximity.radius,
  });
  if (!parsed.success) return failure({ code: "invalid_input", message: "Malformed proximity criterion" });
  return success({ value: { geoTargetIds, proximity: parsed.data } });
}
/** Normalize set-valued inputs and complete multi-ad records, preserving multiplicity and copy/URL binding.
 * Single-ad bytes retain the original digest expression. O(n log n) time/O(n) space for bounded plan arrays.
 * @example planDigest({ plan: parsedSearchPlan })
 */
export function planDigest(required: { plan: SearchPlan }): string {
  if (!required.plan.additionalAds) return digest({ value: { ...required.plan, geoTargetIds: [...required.plan.geoTargetIds].sort(), keywords: [...required.plan.keywords].sort((left, right) => (left.matchType + left.text).localeCompare(right.matchType + right.text)), headlines: [...required.plan.headlines].sort(), descriptions: [...required.plan.descriptions].sort() } });
  const { headlines, descriptions, finalUrl, additionalAds, ...rest } = required.plan;
  // Fixed alphabetical keys make each normalized record's JSON canonical before sorting.
  const ads = [{ headlines, descriptions, finalUrl }, ...additionalAds].map(ad => ({
    descriptions: [...ad.descriptions].sort(), finalUrl: ad.finalUrl, headlines: [...ad.headlines].sort(),
  })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return digest({ value: { ...rest, geoTargetIds: [...rest.geoTargetIds].sort(), keywords: [...rest.keywords].sort((left, right) => (left.matchType + left.text).localeCompare(right.matchType + right.text)), ads } });
}
function assetTexts(required: { value: unknown }): unknown[] {
  if (!Array.isArray(required.value)) return [];
  return required.value.map(asset => asRecord({ value: asset }).text);
}
function supportedControls(required: { campaign: Row; children: { keywords: Row[]; locations: Row[] } }): boolean {
  const network = asRecord({ value: required.campaign.networkSettings });
  const geo = asRecord({ value: required.campaign.geoTargetTypeSetting });
  const keywordsSupported = required.children.keywords.every(row => !asRecord({ value: row.adGroupCriterion }).negative && asRecord({ value: row.adGroupCriterion }).type === "KEYWORD");
  const locationsSupported = required.children.locations.every(row => !asRecord({ value: row.campaignCriterion }).negative && ["LOCATION", "PROXIMITY"].includes(asRecord({ value: row.campaignCriterion }).type as string));
  const biddingSupported = Object.hasOwn(required.campaign, "manualCpc") || optimizedObjective(required) !== undefined;
  return biddingSupported && network.targetGoogleSearch === true && !network.targetPartnerSearchNetwork
    && geo.positiveGeoTargetType === "PRESENCE" && geo.negativeGeoTargetType === "PRESENCE" && keywordsSupported && locationsSupported;
}
function parseFlight(required: { campaign: Row; timezone: string }): Outcome<{ startsAt: number; endsAt: number }> {
  const start = localInstant({ value: required.campaign.startDateTime, timezone: required.timezone });
  if (!start.ok) return start;
  const end = localInstant({ value: required.campaign.endDateTime, timezone: required.timezone });
  if (!end.ok) return end;
  return success({ value: { startsAt: start.value, endsAt: end.value } });
}
/** Converts account-local wall time deterministically; impossible DST times are rejected. */
export function localInstant(required: { value: unknown; timezone: string }): Outcome<number> {
  if (typeof required.value !== "string" || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(required.value)) return failure({ code: "invalid_input", message: "Missing Google flight datetime" });
  const wall = Date.parse(required.value.replace(" ", "T") + "Z");
  if (!Number.isFinite(wall)) return failure({ code: "invalid_input", message: "Invalid campaign calendar date" });
  let instant = wall;
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const rendered = googleDateTime({ epoch: instant, timezone: required.timezone });
    instant += wall - Date.parse(rendered.replace(" ", "T") + "Z");
  }
  if (googleDateTime({ epoch: instant, timezone: required.timezone }) !== required.value) return failure({ code: "invalid_input", message: "Ambiguous or invalid campaign datetime" });
  return success({ value: instant });
}
/** Tainted missing objects project to empty records and fail the owning schema. */
export function asRecord(required: { value: unknown }): Row {
  if (!required.value || typeof required.value !== "object" || Array.isArray(required.value)) return {};
  return required.value as Row;
}

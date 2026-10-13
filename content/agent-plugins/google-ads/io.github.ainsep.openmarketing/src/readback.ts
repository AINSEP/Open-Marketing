import type { CallContext, Outcome } from "@open-marketing/contracts";
import { failure, parse, success, bool, currency, numericId, object, text } from "./schema.ts";
import { hierarchySchema, planSchema } from "./schemas.ts";
import { digest, googleDateTime, validateHierarchy } from "./rules.ts";
import type { AccountBinding, GooglePluginDependencies, Hierarchy, SearchPlan } from "./types.ts";

type Row = Record<string, unknown>;
/** Vendor result envelope is bounded; any pagination/partial failure stays explicit. */
export function searchRows(required: { value: unknown }): Outcome<Row[]> {
  const value = asRecord({ value: required.value });
  if (!required.value || typeof required.value !== "object" || Array.isArray(required.value)) return failure({ code: "invalid_input", message: "Invalid Google response envelope" });
  if (!validSearchEnvelope({ value })) return failure({ code: "invalid_input", message: "Malformed Google response envelope" });
  if (value.nextPageToken || value.partialFailureError) return failure({ code: "limit_exceeded", message: "Search result is incomplete" });
  const rows = value.results ?? [];
  if (!Array.isArray(rows) || rows.length > 100) return failure({ code: "invalid_input", message: "Invalid Google search response" });
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
/** Read the entire bounded OM hierarchy and configuration; empty/extra children fail closed.
 * @complexity Six fixed queries; up to 50 keywords and 20 locations, no per-item I/O. */
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
  return projectHierarchy({ ...required, row, children: children.value, account: account.value });
}
function campaignQuery(required: { filter: string }): string {
  return "SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign.manual_cpc, campaign.start_date_time, campaign.end_date_time, campaign.contains_eu_political_advertising, campaign.geo_target_type_setting.positive_geo_target_type, campaign.geo_target_type_setting.negative_geo_target_type, campaign.network_settings.target_google_search, campaign.network_settings.target_partner_search_network, campaign.network_settings.target_search_network, campaign.network_settings.target_content_network, campaign_budget.id, campaign_budget.amount_micros, campaign_budget.explicitly_shared, campaign_budget.period FROM campaign WHERE " + required.filter;
}
async function readChildren(required: { dependencies: GooglePluginDependencies; context: CallContext; operationId: string; campaignId: string }): Promise<Outcome<{ groups: Row[]; ads: Row[]; keywords: Row[]; locations: Row[] }>> {
  const filter = " WHERE campaign.id = " + required.campaignId;
  const groups = await search({ ...required, query: "SELECT ad_group.id, ad_group.status, ad_group.cpc_bid_micros FROM ad_group" + filter });
  if (!groups.ok) return groups;
  const ads = await search({ ...required, query: "SELECT ad_group.id, ad_group_ad.status, ad_group_ad.ad.id, ad_group_ad.ad.final_urls, ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.responsive_search_ad.descriptions FROM ad_group_ad" + filter });
  if (!ads.ok) return ads;
  const keywords = await search({ ...required, query: "SELECT ad_group.id, ad_group_criterion.criterion_id, ad_group_criterion.status, ad_group_criterion.type, ad_group_criterion.negative, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type FROM ad_group_criterion" + filter });
  if (!keywords.ok) return keywords;
  const locations = await search({ ...required, query: "SELECT campaign_criterion.type, campaign_criterion.negative, campaign_criterion.location.geo_target_constant FROM campaign_criterion" + filter });
  if (!locations.ok) return locations;
  return success({ value: { groups: groups.value, ads: ads.value, keywords: keywords.value, locations: locations.value } });
}
function projectHierarchy(required: { dependencies: GooglePluginDependencies; row: Row; children: { groups: Row[]; ads: Row[]; keywords: Row[]; locations: Row[] }; account: { customerId: string; currency: string; timezone: string; testAccount: boolean } }): Outcome<Hierarchy> {
  const { children, account, row } = required;
  if (children.groups.length !== 1 || children.ads.length !== 1) return failure({ code: "conflict", message: "Expected exactly one controlled group and RSA" });
  const campaign = asRecord({ value: row.campaign });
  if (!supportedControls({ campaign, children })) return failure({ code: "unavailable", message: "Unsupported bidding, network or targeting control" });
  const budget = asRecord({ value: row.campaignBudget });
  const group = asRecord({ value: children.groups[0].adGroup });
  const adGroupAd = asRecord({ value: children.ads[0].adGroupAd });
  const ad = asRecord({ value: adGroupAd.ad });
  const rsa = asRecord({ value: ad.responsiveSearchAd });
  const dates = parseFlight({ campaign, timezone: account.timezone });
  if (!dates.ok) return dates;
  const plan = parse<SearchPlan>({ schema: planSchema, input: {
    name: campaign.name, currency: account.currency, averageDailyBudgetMicros: budget.amountMicros, cpcBidMicros: group.cpcBidMicros,
    ...dates.value, geoTargetIds: children.locations.map(row => String(asRecord({ value: asRecord({ value: row.campaignCriterion }).location }).geoTargetConstant).split("/").at(-1)).sort(),
    keywords: children.keywords.map(row => asRecord({ value: asRecord({ value: row.adGroupCriterion }).keyword })),
    headlines: assetTexts({ value: rsa.headlines }), descriptions: assetTexts({ value: rsa.descriptions }),
    finalUrl: Array.isArray(ad.finalUrls) && ad.finalUrls.length === 1 ? ad.finalUrls[0] : undefined,
    euPoliticalAdvertising: campaign.containsEuPoliticalAdvertising,
  } });
  if (!plan.ok) return plan;
  const network = asRecord({ value: campaign.networkSettings });
  const hierarchy = parse<Hierarchy>({ schema: hierarchySchema, input: {
    ...account, campaignId: String(campaign.id), budgetId: String(budget.id), name: campaign.name, status: campaign.status,
    channel: campaign.advertisingChannelType, searchPartners: network.targetSearchNetwork ?? false, displayNetwork: network.targetContentNetwork ?? false,
    averageDailyBudgetMicros: budget.amountMicros, sharedBudget: budget.explicitlyShared ?? false, period: budget.period,
    ...dates.value, childIds: ["group:" + group.id, "ad:" + group.id + "~" + ad.id, ...children.keywords.map(row => "keyword:" + asRecord({ value: row.adGroup }).id + "~" + asRecord({ value: row.adGroupCriterion }).criterionId)],
    childStatuses: [group.status, adGroupAd.status, ...children.keywords.map(row => asRecord({ value: row.adGroupCriterion }).status)],
    observedAt: required.dependencies.clock.now({}), planDigest: planDigest({ plan: plan.value }),
  } });
  if (!hierarchy.ok) return hierarchy;
  return validateHierarchy({ binding: required.dependencies.binding, hierarchy: hierarchy.value });
}
/** Normalizes set-valued inputs so vendor ordering cannot change operation identity. */
export function planDigest(required: { plan: SearchPlan }): string {
  return digest({ value: { ...required.plan, geoTargetIds: [...required.plan.geoTargetIds].sort(), keywords: [...required.plan.keywords].sort((left, right) => (left.matchType + left.text).localeCompare(right.matchType + right.text)), headlines: [...required.plan.headlines].sort(), descriptions: [...required.plan.descriptions].sort() } });
}
function assetTexts(required: { value: unknown }): unknown[] {
  if (!Array.isArray(required.value)) return [];
  return required.value.map(asset => asRecord({ value: asset }).text);
}
function supportedControls(required: { campaign: Row; children: { keywords: Row[]; locations: Row[] } }): boolean {
  const network = asRecord({ value: required.campaign.networkSettings });
  const geo = asRecord({ value: required.campaign.geoTargetTypeSetting });
  const keywordsSupported = required.children.keywords.every(row => !asRecord({ value: row.adGroupCriterion }).negative && asRecord({ value: row.adGroupCriterion }).type === "KEYWORD");
  const locationsSupported = required.children.locations.every(row => !asRecord({ value: row.campaignCriterion }).negative && asRecord({ value: row.campaignCriterion }).type === "LOCATION");
  return Object.hasOwn(required.campaign, "manualCpc") && network.targetGoogleSearch === true && !network.targetPartnerSearchNetwork
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
function localInstant(required: { value: unknown; timezone: string }): Outcome<number> {
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

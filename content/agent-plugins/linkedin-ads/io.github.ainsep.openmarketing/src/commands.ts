import { createHash } from "node:crypto";
import { z } from "zod";
import { callContextSchema, dailyLimitRequirementSchema, moneyExposureSchema, idSchema, parseBoundary } from "@open-marketing/contracts";
import type { EffectCategory, Outcome } from "@open-marketing/contracts";
import type { LinkedInWireRequest } from "./wire.js";
import { encodeLinkedInReport, reportCommandSchema } from "./reporting.js";

/** IDs remain strings; provider numeric JSON IDs must be safe integers before conversion. */
export const vendorIdSchema = z.string().regex(/^[1-9][0-9]{0,18}$/);
const entityType = z.enum(["campaign_group", "campaign", "creative"]);
const name = z.string().min(1).max(200).refine(value => Buffer.byteLength(value) <= 200);
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const schedule = z.strictObject({ start: timestamp, end: timestamp.optional() }).refine(value => value.end === undefined || value.end > value.start);
const currency = z.string().regex(/^[A-Z]{3}$/);
const amount = z.string().regex(/^(0|[1-9][0-9]{0,11})(\.[0-9]{1,6})?$/).refine(value => /[1-9]/.test(value));
const money = z.strictObject({ amount, currencyCode: currency });
const ids = z.array(vendorIdSchema).min(1).max(100).refine(value => new Set(value).size === value.length);
const token = z.string().min(1).max(2048).regex(/^[^\x00-\x1f\x7f]+$/);
const page = { ids: ids.optional(), pageSize: z.number().int().min(1).max(100).default(100), pageToken: token.optional() };
const geoIds = z.array(vendorIdSchema).min(1).max(100).refine(value => new Set(value).size === value.length);
const group = z.strictObject({ kind: z.literal("create_campaign_group_draft"), name, runSchedule: schedule, totalBudget: money.optional() }).refine(value => value.totalBudget === undefined || value.runSchedule.end !== undefined);
const campaign = z.strictObject({
  kind: z.literal("create_campaign_paused"), name, campaignGroupId: vendorIdSchema,
  organizationId: vendorIdSchema, locale: z.strictObject({ country: z.string().regex(/^[A-Z]{2}$/), language: z.string().regex(/^[a-z]{2}$/) }),
  geoIds, dailyBudget: money, unitCost: money, costType: z.enum(["CPC", "CPM"]),
  runSchedule: schedule, politicalIntent: z.enum(["POLITICAL", "NOT_POLITICAL", "NOT_DECLARED"]),
});
/** Closed vendor tools. Unsupported status, transport, identifiers and extra fields reject. */
export const commandSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("list_accounts"), ...page }),
  z.strictObject({ kind: z.literal("list_campaign_groups"), ...page }),
  z.strictObject({ kind: z.literal("list_campaigns"), ...page }),
  z.strictObject({ kind: z.literal("list_creatives"), ...page }),
  z.strictObject({ kind: z.literal("search_targeting"), facet: z.enum(["locations", "profileLocations", "industries", "employers", "skills", "titles"]), query: z.string().trim().min(1).max(200) }),
  group, campaign,
  z.strictObject({ kind: z.literal("create_creative_paused"), campaignId: vendorIdSchema, reference: z.string().regex(/^urn:li:(share|ugcPost):[1-9][0-9]{0,18}$/) }),
  z.strictObject({ kind: z.literal("activate"), entityType, entityId: vendorIdSchema }),
  z.strictObject({ kind: z.literal("set_budget"), campaignId: vendorIdSchema, dailyBudget: money }),
  z.strictObject({ kind: z.literal("pause"), campaignId: vendorIdSchema }),
  reportCommandSchema,
  z.strictObject({ kind: z.literal("list_conversion_rules") }),
  z.strictObject({ kind: z.literal("create_conversion_rule"), name, type: z.enum(["LEAD", "SIGN_UP", "START_TRIAL", "PURCHASE", "OTHER"]), postClickAttributionWindowSize: z.union([z.literal(1), z.literal(7), z.literal(30), z.literal(90)]), viewThroughAttributionWindowSize: z.union([z.literal(1), z.literal(7), z.literal(30), z.literal(90)]), attributionType: z.enum(["LAST_TOUCH_BY_CAMPAIGN", "LAST_TOUCH_BY_CONVERSION"]), autoAssociationType: z.enum(["OBJECTIVE_BASED", "ALL_CAMPAIGNS"]).optional() }),
  z.strictObject({ kind: z.literal("associate_conversion_rule"), campaignId: vendorIdSchema, conversionId: vendorIdSchema }),
  z.strictObject({ kind: z.literal("list_lead_forms"), start: z.number().int().min(0).max(1000000).default(0), count: z.number().int().min(1).max(100).default(100) }),
]);
/** Public commands may omit pageSize; parsing defaults it to 100. */
export type LinkedInCommand = z.input<typeof commandSchema>;
type ParsedCommand = z.infer<typeof commandSchema>;
/** Server invocation boundary; money metadata uses the canonical approval contract. */
export const invocationSchema = z.strictObject({ context: callContextSchema, operationId: idSchema, command: commandSchema, moneyExposure: moneyExposureSchema.nullable(), requiredLimit: dailyLimitRequirementSchema.nullable() });
/** A fixed REST request and its locally assigned policy class. */
export interface LinkedInEncodedCommand { readonly request: LinkedInWireRequest; readonly effect: EffectCategory }

/** One source for schemas consumed by the host's tool catalog; no registration or startup.
 * Zod refinements stay in the adapter boundary; JSON-schema generation is intentionally unnecessary.
 */
export const linkedinAdsTools = commandSchema.options.map(schema => ({
  name: schema.shape.kind.value,
  inputSchema: schema,
  effect: commandEffect({ kind: schema.shape.kind.value }),
}));

/** Map only documented fields/paths. No egress or arbitrary updater.
 * @param required - Unknown command, server-bound account and currency.
 * @returns Typed invalid input, or a fixed request with forced non-serving creation state.
 * @example encodeLinkedInCommand({ input: { kind: "pause", campaignId: "456" }, accountId: "123", currency: "USD" })
 * @complexity O(n) time/space, n<=100 IDs; one serialized body <=64KiB at dispatch.
 */
export function encodeLinkedInCommand(required: { input: unknown; accountId: string; currency: string }): Outcome<LinkedInEncodedCommand> {
  const parsed = parseBoundary({ schema: commandSchema, input: required.input });
  if (!parsed.ok) return parsed;
  if (!vendorIdSchema.safeParse(required.accountId).success) return invalid();
  const command = parsed.value;
  if (!currenciesMatch({ command, currency: required.currency })) return invalid();
  return { ok: true, value: { request: mapCommand({ command, accountId: required.accountId }), effect: commandEffect({ kind: command.kind }) } };
}

/** Currency mismatches fail before obtaining a token. No FX or minor-unit guesses. @complexity O(1). */
function currenciesMatch(required: { command: ParsedCommand; currency: string }): boolean {
  switch (required.command.kind) {
    case "create_campaign_group_draft": return required.command.totalBudget === undefined || required.command.totalBudget.currencyCode === required.currency;
    case "create_campaign_paused": return required.command.dailyBudget.currencyCode === required.currency && required.command.unitCost.currencyCode === required.currency;
    case "set_budget": return required.command.dailyBudget.currencyCode === required.currency;
    default: return true;
  }
}
function invalid(): Outcome<never> { return { ok: false, error: { code: "invalid_input", message: "LinkedIn account or budget currency invalid", retryable: false } }; }

/** Exhaustive policy mapping; enabling entities and changing budgets always spend. @complexity O(1). */
function commandEffect(required: { kind: LinkedInCommand["kind"] }): EffectCategory {
  switch (required.kind) {
    case "list_accounts": case "list_campaign_groups": case "list_campaigns": case "list_creatives": case "search_targeting": case "report": case "list_conversion_rules": case "list_lead_forms": return "read";
    case "activate": case "set_budget": return "ad_spend";
    case "create_campaign_group_draft": case "create_campaign_paused": case "create_creative_paused": case "pause": case "create_conversion_rule": case "associate_conversion_rule": return "write";
    default: { const exhaustive: never = required.kind; return exhaustive; }
  }
}

/** Fixed endpoint table; user data can only fill validated IDs or encoded finder values. @complexity O(n). */
function mapCommand(required: { command: ParsedCommand; accountId: string }): LinkedInWireRequest {
  const { command, accountId } = required;
  const account = `urn:li:sponsoredAccount:${accountId}`;
  const base = `https://api.linkedin.com/rest/adAccounts/${accountId}`;
  switch (command.kind) {
    case "list_accounts": return searchRequest({ url: "https://api.linkedin.com/rest/adAccounts", command, urnType: "sponsoredAccount" });
    case "list_campaign_groups": return searchRequest({ url: base + "/adCampaignGroups", command, urnType: "sponsoredCampaignGroup" });
    case "list_campaigns": return searchRequest({ url: base + "/adCampaigns", command, urnType: "sponsoredCampaign" });
    case "list_creatives": return creativeSearch({ url: base + "/creatives", command });
    case "search_targeting": return { url: "https://api.linkedin.com/rest/adTargetingEntities?q=typeahead&facet=" + encodeURIComponent("urn:li:adTargetingFacet:" + command.facet) + "&query=" + encodeURIComponent(command.query) + "&queryVersion=QUERY_USES_URNS", method: "GET", restliMethod: "FINDER" };
    case "create_campaign_group_draft": return post({ url: base + "/adCampaignGroups", body: { account, name: command.name, runSchedule: command.runSchedule, totalBudget: command.totalBudget, status: "DRAFT" } });
    case "create_campaign_paused": return post({ url: base + "/adCampaigns", body: {
      account, campaignGroup: `urn:li:sponsoredCampaignGroup:${command.campaignGroupId}`, associatedEntity: `urn:li:organization:${command.organizationId}`,
      name: command.name, locale: command.locale, costType: command.costType, dailyBudget: command.dailyBudget, unitCost: command.unitCost,
      runSchedule: command.runSchedule, politicalIntent: command.politicalIntent, type: "SPONSORED_UPDATES", status: "PAUSED",
      offsiteDeliveryEnabled: false, audienceExpansionEnabled: false,
      targetingCriteria: { include: { and: [{ or: { "urn:li:adTargetingFacet:locations": command.geoIds.map(id => "urn:li:geo:" + id) } }] } },
    } });
    case "create_creative_paused": return post({ url: base + "/creatives", body: { campaign: `urn:li:sponsoredCampaign:${command.campaignId}`, content: { reference: command.reference }, intendedStatus: "PAUSED" } });
    case "activate": return patch({ url: entityUrl({ base, entityType: command.entityType, entityId: command.entityId }), fields: command.entityType === "creative" ? { intendedStatus: "ACTIVE" } : { status: "ACTIVE" } });
    case "set_budget": return patch({ url: base + "/adCampaigns/" + command.campaignId, fields: { dailyBudget: command.dailyBudget } });
    case "pause": return patch({ url: base + "/adCampaigns/" + command.campaignId, fields: { status: "PAUSED" } });
    case "report": return encodeLinkedInReport({ command, accountId });
    case "list_conversion_rules": return { url: "https://api.linkedin.com/rest/conversions?q=account&account=" + encodeURIComponent(account), method: "GET", restliMethod: "FINDER" };
    case "create_conversion_rule": return post({ url: "https://api.linkedin.com/rest/conversions" + (command.autoAssociationType ? "?autoAssociationType=" + command.autoAssociationType : ""), body: { account, name: command.name, type: command.type, conversionMethod: "CONVERSIONS_API", postClickAttributionWindowSize: command.postClickAttributionWindowSize, viewThroughAttributionWindowSize: command.viewThroughAttributionWindowSize, attributionType: command.attributionType } });
    case "associate_conversion_rule": {
      const campaign = "urn:li:sponsoredCampaign:" + command.campaignId;
      const conversion = "urn:lla:llaPartnerConversion:" + command.conversionId;
      return { url: `https://api.linkedin.com/rest/campaignConversions/(campaign:${encodeURIComponent(campaign)},conversion:${encodeURIComponent(conversion)})`, method: "PUT", restliMethod: "UPDATE", body: JSON.stringify({ campaign, conversion }) };
    }
    case "list_lead_forms": return { url: `https://api.linkedin.com/rest/leadForms?q=owner&owner=(sponsoredAccount:${encodeURIComponent(account)})&start=${command.start}&count=${command.count}`, method: "GET", restliMethod: "FINDER" };
    default: { const exhaustive: never = command; return exhaustive; }
  }
}

/** Rest.li syntax delimiters remain literal; each URN value is individually escaped. @complexity O(n), n<=100. */
function searchRequest(required: { url: string; command: Extract<ParsedCommand, { pageSize: number }>; urnType: string }): LinkedInWireRequest {
  const command = required.command;
  let url = required.url + "?q=search&pageSize=" + command.pageSize;
  if (command.ids) url += "&search=(id:(values:List(" + command.ids.map(id => command.kind === "list_accounts" ? id : encodeURIComponent(`urn:li:${required.urnType}:${id}`)).join(",") + ")))";
  else if (command.kind === "list_campaigns") url += "&search=(status:(values:List(ACTIVE,PAUSED,DRAFT,ARCHIVED,COMPLETED,CANCELED,PENDING_DELETION,REMOVED)))";
  else if (command.kind === "list_campaign_groups") url += "&search=(status:(values:List(ACTIVE,PAUSED,DRAFT,ARCHIVED,CANCELED,PENDING_DELETION,REMOVED)))";
  if (command.pageToken) url += "&pageToken=" + encodeURIComponent(command.pageToken);
  return { url, method: "GET", restliMethod: "FINDER" };
}
/** Creative criteria uses creatives=List, not the account/campaign search object. @complexity O(n), n<=100. */
function creativeSearch(required: { url: string; command: Extract<ParsedCommand, { kind: "list_creatives" }> }): LinkedInWireRequest {
  let url = required.url + "?q=criteria&pageSize=" + required.command.pageSize;
  if (required.command.ids) url += "&creatives=List(" + required.command.ids.map(id => encodeURIComponent("urn:li:sponsoredCreative:" + id)).join(",") + ")";
  if (required.command.pageToken) url += "&pageToken=" + encodeURIComponent(required.command.pageToken);
  return { url, method: "GET", restliMethod: "FINDER" };
}
function entityUrl(required: { base: string; entityType: z.infer<typeof entityType>; entityId: string }): string {
  switch (required.entityType) {
    case "campaign_group": return required.base + "/adCampaignGroups/" + required.entityId;
    case "campaign": return required.base + "/adCampaigns/" + required.entityId;
    case "creative": return required.base + "/creatives/" + encodeURIComponent("urn:li:sponsoredCreative:" + required.entityId);
    default: { const exhaustive: never = required.entityType; return exhaustive; }
  }
}
function post(required: { url: string; body: object }): LinkedInWireRequest { return { url: required.url, method: "POST", restliMethod: "CREATE", body: JSON.stringify(required.body) }; }
function patch(required: { url: string; fields: object }): LinkedInWireRequest { return { ...post({ url: required.url, body: { patch: { $set: required.fields } } }), restliMethod: "PARTIAL_UPDATE" }; }

/** Stable digest of JSON data for host exact-call binding, not vendor idempotency support.
 * @example linkedInDigest({ value: { action: "pause" } })
 * @complexity O(b) time/space for bounded JSON; object insertion order is retained.
 */
export function linkedInDigest(required: { value: unknown }): string { return createHash("sha256").update(JSON.stringify(required.value)).digest("hex"); }

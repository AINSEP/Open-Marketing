import { createHash } from "node:crypto";
import { z } from "zod";
import { parseBoundary } from "@open-marketing/contracts";
import type { AppError, EffectCategory, Outcome } from "@open-marketing/contracts";

/** TikTok v1.3 IDs stay decimal strings; no numeric precision loss. */
export const vendorIdSchema = z.string().regex(/^[1-9][0-9]{0,31}$/);
const ids = z.array(vendorIdSchema).min(1).max(100).refine(value => new Set(value).size === value.length);
const pagination = { page: z.number().int().min(1).max(10000).default(1), pageSize: z.number().int().min(1).max(100).default(100) };
// Fixture-labelled status enums; host admission remains false pending vendor acceptance.
export const tiktokStatus = { disabled: "DISABLE", enabled: "ENABLE" } as const;
const name = z.string().trim().min(1).max(256);
const budget = z.number().positive().max(1000000000).multipleOf(0.01);
const mediaId = z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/);
export const tiktokUrlSchema = z.url().max(2048).refine(value => { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password && !url.hash; });
const entity = { entityType: z.enum(["campaign", "adgroup", "ad"]), entityId: vendorIdSchema };
const variants = {
  "get-advertiser": z.strictObject({ kind: z.literal("get-advertiser") }),
  "get-campaigns": z.strictObject({ kind: z.literal("get-campaigns"), ...pagination, campaignIds: ids.optional() }),
  "get-adgroups": z.strictObject({ kind: z.literal("get-adgroups"), ...pagination, adgroupIds: ids.optional() }),
  "get-ads": z.strictObject({ kind: z.literal("get-ads"), ...pagination, adIds: ids.optional() }),
  report: z.strictObject({ kind: z.literal("report"), ...pagination, startDate: z.iso.date(), endDate: z.iso.date() }).refine(validReportDates),
  "create-campaign-paused": z.strictObject({ kind: z.literal("create-campaign-paused"), name, budget }),
  "create-adgroup-paused": z.strictObject({ kind: z.literal("create-adgroup-paused"), name, campaignId: vendorIdSchema, budget, locationIds: ids, scheduleStart: z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/) }),
  "create-ad-paused": z.strictObject({ kind: z.literal("create-ad-paused"), name, adgroupId: vendorIdSchema, text: z.string().trim().min(1).max(100), videoId: mediaId, identityId: mediaId, landingPageUrl: tiktokUrlSchema }),
  "activate-entity": z.strictObject({ kind: z.literal("activate-entity"), ...entity }),
  "pause-entity": z.strictObject({ kind: z.literal("pause-entity"), ...entity }),
};

/** Closed tool commands; account/token/status fields and arbitrary vendor bodies cannot pass. */
export const tiktokCommandSchema = z.discriminatedUnion("kind", [variants["get-advertiser"], variants["get-campaigns"], variants["get-adgroups"], variants["get-ads"], variants.report, variants["create-campaign-paused"], variants["create-adgroup-paused"], variants["create-ad-paused"], variants["activate-entity"], variants["pause-entity"]]);
export type TikTokCommand = z.infer<typeof tiktokCommandSchema>;
export type TikTokReadCommand = Extract<TikTokCommand, { kind: "get-advertiser" | "get-campaigns" | "get-adgroups" | "get-ads" | "report" }>;
/** Backend-only closed campaign stop, absent from tiktokTools. Host must verify the permit. */
export const tiktokHaltCommandSchema = z.strictObject({ kind: z.literal("halt-stop"), campaignIds: ids });
export type TikTokDispatchCommand = TikTokCommand | z.infer<typeof tiktokHaltCommandSchema>;
export type TikTokReportQuery = Extract<TikTokCommand, { kind: "report" }>;
export type TikTokPath = "advertiser/info/" | "campaign/get/" | "adgroup/get/" | "ad/get/" | "report/integrated/get/" | "campaign/create/" | "adgroup/create/" | "ad/create/" | "campaign/status/update/" | "adgroup/status/update/" | "ad/status/update/";
export type TikTokEncoded = { method: "GET"; path: TikTokPath; parameters: Readonly<Record<string, string>> } | { method: "POST"; path: TikTokPath; body: Readonly<Record<string, unknown>> };
/** Server consumes these trusted local descriptors through its ONE catalog/policy. */
export const tiktokTools = [
  describeTool({ name: "tiktok_ads.get_advertiser", schema: variants["get-advertiser"], description: "Read the configured advertiser; not OAuth account enumeration." }),
  describeTool({ name: "tiktok_ads.get_campaigns", schema: variants["get-campaigns"], description: "Read one advertiser's campaigns, at most 100 per page." }),
  describeTool({ name: "tiktok_ads.get_adgroups", schema: variants["get-adgroups"], description: "Read one advertiser's ad groups, at most 100 per page." }),
  describeTool({ name: "tiktok_ads.get_ads", schema: variants["get-ads"], description: "Read one advertiser's ads, at most 100 per page." }),
  describeTool({ name: "tiktok_ads.report", schema: variants.report, description: "Read account spend for at most 31 inclusive account-local dates; partial pages are not totals." }),
  describeTool({ name: "tiktok_ads.create_campaign_paused", schema: variants["create-campaign-paused"], effects: ["write"], description: "Create one disabled website traffic campaign and read its status; never activate it." }),
  describeTool({ name: "tiktok_ads.create_adgroup_paused", schema: variants["create-adgroup-paused"], effects: ["write"], description: "Create one disabled TikTok website traffic group with a daily budget and read its status." }),
  describeTool({ name: "tiktok_ads.create_ad_paused", schema: variants["create-ad-paused"], effects: ["write"], description: "Create one disabled single-video ad with an existing identity/video and read its status." }),
  describeTool({ name: "tiktok_ads.activate_entity", schema: variants["activate-entity"], effects: ["ad_spend"], description: "Enable one entity; requires the server's exact spend card for every call." }),
  describeTool({ name: "tiktok_ads.pause_entity", schema: variants["pause-entity"], effects: ["write"], description: "Disable one existing campaign, ad group or ad through the normal write policy." }),
] as const;

/** Dates are inclusive local calendar dates; Date.parse checks span, not account timezone. */
function validReportDates(required: { startDate: string; endDate: string }): boolean {
  const days = (Date.parse(required.endDate) - Date.parse(required.startDate)) / 86400000;
  return Number.isFinite(days) && days >= 0 && days < 31;
}

function describeTool(required: { name: string; schema: z.ZodType; description: string; effects?: readonly EffectCategory[] }) {
  const inputSchema = z.toJSONSchema(required.schema);
  return { name: required.name, description: required.description, inputSchema, schemaFingerprint: createHash("sha256").update(JSON.stringify(inputSchema)).digest("hex"), effects: required.effects ?? ["read"] as const };
}

/** Fixed request mapping. All account IDs come from the host binding, never the command.
 * @example encodeTikTokCommand({ input: { kind: "get-advertiser" }, accountId: "123" })
 * @complexity O(n) time/space, n <= 100 filter IDs; no I/O.
 */
export function encodeTikTokCommand(required: { input: unknown; accountId: string }): Outcome<TikTokEncoded> {
  const account = parseBoundary({ schema: vendorIdSchema, input: required.accountId });
  if (!account.ok) return account;
  const parsed = parseBoundary({ schema: tiktokCommandSchema, input: required.input });
  if (!parsed.ok) return parsed;
  const selection = { command: parsed.value };
  if (!isTikTokRead(selection)) return encodeWrite({ command: selection.command as Exclude<TikTokCommand, TikTokReadCommand>, accountId: account.value });
  const command = selection.command;
  if (command.kind === "get-advertiser") return { ok: true, value: { method: "GET", path: "advertiser/info/", parameters: { advertiser_ids: JSON.stringify([account.value]) } } };
  const parameters = { advertiser_id: account.value, page: String(command.page), page_size: String(command.pageSize) };
  switch (command.kind) {
    case "get-campaigns": return { ok: true, value: { method: "GET", path: "campaign/get/", parameters: { ...parameters, ...filter({ key: "campaign_ids", ids: command.campaignIds }) } } };
    case "get-adgroups": return { ok: true, value: { method: "GET", path: "adgroup/get/", parameters: { ...parameters, ...filter({ key: "adgroup_ids", ids: command.adgroupIds }) } } };
    case "get-ads": return { ok: true, value: { method: "GET", path: "ad/get/", parameters: { ...parameters, ...filter({ key: "ad_ids", ids: command.adIds }) } } };
    case "report": return { ok: true, value: { method: "GET", path: "report/integrated/get/", parameters: { ...parameters, report_type: "BASIC", service_type: "AUCTION", data_level: "AUCTION_ADVERTISER", dimensions: JSON.stringify(["advertiser_id"]), metrics: JSON.stringify(["spend"]), start_date: command.startDate, end_date: command.endDate } } };
    default: { const exhaustive: never = command; return exhaustive; }
  }
}

/** Local classification is closed; vendor annotations never confer authority. O(1), pure. */
export function isTikTokRead(required: { command: TikTokDispatchCommand }): required is { command: TikTokReadCommand } {
  return ["get-advertiser", "get-campaigns", "get-adgroups", "get-ads", "report"].includes(required.command.kind);
}

/** One POST per action; explicit DISABLE overrides vendor ENABLE defaults. O(n), <=100 locations. */
function encodeWrite(required: { command: Exclude<TikTokCommand, TikTokReadCommand>; accountId: string }): Outcome<TikTokEncoded> {
  const { command, accountId } = required;
  const base = { advertiser_id: accountId, operation_status: tiktokStatus.disabled };
  switch (command.kind) {
    case "create-campaign-paused": return { ok: true, value: { method: "POST", path: "campaign/create/", body: { ...base, campaign_name: command.name, objective_type: "TRAFFIC", budget_mode: "BUDGET_MODE_DAY", budget: command.budget } } };
    case "create-adgroup-paused": return { ok: true, value: { method: "POST", path: "adgroup/create/", body: { ...base, campaign_id: command.campaignId, adgroup_name: command.name, budget_mode: "BUDGET_MODE_DAY", budget: command.budget, promotion_type: "WEBSITE", placement_type: "PLACEMENT_TYPE_NORMAL", placements: ["PLACEMENT_TIKTOK"], location_ids: command.locationIds, optimization_goal: "CLICK", billing_event: "CPC", bid_type: "BID_TYPE_NO_BID", pacing: "PACING_MODE_SMOOTH", schedule_type: "SCHEDULE_FROM_NOW", schedule_start_time: command.scheduleStart } } };
    case "create-ad-paused": return { ok: true, value: { method: "POST", path: "ad/create/", body: { advertiser_id: accountId, adgroup_id: command.adgroupId, creatives: [{ operation_status: tiktokStatus.disabled, ad_name: command.name, ad_text: command.text, ad_format: "SINGLE_VIDEO", video_id: command.videoId, identity_type: "AUTH_CODE", identity_id: command.identityId, landing_page_url: command.landingPageUrl, call_to_action: "LEARN_MORE" }] } } };
    case "activate-entity": case "pause-entity": return { ok: true, value: { method: "POST", path: `${command.entityType}/status/update/`, body: { advertiser_id: accountId, [`${command.entityType}_ids`]: [command.entityId], operation_status: command.kind === "activate-entity" ? tiktokStatus.enabled : tiktokStatus.disabled } } };
    default: { const exhaustive: never = command; return exhaustive; }
  }
}

/** Canonical JSON matches the server safety digest: sorted object keys, preserved array order.
 * Caller supplies already schema-bounded arguments. O(b log k) time/O(b) space; no identifier hashing.
 */
export function digestTikTokArguments(required: { arguments: Readonly<Record<string, unknown>> }): string {
  return createHash("sha256").update(JSON.stringify(canonical({ value: required.arguments }))).digest("hex");
}
function canonical(required: { value: unknown }): unknown {
  if (Array.isArray(required.value)) return required.value.map(value => canonical({ value }));
  if (required.value === null || typeof required.value !== "object") return required.value;
  const record = required.value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(record).sort().map(key => [key, canonical({ value: record[key] })]));
}

function filter(required: { key: string; ids?: string[] }): Record<string, string> {
  return required.ids ? { filtering: JSON.stringify({ [required.key]: required.ids }) } : {};
}

/** Typed, redacted errors are never automatic-retry instructions. */
export function failure(required: { code: AppError["code"]; message: string }): Outcome<never> {
  return { ok: false, error: { ...required, retryable: false } };
}

/** Bounds pure decoder inputs too; cyclic/non-JSON data is invalid. @complexity O(b), b <= 1 MiB accepted. */
export function boundTikTokJson(required: { input: unknown }): Outcome<unknown> {
  try {
    const text = JSON.stringify(required.input);
    if (text === undefined) return failure({ code: "invalid_input", message: "TikTok response is not JSON" });
    if (Buffer.byteLength(text) > 1048576) return failure({ code: "limit_exceeded", message: "TikTok response exceeds 1 MiB" });
    return { ok: true, value: required.input };
  } catch { return failure({ code: "invalid_input", message: "TikTok response is not JSON" }); }
}

/** Candidate response shapes are fixture-labelled UNVERIFIED in evidence; host admission stays false.
 * Extra vendor fields are stripped rather than forwarded to the assistant.
 */
export const tiktokPageSchema = z.object({ page: z.number().int().min(1).max(10000), page_size: z.number().int().min(1).max(100), total_page: z.number().int().nonnegative().max(10000), total_number: z.number().int().nonnegative().max(1000000) });
/** Exact nonnegative vendor decimal text; exponent is supplied by the host, not inferred. */
export const tiktokSpendSchema = z.string().regex(/^(0|[1-9][0-9]{0,15})(\.[0-9]{1,3})?$/);
/** Narrow account-total wire shape; no conversion metrics or CAC interpretation. */
export const tiktokReportDataSchema = z.object({ list: z.array(z.object({ dimensions: z.object({ advertiser_id: vendorIdSchema }), metrics: z.object({ spend: tiktokSpendSchema }) })).max(1), page_info: tiktokPageSchema });
const advertiserDataSchema = z.object({ list: z.array(z.object({ advertiser_id: vendorIdSchema, advertiser_name: z.string().max(256).optional(), currency: z.string().regex(/^[A-Z]{3}$/), timezone: z.string().min(1).max(100) })).length(1) });
const campaignRow = z.object({ advertiser_id: vendorIdSchema, campaign_id: vendorIdSchema, campaign_name: z.string().max(256), operation_status: z.string().min(1).max(100) });
const adgroupRow = z.object({ advertiser_id: vendorIdSchema, campaign_id: vendorIdSchema, adgroup_id: vendorIdSchema, adgroup_name: z.string().max(256), operation_status: z.string().min(1).max(100) });
const adRow = z.object({ advertiser_id: vendorIdSchema, campaign_id: vendorIdSchema, adgroup_id: vendorIdSchema, ad_id: vendorIdSchema, ad_name: z.string().max(256), operation_status: z.string().min(1).max(100) });
const listDataSchemas = { "get-campaigns": z.object({ list: z.array(campaignRow).max(100), page_info: tiktokPageSchema }), "get-adgroups": z.object({ list: z.array(adgroupRow).max(100), page_info: tiktokPageSchema }), "get-ads": z.object({ list: z.array(adRow).max(100), page_info: tiktokPageSchema }) };
const envelopeSchema = z.object({ code: z.number().int(), message: z.string().max(1024).optional(), request_id: z.string().max(256).optional(), data: z.record(z.string(), z.json()).optional() });
type PageInfo = z.infer<typeof tiktokPageSchema>;

/** Validate a bounded POST acknowledgement; code:0 is acceptance, never serving/attribution proof.
 * O(b) time/space, b <=1MiB; typed failure strips vendor messages and request IDs.
 */
export function decodeTikTokAcknowledgement(required: { input: unknown }): Outcome<{ code: number; data: Record<string, unknown> }> {
  const bounded = boundTikTokJson(required);
  if (!bounded.ok) return bounded;
  const parsed = parseBoundary({ schema: envelopeSchema, input: bounded.value });
  if (!parsed.ok) return parsed;
  if (parsed.value.code !== 0) return failure({ code: "unavailable", message: "TikTok rejected the request" });
  if (parsed.value.data === undefined) return failure({ code: "invalid_input", message: "TikTok acknowledgement data missing" });
  return { ok: true, value: { code: 0, data: parsed.value.data } };
}

/** Validate a bounded vendor envelope and exact advertiser/page/filter binding.
 * Unknown status text is preserved; it never proves a paused or active serving state.
 * @example decodeTikTokRead({ input: response, command: { kind: "get-advertiser" }, accountId: "123" })
 * @complexity O(b+n) time/space, b <= 1 MiB, n <= 100 rows; no I/O.
 */
export function decodeTikTokRead(required: { input: unknown; command: TikTokReadCommand; accountId: string }): Outcome<unknown> {
  const command = parseBoundary({ schema: tiktokCommandSchema, input: required.command });
  if (!command.ok) return command;
  if (!isTikTokRead({ command: command.value })) return failure({ code: "invalid_input", message: "TikTok read decoder requires a read command" });
  const request = encodeTikTokCommand({ input: command.value, accountId: required.accountId });
  if (!request.ok) return request;
  const bounded = boundTikTokJson({ input: required.input });
  if (!bounded.ok) return bounded;
  const envelope = parseBoundary({ schema: envelopeSchema, input: bounded.value });
  if (!envelope.ok) return envelope;
  if (envelope.value.code !== 0) return failure({ code: "unavailable", message: "TikTok rejected the request" });
  const data = decodeData({ input: envelope.value.data, command: command.value as TikTokReadCommand, accountId: required.accountId });
  if (!data.ok) return data;
  return { ok: true, value: { code: 0, data: data.value } };
}

/** Account totals cannot accept duplicate or foreign advertiser rows. @complexity O(n), n <= 100. */
function decodeData(required: { input: unknown; command: TikTokReadCommand; accountId: string }): Outcome<unknown> {
  const { command } = required;
  if (command.kind === "get-advertiser") return decodeAdvertiser(required);
  if (command.kind === "report") return decodeReportData({ ...required, command });
  const data = parseBoundary({ schema: listDataSchemas[command.kind] as z.ZodType<{ list: { advertiser_id: string }[]; page_info: PageInfo }>, input: required.input });
  if (!data.ok) return data;
  if (data.value.list.some(row => row.advertiser_id !== required.accountId)) return failure({ code: "forbidden", message: "TikTok response advertiser mismatch" });
  const page = validatePage({ info: data.value.page_info, count: data.value.list.length, command });
  if (!page.ok) return page;
  const filtered = validateEntities({ rows: data.value.list, command });
  if (!filtered.ok) return filtered;
  return data;
}

function decodeAdvertiser(required: { input: unknown; accountId: string }): Outcome<unknown> {
  const data = parseBoundary({ schema: advertiserDataSchema, input: required.input });
  if (!data.ok) return data;
  if (data.value.list[0].advertiser_id !== required.accountId) return failure({ code: "forbidden", message: "TikTok response advertiser mismatch" });
  return data;
}

function decodeReportData(required: { input: unknown; command: TikTokReportQuery; accountId: string }): Outcome<unknown> {
  const data = parseBoundary({ schema: tiktokReportDataSchema, input: required.input });
  if (!data.ok) return data;
  if (data.value.list.some(row => row.dimensions.advertiser_id !== required.accountId)) return failure({ code: "forbidden", message: "TikTok report advertiser mismatch" });
  const page = validatePage({ info: data.value.page_info, count: data.value.list.length, command: required.command });
  if (!page.ok) return page;
  return data;
}

/** A response must match the requested page and its declared totals; missing pages stay explicit. */
function validatePage(required: { info: PageInfo; count: number; command: Exclude<TikTokReadCommand, { kind: "get-advertiser" }> }): Outcome<void> {
  const { info, count, command } = required;
  if (info.page !== command.page || info.page_size !== command.pageSize) return failure({ code: "conflict", message: "TikTok pagination differs from request" });
  if (info.total_page !== Math.ceil(info.total_number / info.page_size)) return failure({ code: "invalid_input", message: "TikTok pagination totals are inconsistent" });
  if (info.page > Math.max(1, info.total_page)) return failure({ code: "invalid_input", message: "TikTok page is outside the declared total" });
  const expected = Math.min(info.page_size, Math.max(0, info.total_number - (info.page - 1) * info.page_size));
  if (count !== expected) return failure({ code: "invalid_input", message: "TikTok page is missing rows" });
  return { ok: true, value: undefined };
}

/** Fail on duplicate IDs or records outside an explicitly requested filter; no partial success.
 * @complexity O(n*m) membership work, n <= 100 rows, m <= 100 requested IDs; no I/O.
 */
function validateEntities(required: { rows: unknown[]; command: Extract<TikTokCommand, { kind: "get-campaigns" | "get-adgroups" | "get-ads" }> }): Outcome<void> {
  const { command } = required;
  const selection = command.kind === "get-campaigns" ? { key: "campaign_id", ids: command.campaignIds } : command.kind === "get-adgroups" ? { key: "adgroup_id", ids: command.adgroupIds } : { key: "ad_id", ids: command.adIds };
  const rowIds = required.rows.map(row => (row as Record<string, string>)[selection.key]);
  if (new Set(rowIds).size !== rowIds.length) return failure({ code: "invalid_input", message: "TikTok page has duplicate entities" });
  const requestedIds = selection.ids;
  if (requestedIds && rowIds.some(id => !requestedIds.includes(id))) return failure({ code: "forbidden", message: "TikTok response differs from requested IDs" });
  return { ok: true, value: undefined };
}

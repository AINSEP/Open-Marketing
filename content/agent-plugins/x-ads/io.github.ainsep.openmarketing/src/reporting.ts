/** Pure synchronous analytics codec; no summation, FX, or inferred account total. */
import { z } from "zod";
import { metricValuesSchema, metricBatchSchema } from "@open-marketing/contracts";
import type { Outcome, MetricValues, MetricMapping } from "@open-marketing/contracts";

const entityId = z.string().max(64).regex(/^[a-z0-9]+$/);
const hour = z.number().int().min(946684800000).max(4102444800000).refine(value => value % 3600000 === 0);
const ids = z.array(entityId).min(1).max(20).refine(value => new Set(value).size === value.length);
export const reportCommandSchema = z.strictObject({
  kind: z.literal("report"), entity: z.enum(["ACCOUNT", "CAMPAIGN"]), entityIds: ids,
  window: z.strictObject({ start: hour, end: hour }), placement: z.enum(["ALL_ON_TWITTER", "SPOTLIGHT", "TREND"]),
}).refine(value => value.window.end > value.window.start && value.window.end - value.window.start <= 604800000);
type ReportCommand = z.output<typeof reportCommandSchema>;
const metric = z.tuple([z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable()]).nullable();
const metrics = z.object({ impressions: metric, clicks: metric, billed_charge_local_micro: metric });
const row = z.object({ id: entityId, id_data: z.tuple([z.object({ segment: z.null(), metrics })]) });
const accountRow = row.extend({ id_data: z.tuple([z.object({ segment: z.null(), metrics: z.object({ impressions: metric }) })]) });
const params = z.object({ entity: z.enum(["ACCOUNT", "CAMPAIGN"]), entity_ids: ids, start_time: z.iso.datetime(), end_time: z.iso.datetime(), granularity: z.literal("TOTAL"), placement: reportCommandSchema.shape.placement, metric_groups: z.array(z.enum(["ENGAGEMENT", "BILLING"])).min(1).max(2), account_id: entityId.optional() });
const responseSchema = z.object({ data_type: z.literal("stats"), time_series_length: z.literal(1), data: z.array(row).max(20), request: z.object({ params }) });
const accountResponseSchema = responseSchema.extend({ data: z.array(accountRow).max(20) });
/** One placement subtotal, vendor currency micros, nullable TOTAL metrics; ACCOUNT clicks/spend are always null. Values can be restated. */
export interface XReport {
  readonly source: "x_ads_analytics"; readonly apiVersion: "12"; readonly accountId: string; readonly currency: string;
  readonly retrievedAt: number; readonly window: { start: number; end: number }; readonly placement: ReportCommand["placement"];
  readonly entity: ReportCommand["entity"]; readonly availability: "reported" | "no_data_access_unconfirmed";
  readonly rows: readonly { entityId: string; spendMicros: number | null; impressions: number | null; clicks: number | null }[];
}

/** Entity-specific metric groups and TOTAL granularity; caller selected one placement. @complexity O(n) time/space, n<=20. */
export function reportQuery(required: { command: ReportCommand }): string {
  const c = required.command;
  return new URLSearchParams({ entity: c.entity, entity_ids: c.entityIds.join(","), start_time: new Date(c.window.start).toISOString(), end_time: new Date(c.window.end).toISOString(), granularity: "TOTAL", placement: c.placement, metric_groups: metricGroups({ entity: c.entity }).join(",") }).toString();
}

/** Atomic projection: reject foreign/duplicate IDs, unsafe numbers and mismatched echoed requests.
 * @complexity O(n*m) time/O(n) space, n,m<=20; null stays null, absent entities never become zero.
 */
export function decodeReport(required: { input: unknown; command: ReportCommand; accountId: string; currency: string; retrievedAt: number }): Outcome<XReport> {
  const schema = required.command.entity === "ACCOUNT" ? accountResponseSchema : responseSchema;
  const parsed = schema.safeParse(required.input);
  if (!parsed.success) return invalidReport();
  const { data, request } = parsed.data;
  if (!matchesRequest({ params: request.params, command: required.command, accountId: required.accountId })) return invalidReport();
  const rowIds = data.map(item => item.id);
  if (new Set(rowIds).size !== rowIds.length || rowIds.some(id => !required.command.entityIds.includes(id))) return invalidReport();
  const rows = data.map(item => projectRow({ row: item }));
  return { ok: true, value: { source: "x_ads_analytics", apiVersion: "12", accountId: required.accountId, currency: required.currency, retrievedAt: required.retrievedAt, window: required.command.window, placement: required.command.placement, entity: required.command.entity, availability: rows.length ? "reported" : "no_data_access_unconfirmed", rows } };
}

/** ACCOUNT parsing strips unsupported metrics before projection; missing/null values never become zero. @complexity O(1) time/space. */
function projectRow(required: { row: z.infer<typeof row> | z.infer<typeof accountRow> }): XReport["rows"][number] {
  const m = required.row.id_data[0].metrics;
  return { entityId: required.row.id, impressions: m.impressions?.[0] ?? null, clicks: "clicks" in m ? m.clicks?.[0] ?? null : null, spendMicros: "billed_charge_local_micro" in m ? m.billed_charge_local_micro?.[0] ?? null : null };
}

/** Compare request identity rather than relabel provider data with the requested window. @complexity O(n*m) time/O(1) space, n,m<=20. */
function matchesRequest(required: { params: z.infer<typeof params>; command: ReportCommand; accountId: string }): boolean {
  const { params: p, command: c } = required;
  if (p.account_id !== undefined && p.account_id !== required.accountId) return false;
  if (p.entity !== c.entity || p.placement !== c.placement) return false;
  if (Date.parse(p.start_time) !== c.window.start || Date.parse(p.end_time) !== c.window.end) return false;
  const groups = metricGroups({ entity: c.entity });
  return p.entity_ids.length === c.entityIds.length && p.entity_ids.every(id => c.entityIds.includes(id)) && p.metric_groups.length === groups.length && groups.every(group => p.metric_groups.includes(group));
}
/** X documents BILLING only for CAMPAIGN among supported entities. @complexity O(1) time/space. */
function metricGroups(required: { entity: ReportCommand["entity"] }): ("ENGAGEMENT" | "BILLING")[] { return required.entity === "ACCOUNT" ? ["ENGAGEMENT"] : ["ENGAGEMENT", "BILLING"]; }
function invalidReport(): Outcome<never> { return { ok: false, error: { code: "protocol_mismatch", message: "X Ads analytics response invalid", retryable: false } }; }

const supportedEntity = z.enum(["ACCOUNT", "CAMPAIGN", "LINE_ITEM", "PROMOTED_TWEET"]);
export const dailyCommandSchema = z.strictObject({ ...reportCommandSchema.shape, kind: z.literal("capability_daily"), entity: supportedEntity }).refine(value => value.window.end > value.window.start && value.window.end - value.window.start <= 604800000);
type DailyCommand = z.infer<typeof dailyCommandSchema>;
const integer = z.union([z.string().regex(/^(0|[1-9]\d{0,37})$/), z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).transform(String)]);
const dailyValues = z.array(integer.nullable()).max(7).nullable().optional();
const dailyMetrics = z.object({ impressions: dailyValues, clicks: dailyValues, billed_charge_local_micro: dailyValues });
const dailyParams = params.extend({ entity: supportedEntity, granularity: z.literal("DAY") });
const dailyResponse = z.object({ data_type: z.literal("stats"), time_series_length: z.number().int().min(1).max(7), data: z.array(z.object({ id: entityId, id_data: z.tuple([z.object({ segment: z.null(), metrics: dailyMetrics })]) })).max(20), request: z.object({ params: dailyParams }) });
const entitySchema = z.object({ id: entityId, campaign_id: entityId.optional(), line_item_id: entityId.optional(), currency: z.string().regex(/^[A-Z]{3}$/).optional(), entity_status: z.string().max(100).optional(), deleted: z.boolean().optional(), servable: z.boolean().nullable().optional(), reasons_not_servable: z.array(z.string().min(1).max(1000)).max(20).optional(), effective_status: z.string().max(100).optional(), timezone: z.string().min(1).max(100).optional(), timezone_switch_at: z.iso.datetime().nullable().optional() });
export type XCapabilityEntity = z.infer<typeof entitySchema>;
const entityPageSchema = z.object({ kind: z.literal("entities"), resource: z.enum(["account", "campaign", "ad_group", "ad"]), items: z.array(entitySchema).max(100), cursor: z.string().max(2048).nullable() });
const dailyReportSchema = z.object({ kind: z.literal("daily"), complete: z.boolean(), rows: z.array(z.object({ entityId, index: z.number().int().min(0).max(6), metrics: metricValuesSchema })).max(140) });
export type XEntityPage = z.infer<typeof entityPageSchema>;
export type XDailyReport = z.infer<typeof dailyReportSchema>;
const activeEntitySchema = z.object({ entity_id: entityId, activity_start_time: z.iso.datetime(), activity_end_time: z.iso.datetime(), placements: z.array(reportCommandSchema.shape.placement).min(1).max(3).refine(values => new Set(values).size === values.length) });
export type XActivePage = { kind: "active"; items: z.infer<typeof activeEntitySchema>[] };
/** Validate window/account echoes, unique IDs and documented placements before metadata reads.
 * @returns Bounded active set or protocol_mismatch, no effects. O(n), n<=1,000.
 */
export function decodeActiveEntities(required: { input: unknown; entity: string; accountId: string; window: { start: number; end: number } }): Outcome<XActivePage> {
  const parsed = z.object({ data: z.array(activeEntitySchema).max(1000), request: z.object({ params: z.object({ account_id: entityId, entity: supportedEntity, start_time: z.iso.datetime(), end_time: z.iso.datetime() }) }) }).safeParse(required.input);
  if (!parsed.success) return invalidReport();
  const p = parsed.data.request.params, items = parsed.data.data;
  if (p.account_id !== required.accountId || p.entity !== required.entity || Date.parse(p.start_time) !== required.window.start || Date.parse(p.end_time) !== required.window.end) return invalidReport();
  if (new Set(items.map(item => item.entity_id)).size !== items.length || items.some(item => Date.parse(item.activity_end_time) < Date.parse(item.activity_start_time))) return invalidReport();
  return { ok: true, value: { kind: "active", items } };
}
const entityMetrics = { spend: { vendorField: "billed_charge_local_micro", meaning: "Billed charge in account currency micros, preserved exactly." }, impressions: { vendorField: "impressions", meaning: "Total impressions." }, clicks: { vendorField: "clicks", meaning: "All clicks, including likes and other engagements; not destination-link clicks." } };
/** Unsupported conversion definitions stay absent; account analytics exposes impressions only. */
export const metricMapping: MetricMapping = { pluginId: "x-ads", version: "1", grains: { account: { impressions: entityMetrics.impressions }, campaign: entityMetrics, ad_group: entityMetrics, ad: entityMetrics } };
/** Fixed DAY query; the caller proves account-timezone alignment before constructing the command. */
export function dailyQuery({ command }: { command: DailyCommand }): string {
  return new URLSearchParams({ entity: command.entity, entity_ids: command.entityIds.join(","), start_time: new Date(command.window.start).toISOString(), end_time: new Date(command.window.end).toISOString(), granularity: "DAY", placement: command.placement, metric_groups: dailyGroups({ entity: command.entity }).join(",") }).toString();
}
/** Validate echoed identity and every exact array before exposing rows. Missing entities make
 * coverage incomplete; explicit null means zero, omitted fields remain unavailable. O(n*d), n<=20,d<=7.
 */
export function decodeDaily(required: { input: unknown; command: DailyCommand; accountId: string }): Outcome<XDailyReport> {
  const parsed = dailyResponse.safeParse(required.input);
  if (!parsed.success) return invalidReport();
  const { data, time_series_length } = parsed.data;
  if (!matchesDailyRequest({ params: parsed.data.request.params, command: required.command, accountId: required.accountId })) return invalidReport();
  if (!validDailyData({ data: parsed.data, command: required.command })) return invalidReport();
  const rows = data.flatMap(item => Array.from({ length: time_series_length }, (_, index) => dailyRow({ id: item.id, index, metrics: item.id_data[0].metrics, account: required.command.entity === "ACCOUNT" })));
  return { ok: true, value: { kind: "daily", complete: data.length === required.command.entityIds.length, rows } };
}
/** Compare the exact request identity without using echoed dates as authority. */
function matchesDailyRequest(required: { params: z.infer<typeof dailyParams>; command: DailyCommand; accountId: string }): boolean {
  const { params: p, command: c } = required;
  const groups = dailyGroups({ entity: c.entity });
  if (p.entity !== c.entity || p.placement !== c.placement) return false;
  if (Date.parse(p.start_time) !== c.window.start || Date.parse(p.end_time) !== c.window.end) return false;
  if (p.account_id !== undefined && p.account_id !== required.accountId) return false;
  const sameIds = p.entity_ids.length === c.entityIds.length && new Set(p.entity_ids).size === p.entity_ids.length && p.entity_ids.every(id => c.entityIds.includes(id));
  return sameIds && p.metric_groups.length === groups.length && groups.every(group => p.metric_groups.includes(group));
}
/** Daily array shape and unique requested entity IDs must agree before any placement sum. */
function validDailyData(required: { data: z.infer<typeof dailyResponse>; command: DailyCommand }): boolean {
  const { data, time_series_length } = required.data;
  if (time_series_length !== (required.command.window.end - required.command.window.start) / 86400000) return false;
  if (new Set(data.map(item => item.id)).size !== data.length) return false;
  if (data.some(item => !required.command.entityIds.includes(item.id))) return false;
  return data.every(item => Object.values(item.id_data[0].metrics).every(value => !Array.isArray(value) || value.length === time_series_length));
}
/** Returned null arrays/cells mean no serving; absent fields stay unavailable. */
function dailyRow(required: { id: string; index: number; metrics: z.infer<typeof dailyMetrics>; account: boolean }): XDailyReport["rows"][number] {
  const { metrics: m, index } = required;
  const metrics = required.account ? { impressions: dailyValue({ values: m.impressions, index }) } : { impressions: dailyValue({ values: m.impressions, index }), clicks: dailyValue({ values: m.clicks, index }), spend: dailyValue({ values: m.billed_charge_local_micro, index }) };
  return { entityId: required.id, index, metrics };
}
/** O(1), pure; preserve missing-field evidence while normalizing documented nulls. */
function dailyValue(required: { values: z.infer<typeof dailyValues>; index: number }): string | null {
  if (required.values === undefined) return null;
  return required.values?.[required.index] ?? "0";
}
/** The documented account exception applies only to impressions among the declared metrics. */
function dailyGroups({ entity }: { entity: DailyCommand["entity"] }): ("ENGAGEMENT" | "BILLING")[] { return entity === "ACCOUNT" ? ["ENGAGEMENT"] : ["ENGAGEMENT", "BILLING"]; }
/** Bounded account-scoped pages for discovery/status; required parent fields are checked before
 * deriving a hierarchy. Foreign account echoes and duplicate IDs reject the entire page.
 */
export function decodeEntityPage(required: { input: unknown; resource: XEntityPage["resource"]; accountId: string; requestedIds?: string[] }): Outcome<XEntityPage> {
  if (required.resource === "account") {
    const parsed = z.object({ data: entitySchema.extend({ timezone: metricBatchSchema.shape.timezone, timezone_switch_at: z.iso.datetime().nullable() }) }).safeParse(required.input);
    if (!parsed.success || parsed.data.data.id !== required.accountId) return invalidReport();
    return { ok: true, value: { kind: "entities", resource: "account", items: [parsed.data.data], cursor: null } };
  }
  const schemas = { campaign: entitySchema.extend({ currency: z.string().regex(/^[A-Z]{3}$/), deleted: z.boolean(), entity_status: z.string().max(100) }), ad_group: entitySchema.extend({ campaign_id: entityId }), ad: entitySchema.extend({ line_item_id: entityId }) };
  const parsed = z.object({ data: z.array(schemas[required.resource]).max(100), next_cursor: z.string().min(1).max(2048).regex(/^[\x21-\x7e]+$/).nullable(), request: z.object({ params: z.object({ account_id: entityId }) }) }).safeParse(required.input);
  if (!parsed.success || parsed.data.request.params.account_id !== required.accountId) return invalidReport();
  if (new Set(parsed.data.data.map(item => item.id)).size !== parsed.data.data.length) return invalidReport();
  if (required.requestedIds && parsed.data.data.some(item => !required.requestedIds!.includes(item.id))) return invalidReport();
  return { ok: true, value: { kind: "entities", resource: required.resource, items: parsed.data.data, cursor: parsed.data.next_cursor } };
}

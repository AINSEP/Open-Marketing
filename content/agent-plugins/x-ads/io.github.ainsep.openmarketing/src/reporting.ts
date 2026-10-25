/** Pure synchronous analytics codec; no summation, FX, or inferred account total. */
import { z } from "zod";
import type { Outcome } from "@open-marketing/contracts";

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

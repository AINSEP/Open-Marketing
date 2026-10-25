import { z } from "zod";
import type { Outcome } from "@open-marketing/contracts";

const day = z.string().regex(/^20[0-9]{2}-[0-9]{2}-[0-9]{2}$/).refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value);
const campaignId = z.string().regex(/^[1-9][0-9]{0,15}$/).refine(value => Number.isSafeInteger(Number(value)));
/** Inclusive provider calendar dates, maximum 31 days; no UTC interval or timezone inference. */
export const reportCommandSchema = z.strictObject({
  kind: z.literal("report"), view: z.enum(["account", "campaign"]), dateFrom: day, dateTo: day,
  campaignIds: z.array(campaignId).min(1).max(100).refine(value => new Set(value).size === value.length).optional(),
  limit: z.number().int().min(1).max(1000).default(1000), offset: z.number().int().min(0).max(1000000).default(0),
}).refine(value => value.dateTo >= value.dateFrom && Date.parse(value.dateTo) - Date.parse(value.dateFrom) < 31 * 86400000)
  .refine(value => value.view === "campaign" || value.campaignIds === undefined);
type ReportCommand = z.infer<typeof reportCommandSchema>;
const count = z.string().regex(/^(0|[1-9][0-9]{0,19})$/);
const reportRow = z.object({ Date: day, CampaignId: campaignId.optional(), Impressions: count, Clicks: count, Cost: count });
/** Source-labelled micros and exact counters, with no inferred totals or exchange conversion. */
export interface YandexDirectReport {
  readonly source: "yandex_direct_reports"; readonly apiVersion: "v501"; readonly accountId: string; readonly currency: string; readonly retrievedAt: number;
  readonly dateFrom: string; readonly dateTo: string; readonly calendar: "provider"; readonly includeVAT: false; readonly moneyUnit: "micros";
  readonly availability: "reported" | "no_data_access_unconfirmed"; readonly potentiallyIncomplete: boolean; readonly nextOffset: number | null;
  readonly rows: readonly z.infer<typeof reportRow>[];
}
function columns(required: { command: ReportCommand }): string[] { return ["Date", ...(required.command.view === "campaign" ? ["CampaignId"] : []), "Impressions", "Clicks", "Cost"]; }
/** Fixed online report specification, explicit VAT exclusion and stable page ordering.
 * @complexity O(n) time/space, n<=100 campaign filters; no I/O. */
export function encodeReport(required: { command: ReportCommand }): object {
  const command = required.command;
  return { params: {
    SelectionCriteria: { DateFrom: command.dateFrom, DateTo: command.dateTo, ...(command.campaignIds ? { Filter: [{ Field: "CampaignId", Operator: "IN", Values: command.campaignIds }] } : {}) },
    FieldNames: columns(required), Page: { Limit: command.limit, Offset: command.offset },
    OrderBy: ["Date", ...(command.view === "campaign" ? ["CampaignId"] : [])].map(Field => ({ Field, SortOrder: "ASCENDING" })),
    ReportName: "OM " + command.view + " " + command.dateFrom + " " + command.dateTo, ReportType: command.view === "account" ? "ACCOUNT_PERFORMANCE_REPORT" : "CAMPAIGN_PERFORMANCE_REPORT",
    DateRangeType: "CUSTOM_DATE", Format: "TSV", IncludeVAT: "NO", IncludeDiscount: "NO",
  } };
}
/** Reject malformed/mixed/duplicate/out-of-window rows atomically; full pages remain incomplete.
 * @complexity O(b+n*m) time, O(b+n) space; b<=1MiB, n<=1000 rows, m<=100 IDs. */
export function decodeReport(required: { text: string; command: ReportCommand; accountId: string; currency: string; retrievedAt: number }): Outcome<YandexDirectReport> {
  const { command } = required;
  const decoded = decodeRows(required);
  if (!decoded.ok) return decoded;
  const rows = decoded.value;
  const next = command.offset + rows.length;
  const potentiallyIncomplete = rows.length === command.limit;
  return { ok: true, value: { source: "yandex_direct_reports", apiVersion: "v501", accountId: required.accountId, currency: required.currency, retrievedAt: required.retrievedAt, dateFrom: command.dateFrom, dateTo: command.dateTo,
    calendar: "provider", includeVAT: false, moneyUnit: "micros", availability: rows.length ? "reported" : "no_data_access_unconfirmed", potentiallyIncomplete, nextOffset: potentiallyIncomplete && next <= 1000000 ? next : null, rows } };
}
/** TSV rows validate as one page; duplicate keys or one malformed row reject all rows.
 * @complexity O(b+n*m) time/O(b+n) space; bounded by the transport and report schema. */
function decodeRows(required: { text: string; command: ReportCommand }): Outcome<z.infer<typeof reportRow>[]> {
  const { command } = required;
  const lines = required.text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  const names = columns({ command });
  if (lines.shift() !== names.join("\t") || lines.length > command.limit) return invalid();
  const rows: z.infer<typeof reportRow>[] = [];
  const keys = new Set<string>();
  for (const line of lines) {
    const cells = line.split("\t");
    if (cells.length !== names.length) return invalid();
    const parsed = reportRow.safeParse(Object.fromEntries(names.map((name, index) => [name, cells[index]])));
    if (!parsed.success || !rowMatches({ row: parsed.data, command })) return invalid();
    const key = parsed.data.Date + ":" + (parsed.data.CampaignId ?? "account");
    if (keys.has(key)) return invalid();
    keys.add(key); rows.push(parsed.data);
  }
  return { ok: true, value: rows };
}
function rowMatches(required: { row: z.infer<typeof reportRow>; command: ReportCommand }): boolean {
  if (required.row.Date < required.command.dateFrom || required.row.Date > required.command.dateTo) return false;
  return required.command.campaignIds === undefined || required.command.campaignIds.includes(required.row.CampaignId ?? "");
}
function invalid(): Outcome<never> { return { ok: false, error: { code: "protocol_mismatch", message: "Yandex Direct report invalid", retryable: false } }; }

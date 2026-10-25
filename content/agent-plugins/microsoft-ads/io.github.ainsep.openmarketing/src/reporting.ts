import { z } from "zod";
import type { CallOptions, Outcome } from "@open-marketing/contracts";
import { request } from "./commands.js";
import { failure } from "./ports.js";
import type { MicrosoftAdsArchiveEntry, MicrosoftAdsDependencies, MicrosoftAdsWireRequest } from "./ports.js";
const dayMs = 86400000;
const utcDay = z.number().int().min(Date.UTC(2000, 0, 1)).max(Date.UTC(2100, 0, 1)).refine(value => value % dayMs === 0);
export const reportCommandSchema = z.strictObject({ kind: z.literal("report"), window: z.strictObject({ start: utcDay, end: utcDay }) })
  .refine(value => value.window.end > value.window.start && value.window.end - value.window.start <= 366 * dayMs);
type ReportCommand = z.infer<typeof reportCommandSchema>;
const columns = ["AccountId", "CampaignId", "TimePeriod", "CurrencyCode", "Spend", "Impressions", "Clicks", "ConversionsQualified"];
const decimal = z.string().max(64).regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/);
const id = z.string().regex(/^[1-9][0-9]{0,18}$/);
const count = z.string().max(32).regex(/^(0|[1-9][0-9]*)$/);
const date = z.iso.date();
const rowSchema = z.tuple([id, id, date, z.string().regex(/^[A-Z]{3}$/), decimal, count, count, decimal]);
export interface MicrosoftAdsReport {
  readonly source: "microsoft_campaign_performance";
  readonly apiVersion: "13";
  readonly timezone: "UTC";
  readonly retrievedAt: number;
  readonly accountId: string;
  readonly currency: string;
  readonly window: ReportCommand["window"];
  readonly availability: "reported" | "no_data";
  readonly rows: readonly { accountId: string; campaignId: string; day: string; currency: string; spend: string; impressions: string; clicks: string; conversions: string }[];
}
type ReportInput = { dependencies: MicrosoftAdsDependencies; command: ReportCommand; rpc: (required: { request: MicrosoftAdsWireRequest }) => Promise<Outcome<unknown>>; download: MicrosoftAdsDependencies["download"] };
/** One submit, <=6 polls and injected waits inside invoke's 60s deadline. No resubmission.
 * @param required - Scoped binding, ZIP reader and already fenced RPC/download effects.
 * @returns Report/no-data, expired polling, or typed failure. @complexity O(b+n), b<=8MiB, n<=10000.
 */
export async function runReport(required: ReportInput, optional?: CallOptions): Promise<Outcome<MicrosoftAdsReport>> {
  const config = required.dependencies.configuration;
  const deadline = required.dependencies.clock.now({}) + 60000;
  const submitted = await required.rpc({ request: request({ service: "Reporting", path: "GenerateReport/Submit", body: { ReportRequest: {
    Type: "CampaignPerformanceReportRequest", Format: "Tsv", FormatVersion: "2.0", Aggregation: "Daily", Columns: columns,
    ExcludeReportHeader: true, ExcludeReportFooter: true, ExcludeColumnHeaders: false, ReturnOnlyCompleteData: true,
    Scope: { AccountIds: [Number(config.accountId)] }, Time: { CustomDateRangeStart: wireDate({ epoch: required.command.window.start }), CustomDateRangeEnd: wireDate({ epoch: required.command.window.end - dayMs }) },
  } } }) });
  if (!submitted.ok) return submitted;
  const parsed = z.object({ ReportRequestId: z.string().min(1).max(40) }).safeParse(submitted.value);
  if (!parsed.success) return failure({ code: "protocol_mismatch" });
  return pollReport({ ...required, reportId: parsed.data.ReportRequestId, deadline }, optional);
}
/** Bounded polling has no retry/submission path. @complexity <=6 RPCs and five waits. */
async function pollReport(required: ReportInput & { reportId: string; deadline: number }, optional?: CallOptions): Promise<Outcome<MicrosoftAdsReport>> {
  for (let poll = 0; poll < 6; poll++) {
    if (poll > 0) await required.dependencies.wait({ milliseconds: 5000 }, optional);
    if (optional?.signal?.aborted || required.dependencies.clock.now({}) >= required.deadline) return failure({ code: "expired" });
    const response = await pollStatus(required);
    if (!response.ok) return response;
    if (response.value.Status === "Pending") continue;
    return finishReport({ ...required, status: response.value }, optional);
  }
  return failure({ code: "expired" });
}
const pollSchema = z.object({ ReportRequestStatus: z.object({ Status: z.enum(["Pending", "Success", "Error"]), ReportDownloadUrl: z.string().max(4096).nullable().optional() }) });
/** Parse the private poll response before selecting lifecycle behavior. @complexity One bounded RPC. */
async function pollStatus(required: ReportInput & { reportId: string; deadline: number }): Promise<Outcome<z.infer<typeof pollSchema>["ReportRequestStatus"]>> {
  const response = await required.rpc({ request: request({ service: "Reporting", path: "GenerateReport/Poll", body: { ReportRequestId: required.reportId } }) });
  if (!response.ok) return response;
  if (required.dependencies.clock.now({}) >= required.deadline) return failure({ code: "expired" });
  const parsed = pollSchema.safeParse(response.value);
  if (!parsed.success) return failure({ code: "protocol_mismatch" });
  return { ok: true, value: parsed.data.ReportRequestStatus };
}
/** Success with nil URL means no data; errors never become empty reports. @complexity O(b<=8MiB). */
async function finishReport(required: ReportInput & { status: z.infer<typeof pollSchema>["ReportRequestStatus"]; deadline: number }, optional?: CallOptions): Promise<Outcome<MicrosoftAdsReport>> {
  if (required.status.Status !== "Success") return failure({ code: "unavailable" });
  const url = required.status.ReportDownloadUrl;
  if (url === null || url === undefined) return reportResult({ ...required, rows: [] });
  const file = await downloadReport({ dependencies: required.dependencies, download: required.download, url }, optional);
  if (!file.ok) return file;
  if (optional?.signal?.aborted || required.dependencies.clock.now({}) >= required.deadline) return failure({ code: "expired" });
  return decodeReport({ ...required, text: file.value });
}
function wireDate(required: { epoch: number }): { Year: number; Month: number; Day: number } {
  const value = new Date(required.epoch);
  return { Year: value.getUTCFullYear(), Month: value.getUTCMonth() + 1, Day: value.getUTCDate() };
}
/** Download callback enters the RPC policy/audit fence; host guard checks public DNS and redirects.
 * ZIP ABI is injected from Jini; file/expanded limits are independently enforced here. @complexity O(b<=8MiB).
 */
async function downloadReport(required: { dependencies: MicrosoftAdsDependencies; download: MicrosoftAdsDependencies["download"]; url: string }, optional?: CallOptions): Promise<Outcome<string>> {
  const url = new URL(required.url);
  if (!safeDownloadUrl({ url })) return failure({ code: "forbidden" });
  const downloaded = await required.download({ url: url.href, maxBytes: 2097152 }, optional);
  if (!downloaded.ok) return failure({ code: downloaded.error.code });
  if (downloaded.value.byteLength > 2097152) return failure({ code: "limit_exceeded" });
  let text: string | undefined;
  for await (const entry of required.dependencies.archiveReader.entries({ archive: downloaded.value })) {
    if (text !== undefined) return failure({ code: "protocol_mismatch" });
    const content = await extractEntry({ entry }, optional);
    if (!content.ok) return content;
    text = content.value;
  }
  if (text === undefined) return failure({ code: "protocol_mismatch" });
  return { ok: true, value: text };
}
/** Local URL checks supplement host public-DNS/redirect enforcement. @complexity O(1). */
function safeDownloadUrl(required: { url: URL }): boolean {
  const url = required.url;
  return url.protocol === "https:" && !url.username && !url.password && !url.hash && (url.port === "" || url.port === "443");
}
/** Reject non-files and unsafe ZIP paths before opening a bounded stream. @complexity O(b<=8MiB). */
async function extractEntry(required: { entry: MicrosoftAdsArchiveEntry }, optional?: CallOptions): Promise<Outcome<string>> {
  const entry = required.entry;
  if (entry.kind !== "file") return failure({ code: "protocol_mismatch" });
  if (!/^[A-Za-z0-9_ -][A-Za-z0-9_. -]{0,199}$/.test(entry.entryPath) || entry.executable) return failure({ code: "protocol_mismatch" });
  if ((entry.declaredSize ?? 0) > 8388608) return failure({ code: "limit_exceeded" });
  return readFile({ stream: entry.openReadStream({}) }, optional);
}
/** Count actual expanded bytes, never trust ZIP metadata. @complexity O(b<=8MiB) time/space. */
async function readFile(required: { stream: AsyncIterable<Uint8Array> }, optional?: CallOptions): Promise<Outcome<string>> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of required.stream) {
    if (optional?.signal?.aborted) return failure({ code: "expired" });
    size += chunk.byteLength;
    if (size > 8388608) return failure({ code: "limit_exceeded" });
    chunks.push(chunk);
  }
  try { return { ok: true, value: new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)) }; } catch { return failure({ code: "protocol_mismatch" }); }
}
/** Fixed scalar TSV only. Quotes must enclose a whole scalar; no embedded quotes/newlines.
 * Validate every row and account/date/currency before exposing anything. @complexity O(b+n), n<=10000.
 */
function decodeReport(required: ReportInput & { text: string }): Outcome<MicrosoftAdsReport> {
  const lines = required.text.replace(/^\uFEFF/, "").replace(/\r?\n$/, "").split(/\r?\n/, 10002);
  if (lines.length > 10001) return failure({ code: "limit_exceeded" });
  const cells = lines.map(line => line.split("\t", columns.length + 1).map(cell => cell.replace(/^"([^"\r\n]*)"$/, "$1")));
  if (JSON.stringify(cells.shift()) !== JSON.stringify(columns)) return failure({ code: "protocol_mismatch" });
  const parsed = z.array(rowSchema).safeParse(cells);
  if (!parsed.success) return failure({ code: "protocol_mismatch" });
  const rows = parsed.data.map(item => ({ accountId: item[0], campaignId: item[1], day: item[2], currency: item[3], spend: item[4], impressions: item[5], clicks: item[6], conversions: item[7] }));
  if (rows.some(row => row.accountId !== required.dependencies.configuration.accountId || row.currency !== required.dependencies.configuration.currency)) return failure({ code: "forbidden" });
  if (rows.some(row => Date.parse(row.day) < required.command.window.start || Date.parse(row.day) >= required.command.window.end)) return failure({ code: "protocol_mismatch" });
  if (new Set(rows.map(row => row.campaignId + ":" + row.day)).size !== rows.length) return failure({ code: "protocol_mismatch" });
  return reportResult({ ...required, rows });
}
function reportResult(required: ReportInput & { rows: MicrosoftAdsReport["rows"] }): Outcome<MicrosoftAdsReport> {
  const config = required.dependencies.configuration;
  return { ok: true, value: { source: "microsoft_campaign_performance", apiVersion: "13", timezone: "UTC", retrievedAt: required.dependencies.clock.now({}), accountId: config.accountId!, currency: config.currency!, window: required.command.window, availability: required.rows.length ? "reported" : "no_data", rows: required.rows } };
}

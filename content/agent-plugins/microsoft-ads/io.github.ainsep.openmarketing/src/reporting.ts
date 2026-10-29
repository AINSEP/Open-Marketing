import { z } from "zod";
import { metricBatchSchema, decimalToMicros } from "@open-marketing/contracts";
import type { CallOptions, Outcome, MetricBatch, MetricMapping, MetricGrain, ReportMetricsInput, CampaignStatusOutput } from "@open-marketing/contracts";
import { request, statusRequest } from "./commands.js";
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
type ReportDependencies = {
  configuration: { connectionId: string; accountId: string | null; currency: string | null };
  clock: MicrosoftAdsDependencies["clock"];
  wait: (required: { milliseconds: number }, optional?: CallOptions) => Promise<unknown>;
  archiveReader: MicrosoftAdsDependencies["archiveReader"];
};
type ReportInput = { dependencies: ReportDependencies; command: ReportCommand; rpc: (required: { request: MicrosoftAdsWireRequest }) => Promise<Outcome<unknown>>; download: MicrosoftAdsDependencies["download"] };
/** One submit, <=6 polls and injected waits inside a 25s budget. No resubmission.
 * @param required - Scoped binding, ZIP reader and already fenced RPC/download effects.
 * @returns Report/no-data, expired polling, or typed failure. @complexity O(b+n), b<=8MiB, n<=10000.
 */
export async function runReport(required: ReportInput, optional?: CallOptions): Promise<Outcome<MicrosoftAdsReport>> {
  const config = required.dependencies.configuration;
  const file = await fetchReport({ ...required, reportRequest: {
    Type: "CampaignPerformanceReportRequest", Format: "Tsv", FormatVersion: "2.0", Aggregation: "Daily", Columns: columns,
    ExcludeReportHeader: true, ExcludeReportFooter: true, ExcludeColumnHeaders: false, ReturnOnlyCompleteData: true,
    Scope: { AccountIds: [Number(config.accountId)] }, Time: { CustomDateRangeStart: wireDate({ epoch: required.command.window.start }), CustomDateRangeEnd: wireDate({ epoch: required.command.window.end - dayMs }) },
  } }, optional);
  if (!file.ok) return file;
  return file.value === null ? reportResult({ ...required, rows: [] }) : decodeReport({ ...required, text: file.value });
}
type Workflow = Omit<ReportInput, "command">;
/** Shared submit/poll/download lifecycle; no credentials or effects bypass the supplied fence. */
async function fetchReport(required: Workflow & { reportRequest: unknown }, optional?: CallOptions): Promise<Outcome<string | null>> {
  const deadline = required.dependencies.clock.now({}) + 25000;
  const submitted = await required.rpc({ request: request({ service: "Reporting", path: "GenerateReport/Submit", body: { ReportRequest: required.reportRequest } }) });
  if (!submitted.ok) return submitted;
  const parsed = z.object({ ReportRequestId: z.string().min(1).max(40) }).safeParse(submitted.value);
  if (!parsed.success) return failure({ code: "protocol_mismatch" });
  return pollReport({ ...required, reportId: parsed.data.ReportRequestId, deadline }, optional);
}
/** Bounded polling has no retry/submission path. @complexity <=6 RPCs and five waits. */
async function pollReport(required: Workflow & { reportId: string; deadline: number }, optional?: CallOptions): Promise<Outcome<string | null>> {
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
async function pollStatus(required: Workflow & { reportId: string; deadline: number }): Promise<Outcome<z.infer<typeof pollSchema>["ReportRequestStatus"]>> {
  const response = await required.rpc({ request: request({ service: "Reporting", path: "GenerateReport/Poll", body: { ReportRequestId: required.reportId } }) });
  if (!response.ok) return response;
  if (required.dependencies.clock.now({}) >= required.deadline) return failure({ code: "expired" });
  const parsed = pollSchema.safeParse(response.value);
  if (!parsed.success) return failure({ code: "protocol_mismatch" });
  return { ok: true, value: parsed.data.ReportRequestStatus };
}
/** Success with nil URL means no data; errors never become empty reports. @complexity O(b<=8MiB). */
async function finishReport(required: Workflow & { status: z.infer<typeof pollSchema>["ReportRequestStatus"]; deadline: number }, optional?: CallOptions): Promise<Outcome<string | null>> {
  if (required.status.Status !== "Success") return failure({ code: "unavailable" });
  const url = required.status.ReportDownloadUrl;
  if (url === null || url === undefined) return { ok: true, value: null };
  const file = await downloadReport({ dependencies: required.dependencies, download: required.download, url }, optional);
  if (!file.ok) return file;
  if (optional?.signal?.aborted || required.dependencies.clock.now({}) >= required.deadline) return failure({ code: "expired" });
  return file;
}
function wireDate(required: { epoch: number }): { Year: number; Month: number; Day: number } {
  const value = new Date(required.epoch);
  return { Year: value.getUTCFullYear(), Month: value.getUTCMonth() + 1, Day: value.getUTCDate() };
}
/** Download callback enters the RPC policy/audit fence; host guard checks public DNS and redirects.
 * ZIP reader is injected; file/expanded limits are independently enforced here. @complexity O(b<=8MiB).
 */
async function downloadReport(required: { dependencies: ReportDependencies; download: MicrosoftAdsDependencies["download"]; url: string }, optional?: CallOptions): Promise<Outcome<string>> {
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

const baseMetrics = {
  spend: { vendorField: "Spend", meaning: "Account-currency spend, converted from whole currency units to integer micros." },
  impressions: { vendorField: "Impressions", meaning: "Number of times the ad was displayed." },
  clicks: { vendorField: "Clicks", meaning: "Clicks on the ad; not restricted to destination-link clicks." },
  vendorConversions: { vendorField: "ConversionsQualified", meaning: "Fractional conversions for goals included in Conversions, attributed using each configured goal's attribution model and conversion window; excludes goals excluded from bidding." },
  vendorConversionValue: { vendorField: "Revenue", meaning: "Advertiser-reported revenue for the included conversions in account currency, using the configured conversion goals and windows." },
};
/** Frozen capability support declaration; conversion windows belong to the account's goals. */
export const metricMapping: MetricMapping = { pluginId: "microsoft-ads", version: "1", grains: { account: baseMetrics, campaign: baseMetrics, ad_group: baseMetrics, ad: baseMetrics } };
const identities: Record<MetricGrain, string[]> = { account: ["AccountId"], campaign: ["AccountId", "CampaignId"], ad_group: ["AccountId", "CampaignId", "AdGroupId"], ad: ["AccountId", "CampaignId", "AdGroupId", "AdId"] };
const reportTypes: Record<MetricGrain, string> = { account: "Account", campaign: "Campaign", ad_group: "AdGroup", ad: "Ad" };
/** Grain-specific daily performance via the existing bounded ZIP workflow. Reports use UTC
 * buckets regardless of account timezone. No hourly regrouping is assumed.
 * @returns Schema-validated batch or an explicit boundary failure; O(b+n), b<=8MiB, n<=5,000.
 * @example runMetricsReport({ dependencies, input, rpc, download })
 */
export async function runMetricsReport(required: Workflow & { input: ReportMetricsInput }, optional?: CallOptions): Promise<Outcome<MetricBatch>> {
  const { configuration } = required.dependencies;
  const columns = [...identities[required.input.grain], "TimePeriod", "CurrencyCode", "Spend", "Impressions", "Clicks", "ConversionsQualified", "Revenue"];
  const file = await fetchReport({ ...required, reportRequest: {
    Type: reportTypes[required.input.grain] + "PerformanceReportRequest", Format: "Tsv", FormatVersion: "2.0", Aggregation: "Daily", Columns: columns,
    ExcludeReportHeader: true, ExcludeReportFooter: true, ExcludeColumnHeaders: false, ReturnOnlyCompleteData: true,
    Scope: { AccountIds: [Number(configuration.accountId)] }, Time: { CustomDateRangeStart: wireDate({ epoch: Date.parse(required.input.days.start) }), CustomDateRangeEnd: wireDate({ epoch: Date.parse(required.input.days.end) - dayMs }) },
  } }, optional);
  if (!file.ok) return file;
  return decodeMetricsReport({ dependencies: required.dependencies, input: required.input, text: file.value, columns });
}
/** Validate the entire file before projection. Duplicate entity/day rows reject atomically.
 * Empty cells are unavailable; unsupported metrics are absent only from the declaration.
 * @complexity O(b+n) time/space, b<=8MiB and n<=5,000.
 */
function decodeMetricsReport(required: { dependencies: ReportDependencies; input: ReportMetricsInput; text: string | null; columns: string[] }): Outcome<MetricBatch> {
  const rows: MetricBatch["rows"] = [];
  const lines = required.text === null ? [] : required.text.replace(/^\uFEFF/, "").replace(/\r?\n$/, "").split(/\r?\n/, 5003);
  if (lines.length > 5001) return failure({ code: "limit_exceeded" });
  if (required.text !== null && JSON.stringify(tsvCells({ line: lines.shift()! })) !== JSON.stringify(required.columns)) return failure({ code: "protocol_mismatch" });
  for (const line of lines) {
    const decoded = metricRow({ ...required, cells: tsvCells({ line }) });
    if (!decoded.ok) return decoded;
    rows.push(decoded.value);
  }
  const config = required.dependencies.configuration;
  const batch = metricBatchSchema.safeParse({ schema: "report.metrics.v1", pluginId: "microsoft-ads", connectionId: config.connectionId, accountId: config.accountId,
    currency: config.currency, timezone: "UTC", ...required.input, mapping: metricMapping, retrievedAt: required.dependencies.clock.now({}),
    dataThrough: Date.parse(required.input.days.end), complete: true, freshness: "stale", finality: "provisional", restated: false, rows });
  return batch.success ? { ok: true, value: batch.data } : failure({ code: "protocol_mismatch" });
}
/** Scalar TSV only, matching the preexisting report codec; no escaped multiline cells. */
function tsvCells({ line }: { line: string }): string[] { return line.split("\t").map(cell => cell.replace(/^"([^"\r\n]*)"$/, "$1")); }
/** One row's identifiers, currency and exact decimals; the batch schema checks dates/uniqueness. */
function metricRow(required: { input: ReportMetricsInput; dependencies: ReportDependencies; cells: string[]; columns: string[] }): Outcome<MetricBatch["rows"][number]> {
  if (required.cells.length !== required.columns.length) return failure({ code: "protocol_mismatch" });
  const row = Object.fromEntries(required.columns.map((key, index) => [key, required.cells[index]]));
  if (identities[required.input.grain].some(key => !id.safeParse(row[key]).success)) return failure({ code: "protocol_mismatch" });
  if (row.AccountId !== required.dependencies.configuration.accountId || row.CurrencyCode !== required.dependencies.configuration.currency) return failure({ code: "forbidden" });
  const parsed = z.object({ Spend: decimal.nullable(), Impressions: count.nullable(), Clicks: count.nullable(), ConversionsQualified: decimal.nullable(), Revenue: decimal.nullable() }).safeParse(Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value === "" ? null : value])));
  if (!parsed.success) return failure({ code: "protocol_mismatch" });
  const m = parsed.data;
  const spend = scaledDecimal({ value: m.Spend }), conversions = scaledDecimal({ value: m.ConversionsQualified }), revenue = scaledDecimal({ value: m.Revenue });
  if (!spend.ok) return spend;
  if (!conversions.ok) return conversions;
  if (!revenue.ok) return revenue;
  return { ok: true, value: { day: row.TimePeriod, entity: metricEntity({ grain: required.input.grain, row }), metrics: { spend: spend.value, impressions: m.Impressions, clicks: m.Clicks, vendorConversions: conversions.value, vendorConversionValue: revenue.value } } };
}
/** Preserve unavailable cells; shared exact scaling failures are tainted vendor evidence. */
function scaledDecimal({ value }: { value: string | null }): Outcome<string | null> {
  if (value === null) return { ok: true, value: null };
  const result = decimalToMicros({ value, rounding: "reject" });
  return result.ok ? result : failure({ code: "protocol_mismatch" });
}
/** Hierarchy columns are mandatory at the requested grain; no inferred parent identifiers. */
function metricEntity({ grain, row }: { grain: MetricGrain; row: Record<string, string> }): MetricBatch["rows"][number]["entity"] {
  switch (grain) {
    case "account": return { grain };
    case "campaign": return { grain, vendorCampaignId: row.CampaignId };
    case "ad_group": return { grain, vendorCampaignId: row.CampaignId, vendorAdGroupId: row.AdGroupId };
    case "ad": return { grain, vendorCampaignId: row.CampaignId, vendorAdGroupId: row.AdGroupId, vendorAdId: row.AdId };
  }
}

const providerId = z.union([id, z.number().int().positive().max(Number.MAX_SAFE_INTEGER).transform(String)]);
const partialErrors = z.array(z.null()).max(1000).nullish();
const statusCampaign = z.object({ Id: providerId, CampaignType: z.string().max(100), Status: z.string().max(100) });
const campaignPage = z.object({ Campaigns: z.array(statusCampaign.nullable()).max(100), PartialErrors: z.array(z.object({ Index: z.number().int().nonnegative(), Code: z.number().int().nonnegative() }).nullable()).max(100).nullish() });
const editorialEntity = z.object({ Id: providerId, EditorialStatus: z.string().max(100) });
type Rpc = Workflow["rpc"];
/** Requested campaigns only, with scoped Search children for editorial evidence. Other
 * campaign types remain unknown until their review surfaces are verified. O(n), <=1,000 RPCs.
 */
export async function runCampaignStatus(required: { campaignIds: string[]; accountId: string; rpc: Rpc; clock: MicrosoftAdsDependencies["clock"] }): Promise<Outcome<CampaignStatusOutput>> {
  const response = await required.rpc({ request: statusRequest({ accountId: required.accountId, campaignIds: required.campaignIds }) });
  if (!response.ok) return response;
  const campaigns = decodeCampaigns({ input: response.value, campaignIds: required.campaignIds });
  if (!campaigns.ok) return campaigns;
  const observations = new Map<string, CampaignStatusOutput["campaigns"][number]>();
  for (const campaign of campaigns.value) {
    const review = await campaignObservation({ ...required, campaign });
    if (!review.ok && review.error.code === "limit_exceeded") break;
    if (!review.ok) return review;
    if (review.value !== null) observations.set(campaign.Id, review.value);
  }
  return { ok: true, value: { observedAt: required.clock.now({}), complete: observations.size === required.campaignIds.length,
    campaigns: required.campaignIds.map(vendorCampaignId => observations.get(vendorCampaignId) ?? { vendorCampaignId, status: "unknown", disapprovalDescriptions: [] }) } };
}
/** Unsupported or oversized campaigns stay unknown without consuming later campaigns' slots. */
async function campaignObservation(required: { campaign: z.infer<typeof statusCampaign>; accountId: string; rpc: Rpc }): Promise<Outcome<CampaignStatusOutput["campaigns"][number] | null>> {
  if (required.campaign.CampaignType !== "Search") return { ok: true, value: null };
  const review = await campaignReview({ ...required, campaignId: required.campaign.Id });
  if (!review.ok) return review;
  if (review.value === null) return { ok: true, value: null };
  return { ok: true, value: { vendorCampaignId: required.campaign.Id, status: microsoftStatus({ lifecycle: required.campaign.Status, review: review.value }), disapprovalDescriptions: review.value.reasons } };
}
/** Partial errors name positions in the requested ID array. Reject malformed/foreign evidence
 * before preserving successful Search campaigns. Pure O(n), n<=100.
 */
function decodeCampaigns(required: { input: unknown; campaignIds: string[] }): Outcome<z.infer<typeof statusCampaign>[]> {
  const parsed = campaignPage.safeParse(required.input);
  if (!parsed.success) return failure({ code: "protocol_mismatch" });
  const campaigns = parsed.data.Campaigns.filter(item => item !== null);
  if (campaigns.some(item => !required.campaignIds.includes(item.Id)) || new Set(campaigns.map(item => item.Id)).size !== campaigns.length) return failure({ code: "protocol_mismatch" });
  const errors = (parsed.data.PartialErrors ?? []).filter(item => item !== null);
  const indices = errors.map(item => item.Index);
  if (!errors.length) return { ok: true, value: campaigns };
  if (new Set(indices).size !== indices.length || indices.some(index => index >= required.campaignIds.length)) return failure({ code: "protocol_mismatch" });
  if (parsed.data.Campaigns.length !== required.campaignIds.length) return failure({ code: "protocol_mismatch" });
  if (!parsed.data.Campaigns.every((item, index) => indices.includes(index) ? item === null : item?.Id === required.campaignIds[index])) return failure({ code: "protocol_mismatch" });
  return { ok: true, value: campaigns };
}
type Review = { states: string[]; reasons: string[] };
/** Scan only the selected campaign's groups, keeping the total request cap at the transport. */
async function campaignReview(required: { campaignId: string; accountId: string; rpc: Rpc }): Promise<Outcome<Review | null>> {
  const response = await required.rpc({ request: request({ service: "CampaignManagement", path: "AdGroups/QueryByCampaignId", body: { CampaignId: required.campaignId } }) });
  if (!response.ok) return response;
  const parsed = z.object({ AdGroups: z.array(z.object({ Id: providerId })).max(10000) }).safeParse(response.value);
  if (!parsed.success || new Set(parsed.data.AdGroups.map(item => item.Id)).size !== parsed.data.AdGroups.length) return failure({ code: "protocol_mismatch" });
  // This campaign is oversized; later campaigns still have the shared RPC/time budget.
  if (parsed.data.AdGroups.length > 1000) return { ok: true, value: null };
  const review: Review = { states: [], reasons: [] };
  for (const group of parsed.data.AdGroups) {
    const result = await groupReview({ ...required, groupId: group.Id });
    if (!result.ok) return result;
    review.states = [...new Set([...review.states, ...result.value.states])];
    review.reasons = [...new Set([...review.reasons, ...result.value.reasons])].slice(0, 20);
  }
  return { ok: true, value: review };
}
/** Ads and keywords use separate editorial queries, as required by Microsoft's API. */
async function groupReview(required: { groupId: string; accountId: string; rpc: Rpc }): Promise<Outcome<Review>> {
  const review: Review = { states: [], reasons: [] };
  for (const type of ["Ad", "Keyword"] as const) {
    const result = await readEditorialEntities({ ...required, type });
    if (!result.ok) return result;
    const entities = result.value;
    const reasons = await editorialReasons({ ...required, type, entities });
    if (!reasons.ok) return reasons;
    review.states.push(...entities.map(item => item.EditorialStatus)); review.reasons.push(...reasons.value);
  }
  return { ok: true, value: review };
}
/** Project a bounded, unique child collection for one editorial entity type. */
async function readEditorialEntities(required: { groupId: string; type: "Ad" | "Keyword"; rpc: Rpc }): Promise<Outcome<z.infer<typeof editorialEntity>[]>> {
  const resource = required.type === "Ad" ? "Ads" : "Keywords";
  const body = required.type === "Ad" ? { AdGroupId: required.groupId, AdTypes: ["Text", "Image", "Product", "AppInstall", "ExpandedText", "DynamicSearch", "ResponsiveAd", "ResponsiveSearch"] } : { AdGroupId: required.groupId };
  const response = await required.rpc({ request: request({ service: "CampaignManagement", path: resource + "/QueryByAdGroupId", body }) });
  if (!response.ok) return response;
  const parsed = z.object({ [resource]: z.array(editorialEntity).max(1000) }).safeParse(response.value);
  if (!parsed.success) return failure({ code: "protocol_mismatch" });
  const entities = parsed.data[resource];
  if (new Set(entities.map(item => item.Id)).size !== entities.length) return failure({ code: "protocol_mismatch" });
  return { ok: true, value: entities };
}
/** Correlate each reason with the exact requested child and parent; never borrow foreign reasons. */
async function editorialReasons(required: { groupId: string; accountId: string; type: "Ad" | "Keyword"; entities: z.infer<typeof editorialEntity>[]; rpc: Rpc }): Promise<Outcome<string[]>> {
  const failed = required.entities.filter(item => item.EditorialStatus === "Disapproved");
  if (!failed.length) return { ok: true, value: [] };
  const response = await required.rpc({ request: request({ service: "CampaignManagement", path: "EditorialReasons/QueryByIds", body: { AccountId: required.accountId, EntityType: required.type, EntityIdToParentIdAssociations: failed.map(item => ({ EntityId: item.Id, ParentId: required.groupId })) } }) });
  if (!response.ok) return response;
  const reason = z.object({ ReasonCode: z.number().int().nonnegative(), Location: z.string().max(200).nullish() });
  const parsed = z.object({ EditorialReasons: z.array(z.object({ AdGroupId: providerId, AdOrKeywordId: providerId, Reasons: z.array(reason).max(20) }).nullable()).max(1000), PartialErrors: partialErrors }).safeParse(response.value);
  if (!parsed.success || parsed.data.EditorialReasons.length !== failed.length) return failure({ code: "protocol_mismatch" });
  const reasons: string[] = [];
  for (const [index, item] of parsed.data.EditorialReasons.entries()) {
    if (!item || item.AdGroupId !== required.groupId || item.AdOrKeywordId !== failed[index].Id) return failure({ code: "protocol_mismatch" });
    reasons.push(...item.Reasons.map(value => editorialDescription({ code: value.ReasonCode, location: value.Location })));
  }
  return { ok: true, value: [...new Set(reasons)] };
}
/** Lifecycle does not establish editorial approval. Unknown review states remain unknown. */
function microsoftStatus(required: { lifecycle: string; review: Review }): CampaignStatusOutput["campaigns"][number]["status"] {
  if (required.lifecycle === "Deleted") return "ended";
  if (["Paused", "BudgetPaused", "BudgetAndManualPaused"].includes(required.lifecycle)) return "paused";
  if (required.review.states.includes("Disapproved")) return "disapproved";
  if (required.review.states.some(state => ["Inactive", "ActiveLimited"].includes(state))) return "pending";
  if (required.lifecycle === "Active" && required.review.states.length && required.review.states.every(state => state === "Active")) return "active";
  return "unknown";
}

/** Describe the verified vendor code/location without inventing an unverified policy taxonomy. */
function editorialDescription(required: { code: number; location?: string | null }): string {
  return "Microsoft editorial reason " + required.code + (required.location ? ": " + required.location : "");
}

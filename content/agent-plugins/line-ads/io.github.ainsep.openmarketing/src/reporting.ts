import { z } from "zod";
import { parse } from "csv-parse/sync";
import { campaignStatusOutputSchema, metricBatchSchema } from "@open-marketing/contracts";
import type { CampaignStatusOutput, MetricBatch, MetricGrain, Outcome, ReportMetricsInput } from "@open-marketing/contracts";
import { vendorIdSchema } from "./commands.js";
import type { ParsedCommand } from "./commands.js";
import type { LineAdsConfiguration } from "./ports.js";

/** Consumed wire schemas strip unconsumed provider fields, including URLs and error details. */
export const providerId = z.union([vendorIdSchema, z.number().int().positive().max(Number.MAX_SAFE_INTEGER).transform(String)]);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const metric = z.number().nonnegative().max(Number.MAX_SAFE_INTEGER);
const state = z.enum(["ACTIVE", "PAUSED", "REMOVED"]);
const name = z.string().min(1).max(1024);
const account = z.object({ id: providerId, name, configuredStatus: state.optional(), currency: z.string().regex(/^[A-Z]{3}$/), timezone: z.string().min(1).max(128), country: z.enum(["JP", "TW", "TH"]) });
const campaign = z.object({ id: providerId, name, configuredStatus: state.optional() });
const paging = z.object({ page: z.number().int().min(1).max(10000), size: z.number().int().min(1).max(100), totalElements: count });
const accountPage = z.object({ datas: z.array(account).max(100), paging });
const campaignPage = z.object({ datas: z.array(campaign).max(100), paging });
const statistics = z.object({ currency: z.string().regex(/^[A-Z]{3}$/).optional(), cost: metric.optional(), imp: count.optional(), click: count.optional(), cv: metric.optional() });
const reportRow = z.object({ adaccount: z.object({ id: providerId }), campaign: z.object({ id: providerId }), statistics: statistics.optional() });
const reportPage = z.object({ datas: z.array(reportRow).max(100), paging, timeRange: z.object({ since: z.iso.date(), until: z.iso.date() }) });

/** Validate page identity/cardinality atomically; no URL following or automatic pagination.
 * @returns Whether this is a coherent bounded page. O(n) time/space, n<=100.
 */
function validPage(required: { ids: string[]; paging: z.infer<typeof paging>; command: ParsedCommand }): boolean {
  const { ids, paging: observed, command } = required;
  if (observed.page !== command.page || observed.size !== command.size || ids.length > command.size) return false;
  if (new Set(ids).size !== ids.length) return false;
  const offset = (command.page - 1) * command.size;
  return ids.length === Math.min(command.size, Math.max(0, observed.totalElements - offset));
}

/** Decode all rows before exposing any data; absent metrics stay null, never inferred zero.
 * @returns A sanitized page/report or protocol_mismatch; O(n) time/space, n<=100; no I/O.
 * @example decodePage({ input: vendorJson, command, configuration, retrievedAt: 1792800000000 })
 */
export function decodePage(required: { input: unknown; command: ParsedCommand; configuration: LineAdsConfiguration; retrievedAt: number }): Outcome<unknown> {
  if (required.command.kind === "report") return decodeReport(required);
  const schema = required.command.kind === "list_accounts" ? accountPage : campaignPage;
  const parsed = schema.safeParse(required.input);
  if (!parsed.success) return invalid();
  const { datas, paging: observed } = parsed.data;
  if (!validPage({ ids: datas.map(item => item.id), paging: observed, command: required.command })) return invalid();
  return { ok: true, value: { items: datas, ...pageMetadata({ paging: observed }) } };
}

/** Preserve vendor dates and bound account metadata; conflicting scope/currency rejects the page.
 * @returns Campaign report page without totals. O(n) time/space, n<=100; no effects.
 */
function decodeReport(required: Parameters<typeof decodePage>[0]): Outcome<unknown> {
  const parsed = reportPage.safeParse(required.input);
  const command = required.command;
  if (!parsed.success || command.kind !== "report") return invalid();
  const { datas, paging: observed, timeRange } = parsed.data;
  if (timeRange.since !== command.since || timeRange.until !== command.until) return invalid();
  if (!validPage({ ids: datas.map(item => item.campaign.id), paging: observed, command })) return invalid();
  if (datas.some(item => item.adaccount.id !== required.configuration.accountId || (item.statistics?.currency !== undefined && item.statistics.currency !== required.configuration.currency))) return invalid();
  const rows = datas.map(item => ({ campaignId: item.campaign.id, cost: item.statistics?.cost ?? null, impressions: item.statistics?.imp ?? null, clicks: item.statistics?.click ?? null, conversions: item.statistics?.cv ?? null }));
  return { ok: true, value: { source: "line_ads_online_campaign", apiVersion: "v3", accountId: required.configuration.accountId,
    currency: required.configuration.currency, timezone: required.configuration.timezone, retrievedAt: required.retrievedAt,
    vendorDateRange: timeRange, availability: rows.length ? "reported" : "no_data_access_unconfirmed", coverage: "page_only", rows, ...pageMetadata({ paging: observed }) } };
}
function pageMetadata(required: { paging: z.infer<typeof paging> }) {
  const p = required.paging;
  return { paging: p, nextPage: p.page * p.size < p.totalElements && p.page < 10000 ? p.page + 1 : null, pageLimitReached: p.page === 10000 && p.page * p.size < p.totalElements };
}
function invalid(): Outcome<never> { return { ok: false, error: { code: "protocol_mismatch", message: "LINE response invalid", retryable: false } }; }

const statusCampaign = z.object({ id: providerId, configuredStatus: state.optional(),
  deliveryStatus: z.string().min(1).max(100).optional(),
  deliveryStatusReasons: z.array(z.object({ code: z.string().min(1).max(100).optional() })).max(100).optional() });
const statusPage = z.object({ datas: z.array(statusCampaign).max(100), paging });
const rejectionReasons: Readonly<Record<string, string>> = {
  CREATIVE_REVIEW_NOT_APPROVED: "Ad not approved", ADGROUP_APP_REVIEW_NOT_APPROVED: "App not approved",
  BILLING_REVIEW_NOT_APPROVED: "Billing not approved", ADACCOUNT_REVIEW_NOT_APPROVED: "Ad account not approved",
  LINE_ACCOUNT_LINK_NOT_APPROVED: "LINE account link not approved",
};
const pendingReasons = ["CAMPAIGN_SCHEDULED", "CREATIVE_REVIEW_IN_REVIEW", "ADGROUP_APP_REVIEW_IN_REVIEW", "BILLING_REVIEW_IN_REVIEW", "ADACCOUNT_REVIEW_IN_REVIEW"];
/** Decode one account-scoped, IDs-filtered page. Missing campaigns stay unknown; unsolicited or
 * duplicate IDs reject atomically. O(n) time/space, at most 100 campaigns and 100 reasons each.
 */
export function decodeCampaignStatus(required: { input: unknown; ids: string[]; observedAt: number }): Outcome<CampaignStatusOutput> {
  const parsed = statusPage.safeParse(required.input);
  if (!parsed.success) return invalid();
  const page = parsed.data;
  if (page.paging.page !== 1 || page.paging.size !== 100 || page.paging.totalElements !== page.datas.length) return invalid();
  const ids = page.datas.map(row => row.id);
  if (new Set(ids).size !== ids.length || ids.some(id => !required.ids.includes(id))) return invalid();
  const found = new Map(page.datas.map(row => [row.id, row]));
  const campaigns = required.ids.map(vendorCampaignId => projectCampaign({ vendorCampaignId, row: found.get(vendorCampaignId) }));
  const output = campaignStatusOutputSchema.safeParse({ observedAt: required.observedAt, complete: campaigns.every(row => row.status !== "unknown"), campaigns });
  return output.success ? { ok: true, value: output.data } : invalid();
}
function projectCampaign(required: { vendorCampaignId: string; row?: z.infer<typeof statusCampaign> }): CampaignStatusOutput["campaigns"][number] {
  const reasons = required.row?.deliveryStatusReasons ?? [];
  const descriptions = reasons.flatMap(reason => reason.code && rejectionReasons[reason.code] ? [reason.code + ": " + rejectionReasons[reason.code]] : []);
  return { vendorCampaignId: required.vendorCampaignId, status: campaignState({ row: required.row }), disapprovalDescriptions: [...new Set(descriptions)].slice(0, 20) };
}
/** Delivery evidence outranks configured intent. Unrecognized reason/state combinations stay unknown. */
function campaignState({ row }: { row?: z.infer<typeof statusCampaign> }): CampaignStatusOutput["campaigns"][number]["status"] {
  if (!row) return "unknown";
  if (row.configuredStatus === "REMOVED" || row.deliveryStatus === "REMOVED") return "ended";
  const codes = (row.deliveryStatusReasons ?? []).map(reason => reason.code);
  if (codes.some(code => code !== undefined && rejectionReasons[code] !== undefined)) return "disapproved";
  if (codes.includes("CAMPAIGN_ENDED")) return "ended";
  if (codes.some(code => pendingReasons.includes(code ?? ""))) return "pending";
  if (row.deliveryStatus === "PAUSED") return "paused";
  if (row.deliveryStatus === "ACTIVE" && codes.every(code => code === "ACTIVE")) return "active";
  return "unknown";
}

// Display names from the reporting field table; exact downloaded headers await live acceptance.
const csvHeaders = { day: "Day", impressions: "Impressions", clicks: "Clicks", ids: {
  account: [], campaign: ["Campaign ID"], ad_group: ["Campaign ID", "Ad group ID"], ad: ["Campaign ID", "Ad group ID", "Ad ID"],
} } as const;
const csvCount = z.union([z.literal("").transform(() => null), z.string().regex(/^\d+$/)]);
const csvRows = z.array(z.record(z.string(), z.string()));

/** Decode bounded UTF-8 CSV atomically; counts stay exact and undocumented spend stays null.
 * @param required CSV from the capped reader plus validated call/account facts.
 * @returns Validated batch or redacted protocol_mismatch. No effects; O(b+n) time/space,
 * b<=1MiB before parsing, n<=5,000 in the final schema. No inferred freshness/calendar coverage.
 * @example decodeMetricsCsv({ text, input, connection, currency: "TWD", timezone: "Asia/Taipei", retrievedAt })
 */
export function decodeMetricsCsv(required: { text: unknown; input: ReportMetricsInput; connection: { connectionId: string; accountId: string }; currency: string; timezone: string; retrievedAt: number }): Outcome<MetricBatch> {
  if (typeof required.text !== "string" || Buffer.byteLength(required.text) > 1048576) return invalid();
  const { grain, days } = required.input;
  const headers = [csvHeaders.day, csvHeaders.impressions, csvHeaders.clicks, ...csvHeaders.ids[grain]];
  let sawHeader = false;
  try {
    // csv-parse's header callback keeps columns header-derived and validates even an empty report.
    const records = csvRows.parse(parse(required.text, { bom: true, columns: (columns: string[]) => {
      if (headers.some(header => !columns.includes(header))) throw new Error("Missing LINE report header");
      sawHeader = true;
      return columns;
    }, skip_empty_lines: true }));
    if (!sawHeader) return invalid();
    const rows = records.map(row => ({ day: z.iso.date().parse(row[csvHeaders.day]), entity: metricEntity({ grain, row }),
      metrics: { impressions: csvCount.parse(row[csvHeaders.impressions]), clicks: csvCount.parse(row[csvHeaders.clicks]), spend: null } }));
    const output = metricBatchSchema.safeParse({ schema: "report.metrics.v1", pluginId: "line-ads", ...required.connection, currency: required.currency,
      timezone: required.timezone, grain, days, retrievedAt: required.retrievedAt, dataThrough: 0, complete: true, freshness: "stale", finality: "provisional", restated: false,
      mapping: { pluginId: "line-ads", version: "1", grains: { [grain]: {
        impressions: { vendorField: csvHeaders.impressions, meaning: "LINE reported daily impressions" },
        clicks: { vendorField: csvHeaders.clicks, meaning: "LINE reported daily clicks" },
        spend: { vendorField: "Cost", meaning: "Cost unit is undocumented; spend is unavailable (null)" },
      } } }, rows });
    return output.success ? { ok: true, value: output.data } : invalid();
  } catch { return invalid(); }
}
/** Require the lineage for the requested grain; malformed/missing IDs throw into the CSV boundary.
 * Pure constant work per row; provider IDs are never synthesized from names or row positions.
 */
function metricEntity({ grain, row }: { grain: MetricGrain; row: Record<string, string> }): MetricBatch["rows"][number]["entity"] {
  const ids = csvHeaders.ids[grain].map(header => vendorIdSchema.parse(row[header]));
  switch (grain) {
    case "account": return { grain };
    case "campaign": return { grain, vendorCampaignId: ids[0] };
    case "ad_group": return { grain, vendorCampaignId: ids[0], vendorAdGroupId: ids[1] };
    case "ad": return { grain, vendorCampaignId: ids[0], vendorAdGroupId: ids[1], vendorAdId: ids[2] };
  }
}

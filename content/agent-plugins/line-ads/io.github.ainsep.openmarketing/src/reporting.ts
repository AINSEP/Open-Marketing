import { z } from "zod";
import type { Outcome } from "@open-marketing/contracts";
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

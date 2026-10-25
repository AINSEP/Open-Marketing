import { z } from "zod";
import type { Outcome } from "@open-marketing/contracts";
import { countSchema, decodePagination, failure, moneySchema, paginationSchema, responseIdSchema } from "./commands.js";
import type { ParsedCommand } from "./commands.js";

const metric = z.object({ date: z.iso.date(), impressions: countSchema, taps: countSchema, tapInstalls: countSchema, totalInstalls: countSchema.optional(), localSpend: moneySchema });
const row = z.object({ metadata: z.object({ campaignId: responseIdSchema, orgId: responseIdSchema }), granularity: z.array(metric).max(91) });
const responseSchema = z.object({ data: z.object({ reportingDataResponse: z.object({ row: z.array(row).max(100) }) }), pagination: paginationSchema, error: z.null().optional() });
/** Daily source metrics: Apple dates are inclusive and remain unmodified. No inferred zero totals. */
export interface AppleSearchAdsReport {
  readonly source: "apple_search_ads_campaign_reports";
  readonly apiVersion: "v5";
  readonly accountId: string;
  readonly currency: string;
  readonly retrievedAt: number;
  readonly timeZone: "UTC";
  readonly startDate: string;
  readonly endDate: string;
  readonly availability: "reported" | "no_data_access_unconfirmed";
  readonly pagination: z.infer<typeof paginationSchema> & { returned: number; requestedLimit: number; coverage: "page" };
  readonly rows: readonly z.infer<typeof row>[];
}

/** Parse the complete bounded page before exposing any metric. A foreign org, duplicate campaign,
 * duplicate/out-of-window date or different currency rejects the whole page; no summation or FX.
 * @param required - Tainted JSON, parsed command, server account/currency and injected retrieval time.
 * @returns Source-labelled daily report or protocol_mismatch; no I/O.
 * @complexity O(n*d) time/space, n<=100 campaigns and d<=91 days, also bounded to 1 MiB.
 */
export function decodeReport(required: { input: unknown; command: Extract<ParsedCommand, { kind: "report" }>; accountId: string; currency: string; retrievedAt: number }): Outcome<AppleSearchAdsReport> {
  const parsed = responseSchema.safeParse(required.input);
  if (!parsed.success) return failure({ code: "protocol_mismatch" });
  const rows = parsed.data.data.reportingDataResponse.row;
  const pagination = decodePagination({ pagination: parsed.data.pagination, ...required.command, returned: rows.length });
  if (!pagination.ok) return pagination;
  if (new Set(rows.map(value => value.metadata.campaignId)).size !== rows.length) return failure({ code: "protocol_mismatch" });
  if (!rows.every(value => validRow({ row: value, ...required }))) return failure({ code: "protocol_mismatch" });
  return { ok: true, value: { source: "apple_search_ads_campaign_reports", apiVersion: "v5", accountId: required.accountId, currency: required.currency, retrievedAt: required.retrievedAt, timeZone: "UTC", startDate: required.command.startDate, endDate: required.command.endDate, availability: rows.some(value => value.granularity.length > 0) ? "reported" : "no_data_access_unconfirmed", pagination: pagination.value, rows } };
}

/** Validate membership and dates per campaign without changing provider attribution semantics. @complexity O(d), d<=91. */
function validRow(required: { row: z.infer<typeof row>; command: Extract<ParsedCommand, { kind: "report" }>; accountId: string; currency: string }): boolean {
  const value = required.row;
  if (value.metadata.orgId !== required.accountId) return false;
  if (new Set(value.granularity.map(item => item.date)).size !== value.granularity.length) return false;
  return value.granularity.every(item => item.date >= required.command.startDate && item.date <= required.command.endDate && item.localSpend.currency === required.currency);
}

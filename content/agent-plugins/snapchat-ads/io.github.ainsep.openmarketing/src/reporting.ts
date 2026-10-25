import { z } from "zod";
import type { Outcome } from "@open-marketing/contracts";
import { failure, integer, success, timestamp, vendorId } from "./commands.js";
import type { SnapchatCommand } from "./commands.js";
import type { SnapchatConfiguration } from "./ports.js";
type ReportCommand = Extract<SnapchatCommand, { kind: "report" }>;
/** Vendor micros stay lossless decimal strings; absent metrics/timestamps remain absent. */
export interface SnapchatReport {
  readonly source: "snapchat_ads_stats"; readonly apiVersion: "v1"; readonly accountId: string | null;
  readonly currency: string; readonly timezone: string; readonly retrievedAt: number;
  readonly requestedWindow: ReportCommand["window"]; readonly boundarySemantics: "provider_unspecified";
  readonly availability: "reported" | "no_data_access_unconfirmed"; readonly rows: readonly unknown[];
}
/** TOTAL dates must be account-local day boundaries, including DST. Invalid zones deny before I/O. */
export function reportWindowValid(required: { command: ReportCommand; timezone: string }): boolean {
  try {
    const format = new Intl.DateTimeFormat("en-GB", { timeZone: required.timezone, hourCycle: "h23", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    return [required.command.window.start, required.command.window.end].every(value => format.format(new Date(value)) === "00:00:00" && new Date(value).getUTCMilliseconds() === 0);
  } catch { return false; }
}
/** Validate one TOTAL entity atomically; no summing, FX, inferred zeros or finalization claim.
 * @complexity O(b) validation, b<=1MiB; at most one aggregate, no I/O. */
export function decodeReport(required: { body: unknown; command: ReportCommand; configuration: SnapchatConfiguration; retrievedAt: number }): Outcome<SnapchatReport> {
  const metrics = required.command.campaignId ? z.object({ spend: integer.optional(), impressions: integer.optional(), swipes: integer.optional() }) : z.object({ spend: integer.optional() });
  const stat = z.object({ id: vendorId, type: z.enum(["AD_ACCOUNT", "CAMPAIGN"]), granularity: z.literal("TOTAL"), stats: metrics,
    start_time: timestamp.optional(), end_time: timestamp.optional(), finalized_data_end_time: timestamp.optional(), conversion_data_processed_end_time: timestamp.optional() });
  const parsed = z.object({ request_status: success, total_stats: z.array(z.object({ sub_request_status: success, total_stat: stat })).max(1) }).safeParse(required.body);
  if (!parsed.success) return failure({ code: "protocol_mismatch" });
  const rows = parsed.data.total_stats.map(value => value.total_stat);
  const expectedId = required.command.campaignId ?? required.configuration.accountId;
  const expectedType = required.command.campaignId ? "CAMPAIGN" : "AD_ACCOUNT";
  if (rows.some(row => row.id !== expectedId || row.type !== expectedType)) return failure({ code: "forbidden" });
  if (rows.some(row => !windowMatches({ row, command: required.command }))) return failure({ code: "protocol_mismatch" });
  return { ok: true, value: { source: "snapchat_ads_stats", apiVersion: "v1", accountId: required.configuration.accountId, currency: required.configuration.currency,
    timezone: required.configuration.timezone, retrievedAt: required.retrievedAt, requestedWindow: required.command.window, boundarySemantics: "provider_unspecified",
    availability: rows.length === 0 ? "no_data_access_unconfirmed" : "reported", rows } };
}
function windowMatches(required: { row: { start_time?: string; end_time?: string }; command: ReportCommand }): boolean {
  const row = required.row, window = required.command.window;
  if (row.start_time !== undefined && Date.parse(row.start_time) !== Date.parse(window.start)) return false;
  return row.end_time === undefined || Date.parse(row.end_time) === Date.parse(window.end);
}

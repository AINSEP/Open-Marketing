import { z } from "zod";
import { callContextSchema, idSchema } from "@open-marketing/contracts";
import type { Outcome } from "@open-marketing/contracts";
import type { PinterestConfiguration, PinterestWireRequest } from "./ports.js";
import { accounts, campaigns, commandSchema, failure, reportCommandSchema } from "./ports.js";
import { reportQuery } from "./reporting.js";

export const vendorId = z.string().regex(/^[0-9]{1,18}$/);
export { cursor, commandSchema } from "./ports.js";
export type { PinterestCommand } from "./ports.js";
const accountsUrl = "https://api.pinterest.com/v5/ad_accounts";
export const invocationSchema = z.strictObject({ context: callContextSchema, operationId: idSchema, command: commandSchema });
/** Full strict schemas, including kind. Every exposed tool is read-only. */
export const pinterestAdsTools = [
  { name: "list_accounts", effect: "read", inputSchema: accounts },
  { name: "list_campaigns", effect: "read", inputSchema: campaigns },
  { name: "report", effect: "read", inputSchema: reportCommandSchema },
] as const;

/** Fixed endpoints only, one page/request. @complexity O(c), c<=100 campaign IDs. */
export function encodeCommand(required: { command: z.output<typeof commandSchema>; configuration: PinterestConfiguration; now: number }): Outcome<PinterestWireRequest> {
  const { command, configuration } = required;
  if (command.kind !== "list_accounts" && configuration.accountId === null) return failure({ code: "forbidden" });
  if (command.kind === "report") return encodeReport({ command, configuration, now: required.now });
  const query = new URLSearchParams({ page_size: String(command.pageSize) });
  if (command.pageToken !== undefined) query.set("bookmark", command.pageToken);
  const path = command.kind === "list_accounts" ? accountsUrl : accountsUrl + "/" + configuration.accountId + "/campaigns";
  return { ok: true, value: { method: "GET", url: path + "?" + query } };
}
/** Keep native date validation separate from entity paging. @complexity O(c), c<=100. */
function encodeReport(required: { command: Extract<z.output<typeof commandSchema>, { kind: "report" }>; configuration: PinterestConfiguration; now: number }): Outcome<PinterestWireRequest> {
  if (required.configuration.currency === null) return failure({ code: "unavailable" });
  const query = reportQuery({ command: required.command, now: required.now });
  if (!query.ok) return query;
  const suffix = required.command.level === "CAMPAIGN" ? "/campaigns/analytics" : "/analytics";
  return { ok: true, value: { method: "GET", url: accountsUrl + "/" + required.configuration.accountId + suffix + "?" + query.value } };
}

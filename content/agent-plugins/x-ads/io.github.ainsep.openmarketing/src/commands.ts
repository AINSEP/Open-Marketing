/** Closed R1 commands; URLs and provider fields remain plugin-owned. */
import { z } from "zod";
import { reportCommandSchema, reportQuery } from "./reporting.js";

export const vendorId = z.string().max(64).regex(/^[a-z0-9]+$/);
export const cursorSchema = z.string().min(1).max(2048).regex(/^[\x21-\x7e]+$/);
const page = { count: z.number().int().min(1).max(100).default(100), cursor: cursorSchema.optional() };
/** No arbitrary account, endpoint, credential or write arguments. Defaults apply at invocation. */
export const commandSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("list_accounts"), ...page }),
  z.strictObject({ kind: z.literal("list_campaigns"), ...page }),
  reportCommandSchema,
]);
/** Commands accepted by invokeXAds; dates are half-open UTC epoch milliseconds. */
export type XCommand = z.input<typeof commandSchema>;
export type ParsedCommand = z.output<typeof commandSchema>;
/** Host catalog contribution; importing descriptors performs no registration or I/O. */
export const xAdsTools = commandSchema.options.map(inputSchema => ({ name: inputSchema.shape.kind.value, inputSchema, effect: "read" as const }));

/** Internal mapping after schema validation; one GET, no automatic cursor traversal. @complexity O(n), n<=20 IDs. */
export function encodeCommand(required: { command: ParsedCommand; accountId: string }): { url: string; method: "GET" } {
  const { command, accountId } = required;
  if (command.kind === "report") return { url: `https://ads-api.x.com/12/stats/accounts/${accountId}?${reportQuery({ command })}`, method: "GET" };
  const query = new URLSearchParams({ count: String(command.count) });
  if (command.cursor) query.set("cursor", command.cursor);
  if (command.kind === "list_campaigns") query.set("with_draft", "true");
  const path = command.kind === "list_accounts" ? "accounts" : `accounts/${accountId}/campaigns`;
  return { url: `https://ads-api.x.com/12/${path}?${query}`, method: "GET" };
}

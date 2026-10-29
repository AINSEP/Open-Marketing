/** Closed R1 commands; URLs and provider fields remain plugin-owned. */
import { z } from "zod";
import { reportCommandSchema, reportQuery, dailyCommandSchema, dailyQuery } from "./reporting.js";

export const vendorId = z.string().max(64).regex(/^[a-z0-9]+$/);
export const cursorSchema = z.string().min(1).max(2048).regex(/^[\x21-\x7e]+$/);
const page = { count: z.number().int().min(1).max(100).default(100), cursor: cursorSchema.optional() };
/** No arbitrary account, endpoint, credential or write arguments. Defaults apply at invocation. */
const entityCommandSchema = z.strictObject({ kind: z.literal("capability_entities"), resource: z.enum(["account", "campaign", "ad_group", "ad"]), cursor: cursorSchema.optional(), entityIds: z.array(vendorId).min(1).max(100).optional() });
const activeCommandSchema = z.strictObject({ kind: z.literal("capability_active"), entity: z.enum(["CAMPAIGN", "LINE_ITEM", "PROMOTED_TWEET"]), window: dailyCommandSchema.shape.window });
export const commandSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("list_accounts"), ...page }),
  z.strictObject({ kind: z.literal("list_campaigns"), ...page }),
  reportCommandSchema,
]);
/** Private read commands never enter the assistant tool schema. */
export const readCommandSchema = z.discriminatedUnion("kind", [...commandSchema.options, dailyCommandSchema, entityCommandSchema, activeCommandSchema]);
/** Commands accepted by invokeXAds; dates are half-open UTC epoch milliseconds. */
export type XCommand = z.input<typeof commandSchema>;
export type ParsedCommand = z.output<typeof readCommandSchema>;
/** Host catalog contribution; importing descriptors performs no registration or I/O. */
export const xAdsTools = commandSchema.options.map(inputSchema => ({ name: inputSchema.shape.kind.value, inputSchema, effect: "read" as const }));

/** Internal mapping after schema validation; one GET, no automatic cursor traversal. @complexity O(n), n<=20 IDs. */
export function encodeCommand(required: { command: ParsedCommand; accountId: string }): { url: string; method: "GET" } {
  const { command, accountId } = required;
  if (command.kind === "capability_daily") return { url: `https://ads-api.x.com/12/stats/accounts/${accountId}?${dailyQuery({ command })}`, method: "GET" };
  if (command.kind === "capability_entities") return entityRequest({ command, accountId });
  if (command.kind === "capability_active") {
    const query = new URLSearchParams({ entity: command.entity, start_time: new Date(command.window.start).toISOString(), end_time: new Date(command.window.end).toISOString() });
    return { url: `https://ads-api.x.com/12/stats/accounts/${accountId}/active_entities?${query}`, method: "GET" };
  }
  if (command.kind === "report") return { url: `https://ads-api.x.com/12/stats/accounts/${accountId}?${reportQuery({ command })}`, method: "GET" };
  const query = new URLSearchParams({ count: String(command.count) });
  if (command.cursor) query.set("cursor", command.cursor);
  if (command.kind === "list_campaigns") query.set("with_draft", "true");
  const path = command.kind === "list_accounts" ? "accounts" : `accounts/${accountId}/campaigns`;
  return { url: `https://ads-api.x.com/12/${path}?${query}`, method: "GET" };
}

/** Filter metadata to active entities or required parents; include deleted matching entities. */
function entityRequest({ command, accountId }: { command: z.infer<typeof entityCommandSchema>; accountId: string }): { url: string; method: "GET" } {
  const resources = { account: "", campaign: "/campaigns", ad_group: "/line_items", ad: "/promoted_tweets" };
  const query = new URLSearchParams({ with_deleted: "true" });
  if (command.resource !== "account") query.set("count", "100");
  if (command.resource === "campaign") query.set("with_draft", "true");
  if (command.cursor) query.set("cursor", command.cursor);
  if (command.entityIds) query.set(({ account: "account_ids", campaign: "campaign_ids", ad_group: "line_item_ids", ad: "promoted_tweet_ids" })[command.resource], command.entityIds.join(","));
  return { url: `https://ads-api.x.com/12/accounts/${accountId}${resources[command.resource]}?${query}`, method: "GET" };
}

import { z } from "zod";
/** Plain wire request produced by the encoder; re-exported by ports. */
export interface VkWireRequest { readonly path: string; readonly method: "GET" }

/** Exact decimal identifiers; unsafe numeric vendor IDs are rejected by response codecs. */
export const vendorIdSchema = z.string().regex(/^[1-9][0-9]{0,18}$/);
const page = { limit: z.number().int().min(1).max(100).default(20), offset: z.number().int().min(0).max(1000000).default(0) };
const accounts = z.strictObject({ kind: z.literal("list_accounts") });
const campaigns = z.strictObject({ kind: z.literal("list_campaigns"), ...page });
const report = z.strictObject({ kind: z.literal("report"), since: z.iso.date(), until: z.iso.date(), ids: z.array(vendorIdSchema).min(1).max(200).refine(ids => new Set(ids).size === ids.length) })
  .refine(value => value.until >= value.since && Date.parse(value.until) - Date.parse(value.since) <= 30 * 86400000);
/** Closed read commands; report dates are inclusive and bounded to 31 days / 200 unique IDs. */
export const commandSchema = z.discriminatedUnion("kind", [
  accounts, campaigns, report,
]);
export type VkCommand = z.input<typeof commandSchema>;
export type ParsedCommand = z.infer<typeof commandSchema>;
/** Singular effect/Zod inputSchema match the existing host descriptor shape; admission is separate. */
export const vkAdsTools: readonly { name: VkCommand["kind"]; inputSchema: z.ZodType; effect: "read" }[] = [
  { name: "list_accounts", inputSchema: accounts, effect: "read" },
  { name: "list_campaigns", inputSchema: campaigns, effect: "read" },
];

/** Encode documented reads; O(1), pure, no URL/field overrides.
 * @param required - A parsed account/campaign read; reports are unavailable.
 * @returns One fixed relative GET path with bounded explicit pagination.
 */
export function encodeCommand(required: { command: Exclude<ParsedCommand, { kind: "report" }> }): VkWireRequest {
  if (required.command.kind === "list_accounts") return { path: "/api/v3/user.json", method: "GET" };
  const query = new URLSearchParams({ limit: String(required.command.limit), offset: String(required.command.offset) });
  return { path: "/api/v2/ad_plans.json?" + query.toString(), method: "GET" };
}

import { z } from "zod";
import type { VkWireRequest } from "./ports.js";

/** Exact decimal identifiers; unsafe numeric vendor IDs are rejected by response codecs. */
export const vendorIdSchema = z.string().regex(/^[1-9][0-9]{0,18}$/);
const page = { limit: z.number().int().min(1).max(100).default(20), offset: z.number().int().min(0).max(1000000).default(0) };
const report = z.strictObject({ kind: z.literal("report"), since: z.iso.date(), until: z.iso.date(), ...page })
  .refine(value => value.until >= value.since && Date.parse(value.until) - Date.parse(value.since) <= 30 * 86400000);
/** Closed boundary includes report solely to return explicit unavailable before any I/O. */
export const commandSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("list_accounts") }),
  z.strictObject({ kind: z.literal("list_campaigns"), ...page }),
  report,
]);
export type VkCommand = z.input<typeof commandSchema>;
export type ParsedCommand = z.infer<typeof commandSchema>;
/** No operation is advertised until the captured relative API paths have a verified origin.
 * Singular effect/inputSchema retain the existing host descriptor shape, without granting access.
 */
export const vkAdsTools: readonly { name: VkCommand["kind"]; inputSchema: z.ZodType; effect: "read" }[] = [];

/** Encode the documented account or AdPlans read; O(1), pure, no URL/field overrides.
 * @param required - A parsed read command. Reports cannot reach this encoder.
 * @returns One fixed relative GET path with bounded explicit pagination.
 */
export function encodeCommand(required: { command: Exclude<ParsedCommand, { kind: "report" }> }): VkWireRequest {
  if (required.command.kind === "list_accounts") return { path: "/api/v3/user.json", method: "GET" };
  const query = new URLSearchParams({ limit: String(required.command.limit), offset: String(required.command.offset) });
  return { path: "/api/v2/ad_plans.json?" + query.toString(), method: "GET" };
}

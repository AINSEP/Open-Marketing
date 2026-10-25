import { z } from "zod";
import type { LineAdsWireRequest } from "./ports.js";

/** Vendor IDs remain exact strings; unsafe numeric response IDs are rejected, never rounded. */
export const vendorIdSchema = z.string().regex(/^[1-9][0-9]{0,18}$/);
const date = z.iso.date().refine(value => value >= "2000-01-01" && value <= "2100-01-01");
const pageFields = { page: z.number().int().min(1).max(10000).default(1), size: z.number().int().min(1).max(100).default(100) };
/** Vendor calendar dates, preserved without claiming UTC or inclusive/exclusive end semantics. */
export const reportCommandSchema = z.strictObject({ kind: z.literal("report"), since: date, until: date, ...pageFields })
  .refine(value => value.until >= value.since && Date.parse(value.until) - Date.parse(value.since) <= 366 * 86400000);
/** Only the three approved reads. Account/group binding belongs to server configuration. */
export const commandSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("list_accounts"), ...pageFields }),
  z.strictObject({ kind: z.literal("list_campaigns"), ...pageFields }),
  reportCommandSchema,
]);
/** Callers may omit pagination; validation supplies one page of at most 100 rows. */
export type LineAdsCommand = z.input<typeof commandSchema>;
/** Parsed command for the private transport; only index.ts is public. */
export type ParsedCommand = z.infer<typeof commandSchema>;
/** Catalog data only; the server routes these through its ONE external-tool policy. */
export const lineAdsTools = commandSchema.options.map(schema => ({ name: schema.shape.kind.value, inputSchema: schema, effect: "read" as const }));

/** Encode only fixed LINE v3 paths; validation and authenticated group resolution precede this.
 * @returns A GET without a body; O(1) bounded string construction, no effects.
 */
export function encodeCommand(required: { command: ParsedCommand; accountId: string | null; groupId: string }): LineAdsWireRequest {
  const { command } = required;
  const suffix = command.kind === "report" ? "/reports/online/campaign" : "/campaigns";
  const path = command.kind === "list_accounts" ? `/groups/${required.groupId}/adaccounts` : `/adaccounts/${required.accountId}${suffix}`;
  const query = new URLSearchParams({ page: String(command.page), size: String(command.size) });
  if (command.kind === "report") { query.set("since", command.since); query.set("until", command.until); }
  return { url: "https://ads.line.me/api/v3" + path + "?" + query.toString(), method: "GET" };
}

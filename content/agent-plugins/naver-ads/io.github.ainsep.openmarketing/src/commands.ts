import { z } from "zod";
import { callContextSchema, idSchema } from "@open-marketing/contracts";

/** Naver customer IDs are distinct from advertiser-center account numbers. */
export const customerIdSchema = z.string().regex(/^[1-9][0-9]{0,18}$/);
export const campaignIdSchema = z.string().regex(/^cmp-[A-Za-z0-9-]{1,120}$/);
const date = z.iso.date();
/** Closed read tools; dates are vendor KST calendar labels, with at most 31 days inclusive. */
export const commandSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("list_accounts"), page: z.number().int().min(0).max(10000).default(0), pageSize: z.number().int().min(1).max(100).default(100) }),
  z.strictObject({ kind: z.literal("list_campaigns"), cursor: campaignIdSchema.optional(), pageSize: z.number().int().min(1).max(100).default(100) }),
  z.strictObject({ kind: z.literal("report"), campaignId: campaignIdSchema, since: date, until: date }).refine(value => {
    const days = (Date.parse(value.until) - Date.parse(value.since)) / 86400000;
    return days >= 0 && days < 31;
  }),
]);
export type NaverCommand = z.input<typeof commandSchema>;
export type ParsedCommand = z.output<typeof commandSchema>;
export const invocationSchema = z.strictObject({ context: callContextSchema, operationId: idSchema, command: commandSchema });
/** Host catalog projection only; no registration, network or module startup. */
export const naverAdsTools = commandSchema.options.map(inputSchema => ({ name: inputSchema.shape.kind.value, inputSchema, effect: "read" as const }));

/** Pure fixed-path encoder; callers validate with commandSchema first. No provider links are followed.
 * @complexity O(1), bounded IDs and dates; one GET per invocation.
 */
export function encodeCommand(required: { command: ParsedCommand }): { path: string; query: URLSearchParams } {
  const command = required.command;
  switch (command.kind) {
    case "list_accounts": return { path: "/ad-accounts", query: new URLSearchParams({ page: String(command.page), size: String(command.pageSize) }) };
    case "list_campaigns": return { path: "/ncc/campaigns", query: new URLSearchParams({ recordSize: String(command.pageSize), selector: "NEXT", ...(command.cursor ? { baseSearchId: command.cursor } : {}) }) };
    case "report": return { path: "/stats", query: new URLSearchParams({ ids: command.campaignId, fields: JSON.stringify(["impCnt", "clkCnt", "salesAmt"]), timeRange: JSON.stringify({ since: command.since, until: command.until }), timeIncrement: "allDays" }) };
    default: { const exhaustive: never = command; return exhaustive; }
  }
}

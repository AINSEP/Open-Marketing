import { z } from "zod";
import { reportCommandSchema } from "./reporting.js";
import { failure } from "./ports.js";
import type { Outcome } from "@open-marketing/contracts";
import type { MicrosoftAdsConfiguration, MicrosoftAdsWireRequest } from "./ports.js";
/** JSON numbers must be exact; Microsoft long IDs outside JS's safe range fail closed. */
export const vendorIdSchema = z.string().regex(/^[1-9][0-9]{0,15}$/).refine(value => Number.isSafeInteger(Number(value)));
const providerId = z.union([vendorIdSchema, z.number().int().positive().max(Number.MAX_SAFE_INTEGER).transform(String)]);
export const commandSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("list_accounts"), pageIndex: z.number().int().min(0).max(10000).default(0), pageSize: z.number().int().min(1).max(100).default(100) }),
  z.strictObject({ kind: z.literal("list_campaigns") }), reportCommandSchema,
]);
export type MicrosoftAdsCommand = z.input<typeof commandSchema>;
export const microsoftAdsTools = commandSchema.options.map(schema => ({ name: schema.shape.kind.value, inputSchema: schema, effect: "read" as const }));
const text = z.string().max(1024);
const account = z.object({ Id: providerId, ParentCustomerId: providerId, Name: text, CurrencyCode: z.string().regex(/^[A-Z]{3}$/), AccountLifeCycleStatus: text });
const campaign = z.object({ Id: providerId, Name: text, Status: z.enum(["Active", "Paused", "BudgetPaused", "BudgetAndManualPaused", "Deleted", "Suspended"]) });
/** Private fixed REST request encoder; no URLs supplied by tools. @complexity O(b), bounded JSON. */
export function request(required: { service: "CustomerManagement" | "CampaignManagement" | "Reporting"; path: string; body: unknown }): MicrosoftAdsWireRequest {
  const host = { CustomerManagement: "clientcenter", CampaignManagement: "campaign", Reporting: "reporting" }[required.service];
  return { url: `https://${host}.api.bingads.microsoft.com/${required.service}/v13/${required.path}`, method: "POST", body: JSON.stringify(required.body) };
}
/** Atomic projections strip unconsumed provider fields. Duplicate IDs reject the whole page.
 * @param required - Bounded tainted response and validated command/binding.
 * @returns A safe page or typed protocol failure. No I/O. @complexity O(n), n<=1000.
 */
export function decodeList(required: { input: unknown; command: Exclude<MicrosoftAdsCommand, { kind: "report" }>; configuration: MicrosoftAdsConfiguration }): Outcome<unknown> {
  const { command } = required;
  if (command.kind === "list_accounts") {
    const parsed = z.object({ Accounts: z.array(account).max(command.pageSize ?? 100) }).safeParse(required.input);
    if (!parsed.success) return failure({ code: "protocol_mismatch" });
    const items = parsed.data.Accounts;
    if (new Set(items.map(item => item.Id)).size !== items.length) return failure({ code: "protocol_mismatch" });
    const next = (command.pageIndex ?? 0) + 1;
    return { ok: true, value: { items, nextPageIndex: items.length === (command.pageSize ?? 100) && next <= 10000 ? next : null, pageLimitReached: next > 10000 } };
  }
  const parsed = z.object({ Campaigns: z.array(campaign).max(1000) }).safeParse(required.input);
  if (!parsed.success) return failure({ code: "protocol_mismatch" });
  if (new Set(parsed.data.Campaigns.map(item => item.Id)).size !== parsed.data.Campaigns.length) return failure({ code: "protocol_mismatch" });
  return { ok: true, value: { accountId: required.configuration.accountId, campaignType: "Search", items: parsed.data.Campaigns } };
}
/** Authenticated user projection, excluding contact details and roles. */
export const userSchema = z.object({ User: z.object({ Id: providerId }) });

/** Fixed account-scoped capability lookup; never scans unrelated campaigns. */
export function statusRequest(required: { accountId: string; campaignIds: string[] }): MicrosoftAdsWireRequest {
  return request({ service: "CampaignManagement", path: "Campaigns/QueryByIds", body: { AccountId: required.accountId, CampaignIds: required.campaignIds } });
}

import { z } from "zod";
import type { AppError, Outcome } from "@open-marketing/contracts";
import type { SnapchatConfiguration, SnapchatWireRequest } from "./ports.js";

export { vendorId, timestamp, commandSchema } from "./ports.js";
export type { SnapchatCommand } from "./ports.js";
import { vendorId, timestamp, commandSchema, cursor } from "./ports.js";
import type { SnapchatCommand } from "./ports.js";

export const success = z.enum(["SUCCESS", "success"]);
export const integer = z.union([z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).transform(String), z.string().regex(/^(0|[1-9][0-9]{0,19})$/)]);
/** Host catalog descriptors; the adapter executes refinements even after JSON-schema projection. */
export const snapchatAdsTools = commandSchema.options.map(schema => ({ name: schema.shape.kind.value, inputSchema: schema, effect: "read" as const }));

/** Private fixed-path codec; no I/O. Account-bound commands require a server-resolved account. */
export function encodeCommand(required: { command: SnapchatCommand; configuration: SnapchatConfiguration }): SnapchatWireRequest {
  const { command, configuration } = required;
  const url = new URL("https://adsapi.snapchat.com/v1" + commandPath({ command, accountId: configuration.accountId }));
  if (command.kind === "report") {
    url.searchParams.set("granularity", "TOTAL");
    url.searchParams.set("fields", command.campaignId ? "spend,impressions,swipes" : "spend");
    url.searchParams.set("start_time", command.window.start);
    url.searchParams.set("end_time", command.window.end);
  } else if (command.kind !== "list_organizations") {
    url.searchParams.set("limit", String(command.pageSize ?? 100));
    if (command.cursor) url.searchParams.set("cursor", command.cursor);
  }
  return { method: "GET", url: url.href };
}
function commandPath(required: { command: SnapchatCommand; accountId: string | null }): string {
  const command = required.command;
  switch (command.kind) {
    case "list_organizations": return "/me/organizations";
    case "list_accounts": return "/organizations/" + command.organizationId + "/adaccounts";
    case "list_campaigns": return "/adaccounts/" + required.accountId + "/campaigns";
    case "list_creatives": return "/adaccounts/" + required.accountId + "/creatives";
    case "report": return command.campaignId ? "/campaigns/" + command.campaignId + "/stats" : "/adaccounts/" + required.accountId + "/stats";
    default: { const exhaustive: never = command; throw new Error(String(exhaustive)); }
  }
}
const text = z.string().min(1).max(1024);
const organization = z.object({ id: vendorId, name: text });
const account = organization.extend({ organization_id: vendorId, currency: z.string().regex(/^[A-Z]{3}$/), timezone: text, status: text });
const campaign = organization.extend({ ad_account_id: vendorId, status: z.enum(["ACTIVE", "PAUSED"]), start_time: timestamp.optional(), end_time: timestamp.optional() });
const creative = organization.extend({ ad_account_id: vendorId, type: text, review_status: text.optional() });
const paging = z.object({ next_link: z.string().max(4096).nullable().optional() });
function listShape(required: { key: string; item: z.ZodType }): z.ZodType<Record<string, unknown>> {
  return z.object({ sub_request_status: success, [required.key]: required.item });
}
/** Atomic page validation strips unconsumed provider fields. Foreign/duplicate/partial pages reject.
 * @complexity O(n) time/space, n<=100. An ownership read must return exactly its requested ID. */
export function decodeList(required: { body: unknown; command: SnapchatCommand; configuration: SnapchatConfiguration; request: SnapchatWireRequest; ownershipId?: string }): Outcome<unknown> {
  const command = required.command;
  const kind = required.ownershipId ? "list_campaigns" : command.kind;
  const [plural, singular, item] = listDefinition({ kind });
  const schema = z.object({ request_status: success, [plural]: z.array(listShape({ key: singular, item })).max(100), paging: paging.optional() });
  const parsed = schema.safeParse(required.body);
  if (!parsed.success) return failure({ code: "protocol_mismatch" });
  const rows = parsed.data[plural] as Record<string, unknown>[];
  const items = rows.map(row => row[singular] as Record<string, unknown>);
  const limit = "pageSize" in required.command ? required.command.pageSize ?? 100 : 100;
  if (items.length > limit || new Set(items.map(value => value.id)).size !== items.length) return failure({ code: "protocol_mismatch" });
  const owned = checkOwnership({ ...required, items });
  if (!owned.ok) return owned;
  // The computed collection key widens TS inference; the explicit paging schema above validates this projection.
  const metadata = parsed.data.paging as z.infer<typeof paging> | undefined;
  const next = nextCursor({ link: metadata?.next_link, request: required.request });
  return next.ok ? { ok: true, value: { items, nextCursor: next.value } } : next;
}
/** Parent ownership is mandatory for every projected child; no partial page escapes. */
function checkOwnership(required: { items: Record<string, unknown>[]; command: SnapchatCommand; configuration: SnapchatConfiguration; ownershipId?: string }): Outcome<void> {
  const { items, command } = required;
  if (items.some(value => value.ad_account_id !== undefined && value.ad_account_id !== required.configuration.accountId)) return failure({ code: "forbidden" });
  if (command.kind === "list_accounts" && items.some(value => value.organization_id !== command.organizationId)) return failure({ code: "forbidden" });
  if (required.ownershipId && (items.length !== 1 || items[0].id !== required.ownershipId)) return failure({ code: "forbidden" });
  return { ok: true, value: undefined };
}
function listDefinition(required: { kind: SnapchatCommand["kind"] }): [string, string, z.ZodType] {
  switch (required.kind) {
    case "list_organizations": return ["organizations", "organization", organization];
    case "list_accounts": return ["adaccounts", "adaccount", account];
    case "list_creatives": return ["creatives", "creative", creative];
    default: return ["campaigns", "campaign", campaign];
  }
}
/** Validate the provider link, return only a bounded cursor; never fetch it or propagate its extras. */
function nextCursor(required: { link?: string | null; request: SnapchatWireRequest }): Outcome<string | null> {
  if (!required.link) return { ok: true, value: null };
  try {
    const next = new URL(required.link), current = new URL(required.request.url);
    if (next.origin !== current.origin || next.pathname !== current.pathname || next.username || next.password || next.hash) return failure({ code: "protocol_mismatch" });
    const parsed = cursor.safeParse(next.searchParams.get("cursor"));
    if (!parsed.success || next.searchParams.getAll("cursor").length !== 1) return failure({ code: "protocol_mismatch" });
    return { ok: true, value: parsed.data };
  } catch { return failure({ code: "protocol_mismatch" }); }
}
/** Sanitized boundary failures never include vendor bodies, URLs or broker errors. */
export function failure(required: { code: AppError["code"] }): Outcome<never> { return { ok: false, error: { code: required.code, message: "Snapchat request " + required.code, retryable: false } }; }

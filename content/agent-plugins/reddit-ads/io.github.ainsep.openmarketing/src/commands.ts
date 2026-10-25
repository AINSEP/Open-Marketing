import { z } from "zod";
import { callContextSchema, idSchema } from "@open-marketing/contracts";
import type { Outcome } from "@open-marketing/contracts";
import type { RedditWireRequest } from "./ports.js";
import { reportCommandSchema, encodeReport, pageFields } from "./reporting.js";

/** Local bounds for opaque provider IDs and continuation tokens; never accept URLs as commands. */
export const accountIdSchema = z.string().regex(/^[A-Za-z0-9_]{1,128}$/);
const businessId = z.string().regex(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);
/** Exactly four read commands; unavailable schemas remain explicit, pre-credential failures. */
export const commandSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("list_businesses"), ...pageFields }),
  z.strictObject({ kind: z.literal("list_accounts"), businessId, ...pageFields }),
  z.strictObject({ kind: z.literal("list_campaigns"), ...pageFields }),
  reportCommandSchema,
]);
export type RedditCommand = z.input<typeof commandSchema>;
export type ParsedCommand = z.output<typeof commandSchema>;
/** Host catalog consumes these Zod schemas; the report POST retains read policy. */
export const redditAdsTools = commandSchema.options.map(inputSchema => ({ name: inputSchema.shape.kind.value, inputSchema, effect: "read" as const }));
export const invocationSchema = z.strictObject({ context: callContextSchema, operationId: idSchema, command: commandSchema, moneyExposure: z.null(), requiredLimit: z.null() });

/** Encode only sourced wire contracts; unresolved list schemas fail before credential access.
 * @param required - Parsed command and host account binding.
 * @returns Fixed v3 request or not_implemented; pure, O(b) time/space for <=64KiB input.
 */
export function encodeCommand(required: { command: ParsedCommand; accountId: string | null }): Outcome<RedditWireRequest> {
  const { command } = required;
  let path: string;
  switch (command.kind) {
    case "list_businesses": path = "/me/businesses"; break;
    case "report": path = `/ad_accounts/${required.accountId}/reports`; break;
    case "list_accounts": case "list_campaigns": return { ok: false, error: { code: "not_implemented", message: "NEEDS: official Reddit v3 list request/response schema evidence", retryable: false } };
    default: { const exhaustive: never = command; return exhaustive; }
  }
  const url = new URL("https://ads-api.reddit.com/api/v3" + path);
  url.searchParams.set("page.size", String(command.pageSize));
  if (command.pageToken) url.searchParams.set("page.token", command.pageToken);
  if (command.kind === "report") return { ok: true, value: { url: url.href, method: "POST", body: encodeReport({ command }) } };
  return { ok: true, value: { url: url.href, method: "GET" } };
}

/** Only return an opaque continuation after checking the complete provider link against this call.
 * @returns Null at the last page, a token, or protocol_mismatch; no links are dispatched directly.
 * @complexity O(u) time/space, u<=4096 URL characters.
 */
export function nextPage(required: { next?: string | null; request: RedditWireRequest; pageToken?: string }): Outcome<string | null> {
  if (required.next == null) return { ok: true, value: null };
  try {
    const next = new URL(required.next);
    const current = new URL(required.request.url);
    if (!sameResource({ next, current })) return invalidPage();
    const entries = [...next.searchParams];
    if (entries.some(([key]) => !["page.size", "page.token"].includes(key)) || new Set(entries.map(([key]) => key)).size !== entries.length) return invalidPage();
    if (next.searchParams.has("page.size") && next.searchParams.get("page.size") !== current.searchParams.get("page.size")) return invalidPage();
    const token = pageFields.pageToken.unwrap().safeParse(next.searchParams.get("page.token"));
    if (!token.success || token.data === required.pageToken) return invalidPage();
    return { ok: true, value: token.data };
  } catch { return invalidPage(); }
}
/** Continuations must retain the current HTTPS origin/path without userinfo or fragments. O(1). */
function sameResource(required: { next: URL; current: URL }): boolean {
  const { next, current } = required;
  return next.origin === current.origin && next.pathname === current.pathname && !next.username && !next.password && !next.hash;
}
function invalidPage(): Outcome<never> { return { ok: false, error: { code: "protocol_mismatch", message: "Reddit continuation invalid", retryable: false } }; }

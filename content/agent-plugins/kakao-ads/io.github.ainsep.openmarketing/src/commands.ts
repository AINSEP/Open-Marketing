import { z } from "zod";
import { callContextSchema, idSchema } from "@open-marketing/contracts";
import { reportCommandSchema } from "./reporting.js";

/** Closed read-only command union; account IDs and credentials are server-bound. */
export const commandSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("list_accounts"), page: z.number().int().min(0).max(1000000).optional() }),
  z.strictObject({ kind: z.literal("list_campaigns"), config: z.enum(["ON", "OFF"]).optional() }),
  reportCommandSchema,
]);
export type KakaoCommand = z.infer<typeof commandSchema>;
export const invocationSchema = z.strictObject({ context: callContextSchema, operationId: idSchema, command: commandSchema });
/** Fixed method/path only; never accepts a caller URL or provider pagination link. */
export interface KakaoWireRequest { readonly url: string; readonly accountId: string | null }
/** Host catalog descriptors; declarations confer no authority. */
export const kakaoAdsTools = commandSchema.options.map(schema => ({ name: schema.shape.kind.value, inputSchema: schema, effect: "read" as const }));

/** Encode a validated command, without I/O. Account binding is checked before this function.
 * @param required - Parsed command and server account; report dates use yyyyMMdd.
 * @returns Fixed v4 GET request. @complexity O(1) bounded query construction.
 */
export function encodeKakaoCommand(required: { command: KakaoCommand; accountId: string | null }): KakaoWireRequest {
  const { command, accountId } = required;
  const base = "https://apis.moment.kakao.com/openapi/v4/";
  switch (command.kind) {
    case "list_accounts": return { url: base + "adAccounts/pages?" + new URLSearchParams({ page: String(command.page ?? 0), size: "10" }), accountId: null };
    case "list_campaigns": return { url: base + "campaigns" + (command.config ? "?config=" + command.config : ""), accountId };
    case "report": return { url: base + "adAccounts/report?" + new URLSearchParams({ adAccountId: accountId!, start: command.start, end: command.end, timeUnit: "DAY", level: "AD_ACCOUNT", metricsGroup: "BASIC" }), accountId };
    default: { const exhaustive: never = command; return exhaustive; }
  }
}

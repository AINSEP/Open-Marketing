import { z } from "zod";
import type { AppError, Outcome } from "@open-marketing/contracts";

/** Vendor integers stay strings; unsafe JSON numbers are rejected before conversion. */
export const vendorIdSchema = z.string().regex(/^[1-9][0-9]{0,18}$/);
export const responseIdSchema = z.union([vendorIdSchema, z.number().int().positive().max(Number.MAX_SAFE_INTEGER).transform(String)]);
export const countSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const moneySchema = z.object({ amount: z.string().max(64).regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/), currency: z.string().regex(/^[A-Z]{3}$/) });
export const paginationSchema = z.object({ totalCount: countSchema, offset: countSchema, pageSize: countSchema.max(100) });
const page = { offset: z.number().int().min(0).max(1000000).default(0), limit: z.number().int().min(1).max(100).default(100) };
/** Closed commands: no caller-supplied host, headers, account, status or arbitrary fields. */
export const commandSchema = z.discriminatedUnion("kind", [z.strictObject({ kind: z.literal("list_accounts") }), z.strictObject({ kind: z.literal("list_campaigns"), ...page })]);
export type AppleSearchAdsCommand = z.input<typeof commandSchema>;
export type ParsedCommand = z.output<typeof commandSchema>;
/** Host catalog data only; imports register nothing and start no I/O. */
export const appleSearchAdsTools = commandSchema.options.map(schema => ({ name: schema.shape.kind.value, inputSchema: schema, effect: "read" as const }));
export interface AppleRequest { readonly url: string; readonly method: "GET" | "POST"; readonly body?: string }

/** Encode one fixed v1 read. No loops or retries.
 * @param required - Parsed closed command. @returns Request bytes without credentials.
 * @complexity O(1), request size bounded by the fixed schema.
 */
export function encodeCommand(required: { command: ParsedCommand }): AppleRequest {
  const command = required.command;
  const base = "https://api.ads.apple.com/v1";
  switch (command.kind) {
    case "list_accounts": return { url: base + "/acls", method: "GET" };
    case "list_campaigns": return { url: base + "/campaigns/query", method: "POST", body: JSON.stringify({ sorting: [{ field: "id", order: "ASC" }], pagination: { offset: command.offset, pageSize: command.limit, fetchTotalCount: true } }) };
    default: { const exhaustive: never = command; throw new Error(String(exhaustive)); }
  }
}

/** Reject inconsistent pages atomically; always label output as a page, never an account total.
 * @param required - Validated vendor pagination and requested bounds. @returns Scope-safe metadata or protocol_mismatch.
 * @complexity O(1), no I/O.
 */
export function decodePagination(required: { pagination: z.infer<typeof paginationSchema>; offset: number; limit: number; returned: number }): Outcome<z.infer<typeof paginationSchema> & { returned: number; requestedLimit: number; coverage: "page" }> {
  const { pagination, offset, limit, returned } = required;
  if (pagination.offset !== offset || pagination.pageSize > limit || returned > pagination.pageSize) return failure({ code: "protocol_mismatch" });
  if (returned > 0 && offset + returned > pagination.totalCount) return failure({ code: "protocol_mismatch" });
  return { ok: true, value: { ...pagination, returned, requestedLimit: limit, coverage: "page" } };
}

/** Sanitized boundary failure; never includes credentials, raw provider text or thrown errors. */
export function failure(required: { code: AppError["code"] }): Outcome<never> {
  return { ok: false, error: { code: required.code, message: "Apple Search Ads request failed (" + required.code + ")", retryable: false } };
}

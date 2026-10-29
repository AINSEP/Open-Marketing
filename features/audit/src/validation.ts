import { z } from "zod";
import {
  appErrorSchema, callContextSchema, epochSchema, idSchema,
  pageQuerySchema, parseBoundary,
} from "@open-marketing/contracts";
import type { AppError, CallContext, CallOptions, Outcome } from "@open-marketing/contracts";
import type { AuditEntry, AuditQuery } from "./types.js";
import { auditEntrySchema } from "./types.js";

/** Receipts/cursors are operational identifiers; payload-shaped values cannot escape in output. */
const operationalIdentifierSchema = idSchema.refine(value => operationalId({ value }) === value);
/** Reject invalid injected IDs/clocks and malformed adapters before exposing a receipt. */
export const auditReceiptSchema = z.strictObject({ entryId: operationalIdentifierSchema, recordedAt: epochSchema });
/** Bound adapter output; a continuation must accompany at least one returned entry. */
export const auditPageSchema = z.strictObject({ items: z.array(auditEntrySchema).max(100), cursor: operationalIdentifierSchema.nullable() })
  .refine(value => value.cursor === null || value.items.length > 0);
/** Queries cannot request unbounded exports. */
export const auditQuerySchema = pageQuerySchema.extend({ operationId: idSchema.optional() });
const contextSchema = callContextSchema.refine(value => JSON.stringify(value).length <= 8192);
const appendSchema = z.strictObject({ context: contextSchema, entry: auditEntrySchema });
const listSchema = z.strictObject({ context: contextSchema, query: auditQuerySchema });

/** Stable errors contain no input, driver messages or secrets. @complexity O(1). */
export function failure<T>(required: { code: AppError["code"] }): Outcome<T> {
  return { ok: false, error: { code: required.code, message: `Audit ${required.code}`, retryable: false } };
}

/** Snapshot before awaiting. Owner principals cannot claim another owner; server authorizes agents/services.
 * @complexity O(r), r <=64 references.
 */
export function validateAppend(required: { input: unknown }, optional?: CallOptions): Outcome<{ context: CallContext; entry: AuditEntry }> {
  if (optional?.signal?.aborted) return failure({ code: "cancelled" });
  const result = parseBoundary({ schema: appendSchema, input: required.input });
  if (!result.ok) return result;
  if (!ownerMatches({ context: result.value.context })) return failure({ code: "forbidden" });
  return result;
}

/** Validate bounded queries before I/O. @complexity O(1), bounded strings. */
export function validateList(required: { input: unknown }, optional?: CallOptions): Outcome<{ context: CallContext; query: AuditQuery }> {
  if (optional?.signal?.aborted) return failure({ code: "cancelled" });
  const result = parseBoundary({ schema: listSchema, input: required.input });
  if (!result.ok) return result;
  if (!ownerMatches({ context: result.value.context })) return failure({ code: "forbidden" });
  return result;
}

function ownerMatches(required: { context: CallContext }): boolean {
  if (required.context.principal.kind !== "owner") return true;
  return required.context.principal.ownerId === required.context.scope.ownerId;
}

/** Parse tainted outcomes; adapter error messages never reach operational output.
 * @complexity Schema-dependent bounded traversal.
 */
export function parseOutcome<T>(required: { input: unknown; schema: z.ZodType<T> }): Outcome<T> {
  const parsed = z.discriminatedUnion("ok", [
    z.strictObject({ ok: z.literal(true), value: required.schema }),
    z.strictObject({ ok: z.literal(false), error: appErrorSchema }),
  ]).safeParse(required.input);
  if (!parsed.success) return failure({ code: "protocol_mismatch" });
  if (!parsed.data.ok) return failure({ code: parsed.data.error.code });
  return { ok: true, value: parsed.data.value };
}

/** Correlation identifiers are opaque IDs, never display text. @complexity O(s), s <=256.
 * Obvious payload shapes are withheld; composition must supply non-personal identifiers.
 */
export function operationalId(required: { value: string }): string {
  if (!/^[a-zA-Z0-9:_-]{1,256}$/.test(required.value)) return "[redacted]";
  return required.value;
}

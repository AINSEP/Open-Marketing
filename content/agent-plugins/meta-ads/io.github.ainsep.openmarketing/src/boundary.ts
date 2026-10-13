import { createHash } from "node:crypto";
import { z } from "zod";
import type { AppError, Outcome } from "@open-marketing/contracts";

/** Safe boundary error; never includes provider messages, arguments or credentials. */
export function failure<T>(required: { code: AppError["code"]; message: string }): Outcome<T> {
  return { ok: false, error: { ...required, retryable: false } };
}

/** Parse bounded tainted values, returning a stable error. @complexity Schema-dependent bounded traversal. */
export function parse<T>(required: { schema: z.ZodType<T>; input: unknown }): Outcome<T> {
  const result = required.schema.safeParse(required.input);
  if (!result.success) return failure({ code: "invalid_input", message: "Invalid Meta boundary value" });
  return { ok: true, value: result.data };
}

/** Canonical key-order independent JSON digest. Call only after a bounded JSON schema parse.
 * @example digest({ value: { status: "PAUSED", entity_id: "123" } })
 * @complexity O(n log k) time, O(n) space; n bytes and k object keys.
 */
export function digest(required: { value: unknown }): string {
  return createHash("sha256").update(canonical({ value: required.value })).digest("hex");
}

/** Array order is significant; object insertion order is not. @complexity O(n log k), O(n) space. */
function canonical(required: { value: unknown }): string {
  const value = required.value;
  if (Array.isArray(value)) return "[" + value.map(item => canonical({ value: item })).join(",") + "]";
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) => left < right ? -1 : Number(left > right));
    return "{" + entries.map(([key, item]) => JSON.stringify(key) + ":" + canonical({ value: item })).join(",") + "}";
  }
  return JSON.stringify(value);
}

/** Transport/boundary loss after handoff cannot establish that a write did not occur. @complexity O(1). */
export function isUncertainFailure(required: { error: AppError }): boolean {
  return ["unavailable", "protocol_mismatch", "cancelled", "limit_exceeded"].includes(required.error.code);
}

/** Bound JSON before recursive schema validation; no raw value leaves this boundary.
 * @complexity O(n) time and space up to the caller-provided byte limit.
 */
export function boundedJson(required: { input: unknown; maxBytes: number }): Outcome<unknown> {
  let serialized: string | undefined;
  try { serialized = JSON.stringify(required.input); }
  catch { return failure({ code: "invalid_input", message: "Meta payload is not JSON" }); }
  if (serialized === undefined) return failure({ code: "invalid_input", message: "Meta payload is not JSON" });
  if (Buffer.byteLength(serialized) > required.maxBytes) return failure({ code: "limit_exceeded", message: "Meta payload exceeds byte limit" });
  return { ok: true, value: JSON.parse(serialized) as unknown };
}

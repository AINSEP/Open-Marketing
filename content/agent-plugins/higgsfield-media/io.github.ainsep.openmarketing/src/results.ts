import { appErrorSchema } from "@open-marketing/contracts";
import type { AppError, Outcome } from "@open-marketing/contracts";
import { HiggsfieldBoundaryError } from "./types.js";

/** Stable sanitized boundary failure; no vendor text or input is copied into diagnostics. */
export function failure<T>(required: { code: AppError["code"]; message: string }): Outcome<T> {
  return { ok: false, error: { ...required, retryable: false } };
}
/** Adapt a typed value to Jini's throwing parser/signer ABI. @complexity O(1). */
export function unwrap<T>(required: { outcome: Outcome<T> }): T {
  if (!required.outcome.ok) throw new HiggsfieldBoundaryError(required.outcome.error);
  return required.outcome.value;
}
/** Catch only at the injected third-party port edge; ambiguous effects are never retryable.
 * @returns Typed unavailable for opaque failures; preserves local typed boundary failures.
 * @complexity O(1) plus the supplied bounded operation.
 */
export async function portBoundary<T>(required: { execute: () => Promise<Outcome<T>> }): Promise<Outcome<T>> {
  try {
    const outcome = await required.execute();
    if (outcome.ok) return outcome;
    const error = appErrorSchema.safeParse(outcome.error);
    if (!error.success) return failure({ code: "protocol_mismatch", message: "Invalid Higgsfield port error" });
    return failure({ code: error.data.code, message: "Higgsfield operation refused; reconcile possible charge" });
  }
  catch (error) {
    if (error instanceof HiggsfieldBoundaryError) return failure({ code: error.code, message: error.message });
    return failure({ code: "unavailable", message: "Higgsfield boundary unavailable; reconcile possible charge" });
  }
}

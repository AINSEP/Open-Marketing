import type { AppError, Outcome } from "@open-marketing/contracts";

/** Stable, redacted boundary failure. @complexity O(1). */
export function failure(required: { code: AppError["code"]; message: string }): Outcome<never> {
  return { ok: false, error: { ...required, retryable: false } };
}
/** Successful typed value. @complexity O(1). */
export function success<T>(required: { value: T }): Outcome<T> {
  return { ok: true, value: required.value };
}
/**
 * Narrow wrapper for injected I/O ABIs that may throw opaque infrastructure errors.
 * Returned errors are redacted too; neither SDK exceptions nor port messages reach the agent.
 * @complexity O(1) excluding the injected effect.
 */
export async function boundary<T>(required: { perform: () => Promise<Outcome<T>> }): Promise<Outcome<T>> {
  try {
    const result = await required.perform();
    if (!result.ok) return failure({ code: result.error.code, message: "Federation boundary denied or unavailable" });
    return result;
  } catch {
    return failure({ code: "unavailable", message: "Federation boundary unavailable" });
  }
}

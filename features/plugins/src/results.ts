import type { AppError, Outcome } from "@open-marketing/contracts";

/** Stable failure without tainted data. @complexity O(1) time/space. */
export function failure(required: { code: AppError["code"]; message: string }): Outcome<never> {
  return { ok: false, error: { ...required, retryable: false } };
}

/** Foreign exception adapter; never leaks vendor errors. @complexity O(1). */
export async function attempt<T>(required: { run: () => Promise<Outcome<T>> }): Promise<Outcome<T>> {
  try { return await required.run(); }
  catch { return failure({ code: "unavailable", message: "Plugin boundary failed; reconcile before retry" }); }
}

/** Successful typed value. @complexity O(1). */
export function success<T>(required: { value: T }): Outcome<T> { return { ok: true, value: required.value }; }

import { appErrorSchema, callContextSchema } from '@open-marketing/contracts';
import type { AddonDependencies } from './types.js';
import type { AppError, Outcome, CallContext, CallOptions } from "@open-marketing/contracts";

/** Stable failure without tainted data. @complexity O(1) time/space. */
export function failure(required: { code: AppError["code"]; message: string }): { ok: false; error: AppError } {
  return { ok: false, error: { ...required, retryable: false } };
}

/** Foreign exception adapter; never leaks vendor errors. @complexity O(1). */
export async function attempt<T>(required: { run: () => Promise<Outcome<T>> }): Promise<Outcome<T>> {
  try { return await required.run(); }
  catch { return failure({ code: "unavailable", message: "Plugin boundary failed; reconcile before retry" }); }
}

/** Successful typed value. @complexity O(1). */
export function success<T>(required: { value: T }): Outcome<T> { return { ok: true, value: required.value }; }

/** Runs the injected operation with validated context and optional cancellation, then observes its outcome.
 * Valid structured failures retain their message and retry authority; throws become redacted unavailable errors.
 * No request bytes, plugin exceptions or secrets reach telemetry.
 * @example const result = await addonBoundary({ context, dependencies: { observer }, operation, run });
 * @complexity O(1) boundary time/space for fixed-shape validation; excludes the injected operation.
 */
export async function addonBoundary<T>(required: { context: CallContext; dependencies: Pick<AddonDependencies, 'observer'>; operation: string; run: () => Promise<Outcome<T>> }, optional?: CallOptions): Promise<Outcome<T>> {
    let result: Outcome<T>;
    try {
        const parsed = callContextSchema.safeParse(required.context);
        if (!parsed.success) result = addonFailure({ code: 'invalid_input' });
        else if (optional?.signal?.aborted) result = addonFailure({ code: 'cancelled' });
        else result = await required.run();
    } catch { result = addonFailure({ code: 'unavailable' }); }
    if (!result.ok) {
        const error = appErrorSchema.safeParse(result.error);
        result = error.success ? { ok: false, error: error.data } : addonFailure({ code: 'unavailable' });
    }
    try { required.dependencies.observer.observe({ operation: required.operation, outcome: result.ok ? 'succeeded' : result.error.code,
        correlationId: required.context.correlationId, traceId: required.context.traceId, runId: required.context.runId }); }
    catch { /* Observation cannot change committed activation. */ }
    return result;
}

/** Stable error values redact plugin/library errors and keep retries explicit. */
export function addonFailure(required: { code: AppError['code'] }): { ok: false; error: AppError } {
    return { ok: false, error: { code: required.code, message: 'Add-on operation unavailable or denied', retryable: required.code === 'unavailable' } };
}

/** A partially completed mutation requires reconciliation, never an automatic retry. */
export function reconciliationFailure(): { ok: false; error: AppError } {
    return failure({ code: 'unavailable', message: 'Add-on outcome uncertain; reconcile installation and runtime state before retrying' });
}

import type { CallContext, CallOptions, Outcome } from "@open-marketing/contracts";
import type { MeasureObserverPort } from "./ports.js";
import { failure } from "./rules.js";

/** Translate boundary throws without leaking secrets. Observers are best effort and
 * cannot manufacture failure/retry after a committed effect. @complexity O(1). */
export async function runBoundary<T>(required: { operation: string; context: CallContext; observer?: MeasureObserverPort; work: () => Promise<Outcome<T>> }, optional?: CallOptions): Promise<Outcome<T>> {
  if (optional?.signal?.aborted) return failure({ code: "cancelled", message: "Measurement operation cancelled" });
  let result: Outcome<T>;
  try { result = await required.work(); }
  catch { result = failure({ code: "unavailable", message: "Measurement boundary failed", retryable: false }); }
  observe({ ...required, result });
  return result;
}
function observe<T>(required: { operation: string; context: CallContext; observer?: MeasureObserverPort; result: Outcome<T> }): void {
  try { required.observer?.observe({ operation: required.operation, outcome: required.result.ok ? "succeeded" : required.result.error.code, correlationId: required.context.correlationId, traceId: required.context.traceId, runId: required.context.runId }); }
  catch { /* Telemetry failure must not change an authoritative outcome. */ }
}

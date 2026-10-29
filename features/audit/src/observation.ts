import type { CallContext, ObserverPort, Outcome } from "@open-marketing/contracts";
import { operationalId } from "./validation.js";

/** Telemetry cannot convert a committed append into a failure. Entries, references, digests and
 * exceptions never enter this sink. @complexity O(1), bounded identifiers.
 */
export function observe<T>(required: {
  observer?: ObserverPort; context: CallContext; operation: string; outcome: Outcome<T>;
}): void {
  try {
    required.observer?.observe({
      operation: required.operation,
      outcome: required.outcome.ok ? "ok" : required.outcome.error.code,
      correlationId: operationalId({ value: required.context.correlationId }),
      traceId: operationalId({ value: required.context.traceId }),
      runId: required.context.runId === undefined ? undefined : operationalId({ value: required.context.runId }),
    });
  } catch { /* Best effort diagnostics preserve the original typed outcome. */ }
}

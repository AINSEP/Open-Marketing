import type { CallContext, CallOptions, Outcome, ObserverPort } from "@open-marketing/contracts";
import type { z } from "zod";
import { failure } from "./rules.js";
import { outcomeSchema } from "./schemas.js";

/** Map thrown/malformed port output to an explicit unavailable result. No retries. @complexity O(1) for bounded workspace values. */
export async function callPort<T>(required: { invoke: () => Promise<Outcome<T>>; schema: z.ZodType<T> }, optional?: CallOptions): Promise<Outcome<T>> {
  if (optional?.signal?.aborted) return failure({ code: "cancelled", message: "Workspace operation cancelled" });
  try {
    const parsed = outcomeSchema({ value: required.schema }).safeParse(await required.invoke());
    if (!parsed.success) return failure({ code: "unavailable", message: "Invalid workspace adapter result" });
    return parsed.data;
  } catch {
    return failure({ code: "unavailable", message: "Workspace adapter unavailable" });
  }
}
/** Nonblocking observer failures cannot undo a committed binding. No secrets emitted. @complexity O(1). */
export function observe(required: { observer?: ObserverPort; operation: string; result: Outcome<unknown>; context: Pick<CallContext, "correlationId" | "traceId" | "runId"> }): void {
  try {
    required.observer?.observe({ operation: required.operation, outcome: required.result.ok ? "succeeded" : required.result.error.code, correlationId: required.context.correlationId, traceId: required.context.traceId, ...(required.context.runId === undefined ? {} : { runId: required.context.runId }) });
  } catch {
    // Observer ports are best effort; their failures cannot change domain semantics.
  }
}

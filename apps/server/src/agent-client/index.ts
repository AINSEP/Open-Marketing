import { parseBoundary, runEventSchema, eventSubscriptionSchema } from "@open-marketing/contracts";
import type { Outcome, RunEvent, ObserverPort } from "@open-marketing/contracts";
export interface JsonTransportPort { send(required: { path: string; authorization: string; body: unknown; signal?: AbortSignal }): Promise<Outcome<unknown>> }
export interface SseTransportPort { subscribe(required: { path: string; authorization: string; after: number; signal?: AbortSignal }): AsyncIterable<unknown> }
interface StreamInput { runId: string; path: string; authorization: string; after: number; signal?: AbortSignal }
/** Versioned, scoped protocol boundary. Credential transport, reconnect and event persistence remain injected. */
export function createEventClient(required: { sse: SseTransportPort; observer: ObserverPort; maxEvents: number }) {
 return { async *events(input: StreamInput): AsyncIterable<Outcome<RunEvent>> {
  const subscription = validateSubscription({ input, limit: required.maxEvents });
  if (!subscription.ok) { yield subscription; return; }
  let sequence = input.after; let count = 0;
  for await (const event of required.sse.subscribe(input)) {
   if (++count > required.maxEvents) { yield { ok: false, error: { code: "limit_exceeded", message: "Event batch bound exceeded", retryable: false } }; return; }
   const parsed = parseBoundary({ schema: runEventSchema, input: event });
   if (!parsed.ok) { yield parsed; return; }
   if (parsed.value.runId !== input.runId || parsed.value.sequence <= sequence) { yield { ok: false, error: { code: "invalid_input", message: "Event scope or ordering mismatch", retryable: false } }; return; }
   sequence = parsed.value.sequence;
   required.observer.observe({ operation: "events.receive", outcome: "validated", correlationId: parsed.value.correlationId, traceId: parsed.value.traceId, runId: parsed.value.runId });
   yield parsed;
  }
 } };
}
function validateSubscription(required: { input: StreamInput; limit: number }): Outcome<unknown> {
 const parsed = parseBoundary({ schema: eventSubscriptionSchema, input: { runId: required.input.runId, after: required.input.after, limit: required.limit } });
 if (!parsed.ok) return parsed;
 if (required.input.path !== "/internal/v1/runs/" + encodeURIComponent(required.input.runId) + "/events" || !/^Bearer [^\s]{32,256}$/.test(required.input.authorization)) return { ok: false, error: { code: "invalid_input", message: "Scoped authenticated event route required", retryable: false } };
 return parsed;
}

import { parseBoundary, runEventSchema, eventSubscriptionSchema } from "@open-marketing/contracts";
import type { Outcome, RunEvent, ObserverPort } from "@open-marketing/contracts";
import { z } from 'zod';
import { requestOm, type HttpRuntime, type HttpSession } from '../cli/http.js';
import type { CancelRunRequest, StartRunRequest } from '@open-marketing/contracts';
export interface JsonTransportPort { send(required: { path: string; authorization: string; body: unknown; signal?: AbortSignal }): Promise<Outcome<unknown>> }
export interface SseTransportPort { subscribe(required: { runId: string; path: string; authorization: string; after: number; signal?: AbortSignal }): AsyncIterable<unknown> }
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

/** Real control transport reuses bounded JSON/envelope/deadline parsing, with the separate
 * service credential. The legacy event-client transport name is retained; its source is polling.
 * @example const client = createAgentControlClient({ baseUrl, token, runtime, observer });
 */
export function createAgentControlClient(required: { baseUrl: string; token: string; runtime: HttpRuntime; observer: ObserverPort }) {
 const receipt = z.strictObject({ runId: z.string().min(1).max(256), status: z.enum(['requested', 'pending']) });
 const cancelled = z.strictObject({ runId: z.string().min(1).max(256), status: z.enum(['requested', 'cancelled']) });
 function session(input: { correlationId: string; traceId: string }): HttpSession {
  return { ...required, ...input };
 }
 const transport: SseTransportPort = { async *subscribe(input) {
  const result = await requestOm({ session: session({ correlationId: required.runtime.ids.next({}), traceId: required.runtime.ids.next({}) }),
   route: { method: 'GET', path: input.path + '?after=' + input.after + '&limit=128&runId=' + encodeURIComponent(input.runId), schema: z.array(runEventSchema).max(128) } });
  if (!result.ok) throw new Error('Agent event polling unavailable');
  for (const event of result.value) yield event;
 } };
 const events = createEventClient({ sse: transport, observer: required.observer, maxEvents: 128 });
 return {
  health: () => requestOm({ session: session({ correlationId: required.runtime.ids.next({}), traceId: required.runtime.ids.next({}) }),
   route: { method: 'GET', path: '/internal/v1/health', schema: z.strictObject({ protocolVersion: z.literal(1), ready: z.literal(true), runtime: z.literal('available') }) } }),
  start: (input: StartRunRequest) => requestOm({ session: session(input.context), route: { method: 'POST', path: '/internal/v1/runs', schema: receipt }, body: input }),
  cancel: (input: { request: CancelRunRequest; correlationId: string; traceId: string }) => requestOm({ session: session(input),
   route: { method: 'POST', path: '/internal/v1/runs/:id/cancel', schema: cancelled }, id: input.request.runId, body: input.request }),
  events: events.events,
 };
}

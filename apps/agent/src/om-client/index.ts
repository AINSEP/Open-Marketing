import { z } from 'zod';
import { assistantContextSchema, appErrorSchema, notImplemented, parseBoundary, runEventSchema, eventSubscriptionSchema } from "@open-marketing/contracts";
import type { Outcome, RunEvent, ObserverPort, StartRunRequest } from "@open-marketing/contracts";
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
 if (required.input.path !== "/api/agent/v1/runs/" + encodeURIComponent(required.input.runId) + "/events" || !/^Bearer [^\s]{32,256}$/.test(required.input.authorization)) return { ok: false, error: { code: "invalid_input", message: "Scoped authenticated event route required", retryable: false } };
 return parsed;
}

/** Fixed OM model context/event routes. No arbitrary network target or vendor credential is accepted. */
export function createOmModelClient(required: {
 serverOrigin: string; fetch: typeof fetch; observer: ObserverPort;
 deadline(required: { timeoutMs: number }): { signal: AbortSignal; dispose(): void };
}): import('../runtime/model.js').ModelClient {
 const origin = new URL(required.serverOrigin);
 if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || origin.pathname !== '/' || origin.username || origin.password || origin.hash || origin.search) throw new Error('OM loopback origin required');
 return {
  brokerBaseUrl: origin.origin + '/api/agent/v1/model/anthropic', system: 'You are the Open Marketing assistant. Use only OM tools. Never claim an action completed without its tool result.', tools: [],
  deadline: required.deadline,
  load: input => modelRequest({ ...required, ...input, operation: 'context', schema: assistantContextSchema }),
  async publish(input) {
   const result = await modelRequest({ ...required, ...input, operation: 'events', body: input.event, schema: z.strictObject({ recorded: z.literal(true) }) });
   return result.ok ? { ok: true, value: undefined } : result;
  },
  async executeTool() { return notImplemented({ operation: 'assistant.tools (A3)' }); },
 };
}

/** A single authenticated callback, 15s deadline and 128 KiB body bound, with no retries. */
async function modelRequest<T>(required: {
 serverOrigin: string; fetch: typeof fetch; observer: ObserverPort; run: StartRunRequest; operation: 'context' | 'events';
 body?: unknown; signal: AbortSignal; schema: z.ZodType<T>;
 deadline(required: { timeoutMs: number }): { signal: AbortSignal; dispose(): void };
}): Promise<Outcome<T>> {
 const timeout = required.deadline({ timeoutMs: 15000 });
 const signal = AbortSignal.any([required.signal, timeout.signal]);
 let outcome = 'unavailable';
 try {
  const response = await required.fetch(required.serverOrigin + '/api/agent/v1/runs/' + encodeURIComponent(required.run.runId) + '/' + required.operation, {
   method: required.operation === 'context' ? 'GET' : 'POST', redirect: 'error', signal,
   headers: { authorization: 'Bearer ' + required.run.runBearer, 'content-type': 'application/json', 'x-correlation-id': required.run.context.correlationId, 'x-trace-id': required.run.context.traceId },
   ...(required.body === undefined ? {} : { body: JSON.stringify(required.body) }),
  });
  const result = await boundedModelResponse({ response, schema: required.schema });
  if (signal.aborted) return { ok: false, error: { code: 'cancelled', message: 'OM callback interrupted', retryable: false } };
  outcome = result.ok ? 'ok' : result.error.code;
  return result;
 } catch { return { ok: false, error: { code: 'unavailable', message: 'OM callback unavailable', retryable: false } }; }
 finally {
  timeout.dispose();
  try { required.observer.observe({ operation: 'agent.om.' + required.operation, outcome, runId: required.run.runId,
   correlationId: required.run.context.correlationId, traceId: required.run.context.traceId }); }
  catch { /* Diagnostics cannot replace the callback outcome. */ }
 }
}
/** Consume bounded JSON and close the response even when parsing fails. */
async function boundedModelResponse<T>(required: { response: Response; schema: z.ZodType<T> }): Promise<Outcome<T>> {
 const reader = required.response.body?.getReader();
 if (!reader) throw new Error('Missing OM response');
 let bytes = 0; let text = ''; const decoder = new TextDecoder('utf-8', { fatal: true });
 try {
  while (true) {
   const chunk = await reader.read();
   if (chunk.done) break;
   bytes += chunk.value.byteLength;
   if (bytes > 131072) throw new Error('OM context bound exceeded');
   text += decoder.decode(chunk.value, { stream: true });
  }
  const schema = z.discriminatedUnion('ok', [z.strictObject({ ok: z.literal(true), value: required.schema }), z.strictObject({ ok: z.literal(false), error: appErrorSchema })]);
  const parsed = parseBoundary({ schema, input: JSON.parse(text + decoder.decode()) as unknown });
  if (!parsed.ok) return parsed;
  if (!required.response.ok && parsed.value.ok) throw new Error('OM status mismatch');
  return parsed.value;
 } finally { try { await reader.cancel(); } finally { reader.releaseLock(); } }
}

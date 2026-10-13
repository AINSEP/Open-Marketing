import { parseBoundary, runEventSchema, eventSubscriptionSchema, epochSchema } from "@open-marketing/contracts";
import type { Outcome, RunEvent, ObserverPort, ClockPort } from "@open-marketing/contracts";
import type { TimerPort } from "./types.js";
import { isSafeUiValue } from "./validation.js";

/** Auth stays in the transport adapter; it is never copied to observer or UI state. */
export interface JsonTransportPort { send(required: { path: string; authorization: string; body: unknown; signal?: AbortSignal }): Promise<Outcome<unknown>> }
export interface SseTransportPort { subscribe(required: { path: string; authorization: string; after: number; signal?: AbortSignal }): AsyncIterable<unknown> }
export interface StreamInput { runId: string; path: string; authorization: string; after: number; expiresAt?: number; signal?: AbortSignal }
export interface EventClient { events(required: StreamInput): AsyncIterable<Outcome<RunEvent>> }
interface Dependencies { abort: () => AbortController; sse: SseTransportPort; observer: ObserverPort; clock: ClockPort; timers: TimerPort; maxEvents: number; retryDelaysMs: readonly number[] }
interface Cursor { sequence: number; count: number; seen: Map<string, string>; terminal: boolean }
function failure(required: { code: "invalid_input" | "unavailable" | "expired" | "cancelled" | "limit_exceeded"; message: string; retryable?: boolean }): Outcome<never> {
  return { ok: false, error: { ...required, retryable: required.retryable ?? false } };
}
function validateSubscription(required: { input: StreamInput; deps: Dependencies }): Outcome<unknown> {
  const parsed = parseBoundary({ schema: eventSubscriptionSchema, input: { runId: required.input.runId, after: required.input.after, limit: required.deps.maxEvents } });
  if (!parsed.ok) return parsed;
  if (required.input.expiresAt !== undefined && !epochSchema.safeParse(required.input.expiresAt).success) return failure({ code: "invalid_input", message: "Invalid run expiry" });
  const expected = "/api/agent/v1/runs/" + encodeURIComponent(required.input.runId) + "/events";
  if (required.input.path !== expected || !/^Bearer [^\s]{32,256}$/.test(required.input.authorization)) return failure({ code: "invalid_input", message: "Scoped authenticated event route required" });
  if (required.deps.retryDelaysMs.length > 5 || required.deps.retryDelaysMs.some(delay => invalidDelay({ delay }))) return failure({ code: "invalid_input", message: "Invalid retry bounds" });
  return parsed;
}
function invalidDelay(required: { delay: number }): boolean { return !Number.isFinite(required.delay) || required.delay < 0 || required.delay > 30000; }
function interrupted(required: { input: StreamInput; clock: ClockPort }): Outcome<never> | null {
  if (required.input.expiresAt !== undefined && required.clock.now({}) >= required.input.expiresAt) return failure({ code: "expired", message: "Run observation expired" });
  if (required.input.signal?.aborted) return failure({ code: "cancelled", message: "Event observation cancelled" });
  return null;
}
/** Foreign transport failures are translated here; exception text may contain credentials. */
async function* readConnection(required: { deps: Dependencies; input: StreamInput }): AsyncIterable<Outcome<unknown>> {
  try {
    for await (const value of required.deps.sse.subscribe(required.input)) yield { ok: true, value };
  } catch { yield failure({ code: "unavailable", message: "Event connection interrupted", retryable: true }); }
}
/** Exact replay is skipped; ID collisions and changed replay fail closed instead of double-applying. */
function acceptEvent(required: { raw: unknown; input: StreamInput; cursor: Cursor; maxEvents: number; clock: ClockPort }): Outcome<RunEvent | null> {
  const stopped = interrupted({ input: required.input, clock: required.clock });
  if (stopped) return stopped;
  required.cursor.count += 1;
  if (required.cursor.count > required.maxEvents) return failure({ code: "limit_exceeded", message: "Event batch bound exceeded" });
  if (!isSafeUiValue({ value: required.raw, maxCharacters: 65536 })) return failure({ code: "invalid_input", message: "Event display payload rejected" });
  const parsed = parseBoundary({ schema: runEventSchema, input: required.raw });
  if (!parsed.ok) return parsed;
  const event = parsed.value;
  if (event.runId !== required.input.runId) return failure({ code: "invalid_input", message: "Event scope mismatch" });
  const signature = JSON.stringify(event);
  const replay = replayDecision({ previous: required.cursor.seen.get(event.eventId), signature, event, sequence: required.cursor.sequence, after: required.input.after });
  if (!replay.ok) return replay;
  if (replay.value === "duplicate") return { ok: true, value: null };
  required.cursor.seen.set(event.eventId, signature);
  required.cursor.sequence = event.sequence;
  required.cursor.terminal = ["ended", "cancelled", "error"].includes(event.kind);
  return parsed;
}
/** The cursor may predate this subscription; only that historical range lacks replay evidence. */
function replayDecision(required: { previous: string | undefined; signature: string; event: RunEvent; sequence: number; after: number }): Outcome<"new" | "duplicate"> {
  if (required.previous !== undefined && required.previous !== required.signature) return failure({ code: "invalid_input", message: "Conflicting event replay" });
  if (required.event.sequence <= required.sequence) {
    if (required.previous !== undefined || required.event.sequence <= required.after) return { ok: true, value: "duplicate" };
    return failure({ code: "invalid_input", message: "Out-of-order event identity" });
  }
  if (required.previous !== undefined) return failure({ code: "invalid_input", message: "Reused event identifier" });
  return { ok: true, value: "new" };
}
async function* receiveBatch(required: { deps: Dependencies; input: StreamInput; cursor: Cursor }): AsyncIterable<Outcome<RunEvent>> {
  for await (const raw of readConnection({ deps: required.deps, input: { ...required.input, after: required.cursor.sequence } })) {
    if (!raw.ok) return; // Only observation reconnects; approval/cancellation writes never do.
    const parsed = acceptEvent({ raw: raw.value, input: required.input, cursor: required.cursor, maxEvents: required.deps.maxEvents, clock: required.deps.clock });
    if (!parsed.ok) { yield parsed; required.cursor.terminal = true; return; }
    if (parsed.value === null) continue;
    const event = parsed.value;
    required.deps.observer.observe({ operation: "events.receive", outcome: "validated", correlationId: event.correlationId, traceId: event.traceId, runId: event.runId });
    yield { ok: true, value: event };
    if (required.cursor.terminal) return;
  }
}
/** Resume from the last accepted sequence across bounded read-only reconnects.
 * An unexpected EOF is unavailable, never successful completion. Cursor memory is per subscription.
 * @example client.events({ runId, path, authorization, after: 0, signal })
 * @complexity O(events × bounded payload size), O(maxEvents × payload size) replay evidence.
 */
export function createEventClient(required: Dependencies): EventClient {
  return { async *events(input) {
    const valid = validateSubscription({ input, deps: required });
    if (!valid.ok) { yield valid; return; }
    const controller = required.abort();
    const abort = (): void => controller.abort();
    input.signal?.addEventListener("abort", abort, { once: true });
    if (input.signal?.aborted) abort();
    let deadline: unknown = null;
    if (input.expiresAt !== undefined) deadline = required.timers.schedule({ delayMs: Math.max(0, input.expiresAt - required.clock.now({})), callback: abort });
    try { yield* reconnect({ deps: required, request: { ...input, signal: controller.signal } }); }
    finally {
      controller.abort(); input.signal?.removeEventListener("abort", abort);
      if (deadline !== null) required.timers.cancel({ handle: deadline });
    }
  } };
}

async function* reconnect(input: { deps: Dependencies; request: StreamInput }): AsyncIterable<Outcome<RunEvent>> {
    const cursor: Cursor = { sequence: input.request.after, count: 0, seen: new Map(), terminal: false };
    for (let attempt = 0; attempt <= input.deps.retryDelaysMs.length; attempt += 1) {
      const stopped = interrupted({ input: input.request, clock: input.deps.clock });
      if (stopped) { yield stopped; return; }
      yield* receiveBatch({ deps: input.deps, input: input.request, cursor });
      if (cursor.terminal) return;
      const delayMs = input.deps.retryDelaysMs[attempt];
      if (delayMs !== undefined) await input.deps.timers.wait({ delayMs, signal: input.request.signal });
    }
    yield interrupted({ input: input.request, clock: input.deps.clock }) ?? failure({ code: "unavailable", message: "Event stream reconnect limit reached", retryable: true });
}

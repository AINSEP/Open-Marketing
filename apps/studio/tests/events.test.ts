import { it, expect } from "vitest";
import { createEventClient } from "../src/shared/api/index.js";
import type { SseTransportPort } from "../src/shared/api/index.js";
import type { Outcome, RunEvent, ObserverEvent } from "@open-marketing/contracts";
import { testRuntime } from "./support/runtime.js";

/** Synthetic authenticated wire frames; bearer stays outside the event and observer payloads. */
function event(required: { sequence: number; kind?: RunEvent["kind"]; payload?: RunEvent["payload"] }): RunEvent {
  return { protocolVersion: 1, eventId: "event-" + required.sequence, runId: "run-1", sequence: required.sequence, correlationId: "correlation-1", traceId: "trace-1", kind: required.kind ?? "delta", payload: required.payload ?? { type: "status", text: "fixture" } };
}
async function collect(required: { events: AsyncIterable<Outcome<RunEvent>> }): Promise<readonly Outcome<RunEvent>[]> {
  const values: Outcome<RunEvent>[] = []; for await (const value of required.events) values.push(value); return values;
}
function input() { return { runId: "run-1", path: "/api/agent/v1/runs/run-1/events", authorization: "Bearer " + "fixture-only-".repeat(4), after: 0 }; }
function setup(required: { transport: SseTransportPort; maxEvents?: number; retries?: readonly number[] }) {
  const host = testRuntime(); const observed: ObserverEvent[] = [];
  const client = createEventClient({ abort: host.runtime.abort, sse: required.transport, observer: { observe(value) { observed.push(value); } }, clock: host.runtime.clock, timers: { ...host.runtime.timers, async wait() {} }, maxEvents: required.maxEvents ?? 100, retryDelaysMs: required.retries ?? [0] });
  return { client, observed, host };
}
it("reconnect resumes from accepted cursor and exact replay applies once", async () => {
  const cursors: number[] = [];
  const transport: SseTransportPort = { async *subscribe(request) { cursors.push(request.after); yield event({ sequence: 1 }); if (cursors.length === 1) throw new Error("opaque network failure"); yield event({ sequence: 2, kind: "ended" }); } };
  const { client, observed } = setup({ transport }); const values = await collect({ events: client.events(input()) });
  expect(cursors).toEqual([0, 1]);
  expect(values).toEqual([{ ok: true, value: event({ sequence: 1 }) }, { ok: true, value: event({ sequence: 2, kind: "ended" }) }]);
  expect(observed.map(value => value.runId)).toEqual(["run-1", "run-1"]);
  expect(JSON.stringify(observed)).not.toContain("Bearer");
});
it("changed replay, foreign run, and sensitive payload fail before observer/UI delivery", async () => {
  const conflicting: SseTransportPort = { async *subscribe() { yield event({ sequence: 1 }); yield event({ sequence: 1, payload: { changed: true } }); } };
  const first = setup({ transport: conflicting });
  expect((await collect({ events: first.client.events(input()) }))[1]).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  const foreign: SseTransportPort = { async *subscribe() { yield { ...event({ sequence: 1 }), runId: "other-run" }; } };
  expect((await collect({ events: setup({ transport: foreign }).client.events(input()) }))[0]).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  const sensitive: SseTransportPort = { async *subscribe() { yield event({ sequence: 1, payload: { nested: { api_key: "credential-value" } } }); } };
  const guarded = setup({ transport: sensitive });
  expect((await collect({ events: guarded.client.events(input()) }))[0]).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  expect(guarded.observed).toEqual([]);
});
it("unexpected EOF, repeated replay storm, cancellation, and expiry remain explicit", async () => {
  const empty: SseTransportPort = { async *subscribe() {} }; const exhausted = setup({ transport: empty });
  expect(await collect({ events: exhausted.client.events(input()) })).toMatchObject([{ ok: false, error: { code: "unavailable" } }]);
  const storm: SseTransportPort = { async *subscribe() { yield event({ sequence: 1 }); yield event({ sequence: 1 }); yield event({ sequence: 1 }); } };
  expect((await collect({ events: setup({ transport: storm, maxEvents: 2 }).client.events(input()) }))[1]).toMatchObject({ ok: false, error: { code: "limit_exceeded" } });
  const controller = new AbortController(); controller.abort();
  expect(await collect({ events: exhausted.client.events({ ...input(), signal: controller.signal }) })).toMatchObject([{ ok: false, error: { code: "cancelled" } }]);
  expect(await collect({ events: exhausted.client.events({ ...input(), expiresAt: 1000 }) })).toMatchObject([{ ok: false, error: { code: "expired" } }]);
});
it("subscription route, protocol, and payload size are bounded before acceptance", async () => {
  const empty: SseTransportPort = { async *subscribe() {} }; const { client } = setup({ transport: empty });
  expect(await collect({ events: client.events({ ...input(), path: "/api/other" }) })).toMatchObject([{ ok: false, error: { code: "invalid_input" } }]);
  const malformed: SseTransportPort = { async *subscribe() { yield { ...event({ sequence: 1 }), protocolVersion: 2 }; } };
  expect(await collect({ events: setup({ transport: malformed }).client.events(input()) })).toMatchObject([{ ok: false, error: { code: "invalid_input" } }]);
  const oversized: SseTransportPort = { async *subscribe() { yield event({ sequence: 1, payload: { text: "a".repeat(65537) } }); } };
  expect(await collect({ events: setup({ transport: oversized }).client.events(input()) })).toMatchObject([{ ok: false, error: { code: "invalid_input" } }]);
});
it("an idle subscription aborts at expiry and cleans up its deadline", async () => {
  const host = testRuntime();
  const transport: SseTransportPort = { async *subscribe(request) { await host.runtime.timers.wait({ delayMs: 60000, signal: request.signal }); } };
  const client = createEventClient({ abort: host.runtime.abort, sse: transport, clock: host.runtime.clock, timers: host.runtime.timers, observer: { observe() {} }, maxEvents: 100, retryDelaysMs: [] });
  const values = collect({ events: client.events({ ...input(), expiresAt: 2000 }) });
  await Promise.resolve(); host.advance({ ms: 1000 });
  expect(await values).toMatchObject([{ ok: false, error: { code: "expired" } }]);
  expect(host.pending()).toBe(0);
});

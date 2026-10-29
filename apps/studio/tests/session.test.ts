import { it, expect, vi } from "vitest";
import type { RunEvent, NavigationResult } from "@open-marketing/contracts";
import { createChatSession } from "../src/features/chat-run/index.js";
import { createHttpStudioApi, createSampleStudioApi } from "../src/shared/api/index.js";
import type { StudioApiPort } from "../src/shared/api/index.js";
import { testRuntime } from "./support/runtime.js";

function event(required: { sequence: number; kind?: RunEvent["kind"]; payload?: RunEvent["payload"] }): RunEvent {
  return { protocolVersion: 1, eventId: "event-" + required.sequence, runId: "run-1", sequence: required.sequence, correlationId: "correlation-1", traceId: "trace-1", kind: required.kind ?? "delta", payload: required.payload ?? { type: "message", message: { id: "assistant-1", role: "assistant", text: "Fixture response" } } };
}
function setup(required: { override?: Partial<StudioApiPort> } = {}) {
  const host = testRuntime(); const acknowledgements: NavigationResult[] = [];
  const api: StudioApiPort = { ...createSampleStudioApi({ runtime: host.runtime }), async start() { return { ok: true, value: { runId: "run-1", status: "pending", expiresAt: 11000 } }; }, async cancel(input) { return { ok: true, value: { runId: input.runId, status: "cancelled" } }; }, async *events() { yield { ok: true, value: event({ sequence: 1 }) }; yield { ok: true, value: event({ sequence: 1 }) }; yield { ok: true, value: event({ sequence: 2, kind: "ended", payload: { type: "status", text: "done" } }) }; }, async acknowledgeNavigation(input) { acknowledgements.push(input.result); return { ok: true, value: { status: "recorded" } }; }, ...required.override };
  const session = createChatSession({ api, runtime: host.runtime, async navigate(input) { return { status: "failed", actionId: input.action.actionId, error: { code: "unavailable", message: "No browser", retryable: false } }; } });
  return { host, session, acknowledgements };
}
it("full-message replay is deduplicated and completion is driven by a terminal event", async () => {
  const { session, host } = setup(); await session.send({ text: "a brief" });
  expect(session.getSnapshot().status).toBe("complete");
  expect(session.getSnapshot().messages.filter(message => message.id === "assistant-1")).toEqual([{ id: "assistant-1", role: "assistant", text: "Fixture response" }]);
  expect(host.pending()).toBe(0); session.dispose();
});
it("an event stream ending early does not masquerade as a completed response", async () => {
  const { session } = setup({ override: { async *events() { yield { ok: true, value: event({ sequence: 1 }) }; } } });
  await session.send({ text: "a brief" }); expect(session.getSnapshot().status).toBe("unavailable");
  expect(session.getSnapshot().notice).toBe("Stream ended without a completion event. Outcomes are unconfirmed."); session.dispose();
});
it("navigation failures are acknowledged as failures rather than requested-as-completed", async () => {
  const action = { kind: "navigate", actionId: "nav-1", target: "campaigns" };
  const { session, acknowledgements } = setup({ override: { async *events() { yield { ok: true, value: event({ sequence: 1, payload: { type: "navigation", action } }) }; yield { ok: true, value: event({ sequence: 2, kind: "ended", payload: { type: "status", text: "done" } }) }; } } });
  await session.send({ text: "open campaigns" });
  expect(acknowledgements).toEqual([{ status: "failed", actionId: "nav-1", error: { code: "unavailable", message: "No browser", retryable: false } }]);
  expect(session.getSnapshot().navigation).toEqual(acknowledgements[0]); session.dispose();
});
it("owner cancellation stops observation and distinguishes requested from acknowledged cancellation", async () => {
  const host = testRuntime();
  const { session } = setup({ override: { async *events(input) { await host.runtime.timers.wait({ delayMs: 60000, signal: input.signal }); }, async cancel(input) { return { ok: true, value: { runId: input.runId, status: "requested" } }; } } });
  const sending = session.send({ text: "a brief" }); await Promise.resolve();
  expect(session.getSnapshot().status).toBe("running"); await session.cancel(); await sending;
  expect(session.getSnapshot().status).toBe("cancelling");
  expect(session.getSnapshot().notice).toBe("Cancellation requested; remote completion is unconfirmed."); session.dispose();
});
it("expiry aborts observation and sends the typed expiry reason without claiming a refund", async () => {
  const fixture = testRuntime(); const cancelled: string[] = [];
  const { session, host } = setup({ override: { async *events(input) { await fixture.runtime.timers.wait({ delayMs: 60000, signal: input.signal }); }, async cancel(input) { cancelled.push(input.reason); return { ok: true, value: { runId: input.runId, status: "cancelled" } }; } } });
  const sending = session.send({ text: "a brief" }); await Promise.resolve(); host.advance({ ms: 10000 }); await sending;
  expect(session.getSnapshot().status).toBe("expired"); expect(cancelled).toEqual(["expired"]);
  expect(session.getSnapshot().notice).toBe("Run expired. External outcomes remain unconfirmed."); session.dispose();
});
it("invalid and sensitive events cannot enter the transcript", async () => {
  const { session } = setup({ override: { async *events() { yield { ok: true, value: event({ sequence: 1, payload: { type: "message", message: { id: "unsafe", role: "assistant", text: "Bearer confidential-value" } } }) }; } } });
  await session.send({ text: "a brief" }); expect(session.getSnapshot().status).toBe("unavailable");
  expect(session.getSnapshot().messages.some(message => message.id === "unsafe")).toBe(false); session.dispose();
});
it("cancelling an unresolved start clears its timer and rejects its late receipt", async () => {
  const deferred = Promise.withResolvers<Awaited<ReturnType<StudioApiPort["start"]>>>();
  const { session, host } = setup({ override: { start() { return deferred.promise; } } });
  const pending = session.send({ text: "a brief" }); await Promise.resolve();
  await session.cancel(); expect(host.pending()).toBe(0); expect(session.getSnapshot().status).toBe("cancelled");
  host.advance({ ms: 15000 }); expect(session.getSnapshot().status).toBe("cancelled");
  deferred.resolve({ ok: true, value: { runId: "late-run", status: "pending", expiresAt: 999999 } }); await pending;
  expect(session.getSnapshot().status).toBe("cancelled"); session.dispose();
});
it("recognizable credentials are rejected before outgoing transcript insertion", async () => {
  const { session } = setup(); await session.send({ text: "Bearer credential-value" });
  expect(session.getSnapshot().messages).toEqual([]); expect(session.getSnapshot().notice).toBe("Message rejected: keep credentials out of chat."); session.dispose();
});
it("a repeated stop cannot convert pending server cancellation into local success", async () => {
  const fixture = testRuntime(); let count = 0;
  const { session } = setup({ override: { async *events(input) { await fixture.runtime.timers.wait({ delayMs: 60000, signal: input.signal }); }, async cancel(input) { count += 1; return { ok: true, value: { runId: input.runId, status: "requested" } }; } } });
  const sending = session.send({ text: "a brief" }); await Promise.resolve(); await session.cancel(); await sending; await session.cancel();
  expect(count).toBe(1); expect(session.getSnapshot().status).toBe("cancelling");
  expect(session.getSnapshot().notice).toBe("Cancellation requested; remote completion is unconfirmed."); session.dispose();
});

it('forwards validated image references through the Jini session transport', async () => {
  const start = vi.fn<StudioApiPort['start']>(async () => ({ ok: true, value: { runId: 'run-1', status: 'pending', expiresAt: 11000 } }));
  const { session } = setup({ override: { start } });
  const ref = { path: 'asset', name: 'image.png', kind: 'image' as const, size: 20 };
  try {
    await session.transport.startRun({ history: [{ id: 'question', role: 'user', content: 'Look at this' }], attachments: [ref], signal: new AbortController().signal }, { onEvent() {}, onError() {}, onDone() {} });
    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0][0]).toMatchObject({ message: { text: 'Look at this' }, attachments: [ref] });
  } finally { session.dispose(); }
});
it('invalid image refs and partial-invalid batches fail before a send or local transcript insertion', async () => {
  const start = vi.fn<StudioApiPort['start']>();
  const { session } = setup({ override: { start } });
  const ref = { path: 'asset', name: 'image.png', kind: 'image' as const, size: 20 };
  try {
    for (const attachments of [[{ ...ref, name: 'bad/filename' }], [{ ...ref, size: 1048577 }], [ref, { ...ref, kind: 'file' as const }], Array(5).fill(ref)]) {
      await expect(session.transport.startRun({ history: [{ id: 'question', role: 'user', content: 'Look' }], attachments, signal: new AbortController().signal }, { onEvent() {}, onError() {}, onDone() {} })).rejects.toThrow('Invalid attachment.');
    }
    expect(start).not.toHaveBeenCalled(); expect(session.getSnapshot().messages).toEqual([]);
  } finally { session.dispose(); }
});

it('uploads raw image bytes, validates server refs and includes them in the HTTP run request', async () => {
  const host = testRuntime(); const observed: unknown[] = [];
  const ref = { path: 'asset', name: 'private image.png', kind: 'image' as const, size: 4 };
  const calls: { url: string; body: unknown; contentType: string | null }[] = [];
  let invalidReply = false;
  const api = createHttpStudioApi({ baseUrl: 'http://localhost', runtime: host.runtime, observer: { observe(event) { observed.push(event); } },
    async fetch(url, options) {
      calls.push({ url: String(url), body: options?.body, contentType: new Headers(options?.headers).get('content-type') });
      if (String(url).includes('/api/attachments')) return Response.json({ ok: true, value: invalidReply ? { ...ref, kind: 'file' } : ref });
      return Response.json({ ok: true, value: { runId: 'run-1', status: 'pending', expiresAt: 11000 } });
    } });
  const file = new File(['data'], ref.name, { type: 'image/png' });
  const signal = new AbortController().signal;
  expect(await api.attachments!.upload({ file, signal })).toEqual({ ok: true, value: ref });
  expect(calls[0]).toEqual({ url: 'http://localhost/api/attachments?name=private%20image.png', body: file, contentType: 'application/octet-stream' });
  await api.start({ message: { id: 'question', role: 'user', text: 'Look' }, attachments: [ref], signal });
  expect(JSON.parse(String(calls[1].body))).toEqual({ prompt: 'Look', attachments: [ref] });
  expect(calls[1].contentType).toBe('application/json');
  invalidReply = true;
  expect((await api.attachments!.upload({ file, signal })).ok).toBe(false);
  const controller = new AbortController(); controller.abort();
  expect(await api.attachments!.upload({ file, signal: controller.signal })).toMatchObject({ ok: false, error: { code: 'cancelled' } });
  expect(calls).toHaveLength(3);
  expect(JSON.stringify(observed)).not.toContain(ref.name);
  expect(host.pending()).toBe(0);
});

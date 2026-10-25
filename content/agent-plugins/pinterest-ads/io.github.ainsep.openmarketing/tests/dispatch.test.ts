import { expect, it, vi } from "vitest";
import { configuration, fixture, invocation, now } from "./fixtures.js";
import { dispatchSuite } from "./contract/dispatch-suite.js";

dispatchSuite({ name: "memory gateway / real plugin transport", makeFixture: () => fixture() });
it("admitted false performs zero credential and network I/O", async () => {
  const f = fixture({ admitted: false });
  expect(await f.adapter.invoke(invocation())).toMatchObject({ ok: false, error: { code: "forbidden" } });
  expect(f.credentialCalls).toHaveLength(0); expect(f.calls).toHaveLength(0);
});
it("rechecks withdrawal after credential lookup", async () => {
  const f = fixture({ credentialHook: () => { f.state.current = false; } });
  expect(await f.adapter.invoke(invocation())).toMatchObject({ ok: false, error: { code: "forbidden" } }); expect(f.calls).toHaveLength(0);
});
it("allows null-account discovery but refuses account operations", async () => {
  const f = fixture({ configuration: { ...configuration, accountId: null, currency: null } });
  expect((await f.adapter.invoke(invocation())).ok).toBe(true);
  expect(f.credentialCalls[0].accountId).toBeNull();
  expect(await f.adapter.invoke(invocation({ command: { kind: "list_campaigns" } }))).toMatchObject({ ok: false, error: { code: "forbidden" } }); expect(f.calls).toHaveLength(1);
});
it.each([401, 403, 429, 500, 302])("sanitizes HTTP %s without retry", async status => {
  const f = fixture({ response: () => new Response("synthetic-secret", { status }) });
  const result = await f.adapter.invoke(invocation());
  expect(result).toMatchObject({ ok: false, error: { retryable: false } }); expect(JSON.stringify(result)).not.toContain("synthetic-secret"); expect(f.calls).toHaveLength(1);
});
it.each(["not json", JSON.stringify({ items: [{ id: "123" }, { id: "123" }] }), JSON.stringify({ items: [{ id: "123" }, { id: 123 }] }), "x".repeat(1048577)])("rejects malformed/duplicate/oversized pages atomically", async body => {
  const f = fixture({ response: () => new Response(body) }); expect(await f.adapter.invoke(invocation())).toMatchObject({ ok: false }); expect(f.calls).toHaveLength(1);
});
it("rejects expired or malformed credentials before egress", async () => {
  for (const credential of [{ accessToken: "synthetic-secret", expiresAt: now }, { accessToken: "bad\nheader" }]) {
    const f = fixture({ credential }); expect(await f.adapter.invoke(invocation())).toMatchObject({ ok: false }); expect(f.calls).toHaveLength(0);
  }
});
it("guards a repeated gateway callback against a second fetch", async () => {
  const f = fixture({ gateway: { async dispatch(input) { expect((await input.execute()).ok).toBe(true); return input.execute(); } } });
  expect(await f.adapter.invoke(invocation())).toMatchObject({ ok: false, error: { code: "conflict" } }); expect(f.calls).toHaveLength(1);
});
it("bounds oversized input before broker access", async () => {
  const f = fixture(); const input = { ...invocation(), junk: "x".repeat(65536) } as ReturnType<typeof invocation>;
  expect(await f.adapter.invoke(input)).toMatchObject({ ok: false, error: { code: "limit_exceeded" } }); expect(f.credentialCalls).toHaveLength(0);
});
it("keeps receipts when telemetry fails and sanitizes thrown transport errors", async () => {
  const f = fixture({ observerThrows: true }); expect((await f.adapter.invoke(invocation())).ok).toBe(true);
  const broken = fixture({ response: () => { throw new Error("synthetic-secret"); } });
  expect(await broken.adapter.invoke(invocation())).toMatchObject({ ok: false, error: { code: "unavailable", retryable: false } });
  expect(JSON.stringify(broken.observations)).not.toContain("synthetic-secret"); expect(broken.calls).toHaveLength(1);
});
it("cancels between token lookup and fetch", async () => {
  const controller = new AbortController(); const f = fixture({ credentialHook: () => controller.abort() });
  expect(await f.adapter.invoke(invocation(), { signal: controller.signal })).toMatchObject({ ok: false, error: { code: "cancelled" } }); expect(f.calls).toHaveLength(0);
});
it("applies the 15s deadline to a stalled response body", async () => {
  vi.useFakeTimers();
  try {
    const timeout = new AbortController();
    const deadline = vi.fn((input: { timeoutMs: number }) => { setTimeout(() => timeout.abort(), input.timeoutMs); return timeout.signal; });
    const f = fixture({ deadline, response: () => new Response(new ReadableStream({ start() { /* Intentionally stalls until cancelled. */ } })) });
    const pending = f.adapter.invoke(invocation()); await vi.advanceTimersByTimeAsync(15000);
    expect(await pending).toMatchObject({ ok: false, error: { code: "unavailable" } }); expect(f.calls).toHaveLength(1);
    expect(deadline).toHaveBeenCalledExactlyOnceWith({ timeoutMs: 15000 }); expect(f.calls[0].init.signal).toBe(timeout.signal);
  } finally { vi.useRealTimers(); }
});
it("combines the injected deadline with caller cancellation during a body read", async () => {
  const caller = new AbortController(), timeout = new AbortController();
  const f = fixture({ deadline: () => timeout.signal, response: () => {
    caller.abort(); return new Response(new ReadableStream());
  } });
  expect(await f.adapter.invoke(invocation(), { signal: caller.signal })).toMatchObject({ ok: false, error: { code: "cancelled" } });
  expect(f.calls).toHaveLength(1); expect(f.calls[0].init.signal?.aborted).toBe(true); expect(timeout.signal.aborted).toBe(false);
});

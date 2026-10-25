import { expect, it } from "vitest";
import { configuration, fixture, invocation, now, pendingResponse } from "./fixtures.js";
import { dispatchSuite } from "./contract/dispatch-suite.js";

dispatchSuite({ name: "HTTP with memory host", makeFixture: fixture });
it("local non-admission prevents even the gateway and broker", async () => {
  const f = fixture({ configuration: { ...configuration, admitted: false }, gateway: { async dispatch() { throw new Error("must not enter"); } } });
  expect(await f.adapter.invoke(invocation())).toMatchObject({ ok: false, error: { code: "forbidden" } });
  expect(f.credentials).toHaveLength(0); expect(f.calls).toHaveLength(0);
  expect(f.deadlines).toHaveLength(0);
});
it("guards duplicate host callbacks", async () => {
  const f = fixture({ gateway: { async dispatch(input) { await input.execute(); return input.execute(); } } });
  expect(await f.adapter.invoke(invocation())).toMatchObject({ ok: false, error: { code: "conflict" } });
  expect(f.calls).toHaveLength(1); expect(f.credentials).toHaveLength(1);
});
it.each([{}, { accessToken: "bad\r\nheader" }, { accessToken: "synthetic-secret", expiresAt: now }])("rejects malformed or expired credentials", async credential => {
  const f = fixture({ credential });
  expect(await f.adapter.invoke(invocation())).toMatchObject({ ok: false }); expect(f.calls).toHaveLength(0);
});
it("rechecks expiry after broker access", async () => {
  const f = fixture({ credentialHook: () => { f.state.time = now + 1000; } });
  expect(await f.adapter.invoke(invocation())).toMatchObject({ ok: false, error: { code: "expired" } }); expect(f.calls).toHaveLength(0);
});
it("rechecks cancellation after broker access", async () => {
  const controller = new AbortController();
  const f = fixture({ credentialHook: () => controller.abort() });
  expect(await f.adapter.invoke(invocation(), { signal: controller.signal })).toMatchObject({ ok: false, error: { code: "cancelled" } });
  expect(f.calls).toHaveLength(0);
});
it.each([[401, "unauthenticated"], [403, "forbidden"], [429, "limit_exceeded"], [500, "unavailable"], [302, "protocol_mismatch"]])("classifies HTTP %s without retry or provider text", async (status, code) => {
  const f = fixture({ response: () => new Response("synthetic-secret", { status: Number(status) }) });
  const result = await f.adapter.invoke(invocation());
  expect(result).toMatchObject({ ok: false, error: { code } }); expect(f.calls).toHaveLength(1);
  expect(JSON.stringify({ result, observations: f.observations })).not.toContain("synthetic-secret");
});
it("redacts thrown I/O failures and isolates telemetry failure", async () => {
  const f = fixture({ response: () => { throw new Error("synthetic-secret"); } });
  expect(await f.adapter.invoke(invocation())).toEqual({ ok: false, error: { code: "unavailable", message: "WhatsApp Business request failed", retryable: false } });
  expect(f.calls).toHaveLength(1);
  expect(await fixture({ observerThrows: true }).adapter.invoke(invocation())).toMatchObject({ ok: true });
});
it.each([
  { phase: "fetch", source: "caller", code: "cancelled" }, { phase: "body", source: "caller", code: "cancelled" },
  { phase: "fetch", source: "deadline", code: "unavailable" }, { phase: "body", source: "deadline", code: "unavailable" },
] as const)("classifies $source abort during $phase without retry or secret leakage", async ({ phase, source, code }) => {
  const ready = Promise.withResolvers<void>();
  const caller = new AbortController();
  let dispatched: unknown;
  const f = fixture({ response: ({ signal }) => pendingResponse({ signal, phase, ready: ready.resolve }),
    gateway: { async dispatch(input) { const result = await input.execute(); dispatched = result; return result; } } });
  const pending = f.adapter.invoke(invocation(), { signal: caller.signal });
  await ready.promise;
  expect(f.deadlines).toHaveLength(1); expect(f.deadlines[0].timeoutMs).toBe(15000);
  (source === "caller" ? caller : f.deadlines[0].controller).abort();
  const result = await pending;
  expect(dispatched).toEqual(result);
  expect(result).toEqual({ ok: false, error: { code, message: "WhatsApp Business request failed", retryable: false } });
  expect(f.calls[0].init?.signal?.aborted).toBe(true);
  expect(f.calls).toHaveLength(1); expect(f.credentials).toHaveLength(1);
  expect(f.observations).toMatchObject([{ outcome: code, correlationId: "correlation", traceId: "trace", runId: "run" }]);
  expect(JSON.stringify({ result, observations: f.observations })).not.toContain("synthetic-secret");
});

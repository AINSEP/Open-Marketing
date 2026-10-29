import { expect, it, vi } from "vitest";
import { pluginConfigurationSchema } from "@open-marketing/contracts";
import type { ObserverEvent, PluginCapabilityDependencies } from "@open-marketing/contracts";
import { createTools, tools, whatsappBusinessTools } from "../src/index.js";
import { account, configuration, fixture, invocation, now, pendingResponse } from "./fixtures.js";
import { dispatchSuite } from "./contract/dispatch-suite.js";

dispatchSuite({ name: "HTTP with memory host", makeFixture: fixture });
it("runs the real standard factory with the inner Bearer token and cleans up its wait", async () => {
  const card = { accessToken: "factory-access-token", wabaId: "123", phoneNumberId: "456", appSecret: "factory-app-secret" };
  const credentials = { access: vi.fn<PluginCapabilityDependencies["credentials"]["access"]>(async () => ({ ok: true, value: { accessToken: JSON.stringify(card) } })) };
  const fetch = vi.fn<PluginCapabilityDependencies["fetch"]>(async () => Response.json(account));
  const observations: ObserverEvent[] = [];
  const wait = vi.fn<PluginCapabilityDependencies["wait"]>(() => new Promise(() => {}));
  const adapter = createTools({ configuration: pluginConfigurationSchema.parse({ scope: configuration.scope,
    connectionId: configuration.connectionId, accountId: configuration.accountId, pluginDigest: configuration.pluginDigest, settings: {} }),
    credentials, fetch, clock: { now: () => now }, observer: { observe(event) { observations.push(event); } }, wait });
  const input = { context: invocation().context, connection: { connectionId: configuration.connectionId, accountId: configuration.accountId },
    name: whatsappBusinessTools[0].name, operationId: "operation", input: { kind: "get_account_status" }, moneyExposure: null, requiredLimit: null };
  expect(credentials.access).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  const result = await adapter.invoke(input);
  expect(result).toEqual({ ok: true, value: { operationId: "operation",
    data: { id: "123", name: "Fixture", business_verification_status: "VERIFIED", account_review_status: "APPROVED" } } });
  expect(credentials.access).toHaveBeenCalledExactlyOnceWith({ connectionId: configuration.connectionId, accountId: configuration.accountId }, undefined);
  expect(fetch).toHaveBeenCalledOnce();
  expect(new Headers(fetch.mock.calls[0][1]?.headers).get("Authorization")).toBe("Bearer " + card.accessToken);
  expect(observations).toMatchObject([{ outcome: "succeeded", correlationId: "correlation", traceId: "trace", runId: "run" }]);
  const serialized = JSON.stringify({ result, fetchCalls: fetch.mock.calls, observations });
  expect(serialized).not.toContain(JSON.stringify(card));
  expect(serialized).not.toContain("factory-app-secret");
  expect(serialized).not.toContain("{\\\"");
  expect(tools.map(tool => tool.name)).toEqual(whatsappBusinessTools.map(tool => tool.name));
  expect(wait).toHaveBeenCalledExactlyOnceWith({ milliseconds: 15000 }, { signal: expect.any(AbortSignal) });
  expect(wait.mock.calls[0][1]?.signal?.aborted).toBe(true);

  credentials.access.mockClear(); fetch.mockClear();
  for (const connection of [{ ...input.connection, connectionId: "foreign" }, { ...input.connection, accountId: null }, { ...input.connection, accountId: "999" }]) {
    expect(await adapter.invoke({ ...input, connection })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(credentials.access).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  }
});
it("uses broker denial without exposing sensitive denial text", async () => {
  const f = fixture({ configuration });
  f.state.credentialsAllowed = false;
  expect(configuration).not.toHaveProperty("admitted");
  const result = await f.adapter.invoke(invocation());
  expect(result).toEqual({ ok: false, error: { code: "forbidden", message: "WhatsApp Business request failed", retryable: false } });
  expect(JSON.stringify({ result, observations: f.observations })).not.toMatch(/gateway-secret|fixture-secret|15555550100/);
  expect(f.credentials).toHaveLength(1); expect(f.calls).toHaveLength(0);
  expect(f.deadlines).toHaveLength(0);
});
it.each([{}, { accessToken: "not json synthetic-secret" }, { accessToken: JSON.stringify({ accessToken: "bad\r\nheader" }) }, { accessToken: JSON.stringify({ accessToken: "synthetic-secret" }), expiresAt: now }])("rejects malformed or expired credentials", async credential => {
  const f = fixture({ credential });
  const result = await f.adapter.invoke(invocation());
  expect(result).toMatchObject({ ok: false }); expect(f.calls).toHaveLength(0);
  expect(JSON.stringify({ result, observations: f.observations })).not.toContain("secret");
});
it("accepts the extra fields the token credential card saves", async () => {
  const f = fixture({ credential: { accessToken: JSON.stringify({ accessToken: "synthetic-secret", wabaId: "123", phoneNumberId: "456", appSecret: "app-secret" }), expiresAt: now + 1000 } });
  expect(await f.adapter.invoke(invocation())).toMatchObject({ ok: true }); expect(f.calls).toHaveLength(1);
  const authorization = new Headers(f.calls[0]!.init?.headers).get("Authorization");
  expect(authorization).toBe("Bearer synthetic-secret");
  expect(authorization).not.toContain("{"); expect(authorization).not.toContain("app-secret");
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
  const f = fixture({ response: ({ signal }) => pendingResponse({ signal, phase, ready: ready.resolve }) });
  const pending = f.adapter.invoke(invocation(), { signal: caller.signal });
  await ready.promise;
  expect(f.deadlines).toHaveLength(1); expect(f.deadlines[0].timeoutMs).toBe(15000);
  (source === "caller" ? caller : f.deadlines[0].controller).abort();
  const result = await pending;
  expect(result).toEqual({ ok: false, error: { code, message: "WhatsApp Business request failed", retryable: false } });
  expect(f.calls[0].init?.signal?.aborted).toBe(true);
  expect(f.calls).toHaveLength(1); expect(f.credentials).toHaveLength(1);
  expect(f.observations).toMatchObject([{ outcome: code, correlationId: "correlation", traceId: "trace", runId: "run" }]);
  expect(JSON.stringify({ result, observations: f.observations })).not.toContain("synthetic-secret");
});

it("denies foreign or missing WABA credentials without egress or secret text", async () => {
  for (const identity of [{ wabaId: "999" }, {}]) {
    const f = fixture({ credential: { accessToken: JSON.stringify({ accessToken: "synthetic-secret", ...identity }) } });
    const result = await f.adapter.invoke(invocation());
    expect(result).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(f.calls).toHaveLength(0);
    expect(JSON.stringify({ result, observations: f.observations })).not.toContain("synthetic-secret");
  }
});

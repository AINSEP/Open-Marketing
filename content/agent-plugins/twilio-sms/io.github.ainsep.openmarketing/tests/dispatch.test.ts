import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createTwilioSmsAdapter, twilioSmsTools } from "../src/index.js";
import type { TwilioCommand } from "../src/index.js";
import { accountBody, accountDeniedBody, binding, denied, fixture, invocation } from "./fixtures.js";

describe("Twilio reads/auth boundary (fixture fetch only)", () => {
  it("is inert and uses API-key Basic auth, bounded signal and no redirects", async () => {
    const f = fixture(); expect(f.fetch).not.toHaveBeenCalled(); expect(f.credentials.access).not.toHaveBeenCalled();
    const result = await f.adapter.invoke(invocation);
    expect(result).toEqual({ ok: true, value: { operationId: "operation", status: "succeeded", sendReadiness: "unknown", data: { sid: binding.accountSid, status: "active", type: "Trial" } } });
    const [url, options] = f.fetch.mock.calls[0];
    expect(url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${binding.accountSid}.json`);
    expect(options).toMatchObject({ method: "GET", redirect: "error", headers: { Authorization: "Basic " + Buffer.from("SK" + "a".repeat(32) + ":fixture-secret").toString("base64") } });
    expect(options?.signal).toBeInstanceOf(AbortSignal); expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(f.deadlineSignal).toHaveBeenCalledExactlyOnceWith({ timeoutMs: 15000 });
    expect(f.events).toEqual([{ operation: "twilio-sms.account_status", outcome: "succeeded", correlationId: "correlation", traceId: "trace", runId: "run" }]);
  });
  it.each([false, true])("enforces local admission and host denial (%s)", async admitted => {
    const f = fixture({ configuration: { ...binding, admitted }, gateway: { dispatch: vi.fn(async () => denied()) } });
    const result = await f.adapter.invoke(invocation);
    expect(result).toEqual({ ok: false, error: { code: "forbidden", message: "Twilio read forbidden", retryable: false } });
    expect(JSON.stringify({ result, events: f.events })).not.toMatch(/gateway-secret|fixture-secret|15555550100/);
    expect(f.fetch).not.toHaveBeenCalled(); if (!admitted) expect(f.credentials.access).not.toHaveBeenCalled();
  });
  it.each([
    { ...invocation, command: { kind: "send", connectionId: "twilio", to: "+15555550100" } },
    { ...invocation, command: { ...invocation.command, connectionId: "other" } },
    { ...invocation, context: { ...invocation.context, scope: { ...binding.scope, workspaceId: "other" } } },
    { ...invocation, command: { ...invocation.command, apiKeySecret: "injected" } },
  ])("rejects unsupported/foreign/credential-bearing input before broker", async input => {
    const f = fixture(); expect(await f.adapter.invoke(input as typeof invocation)).toMatchObject({ ok: false });
    expect(f.credentials.access).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled();
  });
  it.each([401, 403, 404, 429, 500, 302])("handles HTTP %i without retry or raw errors", async status => {
    const f = fixture({ response: () => new Response("provider-secret", { status }) });
    const result = await f.adapter.invoke(invocation);
    if (status === 401 || status === 403) expect(result).toEqual({ ok: true, value: { operationId: "operation", status: "permission_limited", data: null, sendReadiness: "unknown" } });
    else expect(result).toEqual({ ok: false, error: { code: "unavailable", message: "Twilio read unavailable", retryable: false } });
    expect(JSON.stringify(result)).not.toContain("provider-secret"); expect(f.fetch).toHaveBeenCalledTimes(1);
  });
  it("keeps Accounts 401/20003 ambiguous while sender 401 remains an authentication failure", async () => {
    const f = fixture({ response: () => Response.json(accountDeniedBody, { status: 401 }) });
    const result = await f.adapter.invoke(invocation);
    expect(result).toEqual({ ok: true, value: { operationId: "operation", status: "permission_limited", sendReadiness: "unknown", data: null } });
    expect(JSON.stringify(result)).not.toMatch(/20003|Authentication Error|more_info/);
    expect(f.events).toEqual([{ operation: "twilio-sms.account_status", outcome: "permission_limited", correlationId: "correlation", traceId: "trace", runId: "run" }]);
    const sender = fixture({ response: () => Response.json(accountDeniedBody, { status: 401 }) });
    expect(await sender.adapter.invoke({ ...invocation, command: { kind: "sender_status", connectionId: "twilio", resource: "service" } })).toEqual({ ok: false, error: { code: "unauthenticated", message: "Twilio read unauthenticated", retryable: false } });
    expect(f.fetch).toHaveBeenCalledTimes(1); expect(sender.fetch).toHaveBeenCalledTimes(1);
  });
  it.each(["fetch", "body"])("expires the injected deadline during %s without timers or retries", async phase => {
    const f = fixture();
    f.fetch.mockImplementation(async (_url, options) => {
      const signal = options!.signal!;
      if (phase === "fetch") { f.deadline.abort(); signal.throwIfAborted(); }
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode('{"sid":'));
        signal.addEventListener("abort", () => controller.error(new Error("deadline-secret")), { once: true });
        f.deadline.abort();
      } }));
    });
    const result = await f.adapter.invoke(invocation, { signal: new AbortController().signal });
    expect(result).toEqual({ ok: false, error: { code: "unavailable", message: "Twilio read unavailable", retryable: false } });
    expect(JSON.stringify({ result, events: f.events })).not.toContain("deadline-secret");
    expect(f.fetch).toHaveBeenCalledTimes(1); expect(f.deadlineSignal).toHaveBeenCalledExactlyOnceWith({ timeoutMs: 15000 });
  });
  it.each(["expired", "throws"])("rejects an unavailable host deadline (%s) before fetch", async mode => {
    const expired = fixture(); expired.deadline.abort();
    if (mode === "throws") expired.deadlineSignal.mockImplementationOnce(() => { throw new Error("deadline-secret"); });
    expect(await expired.adapter.invoke(invocation)).toEqual({ ok: false, error: { code: "unavailable", message: "Twilio read unavailable", retryable: false } });
    expect(expired.fetch).not.toHaveBeenCalled();
  });
  it.each(["foreign", "malformed", "denied", "expired", "throws"])("fails closed on %s credentials", async mode => {
    const f = fixture();
    f.credentials.access.mockImplementation(async () => {
      if (mode === "throws") throw new Error("broker-secret");
      if (mode === "denied") return { ok: false, error: { code: "forbidden", message: "broker-secret", retryable: false } };
      return { ok: true, value: { accountSid: mode === "foreign" ? "AC" + "b".repeat(32) : binding.accountSid, apiKeySid: "SK" + "a".repeat(32), apiKeySecret: mode === "malformed" ? "bad\nsecret" : "fixture-secret", expiresAt: mode === "expired" ? 1000 : undefined } };
    });
    const result = await f.adapter.invoke(invocation); expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).not.toContain("secret"); expect(f.fetch).not.toHaveBeenCalled();
  });
  it("rechecks cancellation and guards repeated execute callbacks", async () => {
    const controller = new AbortController();
    const cancelled = fixture({ gateway: { dispatch: async input => { controller.abort(); return input.execute(); } } });
    expect(await cancelled.adapter.invoke(invocation, { signal: controller.signal })).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(cancelled.fetch).not.toHaveBeenCalled();
    const repeated = fixture({ gateway: { dispatch: async input => { await input.execute(); return input.execute(); } } });
    expect(await repeated.adapter.invoke(invocation)).toMatchObject({ ok: false, error: { code: "conflict" } }); expect(repeated.fetch).toHaveBeenCalledTimes(1);
  });
  it.each(["invalid json", "x".repeat(65537), JSON.stringify({ ...accountBody, sid: "AC" + "b".repeat(32) }), JSON.stringify({ ...accountBody, status: null })])("bounds and validates tainted responses", async body => {
    const f = fixture({ response: () => new Response(body) }); expect(await f.adapter.invoke(invocation)).toMatchObject({ ok: false });
  });
  it("maps fetch failures and invalid clock; observer exceptions do not rewrite results", async () => {
    const f = fixture(); f.fetch.mockRejectedValue(new Error("transport-secret"));
    expect(await f.adapter.invoke(invocation)).toMatchObject({ ok: false, error: { code: "unavailable" } });
    const invalid = fixture(); invalid.dependencies.clock.now = () => NaN;
    expect(await invalid.adapter.invoke(invocation)).toMatchObject({ ok: false, error: { code: "invalid_input" } }); expect(invalid.fetch).not.toHaveBeenCalled();
    const observer = fixture(); observer.dependencies.observer.observe = () => { throw new Error("telemetry"); };
    expect(await observer.adapter.invoke(invocation)).toMatchObject({ ok: true });
  });
  it.each([
    ["service", { sid: binding.messagingServiceSid, account_sid: binding.accountSid, use_inbound_webhook_on_number: false, smart_encoding: true }, `/Services/${binding.messagingServiceSid}`],
    ["number", { sid: binding.phoneNumberSid, account_sid: binding.accountSid, service_sid: binding.messagingServiceSid, capabilities: ["SMS", "MMS"] }, `/Services/${binding.messagingServiceSid}/PhoneNumbers/${binding.phoneNumberSid}`],
    ["brand", { sid: "BN" + "a".repeat(32), status: "PENDING" }, "/a2p/BrandRegistrations/BN" + "a".repeat(32)],
    ["campaign", { sid: "QE" + "a".repeat(32), account_sid: binding.accountSid, messaging_service_sid: binding.messagingServiceSid, brand_registration_sid: "BN" + "a".repeat(32), campaign_status: "FAILED" }, `/Services/${binding.messagingServiceSid}/Compliance/Usa2p/QE` + "a".repeat(32)],
    ["toll_free", { sid: "HH" + "a".repeat(32), account_sid: binding.accountSid, tollfree_phone_number_sid: binding.phoneNumberSid, status: "IN_REVIEW" }, "/Tollfree/Verifications/HH" + "a".repeat(32)],
  ] as const)("reads %s without asserting send readiness", async (resource, body, path) => {
    const configuration = resource === "toll_free" ? { ...binding, registration: { kind: "toll_free" as const, verificationSid: "HH" + "a".repeat(32) } } : binding;
    const f = fixture({ configuration, response: () => Response.json({ ...body, secret: "tainted" }) });
    const command: TwilioCommand = { kind: "sender_status", connectionId: binding.connectionId, resource };
    const result = await f.adapter.invoke({ ...invocation, command });
    expect(result).toEqual({ ok: true, value: { operationId: "operation", status: "succeeded", data: body, sendReadiness: "unknown" } });
    expect(JSON.stringify(result)).not.toMatch(/secret|tainted/);
    expect(f.fetch.mock.calls[0][0]).toBe("https://messaging.twilio.com/v1" + path);
    const foreign = fixture({ configuration, response: () => Response.json({ ...body, sid: "AC" + "b".repeat(32) }) });
    expect(await foreign.adapter.invoke({ ...invocation, command })).toMatchObject({ ok: false });
  });
  it("rejects foreign membership and missing registration with zero partial results", async () => {
    const f = fixture({ response: () => Response.json({ sid: binding.phoneNumberSid, account_sid: binding.accountSid, service_sid: "MG" + "b".repeat(32), capabilities: ["SMS"] }) });
    expect(await f.adapter.invoke({ ...invocation, command: { kind: "sender_status", connectionId: "twilio", resource: "number" } })).toMatchObject({ ok: false });
    const unknown = fixture({ configuration: { ...binding, registration: { kind: "unknown" } } });
    expect(await unknown.adapter.invoke({ ...invocation, command: { kind: "sender_status", connectionId: "twilio", resource: "brand" } })).toMatchObject({ ok: false, error: { code: "unavailable" } }); expect(unknown.fetch).not.toHaveBeenCalled(); expect(unknown.credentials.access).not.toHaveBeenCalled();
  });
  it("keeps portable metadata and the typed read catalog aligned", () => {
    const root = new URL("../../", import.meta.url);
    const plugin = JSON.parse(readFileSync(new URL("plugin.json", root), "utf8"));
    expect(plugin.$schema).toBe("https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
    expect(plugin.extensions["io.github.ainsep.openmarketing"]).toMatchObject({ admitted: false, enabled: false });
    expect(JSON.parse(readFileSync(new URL("mcp.json", root), "utf8"))).toEqual({ $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json", mcpServers: {} });
    const capabilities = JSON.parse(readFileSync(new URL("io.github.ainsep.openmarketing/capabilities.json", root), "utf8"));
    expect(capabilities.tools.map((tool: { name: string }) => tool.name)).toEqual(twilioSmsTools.map(tool => tool.name));
    expect(capabilities.capabilities[0].schemaFingerprint).toBe(createHash("sha256").update(readFileSync(new URL("../src/commands.ts", import.meta.url))).digest("hex"));
    expect(twilioSmsTools.every(tool => tool.effect === "read")).toBe(true);
  });
});

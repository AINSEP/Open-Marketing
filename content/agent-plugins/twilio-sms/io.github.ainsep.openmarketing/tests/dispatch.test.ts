import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { pluginConfigurationSchema } from "@open-marketing/contracts";
import type { PluginCapabilityDependencies } from "@open-marketing/contracts";
import { createTools, twilioSmsTools, tools } from "../src/index.js";
import type { TwilioCommand } from "../src/index.js";
import { accountBody, accountDeniedBody, binding, credential, resourceBinding, fixture, invocation } from "./fixtures.js";

describe("Twilio reads/auth boundary (fixture fetch only)", () => {
  it("runs the real standard factory with bound credentials and cleans up its wait", async () => {
    const card = { ...credential, authToken: "factory-auth-token" };
    const f = fixture({ credential: card });
    const wait = vi.fn<PluginCapabilityDependencies["wait"]>(() => new Promise(() => {}));
    const configuration = pluginConfigurationSchema.parse({ scope: binding.scope, connectionId: binding.connectionId,
      accountId: binding.accountId, pluginDigest: binding.pluginDigest, settings: {} });
    const adapter = createTools({ configuration, credentials: f.credentials, fetch: f.fetch,
      clock: f.dependencies.clock, observer: f.dependencies.observer, wait });
    const input = { context: invocation.context, connection: { connectionId: binding.connectionId, accountId: binding.accountId },
      name: twilioSmsTools[0].name, operationId: "operation", input: { kind: "account_status" }, moneyExposure: null, requiredLimit: null };
    expect(f.credentials.access).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled();
    const result = await adapter.invoke(input);
    expect(result).toEqual({ ok: true, value: { operationId: "operation", status: "succeeded", sendReadiness: "unknown",
      data: { sid: binding.accountId, status: "active", type: "Trial" } } });
    expect(f.credentials.access).toHaveBeenCalledExactlyOnceWith({ connectionId: binding.connectionId, accountId: binding.accountId }, undefined);
    expect(f.fetch).toHaveBeenCalledOnce();
    expect(new Headers(f.fetch.mock.calls[0][1]?.headers).get("Authorization"))
      .toBe("Basic " + Buffer.from(card.apiKeySid + ":" + card.apiKeySecret).toString("base64"));
    expect(f.events).toMatchObject([{ outcome: "succeeded", correlationId: "correlation", traceId: "trace", runId: "run" }]);
    const serialized = JSON.stringify({ result, fetchCalls: f.fetch.mock.calls, observations: f.events });
    expect(serialized).not.toContain(JSON.stringify(card));
    expect(serialized).not.toMatch(/fixture-secret|factory-auth-token/);
    expect(serialized).not.toContain("{\\\"");
    expect(tools.map(tool => tool.name)).toEqual(twilioSmsTools.map(tool => tool.name));
    expect(wait).toHaveBeenCalledExactlyOnceWith({ milliseconds: 15000 }, { signal: expect.any(AbortSignal) });
    expect(wait.mock.calls[0][1]?.signal?.aborted).toBe(true);

    f.credentials.access.mockClear(); f.fetch.mockClear();
    for (const connection of [{ ...input.connection, connectionId: "foreign" }, { ...input.connection, accountId: null }, { ...input.connection, accountId: "AC" + "b".repeat(32) }]) {
      expect(await adapter.invoke({ ...input, connection })).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(f.credentials.access).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled();
    }
  });
  it("is inert and uses API-key Basic auth, bounded signal and no redirects", async () => {
    const f = fixture(); expect(f.fetch).not.toHaveBeenCalled(); expect(f.credentials.access).not.toHaveBeenCalled();
    const result = await f.adapter.invoke(invocation);
    expect(result).toEqual({ ok: true, value: { operationId: "operation", status: "succeeded", sendReadiness: "unknown", data: { sid: binding.accountId, status: "active", type: "Trial" } } });
    const [url, options] = f.fetch.mock.calls[0];
    expect(url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${binding.accountId}.json`);
    expect(options).toMatchObject({ method: "GET", redirect: "error", headers: { Authorization: "Basic " + Buffer.from("SK" + "a".repeat(32) + ":fixture-secret").toString("base64") } });
    expect(options?.signal).toBeInstanceOf(AbortSignal); expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(f.deadlineSignal).toHaveBeenCalledExactlyOnceWith({ timeoutMs: 15000 });
    expect(f.events).toEqual([{ operation: "twilio-sms.account_status", outcome: "succeeded", correlationId: "correlation", traceId: "trace", runId: "run" }]);
  });
  it.each(["fixture-auth-token", ""])("accepts optional card fields including a blank webhook authToken (%s)", async authToken => {
    const f = fixture();
    f.credentials.access.mockResolvedValueOnce({ ok: true, value: { accessToken: JSON.stringify({ accountSid: binding.accountId, apiKeySid: "SK" + "a".repeat(32), apiKeySecret: "fixture-secret", authToken, messagingServiceSid: "", phoneNumberSid: "", brandSid: "", campaignSid: "", tollfreeVerificationSid: "" }) } });
    expect(await f.adapter.invoke(invocation)).toMatchObject({ ok: true });
    expect(JSON.stringify(f.fetch.mock.calls)).not.toContain("fixture-auth-token");
  });
  it("enforces broker denial without exposing sensitive denial text", async () => {
    const f = fixture({ configuration: binding });
    f.credentials.access.mockResolvedValueOnce({ ok: false, error: { code: "forbidden", message: "gateway-secret +15555550100 fixture-secret", retryable: true } });
    expect(binding).not.toHaveProperty("admitted");
    const result = await f.adapter.invoke(invocation);
    expect(result).toEqual({ ok: false, error: { code: "forbidden", message: "Twilio read forbidden", retryable: false } });
    expect(JSON.stringify({ result, events: f.events })).not.toMatch(/gateway-secret|fixture-secret|15555550100/);
    expect(f.fetch).not.toHaveBeenCalled(); expect(f.credentials.access).toHaveBeenCalledOnce();
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
    expect(await sender.adapter.invoke({ ...invocation, command: { kind: "sender_status", resource: "service" } })).toEqual({ ok: false, error: { code: "unauthenticated", message: "Twilio read unauthenticated", retryable: false } });
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
  it.each(["foreign", "malformed", "denied", "expired", "throws", "not-json", "pre-decoded"])("fails closed on %s credentials", async mode => {
    const f = fixture();
    f.credentials.access.mockImplementation(async () => {
      if (mode === "throws") throw new Error("broker-secret");
      if (mode === "denied") return { ok: false, error: { code: "forbidden", message: "broker-secret", retryable: false } };
      if (mode === "not-json") return { ok: true, value: { accessToken: "not json fixture-secret" } };
      const card = { accountSid: mode === "foreign" ? "AC" + "b".repeat(32) : binding.accountId, apiKeySid: "SK" + "a".repeat(32), apiKeySecret: mode === "malformed" ? "bad\nsecret" : "fixture-secret" };
      if (mode === "pre-decoded") return { ok: true, value: card as unknown as { accessToken: string } };
      return { ok: true, value: { accessToken: JSON.stringify(card), expiresAt: mode === "expired" ? 1000 : undefined } };
    });
    const result = await f.adapter.invoke(invocation); expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify({ result, events: f.events })).not.toContain("secret"); expect(f.fetch).not.toHaveBeenCalled();
  });
  it("rejects cancellation before invoke without network access", async () => {
    const controller = new AbortController();
    const cancelled = fixture();
    controller.abort();
    expect(await cancelled.adapter.invoke(invocation, { signal: controller.signal })).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(cancelled.fetch).not.toHaveBeenCalled();
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
    ["service", { sid: resourceBinding.messagingServiceSid, account_sid: binding.accountId, use_inbound_webhook_on_number: false, smart_encoding: true }, `/Services/${resourceBinding.messagingServiceSid}`],
    ["number", { sid: resourceBinding.phoneNumberSid, account_sid: binding.accountId, service_sid: resourceBinding.messagingServiceSid, capabilities: ["SMS", "MMS"] }, `/Services/${resourceBinding.messagingServiceSid}/PhoneNumbers/${resourceBinding.phoneNumberSid}`],
    ["brand", { sid: "BN" + "a".repeat(32), status: "PENDING" }, "/a2p/BrandRegistrations/BN" + "a".repeat(32)],
    ["campaign", { sid: "QE" + "a".repeat(32), account_sid: binding.accountId, messaging_service_sid: resourceBinding.messagingServiceSid, brand_registration_sid: "BN" + "a".repeat(32), campaign_status: "FAILED" }, `/Services/${resourceBinding.messagingServiceSid}/Compliance/Usa2p/QE` + "a".repeat(32)],
    ["toll_free", { sid: "HH" + "a".repeat(32), account_sid: binding.accountId, tollfree_phone_number_sid: resourceBinding.phoneNumberSid, status: "IN_REVIEW" }, "/Tollfree/Verifications/HH" + "a".repeat(32)],
  ] as const)("reads %s without asserting send readiness", async (resource, body, path) => {
    const f = fixture({ response: () => Response.json({ ...body, secret: "tainted" }) });
    const command: TwilioCommand = { kind: "sender_status", resource };
    const result = await f.adapter.invoke({ ...invocation, command });
    expect(result).toEqual({ ok: true, value: { operationId: "operation", status: "succeeded", data: body, sendReadiness: "unknown" } });
    expect(JSON.stringify(result)).not.toMatch(/secret|tainted/);
    expect(f.fetch.mock.calls[0][0]).toBe("https://messaging.twilio.com/v1" + path);
    const foreign = fixture({ response: () => Response.json({ ...body, sid: "AC" + "b".repeat(32) }) });
    expect(await foreign.adapter.invoke({ ...invocation, command })).toMatchObject({ ok: false });
  });
  it("rejects foreign membership and missing credential selectors with zero partial results", async () => {
    const f = fixture({ response: () => Response.json({ sid: resourceBinding.phoneNumberSid, account_sid: binding.accountId, service_sid: "MG" + "b".repeat(32), capabilities: ["SMS"] }) });
    expect(await f.adapter.invoke({ ...invocation, command: { kind: "sender_status", resource: "number" } })).toMatchObject({ ok: false });
    const unknown = fixture({ credential: { ...credential, brandSid: "", campaignSid: "", tollfreeVerificationSid: "", authToken: "" } });
    expect(await unknown.adapter.invoke({ ...invocation, command: { kind: "sender_status", resource: "brand" } })).toMatchObject({ ok: false, error: { code: "unavailable" } }); expect(unknown.fetch).not.toHaveBeenCalled(); expect(unknown.credentials.access).toHaveBeenCalledOnce();
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

it("binds the credential account and rejects a second command connection", async () => {
  const foreign = fixture({ credential: { ...credential, accountSid: "AC" + "b".repeat(32) } });
  const result = await foreign.adapter.invoke(invocation);
  expect(result).toMatchObject({ ok: false, error: { code: "forbidden" } });
  expect(foreign.fetch).not.toHaveBeenCalled();
  expect(JSON.stringify({ result, events: foreign.events })).not.toContain("fixture-secret");
  const nested = fixture();
  const input = { ...invocation, command: { ...invocation.command, connectionId: binding.connectionId } };
  expect(await nested.adapter.invoke(input)).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  expect(nested.fetch).not.toHaveBeenCalled(); expect(nested.credentials.access).not.toHaveBeenCalled();
});

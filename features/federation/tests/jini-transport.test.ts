import { describe, expect, it, vi } from "vitest";
import { defaultFederationMessages } from "@jini-ai/mcp/federation";
import { ScriptedMcpHttpExchange, ScriptedMcpStdioChannel } from "@jini-ai/mcp/federation/testing";
import { createJiniHttpMcpTransport, createJiniStdioMcpTransport } from "../index.js";
import type { JiniHttpTransportDependencies, McpTransportPort } from "../index.js";
import { call, context } from "./fixtures/domain.js";
import { latch } from "./fixtures/latch.js";
import { protocolReply } from "./fixtures/protocol.js";

type Reply = ConstructorParameters<typeof ScriptedMcpHttpExchange>[0]["respond"];
const binding = { connectionId: "fixture", credentialReference: "broker-reference", timeoutMs: 2000, clientInfo: { name: "om-fixture", version: "1.0.0" } };

/** Direct transport request; authority is an explicit test-controlled fence. */
function outbound(required: { operationId?: string; query?: string; traceId?: string; isCurrent?: () => boolean } = {}): Parameters<McpTransportPort["invoke"]>[0] {
  return { context: { ...context, traceId: required.traceId ?? context.traceId }, call: call(required),
    credentialReference: "broker-reference", dispatchFence: { isCurrent: required.isCurrent ?? (() => true) } };
}

/** Scripted protocol edge under the published HTTP implementation; raw response variations stay injectable. */
function httpSystem(required: { respond?: Reply; bearerToken?: JiniHttpTransportDependencies["bearerToken"]; timeoutMs?: number } = {}) {
  const exchange = new ScriptedMcpHttpExchange({ respond: required.respond ?? (({ request }) => {
    if (!request.message) return { status: 204 };
    const reply = protocolReply({ request: request.message as Parameters<typeof protocolReply>[0]["request"] });
    return reply === null ? { status: 202 } : { body: reply };
  }) });
  const port = createJiniHttpMcpTransport({ ...binding, timeoutMs: required.timeoutMs ?? binding.timeoutMs, exchange,
    spec: { url: "https://fixture.invalid/mcp", headers: {} }, bearerToken: required.bearerToken ?? (() => undefined) });
  return { exchange, port };
}

describe("Published Jini transport safety and lifecycle", () => {
  it("factory construction is inert and a mismatched broker reference denies before connection", async () => {
    const { exchange, port } = httpSystem({});
    expect(exchange.sent).toHaveLength(0);
    const result = await port.invoke({ ...outbound({}), credentialReference: "foreign-broker" });
    expect(result).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(exchange.sent).toHaveLength(0);
  });

  it("concurrent calls keep independent operation IDs, traces and arguments at actual egress", async () => {
    const { exchange, port } = httpSystem({});
    try {
      const requests = [outbound({ operationId: "first", query: "one", traceId: "trace-one" }), outbound({ operationId: "second", query: "two", traceId: "trace-two" })];
      const results = await Promise.all(requests.map(request => port.invoke(request)));
      expect(results.every(result => result.ok)).toBe(true);
      const sent = exchange.sent.filter(request => request.message?.method === "tools/call");
      expect(sent).toHaveLength(2);
      expect(sent.map(request => request.message?.params)).toEqual(requests.map(request => ({ name: "echo", arguments: request.call.arguments,
        _meta: { "io.github.ainsep.openmarketing": { operationId: request.call.operationId, correlationId: context.correlationId, traceId: request.context.traceId,
          runId: context.runId, argumentsDigest: request.call.argumentsDigest, pluginDigest: request.call.pluginDigest, schemaFingerprint: request.call.schemaFingerprint } } })));
    } finally { await port.dispose({ connectionId: "fixture" }); }
  });

  it("revocation during the final asynchronous HTTP token lookup prevents tools/call", async () => {
    const reached = latch();
    const release = latch();
    let lookups = 0;
    let current = true;
    const { exchange, port } = httpSystem({ bearerToken: async () => {
      lookups += 1;
      if (lookups === 3) { reached.release(); await release.wait(); }
      return "server-only-fixture-token";
    } });
    const result = port.invoke(outbound({ isCurrent: () => current }));
    await reached.wait();
    current = false;
    release.release();
    try {
      expect(await result).toMatchObject({ ok: false, error: { code: "forbidden", retryable: false } });
      expect(exchange.sent.filter(request => request.message?.method === "tools/call")).toHaveLength(0);
    } finally { await port.dispose({ connectionId: "fixture" }); }
  });

  it("dispose fences an opening channel, closes its late result and permits a distinct reconnect", async () => {
    const reached = latch();
    const release = latch();
    const closed = latch();
    const channels: ScriptedMcpStdioChannel[] = [];
    const port = createJiniStdioMcpTransport({ ...binding, openChannel: async () => {
      if (channels.length === 0) { reached.release(); await release.wait(); }
      const channel = new ScriptedMcpStdioChannel({ messages: defaultFederationMessages,
        respond: ({ message }) => protocolReply({ request: message as Parameters<typeof protocolReply>[0]["request"] }) ?? undefined });
      channel.onClose({ listener: () => closed.release() });
      channels.push(channel);
      return channel;
    } });
    const pending = port.invoke(outbound({}));
    await reached.wait();
    expect(await port.dispose({ connectionId: "fixture" })).toEqual({ ok: true, value: undefined });
    release.release();
    try {
      expect((await pending).ok).toBe(false);
      await closed.wait();
      expect(channels[0].sent).toHaveLength(0);
      expect(channels[0].closedReason).not.toBeNull();
      expect((await port.invoke(outbound({ operationId: "next" }))).ok).toBe(true);
      expect(channels[1].sent.filter(frame => frame.method === "tools/call")).toHaveLength(1);
    } finally { await port.dispose({ connectionId: "fixture" }); }
  });

  it("an invalid RPC response ID cannot be mapped to success", async () => {
    const { port } = httpSystem({ respond: ({ request }) => {
      if (request.message?.method === "tools/call") return { body: { jsonrpc: "2.0", id: 9999, result: { content: [{ type: "text", text: "wrong request" }] } } };
      const reply = protocolReply({ request: request.message as Parameters<typeof protocolReply>[0]["request"] });
      return reply === null ? { status: 202 } : { body: reply };
    } });
    try { expect(await port.invoke(outbound({}))).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } }); }
    finally { await port.dispose({ connectionId: "fixture" }); }
  });

  it("retains stalled opens at the hard cap even after dispose until late channels close", async () => {
    const reached = latch();
    const release = latch();
    const closed = latch();
    let openingCount = 0;
    let closeCount = 0;
    const port = createJiniStdioMcpTransport({ ...binding, openChannel: async () => {
      openingCount += 1;
      if (openingCount === 100) reached.release();
      await release.wait();
      const channel = new ScriptedMcpStdioChannel({ messages: defaultFederationMessages, respond: () => undefined });
      channel.onClose({ listener: () => { closeCount += 1; if (closeCount === 100) closed.release(); } });
      return channel;
    } });
    const pending = Array.from({ length: 100 }, (_, index) => port.invoke(outbound({ operationId: `operation-${index}` })));
    await reached.wait();
    try {
      expect(await port.invoke(outbound({ operationId: "overflow" }))).toMatchObject({ ok: false, error: { code: "limit_exceeded" } });
      expect((await port.dispose({ connectionId: "fixture" })).ok).toBe(true);
      expect(await port.invoke(outbound({ operationId: "still-opening" }))).toMatchObject({ ok: false, error: { code: "limit_exceeded" } });
      expect(openingCount).toBe(100);
    } finally { release.release(); await Promise.all(pending); await closed.wait(); await port.dispose({ connectionId: "fixture" }); }
  });

  it("rejects an invalid isError field before Jini can normalize it", async () => {
    const { port } = httpSystem({ respond: ({ request }) => {
      if (request.message?.method === "tools/call") return { body: { jsonrpc: "2.0", id: request.message.id, result: { content: [], isError: "yes" } } };
      const reply = protocolReply({ request: request.message as Parameters<typeof protocolReply>[0]["request"] });
      return reply === null ? { status: 202 } : { body: reply };
    } });
    try { expect(await port.invoke(outbound({}))).toMatchObject({ ok: false, error: { code: "invalid_input" } }); }
    finally { await port.dispose({ connectionId: "fixture" }); }
  });

  it("maps a stalled post-handoff call to unknown without retry", async () => {
    vi.useFakeTimers();
    const reached = latch();
    const { exchange, port } = httpSystem({ timeoutMs: 20, respond: ({ request }) => {
      if (request.message?.method === "tools/call") { reached.release(); return undefined; }
      const reply = protocolReply({ request: request.message as Parameters<typeof protocolReply>[0]["request"] });
      return reply === null ? { status: 202 } : { body: reply };
    } });
    try {
      const pending = port.invoke(outbound({}));
      await reached.wait();
      await vi.advanceTimersByTimeAsync(21);
      expect(await pending).toEqual({ ok: true, value: { operationId: "operation", status: "unknown", content: [] } });
      expect(exchange.sent.filter(request => request.message?.method === "tools/call")).toHaveLength(1);
    } finally { await port.dispose({ connectionId: "fixture" }); vi.useRealTimers(); }
  });

  it("SSE results pass the same raw validation and metadata projection", async () => {
    const { port } = httpSystem({ respond: ({ request }) => {
      const reply = protocolReply({ request: request.message as Parameters<typeof protocolReply>[0]["request"] });
      if (reply === null) return { status: 202 };
      return { contentType: "text/event-stream", body: `data: ${JSON.stringify(reply)}\n\n` };
    } });
    try {
      const result = await port.invoke(outbound({}));
      expect(result.ok).toBe(true);
      expect(JSON.stringify(result)).not.toContain("vendorSecret");
    } finally { await port.dispose({ connectionId: "fixture" }); }
  });
});

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { z } from "zod";
import type { CallOptions, Outcome } from "@open-marketing/contracts";
import type { FederationObserverPort, McpTransportPort } from "../ports.js";
import type { ExternalToolResult } from "../types.js";
import { boundary, failure, success } from "../outcomes.js";
import { parseJson, validateOutbound, validateResult } from "../validation.js";

type Outbound = Parameters<McpTransportPort["invoke"]>[0];
/** Foreign SDK ABI is used only inside this adapter; no SDK types enter the application core. */
export type FederationSdkClient = Pick<Client, "callTool" | "close">;
/**
 * Server composition opens an HTTP/stdio SDK session using current broker reference. It owns
 * fetch/process/configuration and must bound initialization, raw wire bytes and stdio buffers.
 * No client session/configuration/credential is returned to the agent.
 */
export type FederationSdkSessionOpener = {
  open(required: { connectionId: string; credentialReference: string; timeoutMs: number }, optional?: CallOptions): Promise<Outcome<FederationSdkClient>>;
};
type Session = { reference: string; pending: Promise<Outcome<FederationSdkClient>> };
const rawResultSchema = z.object({
  content: z.array(z.object({ type: z.literal("text"), text: z.string().max(262144) })).max(100),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
  isError: z.boolean().optional(),
});

/** MCP metadata is deliberately projected away; only bounded text/validated JSON enter the OM envelope. */
function mapResult(required: { raw: unknown; operationId: string }): Outcome<ExternalToolResult> {
  const parsed = parseJson({ schema: rawResultSchema, input: required.raw, maxBytes: 262144 });
  if (!parsed.ok) return parsed;
  const content: unknown[] = parsed.value.content.map(item => ({ type: "text", text: item.text }));
  if (parsed.value.structuredContent) content.push({ type: "json", data: parsed.value.structuredContent });
  return validateResult({ input: { operationId: required.operationId, status: parsed.value.isError ? "failed" : "succeeded", content }, operationId: required.operationId, maxBytes: 262144, maxContent: 100 });
}

/** Narrow SDK call wrapper: errors after handoff mean unknown, never an automatic retry. */
async function callSdk(required: { client: FederationSdkClient; outbound: Outbound; timeoutMs: number }, optional?: CallOptions): Promise<Outcome<ExternalToolResult>> {
  if (optional?.signal?.aborted) return failure({ code: "cancelled", message: "MCP call cancelled before handoff" });
  if (!required.outbound.dispatchFence?.isCurrent()) return failure({ code: "forbidden", message: "Dispatch fence revoked" });
  const { call, context } = required.outbound;
  const metadata = { operationId: call.operationId, correlationId: context.correlationId, traceId: context.traceId, runId: context.runId, argumentsDigest: call.argumentsDigest, pluginDigest: call.pluginDigest, schemaFingerprint: call.schemaFingerprint };
  try {
    // Foreign SDK signature; initialization/tool execution timeout is absolute (progress cannot extend it).
    const raw = await required.client.callTool({ name: call.toolName.split(".").at(-1)!, arguments: call.arguments, _meta: { "io.github.ainsep.openmarketing": metadata } }, undefined, { timeout: required.timeoutMs, maxTotalTimeout: required.timeoutMs, resetTimeoutOnProgress: false, signal: optional?.signal });
    return mapResult({ raw, operationId: call.operationId });
  } catch (error) {
    if (error instanceof Error && error.name === "ZodError") return failure({ code: "invalid_input", message: "Invalid MCP response" });
    return success({ value: { operationId: call.operationId, status: "unknown", content: [] } });
  }
}

async function closeSession(required: { session: Session }): Promise<Outcome<void>> {
  const opened = await required.session.pending;
  if (!opened.ok) return success({ value: undefined });
  return boundary({ perform: async () => { await opened.value.close(); return success({ value: undefined }); } });
}

/** Lifecycle bookkeeping never retries a tool call; failed opening is evicted for a future distinct operation. */
async function openSession(required: { opener: FederationSdkSessionOpener; connectionId: string; credentialReference: string; timeoutMs: number; sessions: Map<string, Session> }, optional?: CallOptions): Promise<Outcome<Session>> {
  const current = required.sessions.get(required.connectionId);
  if (current?.reference === required.credentialReference) return success({ value: current });
  if (current) {
    required.sessions.delete(required.connectionId);
    const closed = await closeSession({ session: current });
    if (!closed.ok) return closed;
  }
  if (required.sessions.has(required.connectionId)) return failure({ code: "conflict", message: "MCP session changed during credential rotation" });
  if (required.sessions.size >= 100) return failure({ code: "limit_exceeded", message: "MCP session capacity exceeded" });
  const session: Session = { reference: required.credentialReference, pending: boundary({ perform: () => required.opener.open({ connectionId: required.connectionId, credentialReference: required.credentialReference, timeoutMs: required.timeoutMs }, optional) }) };
  required.sessions.set(required.connectionId, session);
  return success({ value: session });
}

function observe(required: { observer?: FederationObserverPort; outbound: Outbound; outcome: string }): void {
  try {
    required.observer?.observe({ operation: "federation.transport.invoke", outcome: required.outcome, correlationId: required.outbound.context.correlationId, traceId: required.outbound.context.traceId, runId: required.outbound.context.runId });
  } catch {
    // Required audit is owned by the host; diagnostics must not change an uncertain dispatch.
  }
}

/**
 * Removable SDK shim implementing the owned transport for injected HTTP or stdio sessions.
 * Construction is inert; open occurs on invocation only. Session disposal fences pending opens.
 * @param required - Server-owned opener and bounded SDK request timeout (1..30000ms).
 * @returns Transport with typed errors; post-handoff SDK failure maps to unknown; never retries.
 * @example createSdkMcpTransport({ opener: httpSessionOpener, timeoutMs: 5000 })
 * @complexity O(n) bounded input/result snapshots; O(1) session lookup; <=100 sessions.
 */
export function createSdkMcpTransport(required: { opener: FederationSdkSessionOpener; timeoutMs: number }, optional?: { observer?: FederationObserverPort }): McpTransportPort {
  const sessions = new Map<string, Session>();
  const validTimeout = Number.isSafeInteger(required.timeoutMs) && required.timeoutMs > 0 && required.timeoutMs <= 30000;
  return {
    async invoke(input, options) {
      if (!validTimeout) return failure({ code: "invalid_input", message: "MCP timeout outside allowed range" });
      if (options?.signal?.aborted) return failure({ code: "cancelled", message: "MCP call cancelled" });
      const outbound = validateOutbound(input);
      if (!outbound.ok) return outbound;
      const call = outbound.value.call;
      const opened = await openSession({ ...required, connectionId: call.connectionId, credentialReference: outbound.value.credentialReference, sessions }, options);
      if (!opened.ok) return opened;
      const client = await opened.value.pending;
      if (!client.ok) {
        if (sessions.get(call.connectionId) === opened.value) sessions.delete(call.connectionId);
        return client;
      }
      if (sessions.get(call.connectionId) !== opened.value) return failure({ code: "conflict", message: "MCP session disposed during opening" });
      const result = await callSdk({ client: client.value, outbound: { ...outbound.value, dispatchFence: input.dispatchFence }, timeoutMs: required.timeoutMs }, options);
      observe({ observer: optional?.observer, outbound: input, outcome: result.ok ? result.value.status : result.error.code });
      return result;
    },
    async dispose(input) {
      const session = sessions.get(input.connectionId);
      sessions.delete(input.connectionId);
      if (!session) return success({ value: undefined });
      return closeSession({ session });
    },
  };
}

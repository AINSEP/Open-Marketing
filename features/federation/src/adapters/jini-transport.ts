import { once } from "node:events";
import { connectMcpHttpSession, defaultFederationMessages } from "@jini-ai/mcp/federation";
import type { McpBearerTokenSupplier, McpClientInfo, McpHttpExchange, McpHttpLaunchSpec, McpSessionPort, McpStdioChannel } from "@jini-ai/mcp/federation";
import { connectMcpStdioSession } from "@jini-ai/mcp/federation/stdio";
import type { CallOptions, Outcome, ObserverPort } from "@open-marketing/contracts";
import type { McpTransportPort } from "../ports.js";
import type { ExternalToolResult } from "../types.js";
import { boundary, failure, success } from "../outcomes.js";
import { validateOutbound } from "../validation.js";
import { mapRemoteResult } from "./remote-result.js";
import { guardHttpExchange, guardStdioChannel, WireRejection } from "./wire.js";
import type { Outbound, WireCall } from "./wire.js";

type Binding = { connectionId: string; credentialReference: string; timeoutMs: number; clientInfo: McpClientInfo };
type Connect = (required: { state: WireCall; signal: AbortSignal }) => Promise<McpSessionPort>;
type ActiveCall = { controller: AbortController; session?: McpSessionPort; openingSettled: boolean };

/** Injected server-only HTTP I/O and current broker token supplier. No URL/headers leave this adapter. */
export type JiniHttpTransportDependencies = Binding & { exchange: McpHttpExchange; spec: McpHttpLaunchSpec; bearerToken: McpBearerTokenSupplier };
/** Composition creates a bounded process channel using the broker reference and forwards cancellation. */
export type JiniStdioTransportDependencies = Binding & {
  openChannel: (required: { connectionId: string; credentialReference: string }, optional?: CallOptions) => Promise<McpStdioChannel>;
};

/** Inert HTTP transport using Jini 0.4.3's handshake, auth, timeout and protocol client.
 * @param required - Fixed server connection binding and injected, guarded/bounded exchange.
 * @returns OM transport; failed preflight denies, post-handoff failures are unknown, never retried.
 * @example createJiniHttpMcpTransport({ connectionId, credentialReference, timeoutMs: 5000, clientInfo, exchange, spec, bearerToken })
 * @complexity O(n) bounded wire/result work, <=100 active sessions per instance.
 * @tradeoffs A fresh session per call isolates metadata and credentials; two handshake exchanges per call.
 */
export function createJiniHttpMcpTransport(required: JiniHttpTransportDependencies, optional?: { observer?: ObserverPort }): McpTransportPort {
  const connect: Connect = async input => connectMcpHttpSession({
    exchange: guardHttpExchange({ exchange: required.exchange, state: input.state }),
    spec: required.spec, bearerToken: required.bearerToken, clientInfo: required.clientInfo,
    requestTimeoutMs: required.timeoutMs, messages: defaultFederationMessages,
  });
  return createTransport({ binding: required, connect, observer: optional?.observer });
}

/** Inert stdio transport using Jini's protocol client on an injected channel; never spawns a process.
 * @param required - Server connection binding and cancellation-aware, bounded channel factory.
 * @returns OM transport with the same denial/uncertainty/lifecycle contract as HTTP.
 * @example createJiniStdioMcpTransport({ connectionId, credentialReference, timeoutMs: 5000, clientInfo, openChannel })
 * @complexity O(n) bounded wire/result work, <=100 active sessions per instance.
 * @tradeoffs Each operation owns a child/session; composition chooses process isolation and cleanup.
 */
export function createJiniStdioMcpTransport(required: JiniStdioTransportDependencies, optional?: { observer?: ObserverPort }): McpTransportPort {
  const connect: Connect = async input => {
    const channel = await required.openChannel({ connectionId: required.connectionId, credentialReference: required.credentialReference }, { signal: input.signal });
    if (input.signal.aborted) { channel.close({}); throw new WireRejection({ code: "cancelled" }); }
    return connectMcpStdioSession({ channel: guardStdioChannel({ channel, state: input.state }),
      requestTimeoutMs: required.timeoutMs, clientInfo: required.clientInfo, messages: defaultFederationMessages });
  };
  return createTransport({ binding: required, connect, observer: optional?.observer });
}

/** Bound total open+call time even when an injected callback ignores cancellation; close late sessions.
 * @throws WireRejection on cancellation; caller owns cleanup. @complexity O(1) wait bookkeeping.
 */
async function waitForSession(required: { connect: Connect; state: WireCall; active: ActiveCall; signal: AbortSignal; calls: Set<ActiveCall> }): Promise<McpSessionPort> {
  const opening = required.connect({ state: required.state, signal: required.signal }).then(async session => {
    required.active.openingSettled = true;
    if (required.signal.aborted) { await session.close({}); required.calls.delete(required.active); throw new WireRejection({ code: "cancelled" }); }
    required.active.session = session;
    return session;
  }).catch(error => { required.active.openingSettled = true; required.calls.delete(required.active); throw error; });
  return waitWithinCall({ pending: opening, signal: required.signal });
}

/** Bound non-cooperative I/O promises; removing the losing abort listener prevents retained sessions. */
async function waitWithinCall<T>(required: { pending: Promise<T>; signal: AbortSignal }): Promise<T> {
  if (required.signal.aborted) {
    void required.pending.catch(() => undefined);
    throw new WireRejection({ code: "cancelled" });
  }
  const waiting = new AbortController();
  const aborted = once(required.signal, "abort", { signal: waiting.signal }).then(() => { throw new WireRejection({ code: "cancelled" }); });
  try { return await Promise.race([required.pending, aborted]); }
  finally { waiting.abort(); }
}

/** Invoke once; a validated negative result stays failed, an unobserved outcome stays unknown.
 * @complexity O(n) result projection plus one external call. No retries or reconnect within a call.
 */
async function executeCall(required: { connect: Connect; state: WireCall; active: ActiveCall; calls: Set<ActiveCall> }): Promise<Outcome<ExternalToolResult>> {
  try {
    const session = await waitForSession({ ...required, signal: required.active.controller.signal });
    if (!required.state.isCurrent()) return failure({ code: "forbidden", message: "Dispatch fence revoked" });
    const call = required.state.outbound.call;
    const raw = await waitWithinCall({ pending: session.callTool({ name: call.toolName.split(".").at(-1)!, arguments: { ...call.arguments } }, { signal: required.active.controller.signal }), signal: required.active.controller.signal });
    if (required.state.rejection) return required.state.rejection;
    return mapRemoteResult({ raw, operationId: call.operationId });
  } catch (error) {
    return failedExecution({ state: required.state, error });
  }
}

/** A cancellation after handoff cannot prove the remote did nothing; local validation denials can. */
function failedExecution(required: { state: WireCall; error: unknown }): Outcome<ExternalToolResult> {
  if (required.state.rejection) return required.state.rejection;
  if (required.error instanceof WireRejection) {
    const uncertain = required.error.code === "cancelled" && required.state.handedOff;
    if (!uncertain) return failure({ code: required.error.code, message: "Federation transport denied" });
  }
  if (!required.state.handedOff) return failure({ code: "unavailable", message: "MCP session unavailable" });
  return success({ value: { operationId: required.state.outbound.call.operationId, status: "unknown", content: [] } });
}

/** Validate binding before any connection effect; malformed adapter configuration is an explicit error. */
function checkBinding(required: { binding: Binding; input: Outbound }): Outcome<void> {
  const timeout = required.binding.timeoutMs;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30000) return failure({ code: "invalid_input", message: "MCP timeout outside allowed range" });
  if (required.input?.call?.connectionId !== required.binding.connectionId || required.input?.credentialReference !== required.binding.credentialReference) return failure({ code: "forbidden", message: "MCP connection or broker binding mismatch" });
  if (typeof required.input.dispatchFence?.isCurrent !== "function") return failure({ code: "forbidden", message: "Dispatch fence missing" });
  return success({ value: undefined });
}

/** Redacted diagnostics are best effort; durable host audit remains required. */
function observe(required: { observer?: ObserverPort; outbound: Outbound; result: Outcome<ExternalToolResult> }): void {
  try { required.observer?.observe({ operation: "federation.transport.invoke", outcome: required.result.ok ? required.result.value.status : required.result.error.code,
    correlationId: required.outbound.context.correlationId, traceId: required.outbound.context.traceId, runId: required.outbound.context.runId }); }
  catch { /* Diagnostics cannot change a dispatched outcome. */ }
}

/** Per-instance lifecycle; dispose increments the epoch before awaiting close and cancels pending opens.
 * @complexity O(n) input/result copies; O(c) disposal, c<=100. Retain stalled opens until they settle.
 */
function createTransport(required: { binding: Binding; connect: Connect; observer?: ObserverPort }): McpTransportPort {
  const calls = new Set<ActiveCall>();
  let revision = 0;
  return {
    async invoke(input, options) {
      const binding = checkBinding({ binding: required.binding, input });
      if (!binding.ok) return binding;
      if (options?.signal?.aborted) return failure({ code: "cancelled", message: "MCP invocation cancelled" });
      const parsed = validateOutbound(input);
      if (!parsed.ok) return parsed;
      if (calls.size >= 100) return failure({ code: "limit_exceeded", message: "MCP active call limit exceeded" });
      const epoch = revision;
      const active: ActiveCall = { controller: new AbortController(), openingSettled: false };
      const outbound = { ...parsed.value, dispatchFence: input.dispatchFence };
      const state: WireCall = { outbound, handedOff: false, toolRequest: false,
        isCurrent: () => epoch === revision && !active.controller.signal.aborted && outbound.dispatchFence.isCurrent() };
      return invokeActive({ ...required, active, state, calls }, options);
    },
    async dispose(input) {
      if (input.connectionId !== required.binding.connectionId) return success({ value: undefined });
      revision += 1;
      const results = await Promise.all([...calls].map(active => closeActive({ active })));
      return results.find(result => !result.ok) ?? success({ value: undefined });
    },
  };
}

/** Absolute invocation deadline; caller abort listener and timer are always removed.
 * @complexity O(1) lifecycle plus the bounded execution; session close is handled by Jini's deadline.
 */
async function invokeActive(required: { active: ActiveCall; state: WireCall; calls: Set<ActiveCall>; connect: Connect; binding: Binding; observer?: ObserverPort }, optional?: CallOptions): Promise<Outcome<ExternalToolResult>> {
  const cancel = () => required.active.controller.abort();
  optional?.signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(cancel, required.binding.timeoutMs);
  required.calls.add(required.active);
  try {
    const result = await executeCall(required);
    observe({ observer: required.observer, outbound: required.state.outbound, result });
    return result;
  } finally {
    clearTimeout(timer);
    optional?.signal?.removeEventListener("abort", cancel);
    await closeActive(required);
    if (required.active.openingSettled) required.calls.delete(required.active);
  }
}

/** Abort before closing; sessions that finish opening later are closed by waitForSession. */
async function closeActive(required: { active: ActiveCall }): Promise<Outcome<void>> {
  required.active.controller.abort();
  if (!required.active.session) return success({ value: undefined });
  return boundary({ perform: async () => { await required.active.session!.close({}); return success({ value: undefined }); } });
}

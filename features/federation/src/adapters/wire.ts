import { z } from "zod";
import type { AppError, Outcome } from "@open-marketing/contracts";
import type { McpHttpExchange, McpStdioChannel } from "@jini-ai/mcp/federation";
import type { McpTransportPort } from "../ports.js";
import { failure, success } from "../outcomes.js";
import { parseJson } from "../validation.js";
import { parseRemoteResult } from "./remote-result.js";

export type Outbound = Parameters<McpTransportPort["invoke"]>[0];
/** One invocation owns this state and its session; metadata cannot cross concurrent calls. */
export type WireCall = {
  outbound: Outbound;
  isCurrent: () => boolean;
  handedOff: boolean;
  requestId?: number;
  toolRequest: boolean;
  rejection?: Outcome<never>;
};
const requestSchema = z.object({ jsonrpc: z.literal("2.0"), id: z.number().int().optional(), method: z.string(), params: z.record(z.string(), z.unknown()).optional() });
const replySchema = z.object({ jsonrpc: z.literal("2.0"), id: z.number().int(), result: z.unknown().optional(), error: z.object({ code: z.number().int(), message: z.string().max(4096) }).optional() });
const initializeSchema = z.object({ protocolVersion: z.string().min(1).max(64), capabilities: z.record(z.string(), z.unknown()), serverInfo: z.object({ name: z.string().min(1).max(256), version: z.string().min(1).max(256) }) });

/** Typed internal exception translated at the owned transport boundary; never exposes wire text. */
export class WireRejection extends Error {
  readonly code: AppError["code"];
  constructor(required: { code: AppError["code"] }) { super("Federation wire rejected"); this.code = required.code; }
}

/** Refuse stale authority at the actual send, including after HTTP credential lookup. */
function assertCurrent(required: { state: WireCall; signal?: AbortSignal }): void {
  if (required.signal?.aborted) throw new WireRejection({ code: "cancelled" });
  if (!required.state.isCurrent()) throw new WireRejection({ code: "forbidden" });
}

/** Add only OM metadata to a Jini-generated tools/call; arguments stay byte-equivalent JSON.
 * @throws WireRejection before egress on a changed payload or revoked fence.
 * @complexity O(n log n) bounded JSON; no protocol or admission logic is reimplemented.
 */
export function prepareWireMessage(required: { message: string; state: WireCall; signal?: AbortSignal }): string {
  const parsed = parseJson({ schema: requestSchema, input: JSON.parse(required.message), maxBytes: 75000 });
  if (!parsed.ok) throw new WireRejection({ code: parsed.error.code });
  const frame = parsed.value;
  assertCurrent(required);
  if (frame.id !== undefined) required.state.requestId = frame.id;
  if (frame.method !== "tools/call") return required.message;
  const { call, context } = required.state.outbound;
  const params = frame.params;
  if (params?.name !== call.toolName.split(".").at(-1) || JSON.stringify(params?.arguments) !== JSON.stringify(call.arguments)) throw new WireRejection({ code: "forbidden" });
  required.state.requestId = frame.id;
  required.state.toolRequest = true;
  const metadata = { operationId: call.operationId, correlationId: context.correlationId, traceId: context.traceId,
    ...(context.runId === undefined ? {} : { runId: context.runId }), argumentsDigest: call.argumentsDigest,
    pluginDigest: call.pluginDigest, schemaFingerprint: call.schemaFingerprint };
  return JSON.stringify({ ...frame, params: { ...params, _meta: { "io.github.ainsep.openmarketing": metadata } } });
}

/** Validate correlation and raw result before Jini normalizes it; metadata is bounded and stripped.
 * @returns Redacted rejection; RPC errors remain uncertainty, never trigger replay. @complexity O(n), bounded.
 */
export function checkWireReply(required: { message: string; state: WireCall }): Outcome<void> {
  if (Buffer.byteLength(required.message, "utf8") > 300000) return failure({ code: "limit_exceeded", message: "MCP wire limit exceeded" });
  try {
    const parsed = parseJson({ schema: replySchema, input: JSON.parse(required.message), maxBytes: 300000 });
    if (!parsed.ok) return parsed;
    if (parsed.value.id !== required.state.requestId) return failure({ code: "protocol_mismatch", message: "MCP response ID mismatch" });
    const hasResult = Object.hasOwn(parsed.value, "result");
    if (hasResult === (parsed.value.error !== undefined)) return failure({ code: "protocol_mismatch", message: "MCP response envelope invalid" });
    if (parsed.value.error !== undefined) return success({ value: undefined });
    const result = checkRpcResult({ input: parsed.value.result, toolRequest: required.state.toolRequest });
    if (!result.ok) return result;
    return success({ value: undefined });
  } catch { return failure({ code: "invalid_input", message: "MCP response is not JSON" }); }
}

/** Validate initialize as well as tools/call; the advertised server identity never grants authority. */
function checkRpcResult(required: { input: unknown; toolRequest: boolean }): Outcome<unknown> {
  if (required.toolRequest) return parseRemoteResult({ input: required.input });
  return parseJson({ schema: initializeSchema, input: required.input, maxBytes: 65536 });
}

/** Jini consumes the first SSE data event; guard those same bytes before passing them through.
 * @complexity O(n) bounded response. No stream is opened by this wrapper.
 */
function responseMessage(required: { text: string; contentType: string }): string {
  if (!required.contentType.startsWith("text/event-stream")) return required.text;
  const event = required.text.split(/\r\n\r\n|\n\n|\r\r/, 1)[0];
  return event.split(/\r\n|\r|\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).replace(/^ /, "")).join("\n");
}

/** Injected exchange wrapper probes authority after Jini's asynchronous bearer supplier and before send.
 * @returns Jini exchange; errors are translated by transport. @complexity O(n) bounded wire copying.
 */
export function guardHttpExchange(required: { exchange: McpHttpExchange; state: WireCall }): McpHttpExchange {
  return { async send(request, options) {
    if (request.method !== "POST" || options?.body === undefined) return required.exchange.send(request, options);
    const body = prepareGuardedMessage({ message: options.body, state: required.state, signal: options.signal });
    if (required.state.toolRequest) required.state.handedOff = true;
    const response = await required.exchange.send(request, { ...options, body });
    if (!Object.hasOwn(JSON.parse(body), "id") || response.status < 200 || response.status >= 300) return response;
    if (Buffer.byteLength(response.text, "utf8") > 300000) {
      required.state.rejection = failure({ code: "limit_exceeded", message: "MCP wire limit exceeded" });
      throw new WireRejection({ code: "limit_exceeded" });
    }
    const checked = checkWireReply({ message: responseMessage(response), state: required.state });
    if (!checked.ok) {
      required.state.rejection = checked;
      throw new WireRejection({ code: checked.error.code });
    }
    return response;
  } };
}

/** Bad stdio results are settled through Jini's normal error path, not thrown out of a stream listener.
 * @returns Guarded channel; no process is constructed here. @complexity O(n) bounded message parsing.
 */
export function guardStdioChannel(required: { channel: McpStdioChannel; state: WireCall }): McpStdioChannel {
  return {
    send(input) {
      // Jini also sends method-not-found response frames to server requests; only wrap request frames.
      const frame = JSON.parse(input.message) as { method?: string };
      if (frame.method === undefined) { required.channel.send(input); return; }
      const message = prepareGuardedMessage({ message: input.message, state: required.state });
      if (frame.method === "tools/call") required.state.handedOff = true;
      required.channel.send({ message });
    },
    onMessage(input) { required.channel.onMessage({ listener: message => input.listener(guardStdioReply({ ...required, message: message.message })) }); },
    onClose(input) { required.channel.onClose(input); },
    close(input) { required.channel.close(input); },
  };
}

/** Preserve typed local denial even when Jini wraps an exchange exception as a protocol error. */
function prepareGuardedMessage(required: { message: string; state: WireCall; signal?: AbortSignal }): string {
  try { return prepareWireMessage(required); }
  catch (error) {
    if (error instanceof WireRejection) required.state.rejection = failure({ code: error.code, message: "MCP dispatch denied" });
    throw error;
  }
}

/** Preserve unsolicited server requests for Jini's explicit refusal; fail malformed call replies closed. */
function guardStdioReply(required: { state: WireCall; message: string }): { message: string } {
  if (required.state.requestId === undefined) return { message: required.message };
  const parsed = readMethod({ message: required.message });
  if (parsed.hasMethod) return { message: required.message };
  const checked = checkWireReply(required);
  if (checked.ok) return { message: required.message };
  required.state.rejection = checked;
  return { message: JSON.stringify({ jsonrpc: "2.0", id: required.state.requestId, error: { code: -32603, message: "OM rejected MCP result" } }) };
}

/** Bounded lookahead distinguishes a server request from a reply, without trusting either. */
function readMethod(required: { message: string }): { hasMethod: boolean } {
  if (required.message.length > 300000) return { hasMethod: false };
  try { return { hasMethod: typeof (JSON.parse(required.message) as { method?: unknown })?.method === "string" }; }
  catch { return { hasMethod: false }; }
}

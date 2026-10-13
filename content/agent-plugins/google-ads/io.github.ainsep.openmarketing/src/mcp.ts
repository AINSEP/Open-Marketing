import type { CallContext, Outcome } from "@open-marketing/contracts";
import type { Readable, Writable } from "node:stream";
import { contextSchema, resultSchemas, toolSchemas } from "./schemas.ts";
import { asRecord } from "./readback.ts";
import { failure, object, parse, protect, success, text } from "./schema.ts";
import type { GooglePlugin } from "./plugin.ts";
import type { ToolName } from "./types.ts";

const MAX_FRAME = 262144;
type RpcId = string | number | null;
type RpcResult = { jsonrpc: "2.0"; id: RpcId; result?: unknown; error?: { code: number; message: string } };
/** Read hints are metadata only; admission and authority always remain server-owned. */
export function tools(required: Record<string, never>): unknown[] {
  return Object.entries(toolSchemas).map(([name, inputSchema]) => ({ name, description: descriptions[name as ToolName], inputSchema, annotations: { readOnlyHint: ["list_accounts", "read_campaign", "read_budget", "report", "reconcile"].includes(name), openWorldHint: true } }));
}
const descriptions: Record<ToolName, string> = {
  list_accounts: "Read the one host-scoped Google account; never enumerates foreign accounts.",
  read_campaign: "Read the complete bounded Search hierarchy and status.", read_budget: "Read a non-shared average daily budget; it is not a hard daily cap.",
  report: "Read account-local served cost, clicks and impressions for at most 31 days.",
  create_paused: "Create one bounded Search hierarchy with all serving entities PAUSED.",
  activate: "Activate the exact reviewed controlled plan; requires current exact spend authority.",
  set_budget: "Change one average daily budget under a new exact spend approval.",
  pause: "Pause the specified controlled Search hierarchy with normal write authority.",
  reconcile: "Read back an uncertain operation; never blindly retries it.",
};
/** Removable MCP stdio shim. Per-session initialization and host-owned context; no global
 * registry. Implements initialize, ping, tools/list and tools/call only.
 * @example createMcpSession({ plugin, context }).handle({ input: jsonRpcRequest }) */
export function createMcpSession(required: { plugin: GooglePlugin; context: CallContext }): { handle(input: { input: unknown }): Promise<RpcResult | null> } {
  let initialized = false;
  return { async handle(input) {
    const request = asRecord({ value: input.input });
    const requestId = rpcId({ value: request.id });
    if (request.jsonrpc !== "2.0" || typeof request.method !== "string") return rpcError({ id: requestId, code: -32600, message: "Invalid JSON-RPC request" });
    if (request.method === "notifications/initialized") { if (initialized) return null; return rpcError({ id: requestId, code: -32600, message: "Initialize first" }); }
    if (request.method === "initialize") {
      const params = asRecord({ value: request.params });
      if (!["2025-11-25", "2025-06-18", "2024-11-05"].includes(String(params.protocolVersion))) return rpcError({ id: requestId, code: -32602, message: "Unsupported MCP protocol" });
      initialized = true;
      return { jsonrpc: "2.0", id: requestId, result: { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "om-google-ads", version: "0.1.0" } } };
    }
    if (!initialized) return rpcError({ id: requestId, code: -32600, message: "Initialize first" });
    return handleMethod({ request, id: requestId, ...required });
  } };
}
function rpcId(required: { value: unknown }): RpcId {
  if (typeof required.value === "string" && required.value.length <= 256) return required.value;
  if (typeof required.value === "number" && Number.isSafeInteger(required.value)) return required.value;
  return null;
}
function rpcError(required: { id: RpcId; code: number; message: string }): RpcResult { return { jsonrpc: "2.0", id: required.id, error: { code: required.code, message: required.message } }; }
async function handleMethod(required: { request: Record<string, unknown>; id: RpcId; plugin: GooglePlugin; context: CallContext }): Promise<RpcResult> {
  const { request, id } = required;
  if (request.method === "ping") return { jsonrpc: "2.0", id, result: {} };
  if (request.method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: tools({}) } };
  if (request.method !== "tools/call") return rpcError({ id, code: -32601, message: "Method unavailable" });
  const params = asRecord({ value: request.params });
  if (Object.keys(params).some(key => !["name", "arguments", "_meta"].includes(key))) return rpcError({ id, code: -32602, message: "Invalid tool parameters" });
  if (typeof params.name !== "string") return rpcError({ id, code: -32602, message: "Tool name required" });
  const outcome = await required.plugin.invoke({ context: required.context, name: params.name, arguments: params.arguments ?? {} });
  return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(outcome) }], isError: !outcome.ok } };
}
/** Bounded newline-delimited stdio, one in-flight operation. Foreign stream ABI is kept
 * at this boundary. stdout receives protocol frames only; EOF disposes the session.
 * @complexity O(b), buffered frame <=256KiB, serialized request dispatch. */
export async function serveStdio(required: { stdin: Readable; stdout: Writable; session: ReturnType<typeof createMcpSession> }): Promise<Outcome<void>> {
  let pending: Buffer = Buffer.alloc(0);
  for await (const chunk of required.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (pending.length + bytes.length > MAX_FRAME) return failure({ code: "limit_exceeded", message: "MCP input frame exceeds bound" });
    pending = Buffer.concat([pending, bytes]);
    pending = await drainFrames({ pending, ...required });
  }
  if (pending.length) return failure({ code: "invalid_input", message: "Incomplete MCP frame" });
  return success({ value: undefined });
}
async function drainFrames(required: { pending: Buffer; stdout: Writable; session: ReturnType<typeof createMcpSession> }): Promise<Buffer> {
  let pending = required.pending;
  while (pending.includes(10)) {
    const index = pending.indexOf(10);
    const line = pending.subarray(0, index).toString("utf8");
    pending = pending.subarray(index + 1);
    if (!line.trim()) continue;
    const request = parseJson({ line });
    const response = request.ok ? await required.session.handle({ input: request.value }) : rpcError({ id: null, code: -32700, message: "Invalid JSON" });
    if (response) await writeFrame({ stdout: required.stdout, response });
  }
  return pending;
}
function parseJson(required: { line: string }): Outcome<unknown> {
  try { return success({ value: JSON.parse(required.line) as unknown }); }
  catch { return failure({ code: "invalid_input", message: "Invalid JSON" }); }
}
async function writeFrame(required: { stdout: Writable; response: RpcResult }): Promise<void> {
  const frame = JSON.stringify(required.response) + "\n";
  if (Buffer.byteLength(frame) > MAX_FRAME) { required.stdout.write(JSON.stringify(rpcError({ id: required.response.id, code: -32603, message: "MCP output frame exceeds bound" })) + "\n"); return; }
  await new Promise<void>((resolve, reject) => required.stdout.write(frame, error => { if (error) reject(error); else resolve(); }));
}
/** Real local MCP adapter uses the exact same capability seam as the in-memory plugin.
 * A host injects its private stdio client; no vendor credential crosses this port. */
export interface LocalMcpPort { call(required: { name: string; arguments: unknown }): Promise<Outcome<unknown>> }
export function createLocalMcpAdapter(required: { client: LocalMcpPort; context: CallContext }): Pick<GooglePlugin, "invoke"> {
  return { invoke: input => protect({ work: () => localInvoke({ ...required, input }) }) };
}
async function localInvoke(required: { client: LocalMcpPort; context: CallContext; input: Parameters<GooglePlugin["invoke"]>[0] }): Promise<Outcome<unknown>> {
    const { input } = required;
    const context = parse<CallContext>({ schema: contextSchema, input: input.context });
    if (!context.ok) return context;
    if (context.value.scope.ownerId !== required.context.scope.ownerId || context.value.scope.workspaceId !== required.context.scope.workspaceId) return failure({ code: "forbidden", message: "Local MCP adapter scope mismatch" });
    if (!Object.hasOwn(toolSchemas, input.name)) return failure({ code: "unavailable", message: "Tool unavailable" });
    const args = parse({ schema: toolSchemas[input.name as ToolName], input: input.arguments });
    if (!args.ok) return args;
    const response = await required.client.call({ name: input.name, arguments: input.arguments });
    if (!response.ok) return response;
    return decodeLocalResult({ value: response.value, name: input.name as ToolName });
}
function decodeLocalResult(required: { value: unknown; name: ToolName }): Outcome<unknown> {
    const body = asRecord({ value: required.value });
    const content = body.content;
    if (!Array.isArray(content) || content.length !== 1) return failure({ code: "invalid_input", message: "Invalid local MCP result" });
    const block = asRecord({ value: content[0] });
    if (block.type !== "text" || typeof block.text !== "string" || block.text.length > MAX_FRAME) return failure({ code: "invalid_input", message: "Invalid local MCP content" });
    const decoded = parseJson({ line: block.text });
    if (!decoded.ok) return decoded;
    const outcome = parseOutcome({ value: decoded.value });
    if (!outcome.ok) return outcome;
    return parse({ schema: resultSchemas[required.name], input: outcome.value });
}
function parseOutcome(required: { value: unknown }): Outcome<unknown> {
  const body = asRecord({ value: required.value });
  if (body.ok === true && Object.keys(body).length === 2 && Object.hasOwn(body, "value")) return success({ value: body.value });
  const errorSchema = object({ properties: { code: { type: "string", enum: ["not_implemented", "invalid_input", "unauthenticated", "forbidden", "unavailable", "conflict", "cancelled", "expired", "protocol_mismatch", "limit_exceeded"] }, message: { ...text, maxLength: 1024 }, retryable: { type: "boolean" } } });
  const checked = parse<Extract<Outcome<unknown>, { ok: false }>["error"]>({ schema: errorSchema, input: body.error });
  if (body.ok !== false || Object.keys(body).length !== 2 || !checked.ok) return failure({ code: "invalid_input", message: "Invalid local MCP outcome" });
  return { ok: false, error: checked.value };
}

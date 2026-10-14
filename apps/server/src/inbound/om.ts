import { z } from 'zod';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { mcpRequestSchema, parseBoundary, notImplemented, runEventSchema, idSchema, toolCallSchema, toolSearchSchema } from "@open-marketing/contracts";
import type { Outcome, RunGrantMetadata, ClockPort, RunEvent, AssistantContext } from "@open-marketing/contracts";
import type { CallContext } from '@open-marketing/contracts';
import { discoveryTools } from '../om-tools.js';
import type { OmTools } from '../om-tools.js';
import type { HttpRequest, HttpResponse } from "../ports.js";
export interface RunGrantVerifierPort { verify(required: { authorization: string | undefined }): Promise<Outcome<RunGrantMetadata>> }
/** Fixed local sandbox callbacks. Grant verification and exact route binding precede these effects. */
export interface SandboxCallbacks {
 context(required: { grant: RunGrantMetadata }): Promise<Outcome<AssistantContext | { mode: 'local-sandbox' }>>;
 record(required: { grant: RunGrantMetadata; event: RunEvent }): Promise<Outcome<{ recorded: true }>>;
}
/** Scope comes only from server-verified run grants. No body can widen authority or answer cards. */
export async function handleOmRequest(required: { request: HttpRequest; grants: RunGrantVerifierPort; clock: ClockPort; callbacks?: SandboxCallbacks; tools?: OmTools }): Promise<HttpResponse> {
 const grant = await required.grants.verify({ authorization: required.request.authorization });
 if (!grant.ok) return { status: 401, body: grant };
 const metadata = grant.value;
 if (metadata.revoked || metadata.expiresAt <= required.clock.now({})) return { status: 403, body: { ok: false, error: { code: "expired", message: "Run authority unavailable", retryable: false } } };
 if (required.tools && metadata.capabilities.includes('tools')) return toolRequest({ ...required, tools: required.tools, grant: metadata });
 if (required.callbacks) return sandboxRequest({ ...required, callbacks: required.callbacks, grant: metadata });
 if (required.request.path !== "/api/agent/v1/mcp") return { status: 403, body: { ok: false, error: { code: "forbidden", message: "OM route unavailable", retryable: false } } };
 const parsed = parseBoundary({ schema: mcpRequestSchema, input: required.request.body });
 if (!parsed.ok) return { status: 400, body: parsed };
 return { status: 501, body: notImplemented({ operation: "server.om.mcp" }) };
}

/** Identity is derived from the run bearer. Header tracing cannot widen scope or principal. */
function toolContext(required: { grant: RunGrantMetadata; request: HttpRequest }): CallContext {
 const correlation = idSchema.safeParse(required.request.headers?.['x-correlation-id']);
 const trace = idSchema.safeParse(required.request.headers?.['x-trace-id']);
 return { scope: required.grant.scope, runId: required.grant.runId,
  principal: { kind: 'agent', runId: required.grant.runId, agentInstanceId: required.grant.agentInstanceId },
  correlationId: correlation.success ? correlation.data : required.grant.grantId, traceId: trace.success ? trace.data : required.grant.grantId };
}
async function toolRequest(required: { request: HttpRequest; tools: OmTools; grant: RunGrantMetadata; callbacks?: SandboxCallbacks }): Promise<HttpResponse> {
 const context = toolContext(required);
 if (required.request.path === '/api/agent/v1/mcp' && required.request.method === 'POST') return mcpRequest({ ...required, context });
 const prefix = '/api/agent/v1/runs/' + encodeURIComponent(required.grant.runId) + '/operations/';
 if (required.request.method === 'GET' && required.request.path.startsWith(prefix)) return operationRequest({ ...required, context, prefix });
 if (required.callbacks) return sandboxRequest({ ...required, callbacks: required.callbacks });
 return { status: 403, body: notImplemented({ operation: 'server.om.route' }) };
}
async function operationRequest(required: { request: HttpRequest; tools: OmTools; context: CallContext; prefix: string }): Promise<HttpResponse> {
 const suffix = required.request.path.slice(required.prefix.length);
 const match = /^([^/]+)(\/card)?$/.exec(suffix);
 if (!match) return { status: 400, body: notImplemented({ operation: 'server.om.operation' }) };
 const parsed = operationId({ segment: match[1] });
 if (!parsed.ok) return { status: 400, body: parsed };
 const input = { context: required.context, operationId: parsed.value };
 const result = match[2] ? await required.tools.card(input) : await required.tools.operation(input);
 return { status: result.ok ? 200 : 403, body: result };
}
/** Decode exactly once; separators, control bytes and dot segments are never operation IDs. */
function operationId(required: { segment: string }): Outcome<string> {
 try { return parseBoundary({ schema: idSchema.refine(value => value !== '.' && value !== '..' && !/[\x00-\x1f/\\]/.test(value)), input: decodeURIComponent(required.segment) }); }
 catch { return { ok: false, error: { code: 'invalid_input', message: 'Invalid operation ID', retryable: false } }; }
}

/** Meta-tools share the same catalog/dispatcher as owner HTTP. No recursive run/history tools. */
export async function callDiscoveryTool(required: { tools: OmTools; context: CallContext; name: string; input: unknown; signal?: AbortSignal }): Promise<Outcome<unknown>> {
 switch (required.name) {
  case 'search_tools': {
   const parsed = parseBoundary({ schema: toolSearchSchema, input: required.input });
   return parsed.ok ? required.tools.list({ context: required.context, ...parsed.value }) : parsed;
  }
  case 'describe_tool': {
   const parsed = parseBoundary({ schema: z.strictObject({ name: idSchema }), input: required.input });
   return parsed.ok ? required.tools.describe({ context: required.context, name: parsed.value.name }) : parsed;
  }
  case 'execute_tool': {
   const parsed = parseBoundary({ schema: toolCallSchema, input: required.input });
   return parsed.ok ? required.tools.dispatch({ context: required.context, call: parsed.value, signal: required.signal }) : parsed;
  }
  default: return notImplemented({ operation: 'server.om.discovery-tool' });
 }
}

/** SDK-backed JSON-RPC on the existing authenticated JSON HTTP surface. One request owns one
 * SDK server/transport; no ambient session registry or vendor configuration crosses this boundary.
 * Disconnect closes observation; execute_tool returns pending immediately, never holds the card here.
 * @complexity One SDK dispatch, <=100 descriptors or <=64 KiB tool output; no retries.
 */
async function mcpRequest(required: { request: HttpRequest; tools: OmTools; context: CallContext }): Promise<HttpResponse> {
 const body = required.request.readBody ? await required.request.readBody({}) : { ok: true as const, value: required.request.body };
 const parsed = body.ok ? parseBoundary({ schema: mcpRequestSchema, input: body.value }) : body;
 if (!parsed.ok) return { status: 400, body: parsed };
 const response = Promise.withResolvers<HttpResponse>();
 const server = new Server({ name: 'Open Marketing', version: '0.0.0' }, { capabilities: { tools: {} } });
 const transport: Transport = { async start() {}, async close() { this.onclose?.(); },
  async send(message) { response.resolve({ status: 200, body: message }); } };
 server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: discoveryTools.map(tool => ({ name: tool.name,
  description: tool.description, inputSchema: { ...tool.inputSchema, type: 'object' as const },
  annotations: { readOnlyHint: tool.name !== 'execute_tool', openWorldHint: false } })) }));
 server.setRequestHandler(CallToolRequestSchema, async input => {
  const result = await callDiscoveryTool({ ...required, name: input.params.name, input: input.params.arguments ?? {}, signal: required.request.signal });
  return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], isError: !result.ok };
 });
 const abort = () => response.resolve({ status: 499, body: { ok: false, error: { code: 'cancelled', message: 'MCP request cancelled', retryable: false } } });
 required.request.signal?.addEventListener('abort', abort, { once: true });
 try {
  if (required.request.signal?.aborted) return { status: 499, body: notImplemented({ operation: 'server.om.cancelled' }) };
  await server.connect(transport);
  transport.onmessage?.(parsed.value);
  return await response.promise;
 } catch { return { status: 502, body: notImplemented({ operation: 'server.om.mcp.protocol' }) }; }
 finally { required.request.signal?.removeEventListener('abort', abort); await server.close(); }
}

/** Run identity comes from the credential; no client body/query may widen it. All other
 * operations (including MCP/tools/model/conversions/owner approvals) deny in this sandbox.
 */
async function sandboxRequest(required: { request: HttpRequest; callbacks: SandboxCallbacks; grant: RunGrantMetadata }): Promise<HttpResponse> {
 const prefix = '/api/agent/v1/runs/' + encodeURIComponent(required.grant.runId);
 if (required.request.method === 'GET' && required.request.path === prefix + '/context' && required.grant.capabilities.includes('context')) {
  const result = await required.callbacks.context({ grant: required.grant });
  return { status: result.ok ? 200 : 403, body: result };
 }
 if (required.request.method === 'POST' && required.request.path === prefix + '/events' && required.grant.capabilities.includes('events')) {
  return sandboxEvents(required);
 }
 return { status: 403, body: { ok: false, error: { code: 'forbidden', message: 'Sandbox run capability unavailable', retryable: false } } };
}

/** Event payload parsing stays lazy and follows exact route/capability admission. */
async function sandboxEvents(required: { request: HttpRequest; callbacks: SandboxCallbacks; grant: RunGrantMetadata }): Promise<HttpResponse> {
  const body = required.request.readBody ? await required.request.readBody({}) : { ok: true as const, value: required.request.body };
  if (!body.ok) return { status: 400, body };
  const event = parseBoundary({ schema: runEventSchema, input: body.value });
  if (!event.ok) return { status: 400, body: event };
  const result = await required.callbacks.record({ grant: required.grant, event: event.value });
  return { status: result.ok ? 200 : 409, body: result };
}

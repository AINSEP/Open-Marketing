import { z } from 'zod';
import { assistantContextSchema, appErrorSchema, boundedJsonSchema, confirmationCardSchema, idSchema, parseBoundary, toolDescriptorSchema, toolOperationSchema, toolResultSchema } from "@open-marketing/contracts";
import type { Outcome, ObserverPort, StartRunRequest } from "@open-marketing/contracts";
/** All tool traffic uses fixed OM routes and the same bounded callback adapter. */
function modelPath(required: { run: StartRunRequest; operation: string; operationId?: string }): string {
 if (required.operation === 'mcp') return '/api/agent/v1/mcp';
 const prefix = '/api/agent/v1/runs/' + encodeURIComponent(required.run.runId) + '/';
 if (required.operation === 'operations' || required.operation === 'card')
  return prefix + 'operations/' + encodeURIComponent(idSchema.parse(required.operationId)) + (required.operation === 'card' ? '/card' : '');
 return prefix + required.operation;
}
type ModelTransport = Parameters<typeof createOmModelClient>[0] & { run: StartRunRequest; signal: AbortSignal };
const rpcToolsSchema = z.object({ jsonrpc: z.literal('2.0'), id: idSchema,
 result: z.object({ tools: z.array(z.object({ name: idSchema, description: z.string().max(4096),
  inputSchema: boundedJsonSchema.pipe(z.record(z.string(), z.json())), annotations: z.object({ readOnlyHint: z.boolean().optional() }).optional() })).max(100) }) });
const rpcCallSchema = z.object({ jsonrpc: z.literal('2.0'), id: idSchema,
 result: z.object({ content: z.array(z.object({ type: z.literal('text'), text: z.string().max(131072) })).min(1).max(1), isError: z.boolean().optional() }) });

/** Discover the three model tools from the authoritative server, never a duplicate local catalog. */
async function modelTools(required: ModelTransport): Promise<Outcome<readonly import('@open-marketing/contracts').ToolDescriptor[]>> {
 const id = required.run.grant.grantId;
 const result = await modelRequest({ ...required, operation: 'mcp', body: { jsonrpc: '2.0', id, method: 'tools/list', params: {} }, schema: rpcToolsSchema });
 if (!result.ok) return result;
 if (result.value.id !== id) return { ok: false, error: { code: 'protocol_mismatch', message: 'MCP response identity differs', retryable: false } };
 return parseBoundary({ schema: toolDescriptorSchema.array().max(100), input: result.value.result.tools.map(tool => ({ name: tool.name,
  description: tool.description, inputSchema: tool.inputSchema, effects: tool.annotations?.readOnlyHint === true ? ['read'] : ['write'] })) });
}

/** Schema-validate SDK content and the enclosed OM Outcome; pending has no fabricated output. */
async function modelToolCall(required: ModelTransport & { call: import('@open-marketing/contracts').ToolCall }): Promise<Outcome<import('@open-marketing/contracts').ToolResult>> {
 const result = await modelRequest({ ...required, operation: 'mcp', body: { jsonrpc: '2.0', id: required.call.operationId,
  method: 'tools/call', params: { name: required.call.name, arguments: required.call.input } }, schema: rpcCallSchema });
 if (!result.ok) return result;
 if (result.value.id !== required.call.operationId) return { ok: false, error: { code: 'protocol_mismatch', message: 'MCP response identity differs', retryable: false } };
 const schema = z.discriminatedUnion('ok', [z.strictObject({ ok: z.literal(true), value: boundedJsonSchema }), z.strictObject({ ok: z.literal(false), error: appErrorSchema })]);
 try {
  const output = parseBoundary({ schema, input: JSON.parse(result.value.result.content[0].text) });
  if (!output.ok) return output;
  if (!output.value.ok) return output.value;
  return required.call.name === 'execute_tool' ? parseBoundary({ schema: toolResultSchema, input: output.value.value })
   : { ok: true, value: { status: 'completed', output: output.value.value } };
 } catch { return { ok: false, error: { code: 'protocol_mismatch', message: 'Invalid OM tool response', retryable: false } }; }
}

/** Injected timer waits >=1 second; run abort/deadline interrupts it and removes both listeners. */
async function waitForOperation(required: { signal: AbortSignal; intervalMs: number; deadline(required: { timeoutMs: number }): { signal: AbortSignal; dispose(): void } }): Promise<void> {
 if (required.intervalMs < 1000 || required.signal.aborted) throw new Error('Operation polling interrupted');
 const timer = required.deadline({ timeoutMs: required.intervalMs });
 const signal = AbortSignal.any([required.signal, timer.signal]);
 try {
  if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
  if (required.signal.aborted) throw new Error('Operation polling interrupted');
 } finally { timer.dispose(); }
}
/** Fixed OM model context/event routes. No arbitrary network target or vendor credential is accepted. */
export function createOmModelClient(required: {
 serverOrigin: string; fetch: typeof fetch; observer: ObserverPort;
 deadline(required: { timeoutMs: number }): { signal: AbortSignal; dispose(): void };
}): import('../runtime/model.js').ModelClient {
 const origin = new URL(required.serverOrigin);
 if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || origin.pathname !== '/' || origin.username || origin.password || origin.hash || origin.search) throw new Error('OM loopback origin required');
 return {
  brokerBaseUrl: origin.origin + '/api/agent/v1/model', system: 'You are the Open Marketing assistant. Use search_tools, then describe_tool, then execute_tool. Use only connected OM tools. Never claim an action completed without its tool result. Inspect the bound studio page with page.find_elements and use its actual handles. For appearance, navigate to Settings and inspect appearance-mode before page.select_option. Discover installed skills and add-on instructions with search_tools and load only the selected instructions. Business actions use catalog tools through server policy. Approval answers belong to the human; never answer your own card. Self-cancellation may end this turn before a tool result returns; run cancellation events are the evidence.\n\nFor Open Marketing capabilities, discover site_guide, read {"operation":"overview"}, then explain the relevant topic through execute_tool with a fresh operation ID. The same overview is available at jini://site-guide. Use its current caller-scoped facts and stated limitations before proposing actions; help never grants authority or proves vendor readiness.', tools: [],
  deadline: required.deadline,
  load: input => modelRequest({ ...required, ...input, operation: 'context', schema: assistantContextSchema }),
  async publish(input) {
   const result = await modelRequest({ ...required, ...input, operation: 'events', body: input.event, schema: z.strictObject({ recorded: z.literal(true) }) });
   return result.ok ? { ok: true, value: undefined } : result;
  },
  loadTools: input => modelTools({ ...required, ...input }),
  executeTool: input => modelToolCall({ ...required, ...input }),
  operation: input => modelRequest({ ...required, ...input, operation: 'operations', schema: toolOperationSchema }),
  readCard: input => modelRequest({ ...required, ...input, operation: 'card', schema: confirmationCardSchema.nullable() }),
  wait: input => waitForOperation({ ...required, ...input }),
 };
}

/** A single authenticated callback, 15s deadline and 128 KiB body bound, with no retries. */
async function modelRequest<T>(required: {
 serverOrigin: string; fetch: typeof fetch; observer: ObserverPort; run: StartRunRequest; operation: 'context' | 'events' | 'mcp' | 'operations' | 'card'; operationId?: string;
 body?: unknown; signal: AbortSignal; schema: z.ZodType<T>;
 deadline(required: { timeoutMs: number }): { signal: AbortSignal; dispose(): void };
}): Promise<Outcome<T>> {
 const timeout = required.deadline({ timeoutMs: 15000 });
 const signal = AbortSignal.any([required.signal, timeout.signal]);
 let outcome = 'unavailable';
 try {
  const response = await required.fetch(required.serverOrigin + modelPath(required), {
   method: required.operation === 'events' || required.operation === 'mcp' ? 'POST' : 'GET', redirect: 'error', signal,
   headers: { authorization: 'Bearer ' + required.run.runBearer, 'content-type': 'application/json', 'x-correlation-id': required.run.context.correlationId, 'x-trace-id': required.run.context.traceId },
   ...(required.body === undefined ? {} : { body: JSON.stringify(required.body) }),
  });
  const result = await boundedModelResponse({ response, schema: required.schema, envelope: required.operation === 'mcp' ? 'rpc' : 'outcome' });
  if (signal.aborted) return { ok: false, error: { code: 'cancelled', message: 'OM callback interrupted', retryable: false } };
  outcome = result.ok ? 'ok' : result.error.code;
  return result;
 } catch { return { ok: false, error: { code: 'unavailable', message: 'OM callback unavailable', retryable: false } }; }
 finally {
  timeout.dispose();
  try { required.observer.observe({ operation: 'agent.om.' + required.operation, outcome, runId: required.run.runId,
   correlationId: required.run.context.correlationId, traceId: required.run.context.traceId }); }
  catch { /* Diagnostics cannot replace the callback outcome. */ }
 }
}
/** Consume bounded JSON and close the response even when parsing fails. */
async function boundedModelResponse<T>(required: { response: Response; schema: z.ZodType<T>; envelope?: 'rpc' | 'outcome' }): Promise<Outcome<T>> {
 const reader = required.response.body?.getReader();
 if (!reader) throw new Error('Missing OM response');
 let bytes = 0; let text = ''; const decoder = new TextDecoder('utf-8', { fatal: true });
 try {
  while (true) {
   const chunk = await reader.read();
   if (chunk.done) break;
   bytes += chunk.value.byteLength;
   if (bytes > 131072) throw new Error('OM context bound exceeded');
   text += decoder.decode(chunk.value, { stream: true });
  }
  const value: unknown = JSON.parse(text + decoder.decode());
  if (required.envelope === 'rpc') return parseBoundary({ schema: required.schema, input: value });
  const schema = z.discriminatedUnion('ok', [z.strictObject({ ok: z.literal(true), value: required.schema }), z.strictObject({ ok: z.literal(false), error: appErrorSchema })]);
  const parsed = parseBoundary({ schema, input: value });
  if (!parsed.ok) return parsed;
  if (!required.response.ok && parsed.value.ok) throw new Error('OM status mismatch');
  return parsed.value;
 } finally { try { await reader.cancel(); } finally { reader.releaseLock(); } }
}

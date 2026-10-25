/** External-MCP lifecycle binding; tool authority remains with the server federation host. */
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { JSONRPCMessageSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { createHash } from 'node:crypto';
import { createJiniHttpMcpTransport, createJiniStdioMcpTransport, digestArguments,
  type ExternalToolResult, type JiniHttpTransportDependencies, type JiniStdioTransportDependencies, type McpTransportPort } from '@open-marketing/federation';
import { addonToolEffectsSchema, boundedJsonSchema, callContextSchema, idSchema, parseBoundary, toolDescriptorSchema,
  type CallContext, type ObserverPort, type Outcome } from '@open-marketing/contracts';
import { toolPolicy } from '../om-tools.js';
import type { OmToolDefinition } from '../om-tools.js';
import type { AgentPluginState, bindAgentPluginJobs } from './agent-plugin-backends.js';
import { parseExternalMcpConnection, type ExternalMcpConnection, type ExternalMcpSessions } from '../external-mcp.js';
import type { Integrations } from '../integrations.js';

/** Native I/O is supplied by serve; protocol parsing/fencing belongs to the federation package. */
export interface AddonFederationEffects {
  exchange: JiniHttpTransportDependencies['exchange'];
  openStdio(required: { server: Extract<ExternalMcpConnection['server'], { type: 'stdio' }>; signal?: AbortSignal }): ReturnType<JiniStdioTransportDependencies['openChannel']>;
}
type RemoteTool = { name: string; description?: string; inputSchema: Record<string, unknown>; outputSchema?: Record<string, unknown> };
type Binding = { connection: ExternalMcpConnection; active: Set<McpTransportPort>; discovery: Set<Client>;
  catalog?: Promise<OmToolDefinition[]> };
type Dependencies = { context: CallContext; effects: AddonFederationEffects; integrations: Pick<Integrations, 'access'>; observer: ObserverPort;
  pluginState?(required: { context: CallContext; pluginId: string }): Promise<AgentPluginState | null>;
  jobs?: ReturnType<typeof bindAgentPluginJobs> };
type Sessions = ExternalMcpSessions & { transport: McpTransportPort; definitions(required: { context: CallContext }): Promise<Outcome<readonly OmToolDefinition[]>> };

/** Own <=100 scoped bindings and dispose active sessions on disable, reload and uninstall.
 * Enabled external MCPs are discovered during catalog build; discovery success/failure is retained
 * until enable/reload. Invocation opens a fresh session and rechecks schemas and authority.
 * @example const sessions = bindAddonFederationSessions({ context, effects, integrations, observer });
 * @returns Store lifecycle hooks and the transport port for the existing policy-owning federation host.
 * @complexity O(1) lookup; close O(active calls), bounded to 100 calls per connection.
 */
export function bindAddonFederationSessions(required: Dependencies): Sessions {
  callContextSchema.parse(required.context);
  const bindings = new Map<string, Binding>();
  const close: ExternalMcpSessions['close'] = async input => {
    assertScope({ context: input.context, expected: required.context });
    const binding = bindings.get(input.connectionId);
    bindings.delete(input.connectionId);
    if (!binding) return;
    await Promise.all([...binding.discovery].map(client => client.close()));
    const results = await Promise.all([...binding.active].map(port => port.dispose({ connectionId: input.connectionId })));
    if (results.some(result => !result.ok)) throw new Error('Federation session close failed');
  };
  const sessions: Sessions = {
    close,
    definitions: input => federationDefinitions({ dependencies: required, context: input.context, bindings, transport: sessions.transport }),
    async reload(input) {
      assertScope({ context: input.context, expected: required.context });
      const connection = parseExternalMcpConnection({ value: input.connection });
      await close({ context: input.context, connectionId: connection.connectionId });
      if (!connection.enabled) return;
      if (connection.server.type === 'sse') throw new Error('Legacy SSE session adapter unavailable');
      if (connection.server.type === 'stdio' && connection.credentialConnectionId) throw new Error('Stdio credential environment mapping unavailable');
      if (bindings.size >= 100) throw new RangeError('Federation connection cap');
      bindings.set(connection.connectionId, { connection, active: new Set(), discovery: new Set() });
    },
    transport: {
      async invoke(input, options) {
        if (!sameScope({ context: input.context, expected: required.context })) return denied();
        const binding = bindings.get(input.call.connectionId);
        if (!binding || binding.connection.revision !== input.call.pluginDigest || !input.dispatchFence.isCurrent()) return denied();
        if (!await admittedBinding({ dependencies: required, binding, context: input.context })) return denied();
        if (binding.active.size >= 100) return { ok: false, error: { code: 'limit_exceeded', message: 'Federation active call cap', retryable: false } };
        const effects = guardedEffects({ dependencies: required, binding, context: input.context, isCurrent: () => bindings.get(input.call.connectionId) === binding && input.dispatchFence.isCurrent() });
        const port = connectionTransport({ ...required, effects, context: input.context, connection: binding.connection, credentialReference: input.credentialReference });
        binding.active.add(port);
        try {
          return await port.invoke({ ...input, dispatchFence: { isCurrent: () => bindings.get(input.call.connectionId) === binding && input.dispatchFence.isCurrent() } }, options);
        } finally { await port.dispose({ connectionId: input.call.connectionId }); binding.active.delete(port); }
      },
      async dispose(input) {
        try { await close({ context: required.context, connectionId: input.connectionId }); return { ok: true, value: undefined }; }
        catch { return { ok: false, error: { code: 'unavailable', message: 'Federation session close failed', retryable: false } }; }
      },
    },
  };
  return sessions;
}

/** Resolve sealed credentials freshly for each HTTP exchange, under the invoking scope/trace. */
function connectionTransport(required: { connection: ExternalMcpConnection; context: CallContext; credentialReference: string;
  effects: AddonFederationEffects; integrations: Pick<Integrations, 'access'>; observer: ObserverPort }): McpTransportPort {
  const common = { connectionId: required.connection.connectionId, credentialReference: required.credentialReference,
    timeoutMs: 15000, clientInfo: { name: 'Open Marketing', version: '0.0.0' } };
  const server = required.connection.server;
  if (server.type === 'stdio') return createJiniStdioMcpTransport({ ...common,
    openChannel: (_, options) => required.effects.openStdio({ server, signal: options?.signal }) }, { observer: required.observer });
  return createJiniHttpMcpTransport({ ...common, spec: { url: server.url, headers: server.headers ?? {} },
    exchange: required.effects.exchange, bearerToken: async (_, options) => {
      const connectionId = required.connection.credentialConnectionId;
      if (!connectionId) return undefined;
      if (!required.connection.pluginId) throw new Error('MCP credential plugin binding missing');
      const result = await required.integrations.access({ context: { ...required.context, principal: { kind: 'service', serviceId: 'om-addon-federation' } }, pluginId: required.connection.pluginId, connectionId }, options);
      if (!result.ok) throw new Error('MCP credential unavailable');
      return result.value.accessToken;
    } }, { observer: required.observer });
}

/** Scope validation denies other workspaces before any session or credential effect. */
function sameScope(required: { context: CallContext; expected: CallContext }): boolean {
  const parsed = callContextSchema.safeParse(required.context);
  return parsed.success && parsed.data.scope.ownerId === required.expected.scope.ownerId && parsed.data.scope.workspaceId === required.expected.scope.workspaceId;
}
function assertScope(required: { context: CallContext; expected: CallContext }): void {
  if (!sameScope(required)) throw new Error('Federation scope mismatch');
}
function denied<T>(): Outcome<T> {
  return { ok: false, error: { code: 'forbidden', message: 'Federation connection unavailable or changed', retryable: false } };
}

/** Plugin sources require explicit manifest admission even for handshake/tools/list. External MCP
 * connections have no plugin admission flag; their enabled state is their lifecycle authority.
 */
async function admittedBinding(required: { dependencies: Dependencies; binding: Binding; context: CallContext }): Promise<boolean> {
  if (!required.binding.connection.enabled) return false;
  const pluginId = required.binding.connection.pluginId;
  if (!pluginId) return true;
  try {
    const state = await required.dependencies.pluginState?.({ context: required.context, pluginId });
    return !!state?.enabled && state.admitted && state.revision === required.binding.connection.revision;
  } catch { return false; }
}

/** One gate shared by discovery and execution, following any credential await. No denied source
 * can spawn a process, perform a handshake, or send a tool. Lifecycle close invalidates its fence.
 */
function guardedEffects(required: { dependencies: Dependencies; binding: Binding; context: CallContext; isCurrent(): boolean }): AddonFederationEffects {
  async function check(): Promise<void> {
    if (!await admittedBinding(required) || !required.isCurrent()) throw new Error('MCP source unavailable');
  }
  return { exchange: { async send(input, options) { await check(); options?.signal?.throwIfAborted(); return required.dependencies.effects.exchange.send(input, options); } },
    async openStdio(input) { await check(); input.signal?.throwIfAborted(); return required.dependencies.effects.openStdio(input); } };
}

/** Bounded descriptors join the same catalog. An unadmitted vendor is skipped before discovery.
 * Cached discovery is connection-owned and discarded by reload/close; invocation checks fresh schemas.
 * @complexity <=100 connections, <=100 tools/connection, <=1000 total. One discovery per revision.
 */
async function federationDefinitions(required: { dependencies: Dependencies; context: CallContext; bindings: Map<string, Binding>; transport: McpTransportPort }): Promise<Outcome<readonly OmToolDefinition[]>> {
  if (!sameScope({ context: required.context, expected: required.dependencies.context })) return denied();
  const definitions: OmToolDefinition[] = [];
  for (const binding of required.bindings.values()) {
    const tools = await bindingDefinitions({ ...required, binding });
    if (definitions.length + tools.length > 1000) return { ok: false, error: { code: 'limit_exceeded', message: 'MCP catalog cap', retryable: false } };
    definitions.push(...tools);
  }
  return { ok: true, value: definitions };
}
/** One connection's descriptors; unadmitted bindings contribute none and are never discovered. */
async function bindingDefinitions(required: Parameters<typeof federationDefinitions>[0] & { binding: Binding }): Promise<OmToolDefinition[]> {
  const { binding } = required;
  if (!await admittedBinding(required)) return [];
  binding.catalog ??= discoverDefinitions(required);
  return binding.catalog;
}
/** A failing connection cannot suppress healthy sources or repeat its timeout on each execute.
 * Reload replaces the binding (and its cached failure); no timer or second registry is needed. */
async function discoverDefinitions(required: Parameters<typeof bindingDefinitions>[0]): Promise<OmToolDefinition[]> {
  try {
    const tools = await discover(required);
    return await discoveredDefinitions({ ...required, tools });
  } catch {
    const message = 'MCP discovery unavailable or invalid; enable/reload this connection to retry';
    return [{ name: 'mcp_' + sha({ value: required.binding.connection.connectionId }).slice(0, 16) + '_unavailable',
      description: message, capability: 'External MCP ' + required.binding.connection.connectionId, effects: ['write'], policy: 'write',
      revision: required.binding.connection.revision, inputSchema: { type: 'object' }, unavailableReason: message,
      parse: () => ({ ok: false, error: { code: 'unavailable', message, retryable: false } }),
      invoke: async () => ({ ok: false, error: { code: 'unavailable', message, retryable: false } }) }];
  }
}
async function discoveredDefinitions(required: Parameters<typeof bindingDefinitions>[0] & { tools: RemoteTool[] }): Promise<OmToolDefinition[]> {
  const { binding } = required;
  const pluginId = binding.connection.pluginId;
  const state = pluginId ? await required.dependencies.pluginState?.({ context: required.context, pluginId }) : null;
  const effects = addonToolEffectsSchema.parse(state?.effects ?? ['write']);
  return required.tools.map(tool => mcpDefinition({ ...required, binding, tool, effects }));
}

/** Remote annotations never classify policy. Unknown effects remain write; generation without
 * a verified quote is unavailable. No second confirmation is delegated to the federation transport.
 */
function mcpDefinition(required: Parameters<typeof federationDefinitions>[0] & { binding: Binding; tool: RemoteTool; effects: string[] }): OmToolDefinition {
  const { binding, tool } = required;
  const effects = addonToolEffectsSchema.parse(required.effects);
  const name = 'mcp_' + sha({ value: binding.connection.connectionId }).slice(0, 16) + '_' + tool.name;
  const schema = z.strictObject({ operationId: idSchema, arguments: z.record(z.string(), boundedJsonSchema) });
  const inputSchema = z.toJSONSchema(schema);
  (inputSchema.properties as Record<string, unknown>).arguments = tool.inputSchema;
  const validate = new AjvJsonSchemaValidator().getValidator(tool.inputSchema);
  const policy = toolPolicy({ effects });
  return { name, description: tool.description || tool.name, inputSchema: toolDescriptorSchema.shape.inputSchema.parse(inputSchema), effects, policy,
    capability: 'External MCP ' + tool.name, revision: binding.connection.revision + ':' + sha({ value: tool }),
    unavailableReason: ['spend', 'generation', 'internal'].includes(policy) ? 'NEEDS: verified financial quote/exposure or typed backend workflow' : undefined,
    parse(input) { const parsed = parseBoundary({ schema, input: input.input });
      if (!parsed.ok) return parsed;
      return validate(parsed.value.arguments).valid ? parsed : { ok: false, error: { code: 'invalid_input', message: 'MCP arguments invalid', retryable: false } }; },
    async invoke(input) {
      if (!sameScope({ context: input.context, expected: required.dependencies.context })) return denied();
      const parsed = schema.safeParse(input.input);
      if (!parsed.success || !validate(parsed.data.arguments).valid) return denied();
      const execute = () => invokeDiscovered({ ...required, context: input.context, input: parsed.data, signal: input.signal });
      if (policy === 'read') return execute();
      if (policy !== 'write' && policy !== 'destructive') return denied();
      if (!required.dependencies.jobs) return denied();
      return required.dependencies.jobs.dispatch({ context: input.context, pluginId: binding.connection.pluginId ?? binding.connection.connectionId,
        input: { ...parsed.data, connectionId: binding.connection.connectionId, accountId: null }, execute });
    } };
}

/** Re-list under the same admitted source, then bind actual egress to its exact schema/revision. */
async function invokeDiscovered(required: Parameters<typeof mcpDefinition>[0] & { input: { operationId: string; arguments: Record<string, unknown> }; signal?: AbortSignal }): Promise<Outcome<unknown>> {
  try {
    const result = await dispatchDiscovered(required);
    if (result.ok && result.value.status === 'unknown') return { ok: false, error: { code: 'unavailable', message: 'MCP outcome unknown; reconcile before retrying', retryable: false } };
    return result;
  }
  catch { return { ok: false, error: { code: 'unavailable', message: 'MCP source changed or invocation unavailable; reconcile writes', retryable: false } }; }
}
/** Exceptions from the SDK/third-party transport are mapped only at invokeDiscovered's boundary. */
async function dispatchDiscovered(required: Parameters<typeof invokeDiscovered>[0]): Promise<Outcome<ExternalToolResult>> {
  if (required.signal?.aborted) return denied();
  const fresh = await discover(required);
  const selected = fresh.find(tool => tool.name === required.tool.name);
  if (!selected || sha({ value: selected }) !== sha({ value: required.tool })) return denied();
  const argumentsDigest = digestArguments({ arguments: required.input.arguments });
  if (!argumentsDigest.ok) return argumentsDigest;
  return required.transport.invoke({ context: jsonContext({ context: required.context }), credentialReference: required.binding.connection.credentialConnectionId ?? 'no-credential',
    dispatchFence: { isCurrent: () => required.bindings.get(required.binding.connection.connectionId) === required.binding && !required.signal?.aborted },
    call: { operationId: required.input.operationId, connectionId: required.binding.connection.connectionId,
      toolName: 'io.github.ainsep.openmarketing.' + sha({ value: required.binding.connection.connectionId }).slice(0, 16) + '.' + required.tool.name,
      arguments: required.input.arguments, argumentsDigest: argumentsDigest.value,
      pluginDigest: required.binding.connection.revision, schemaFingerprint: sha({ value: required.tool.inputSchema }) } }, { signal: required.signal });
}

/** Federation snapshots context as strict JSON; an absent run must be omitted, not undefined. */
function jsonContext(required: { context: CallContext }): CallContext {
  const { runId, ...rest } = required.context;
  return runId === undefined ? rest : required.context;
}

/** Reuse the installed MCP SDK's handshake/listTools parser; protocol JSON stays outside Jini zod.
 * Only one bounded page is admitted. Larger/paginated catalogs need explicit discovery support.
 * @complexity <=100 descriptors/256 KiB, 15s total deadline; session closes on every path.
 */
async function discover(required: { dependencies: Dependencies; context: CallContext; binding: Binding; bindings: Map<string, Binding>; signal?: AbortSignal }): Promise<RemoteTool[]> {
  const signal = AbortSignal.any([AbortSignal.timeout(15000), ...(required.signal ? [required.signal] : [])]);
  const client = new Client({ name: 'Open Marketing', version: '0.0.0' });
  if (required.binding.discovery.size >= 100) throw new RangeError('MCP discovery concurrency cap');
  required.binding.discovery.add(client);
  const effects = guardedEffects({ ...required, isCurrent: () => required.bindings.get(required.binding.connection.connectionId) === required.binding && !signal.aborted });
  try {
    const transport = await discoveryTransport({ ...required, effects, signal });
    await client.connect(transport, { signal, timeout: 15000 });
    const result = await client.listTools({}, { signal, timeout: 15000 });
    if (result.nextCursor) throw new RangeError('MCP catalog pagination cap');
    return z.array(z.object({ name: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/), description: z.string().max(4096).optional(),
      inputSchema: toolDescriptorSchema.shape.inputSchema, outputSchema: toolDescriptorSchema.shape.inputSchema.optional() })).max(100).parse(boundedJsonSchema.parse(result.tools));
  } finally { await client.close(); required.binding.discovery.delete(client); }
}

/** SDK HTTP accepts injected bounded exchange; stdio accepts the existing injected Jini channel.
 * The source's own credential is resolved freshly for each HTTP exchange using a service identity.
 */
async function discoveryTransport(required: { dependencies: Dependencies; context: CallContext; binding: Binding; effects: AddonFederationEffects; signal: AbortSignal }): Promise<Transport> {
  const connection = required.binding.connection;
  const server = connection.server;
  if (server.type === 'sse') throw new Error('Legacy SSE discovery unavailable');
  if (server.type === 'stdio') {
    const channel = await required.effects.openStdio({ server, signal: required.signal });
    const transport: Transport = { async start() {}, async close() { channel.close({}); },
      async send(message) { channel.send({ message: JSON.stringify(message) }); } };
    channel.onMessage({ listener: input => { transport.onmessage?.(JSONRPCMessageSchema.parse(JSON.parse(input.message))); } });
    channel.onClose({ listener: () => { transport.onclose?.(); } });
    return transport;
  }
  return new StreamableHTTPClientTransport(new URL(server.url), { reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 0, maxReconnectionDelay: 0, reconnectionDelayGrowFactor: 1 },
    fetch: async (url, options) => {
      // The existing bounded exchange supports POST/DELETE; optional server-push GET is refused locally.
      const method = options?.method ?? 'GET';
      if (method !== 'POST' && method !== 'DELETE') return new Response(null, { status: 405 });
      const headers = new Headers({ ...server.headers, ...headerRecord({ headers: options?.headers }) });
      if (connection.credentialConnectionId) {
        if (!connection.pluginId) throw new Error('MCP credential plugin binding missing');
        const secret = await required.dependencies.integrations.access({ context: { ...required.context, principal: { kind: 'service', serviceId: 'om-addon-federation' } },
          pluginId: connection.pluginId, connectionId: connection.credentialConnectionId }, { signal: required.signal });
        if (!secret.ok) throw new Error('MCP credential unavailable');
        headers.set('Authorization', 'Bearer ' + secret.value.accessToken);
      }
      const result = await required.effects.exchange.send({ url: String(url), method, headers: headerRecord({ headers }) },
        { body: typeof options?.body === 'string' ? options.body : undefined, signal: required.signal });
      return new Response(result.text || null, { status: result.status, headers: { 'content-type': result.contentType, ...(result.sessionId ? { 'mcp-session-id': result.sessionId } : {}) } });
    } });
}
/** Headers.forEach is the documented foreign scalar callback ABI; no DOM.Iterable assumption. */
function headerRecord(required: { headers?: HeadersInit }): Record<string, string> {
  const result: Record<string, string> = {};
  new Headers(required.headers).forEach((value, key) => { result[key] = value; });
  return result;
}
function sha(required: { value: unknown }): string { return createHash('sha256').update(JSON.stringify(required.value)).digest('hex'); }

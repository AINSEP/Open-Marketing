/** External-MCP lifecycle binding; tool authority remains with the server federation host. */
import { z } from 'zod';
import { parseAgentPluginMcpConfig } from '@jini-ai/agent-plugins/lifecycle';
import { boundedJsonSchema, callContextSchema, idSchema } from '@open-marketing/contracts';
import type { CallContext, ObserverPort, Outcome } from '@open-marketing/contracts';
import { createJiniHttpMcpTransport, createJiniStdioMcpTransport } from '@open-marketing/federation';
import type { JiniHttpTransportDependencies, JiniStdioTransportDependencies, McpTransportPort } from '@open-marketing/federation';
import type { ExternalMcpConnection, ExternalMcpSessions } from '../external-mcp.js';
import type { Integrations } from '../integrations.js';

/** Native I/O is supplied by serve; protocol parsing/fencing belongs to the federation package. */
export interface AddonFederationEffects {
  exchange: JiniHttpTransportDependencies['exchange'];
  openStdio(required: { server: Extract<ExternalMcpConnection['server'], { type: 'stdio' }>; signal?: AbortSignal }): ReturnType<JiniStdioTransportDependencies['openChannel']>;
}
type Binding = { connection: ExternalMcpConnection; active: Set<McpTransportPort> };

/** Own <=100 scoped bindings and dispose active sessions on disable, reload and uninstall.
 * Construction/reload do no egress; federation opens a fresh session only for a fenced invocation.
 * @example const sessions = bindAddonFederationSessions({ context, effects, integrations, observer });
 * @returns Store lifecycle hooks and the transport port for the existing policy-owning federation host.
 * @complexity O(1) lookup; close O(active calls), bounded to 100 calls per connection.
 */
export function bindAddonFederationSessions(required: { context: CallContext; effects: AddonFederationEffects;
  integrations: Pick<Integrations, 'access'>; observer: ObserverPort }): ExternalMcpSessions & { transport: McpTransportPort } {
  callContextSchema.parse(required.context);
  const bindings = new Map<string, Binding>();
  const close: ExternalMcpSessions['close'] = async input => {
    assertScope({ context: input.context, expected: required.context });
    const binding = bindings.get(input.connectionId);
    bindings.delete(input.connectionId);
    if (!binding) return;
    const results = await Promise.all([...binding.active].map(port => port.dispose({ connectionId: input.connectionId })));
    if (results.some(result => !result.ok)) throw new Error('Federation session close failed');
  };
  return {
    close,
    async reload(input) {
      assertScope({ context: input.context, expected: required.context });
      const connection = parseConnection({ connection: input.connection });
      await close({ context: input.context, connectionId: connection.connectionId });
      if (!connection.enabled) return;
      if (connection.server.type === 'sse') throw new Error('Legacy SSE session adapter unavailable');
      if (connection.server.type === 'stdio' && connection.credentialConnectionId) throw new Error('Stdio credential environment mapping unavailable');
      if (bindings.size >= 100) throw new RangeError('Federation connection cap');
      bindings.set(connection.connectionId, { connection, active: new Set() });
    },
    transport: {
      async invoke(input, options) {
        if (!sameScope({ context: input.context, expected: required.context })) return denied();
        const binding = bindings.get(input.call.connectionId);
        if (!binding || binding.connection.revision !== input.call.pluginDigest || !input.dispatchFence.isCurrent()) return denied();
        if (binding.active.size >= 100) return { ok: false, error: { code: 'limit_exceeded', message: 'Federation active call cap', retryable: false } };
        const port = connectionTransport({ ...required, context: input.context, connection: binding.connection, credentialReference: input.credentialReference });
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
}

/** Store reload validates an immutable copy; malformed configuration never becomes active. */
function parseConnection(required: { connection: ExternalMcpConnection }): ExternalMcpConnection {
  const connection = z.strictObject({ connectionId: idSchema, pluginId: idSchema.nullable(), revision: idSchema,
    enabled: z.boolean(), credentialConnectionId: idSchema.optional(), server: boundedJsonSchema }).parse(required.connection);
  const parsed = parseAgentPluginMcpConfig({ value: { $schema: 'https://agent-plugins.org/schemas/1.1.0/mcp.schema.json', mcpServers: { connection: connection.server } }, extensionNamespace: 'io.github.ainsep.openmarketing' });
  if (!parsed.ok || !parsed.config.servers.connection) throw new Error('Invalid federation transport');
  return { ...connection, server: parsed.config.servers.connection };
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
      const result = await required.integrations.access({ context: required.context, pluginId: required.connection.pluginId, connectionId }, options);
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

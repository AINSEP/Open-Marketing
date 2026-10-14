/** Server composition fixtures, separate from the HTTP-only CLI boundary. */
import { expect, it } from 'vitest';
import type { CallContext } from '@open-marketing/contracts';
import { readAddonYaml } from '../src/composition/serve.js';
import { bindAddonFederationSessions } from '../src/composition/addon-federation.js';
import { createNodeFederationEffects } from '../src/composition/addon-federation-node.js';
import { digestArguments } from '@open-marketing/federation';
import type { AddonFederationEffects } from '../src/composition/addon-federation.js';
import type { ExternalMcpConnection } from '../src/external-mcp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js';

it('safe YAML accepts core scalars and rejects duplicate keys, custom tags, aliases and oversize', () => {
  expect(readAddonYaml({ yaml: 'name: sample\ndescription: Sample skill' })).toEqual({ name: 'sample', description: 'Sample skill' });
  for (const yaml of ['name: one\nname: two', 'name: !custom sample', 'a: &a [1, 2]\nb: *a', 'x'.repeat(65537)]) expect(() => readAddonYaml({ yaml })).toThrow();
});

/** Scripted wire runs the real federation protocol adapter with an injected exchange/channel. */
function federationFixture() {
  const context: CallContext = { scope: { ownerId: 'owner', workspaceId: 'workspace' }, principal: { kind: 'owner', ownerId: 'owner' }, correlationId: 'correlation', traceId: 'trace' };
  const connection: ExternalMcpConnection = { connectionId: 'mcp-fixture', pluginId: 'fixture-plugin', enabled: true, revision: 'a'.repeat(64), credentialConnectionId: 'credential', server: { type: 'streamable-http', url: 'https://fixture.invalid/mcp' } };
  const calls: { method: string; headers: Readonly<Record<string, string>> }[] = [];
  const accesses: unknown[] = [];
  const effects: AddonFederationEffects = { async openStdio() { throw new Error('Not used by HTTP fixture'); }, exchange: { async send(input, options) {
    const message = options?.body ? JSON.parse(options.body) : {};
    calls.push({ method: message.method ?? input.method, headers: input.headers });
    const result = message.method === 'initialize' ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } } : { content: [{ type: 'text', text: 'fixture-result' }] };
    return { status: message.id === undefined ? 202 : 200, contentType: 'application/json', text: message.id === undefined ? '' : JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) };
  } } };
  const sessions = bindAddonFederationSessions({ context, effects, observer: { observe() {} }, integrations: { async access(input) { accesses.push(input); return { ok: true, value: { accessToken: 'fixture-private-token' } }; } } });
  const digest = digestArguments({ arguments: { query: 'fixture' } });
  if (!digest.ok) throw new Error('Invalid fixture digest');
  const invocation = { context, credentialReference: 'opaque-reference', dispatchFence: { isCurrent: () => true }, call: {
    operationId: 'fixture-operation', connectionId: connection.connectionId, toolName: 'io.github.ainsep.openmarketing.fixture.echo', arguments: { query: 'fixture' }, argumentsDigest: digest.value, pluginDigest: connection.revision, schemaFingerprint: 'b'.repeat(64),
  } };
  return { context, connection, calls, accesses, sessions, invocation, effects };
}

it('binds a concrete HTTP federation transport lazily and resolves credentials at exchange time', async () => {
  const f = federationFixture();
  await f.sessions.reload({ context: f.context, connection: f.connection });
  expect(f.calls).toEqual([]); expect(f.accesses).toEqual([]);
  const result = await f.sessions.transport.invoke(f.invocation);
  expect(result).toMatchObject({ ok: true, value: { status: 'succeeded', content: [{ type: 'text', text: 'fixture-result' }] } });
  expect(f.calls.map(call => call.method)).toContain('tools/call');
  expect(f.accesses.length).toBeGreaterThan(0);
  expect(f.accesses[0]).toMatchObject({ context: f.context, pluginId: 'fixture-plugin', connectionId: 'credential' });
  expect(f.calls[0].headers.authorization ?? f.calls[0].headers.Authorization).toBe('Bearer fixture-private-token');
  expect(JSON.stringify(result)).not.toContain('fixture-private-token');
  await f.sessions.close({ context: f.context, connectionId: f.connection.connectionId });
  const count = f.calls.length;
  expect((await f.sessions.transport.invoke(f.invocation)).ok).toBe(false);
  expect(f.calls).toHaveLength(count);
});

it('denies cross-scope, stale revision, revoked fence and malformed reload before egress', async () => {
  const f = federationFixture();
  await f.sessions.reload({ context: f.context, connection: f.connection });
  expect((await f.sessions.transport.invoke({ ...f.invocation, context: { ...f.context, scope: { ...f.context.scope, workspaceId: 'other' } } })).ok).toBe(false);
  expect((await f.sessions.transport.invoke({ ...f.invocation, call: { ...f.invocation.call, pluginDigest: 'c'.repeat(64) } })).ok).toBe(false);
  expect((await f.sessions.transport.invoke({ ...f.invocation, dispatchFence: { isCurrent: () => false } })).ok).toBe(false);
  expect(f.calls).toEqual([]); expect(f.accesses).toEqual([]);
  await expect(f.sessions.reload({ context: f.context, connection: { ...f.connection, server: { type: 'stdio' } as ExternalMcpConnection['server'] } })).rejects.toThrow();
  await f.sessions.close({ context: f.context, connectionId: f.connection.connectionId });
});

it('bounds native HTTP response bytes without redirects and never constructs a process for HTTP', async () => {
  const options: RequestInit[] = [];
  const effects = createNodeFederationEffects({ fetch: async (_, init) => { options.push(init!); return new Response('x'.repeat(262145)); }, stdio() { throw new Error('HTTP must not spawn'); } });
  await expect(effects.exchange.send({ url: 'https://fixture.invalid', method: 'POST', headers: {} }, { body: '{}' })).rejects.toThrow();
  expect(options).toHaveLength(1); expect(options[0].redirect).toBe('error');
});

it('disabling while credential lookup is pending fences late session initialization', async () => {
  const f = federationFixture();
  const entered = Promise.withResolvers<void>();
  const secret = Promise.withResolvers<{ ok: true; value: { accessToken: string } }>();
  const sessions = bindAddonFederationSessions({ context: f.context, effects: f.effects, observer: { observe() {} },
    integrations: { access: () => { entered.resolve(); return secret.promise; } } });
  await sessions.reload({ context: f.context, connection: f.connection });
  const pending = sessions.transport.invoke(f.invocation);
  await entered.promise;
  await sessions.close({ context: f.context, connectionId: f.connection.connectionId });
  secret.resolve({ ok: true, value: { accessToken: 'late-fixture-token' } });
  expect((await pending).ok).toBe(false);
  expect(f.calls).toEqual([]);
});

it('the SDK stdio wrapper and federation adapter handshake lazily and dispose on completion', async () => {
  const f = federationFixture();
  const launches: StdioServerParameters[] = [];
  let starts = 0; let closes = 0;
  const sent: string[] = [];
  const effects = createNodeFederationEffects({ fetch: async () => { throw new Error('Stdio must not fetch'); }, stdio(input) {
    launches.push(input);
    const transport: Transport = {
      async start() { starts++; }, async close() { closes++; transport.onclose?.(); },
      async send(message) {
        if (!('method' in message)) throw new Error('Expected fixture request');
        sent.push(message.method);
        if (!('id' in message)) return;
        const result = message.method === 'initialize'
          ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
          : { content: [{ type: 'text', text: 'stdio-fixture' }] };
        transport.onmessage?.({ jsonrpc: '2.0', id: message.id, result });
      },
    };
    return transport;
  } });
  const sessions = bindAddonFederationSessions({ context: f.context, effects, observer: { observe() {} },
    integrations: { async access() { throw new Error('This stdio fixture has no credential binding'); } } });
  await sessions.reload({ context: f.context, connection: { ...f.connection, credentialConnectionId: undefined, server: { type: 'stdio', command: 'fixture-command', args: ['fixture-argument'], env: { FIXTURE: 'only' } } } });
  expect(launches).toEqual([]); expect(starts).toBe(0);
  const result = await sessions.transport.invoke(f.invocation);
  expect(result).toMatchObject({ ok: true, value: { status: 'succeeded', content: [{ type: 'text', text: 'stdio-fixture' }] } });
  expect(starts).toBe(1); expect(closes).toBeGreaterThan(0);
  expect(sent).toEqual(['initialize', 'notifications/initialized', 'tools/call']);
  expect(launches).toEqual([{ command: 'fixture-command', args: ['fixture-argument'], env: { FIXTURE: 'only' }, cwd: undefined, stderr: 'ignore', maxBufferSize: 262144 }]);
  await sessions.close({ context: f.context, connectionId: f.connection.connectionId });
  expect((await sessions.transport.invoke(f.invocation)).ok).toBe(false); expect(starts).toBe(1);
});

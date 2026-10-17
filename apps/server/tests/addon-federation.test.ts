/** Server composition fixtures, separate from the HTTP-only CLI boundary. */
import { expect, it } from 'vitest';
import { createOmTools } from '../src/om-tools.js';
import { createMemoryConfirmationExchange } from '@open-marketing/safety';
import type { Outcome } from '@open-marketing/contracts';
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
  let schema: Record<string, unknown> = { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false };
  const calls: { method: string; headers: Readonly<Record<string, string>> }[] = [];
  let outcome: 'succeeded' | 'failed' | 'unknown' = 'succeeded';
  const accesses: unknown[] = [];
  const effects: AddonFederationEffects = { async openStdio() { throw new Error('Not used by HTTP fixture'); }, exchange: { async send(input, options) {
    const message = options?.body ? JSON.parse(options.body) : {};
    calls.push({ method: message.method ?? input.method, headers: input.headers });
    if (message.method === 'tools/call' && outcome === 'unknown') throw new Error('Fixture connection lost after handoff');
    const result = message.method === 'initialize' ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
      : message.method === 'tools/list' ? { tools: [{ name: 'echo', description: 'Fixture echo', inputSchema: schema, annotations: { readOnlyHint: true } }] }
      : { content: [{ type: 'text', text: 'fixture-result' }], isError: outcome === 'failed' };
    return { status: message.id === undefined ? 202 : 200, contentType: 'application/json', text: message.id === undefined ? '' : JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) };
  } } };
  const sessions = bindAddonFederationSessions({ pluginState: admittedFixtureState, context, effects, observer: { observe() {} }, integrations: { async access(input) { accesses.push(input); return { ok: true, value: { accessToken: 'fixture-private-token' } }; } } });
  const digest = digestArguments({ arguments: { query: 'fixture' } });
  if (!digest.ok) throw new Error('Invalid fixture digest');
  const invocation = { context, credentialReference: 'opaque-reference', dispatchFence: { isCurrent: () => true }, call: {
    operationId: 'fixture-operation', connectionId: connection.connectionId, toolName: 'io.github.ainsep.openmarketing.fixture.echo', arguments: { query: 'fixture' }, argumentsDigest: digest.value, pluginDigest: connection.revision, schemaFingerprint: 'b'.repeat(64),
  } };
  return { context, connection, calls, accesses, sessions, invocation, effects,
    setOutcome(input: { status: typeof outcome }) { outcome = input.status; },
    changeSchema() { schema = { type: 'object', properties: { query: { type: 'integer' } }, required: ['query'] }; } };
}

it('binds a concrete HTTP federation transport lazily and resolves credentials at exchange time', async () => {
  const f = federationFixture();
  await f.sessions.reload({ context: f.context, connection: f.connection });
  expect(f.calls).toEqual([]); expect(f.accesses).toEqual([]);
  const result = await f.sessions.transport.invoke(f.invocation);
  expect(result).toMatchObject({ ok: true, value: { status: 'succeeded', content: [{ type: 'text', text: 'fixture-result' }] } });
  expect(f.calls.map(call => call.method)).toContain('tools/call');
  expect(f.accesses.length).toBeGreaterThan(0);
  expect(f.accesses[0]).toMatchObject({ context: { ...f.context, principal: { kind: 'service', serviceId: 'om-addon-federation' } }, pluginId: 'fixture-plugin', connectionId: 'credential' });
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
  const sessions = bindAddonFederationSessions({ pluginState: admittedFixtureState, context: f.context, effects: f.effects, observer: { observe() {} },
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
  const sessions = bindAddonFederationSessions({ pluginState: admittedFixtureState, context: f.context, effects, observer: { observe() {} },
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

/** Explicit admission fixture; real boot reads the installed manifest/capability metadata. */
async function admittedFixtureState() { return { admitted: true, enabled: true, bundled: true, revision: 'a'.repeat(64), metadata: {} }; }
function value<T>(required: { result: Outcome<T> }): T { if (!required.result.ok) throw new Error(required.result.error.message); return required.result.value; }

it('unadmitted vendor MCP refuses discovery and tools/call without any network or credential call', async () => {
  const f = federationFixture();
  const sessions = bindAddonFederationSessions({ context: f.context, effects: f.effects, observer: { observe() {} },
    pluginState: async () => ({ ...await admittedFixtureState(), admitted: false }),
    integrations: { async access() { throw new Error('Unadmitted plugins must not read credentials'); } } });
  await sessions.reload({ context: f.context, connection: f.connection });
  expect(await sessions.definitions({ context: f.context })).toEqual({ ok: true, value: [] });
  expect(await sessions.transport.invoke(f.invocation)).toMatchObject({ ok: false });
  expect(f.calls).toEqual([]);
  await sessions.close({ context: f.context, connectionId: f.connection.connectionId });
});

it('discovered MCP tools use the ONE dispatcher card and ignore remote read-only hints', async () => {
  const f = federationFixture();
  let claims = 0;
  const sessions = bindAddonFederationSessions({ context: f.context, effects: f.effects, pluginState: admittedFixtureState, observer: { observe() {} },
    integrations: { async access(input) { f.accesses.push(input); return { ok: true, value: { accessToken: 'fixture-private-token' } }; } },
    jobs: { async dispatch(input) { claims++; return input.execute({ jobId: 'fixture-job' }); } } });
  await sessions.reload({ context: f.context, connection: f.connection });
  const definitions = value({ result: await sessions.definitions({ context: f.context }) });
  expect(definitions).toHaveLength(1); expect(definitions[0].policy).toBe('write');
  expect(definitions[0].parse({ input: { operationId: 'invalid', arguments: { query: 1 } } })).toMatchObject({ ok: false });
  const clock = { now: () => 1000 }; let sequence = 0;
  const confirmations = createMemoryConfirmationExchange({ clock, ids: { next: () => 'mcp-card-' + ++sequence } });
  const tools = createOmTools({ definitions: input => sessions.definitions(input), confirmations, clock, observer: { observe() {} }, authorize: () => ({ ok: true, value: undefined }) });
  const call = { name: definitions[0].name, operationId: 'mcp-tool-operation', input: { operationId: 'mcp-tool-operation', arguments: { query: 'fixture' } } };
  expect(await tools.dispatch({ context: f.context, call })).toMatchObject({ ok: true, value: { status: 'pending' } });
  expect(f.calls.map(item => item.method)).not.toContain('tools/call');
  const card = value({ result: await tools.card({ context: f.context, operationId: call.operationId }) })!;
  expect(await tools.answer({ context: f.context, response: { cardId: card.cardId, operationId: call.operationId, argumentsDigest: card.argumentsDigest, choice: 'allow' } })).toMatchObject({ ok: true });
  expect(await tools.operation({ context: f.context, operationId: call.operationId })).toMatchObject({ ok: true, value: { status: 'completed',
    output: { status: 'succeeded', content: [{ type: 'text', text: 'fixture-result' }] } } });
  expect(f.calls.filter(item => item.method === 'tools/call')).toHaveLength(1); expect(claims).toBe(1);
  expect(JSON.stringify(await tools.operation({ context: f.context, operationId: call.operationId }))).not.toContain('fixture-private-token');
  await sessions.close({ context: f.context, connectionId: f.connection.connectionId });
  expect(await definitions[0].invoke({ context: f.context, input: call.input })).toMatchObject({ ok: false });
  tools.dispose({});
});

it.each(['failed', 'unknown'] as const)('keeps observed MCP %s outcomes distinct after card allow and never resends', async status => {
  const f = federationFixture(); f.setOutcome({ status });
  let claims = 0; let sequence = 0;
  const sessions = bindAddonFederationSessions({ context: f.context, effects: f.effects, pluginState: admittedFixtureState, observer: { observe() {} },
    integrations: { async access() { return { ok: true, value: { accessToken: 'fixture-private-token' } }; } },
    jobs: { async dispatch(input) { claims++; return input.execute({ jobId: 'fixture-job' }); } } });
  await sessions.reload({ context: f.context, connection: f.connection });
  const definitions = value({ result: await sessions.definitions({ context: f.context }) });
  const clock = { now: () => 1000 };
  const tools = createOmTools({ definitions: input => sessions.definitions(input), clock, observer: { observe() {} }, authorize: () => ({ ok: true, value: undefined }),
    confirmations: createMemoryConfirmationExchange({ clock, ids: { next: () => 'outcome-card-' + ++sequence } }) });
  const call = { name: definitions[0].name, operationId: 'observed-outcome', input: { operationId: 'observed-outcome', arguments: { query: 'fixture' } } };
  try {
    value({ result: await tools.dispatch({ context: f.context, call }) });
    const card = value({ result: await tools.card({ context: f.context, operationId: call.operationId }) })!;
    value({ result: await tools.answer({ context: f.context, response: { cardId: card.cardId, operationId: call.operationId, argumentsDigest: card.argumentsDigest, choice: 'allow' } }) });
    const operation = value({ result: await tools.operation({ context: f.context, operationId: call.operationId }) });
    if (status === 'unknown') expect(operation).toMatchObject({ status: 'unknown', error: { retryable: false } });
    else expect(operation).toMatchObject({ status: 'completed', output: { status: 'failed' } });
    await tools.dispatch({ context: f.context, call });
    expect(claims).toBe(1); expect(f.calls.filter(item => item.method === 'tools/call')).toHaveLength(1);
  } finally { tools.dispose({}); await sessions.close({ context: f.context, connectionId: f.connection.connectionId }); }
});

it('MCP admission revoked during credential lookup prevents even the discovery handshake', async () => {
  const f = federationFixture(); let admitted = true;
  const sessions = bindAddonFederationSessions({ context: f.context, effects: f.effects, observer: { observe() {} },
    pluginState: async () => ({ ...await admittedFixtureState(), admitted }),
    integrations: { async access() { admitted = false; return { ok: true, value: { accessToken: 'fixture-private-token' } }; } } });
  await sessions.reload({ context: f.context, connection: f.connection });
  expect(value({ result: await sessions.definitions({ context: f.context }) })[0]).toMatchObject({ unavailableReason: expect.stringContaining('discovery unavailable') });
  expect(f.calls).toEqual([]);
  await sessions.close({ context: f.context, connectionId: f.connection.connectionId });
});

it('schema drift after catalog discovery denies tool egress and retains no stale callable', async () => {
  const f = federationFixture();
  const sessions = bindAddonFederationSessions({ pluginState: admittedFixtureState, context: f.context, effects: f.effects, observer: { observe() {} },
    integrations: { async access() { return { ok: true, value: { accessToken: 'fixture-private-token' } }; } },
    jobs: { async dispatch(input) { return input.execute({ jobId: 'fixture-job' }); } } });
  await sessions.reload({ context: f.context, connection: f.connection });
  const definition = value({ result: await sessions.definitions({ context: f.context }) })[0];
  f.changeSchema();
  expect(await definition.invoke({ context: f.context, input: { operationId: 'schema-drift', arguments: { query: 'fixture' } } })).toMatchObject({ ok: false });
  expect(f.calls.map(item => item.method)).not.toContain('tools/call');
  await sessions.close({ context: f.context, connectionId: f.connection.connectionId });
});

it('isolates unreachable MCP discovery, caches its failure until reload, and still executes a healthy tool', async () => {
  const f = federationFixture(); let failures = 0; let sequence = 0;
  const broken = { ...f.connection, connectionId: 'broken-mcp', pluginId: null, credentialConnectionId: undefined,
    server: { type: 'streamable-http' as const, url: 'https://unreachable.fixture.invalid/mcp' } };
  const sessions = bindAddonFederationSessions({ context: f.context, pluginState: admittedFixtureState, observer: { observe() {} },
    effects: { ...f.effects, exchange: { async send(input, options) {
      if (input.url.includes('unreachable.')) { failures++; throw new Error('Fixture connection timed out'); }
      return f.effects.exchange.send(input, options);
    } } },
    integrations: { async access() { return { ok: true, value: { accessToken: 'fixture-private-token' } }; } },
    jobs: { async dispatch(input) { return input.execute({ jobId: 'fixture-job' }); } } });
  await sessions.reload({ context: f.context, connection: broken });
  await sessions.reload({ context: f.context, connection: f.connection });
  const tools = createOmTools({ definitions: input => sessions.definitions(input), clock: { now: () => 1000 }, observer: { observe() {} },
    authorize: () => ({ ok: true, value: undefined }), confirmations: createMemoryConfirmationExchange({ clock: { now: () => 1000 }, ids: { next: () => 'isolated-card-' + ++sequence } }) });
  try {
    const definitions = value({ result: await sessions.definitions({ context: f.context }) });
    expect(definitions.filter(tool => tool.unavailableReason)).toHaveLength(1);
    expect(failures).toBe(1);
    const healthy = definitions.find(tool => !tool.unavailableReason)!;
    const call = { name: healthy.name, operationId: 'healthy-operation', input: { operationId: 'healthy-operation', arguments: { query: 'fixture' } } };
    expect(await tools.list({ context: f.context, limit: 100 })).toMatchObject({ ok: true });
    expect(await tools.dispatch({ context: f.context, call })).toMatchObject({ ok: true, value: { status: 'pending' } });
    const card = value({ result: await tools.card({ context: f.context, operationId: call.operationId }) })!;
    expect(await tools.answer({ context: f.context, response: { cardId: card.cardId, operationId: call.operationId, argumentsDigest: card.argumentsDigest, choice: 'allow' } })).toMatchObject({ ok: true });
    expect(await tools.operation({ context: f.context, operationId: call.operationId })).toMatchObject({ ok: true, value: { status: 'completed' } });
    expect(failures).toBe(1);
    await sessions.reload({ context: f.context, connection: broken });
    expect(await sessions.definitions({ context: f.context })).toMatchObject({ ok: true });
    expect(failures).toBe(2);
  } finally {
    tools.dispose({});
    await sessions.close({ context: f.context, connectionId: broken.connectionId });
    await sessions.close({ context: f.context, connectionId: f.connection.connectionId });
  }
});

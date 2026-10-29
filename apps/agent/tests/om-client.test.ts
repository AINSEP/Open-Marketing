/** Written-only MCP envelope regressions; the injected transport makes no network calls. */
import { expect, it } from 'vitest';
import type { StartRunRequest } from '@open-marketing/contracts';
import { boundedJsonSchema } from '@open-marketing/contracts';
import { createOmModelClient } from '../src/om-client/index.js';

const run: StartRunRequest = { protocolVersion: 1, agentInstanceId: 'agent', conversationId: 'conversation', runId: 'run',
    runBearer: 'fixture'.padEnd(64, 'x'), prompt: 'Read saved history',
    context: { scope: { ownerId: 'owner', workspaceId: 'workspace' }, principal: { kind: 'agent', agentInstanceId: 'agent', runId: 'run' },
        runId: 'run', correlationId: 'correlation', traceId: 'trace' },
    grant: { protocolVersion: 1, grantId: 'grant', agentInstanceId: 'agent', conversationId: 'conversation', runId: 'run',
        scope: { ownerId: 'owner', workspaceId: 'workspace' }, capabilities: ['context', 'events', 'model', 'tools'], expiresAt: 10000, authenticationEpoch: 1000, revoked: false } };

for (const scenario of [
    { name: 'reserved headroom with escaped text', output: '"'.repeat(32255), accepted: true },
    { name: 'payload alone fills 64 KiB', output: 'x'.repeat(65534), accepted: false },
]) it('validates the complete MCP result / ' + scenario.name, async () => {
    const output = scenario.output;
    const completed = { status: 'completed' as const, output };
    const rpc = { jsonrpc: '2.0', id: 'operation', result: { content: [{ type: 'text', text: JSON.stringify({ ok: true, value: completed }) }] } };
    const client = createOmModelClient({ serverOrigin: 'http://127.0.0.1:31000', observer: { observe() {} },
        deadline: () => ({ signal: new AbortController().signal, dispose() {} }),
        async fetch(url, options) {
            expect(String(url)).toBe('http://127.0.0.1:31000/api/agent/v1/mcp');
            expect(new Headers(options?.headers).get('authorization')).toBe('Bearer ' + run.runBearer);
            expect(JSON.parse(String(options?.body))).toMatchObject({ id: 'operation', method: 'tools/call', params: { name: 'execute_tool' } });
            return Response.json(rpc);
        } });
    const result = await client.executeTool({ run, signal: new AbortController().signal,
        call: { name: 'execute_tool', operationId: 'operation', input: { name: 'om_conversations_get', operationId: 'history', input: { id: 'conversation', limit: 1 } } } });
    expect(new TextEncoder().encode(JSON.stringify(rpc)).length).toBeLessThan(131072);
    if (scenario.accepted) {
        expect(new TextEncoder().encode(JSON.stringify(output)).length).toBe(64512);
        expect(boundedJsonSchema.safeParse(completed).success).toBe(true);
        expect(result).toEqual({ ok: true, value: completed });
    } else {
        expect(boundedJsonSchema.safeParse(output).success).toBe(true);
        expect(boundedJsonSchema.safeParse(completed).success).toBe(false);
        expect(result.ok).toBe(false);
    }
});

it.each([
    { name: 'exact cap', byteLength: 131072, invalidUtf8: false, accepted: true },
    { name: 'cap plus one', byteLength: 131073, invalidUtf8: false, accepted: false },
    { name: 'invalid UTF-8', byteLength: 256, invalidUtf8: true, accepted: false },
])('bounds and strictly decodes tools/list / $name', async scenario => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: run.grant.grantId, result: { tools: [{ name: 'fixture_tool', description: '~', inputSchema: {} }] } });
    const bytes = new TextEncoder().encode(body.padEnd(scenario.byteLength, ' '));
    if (scenario.invalidUtf8) bytes[body.indexOf('~')] = 0xFF;
    expect(bytes.byteLength).toBe(scenario.byteLength);
    const client = createOmModelClient({ serverOrigin: 'http://127.0.0.1:31000', observer: { observe() {} },
        deadline: () => ({ signal: new AbortController().signal, dispose() {} }),
        async fetch(_url, options) { expect(JSON.parse(String(options?.body))).toMatchObject({ method: 'tools/list' }); return new Response(bytes); } });
    const result = await client.loadTools!({ run, signal: new AbortController().signal });
    expect(result).toMatchObject(scenario.accepted ? { ok: true } : { ok: false, error: { code: 'unavailable' } });
});

it.each([
    { name: 'large image context', byteLength: 200000, accepted: true },
    { name: 'exact 8 MiB context cap', byteLength: 8388608, accepted: true },
    { name: 'context cap plus one', byteLength: 8388609, accepted: false },
])('permits larger responses only for context / $name', async scenario => {
    const image = { mimeType: 'image/png', data: 'AAAA'.repeat(35000) };
    const envelope = { ok: true, value: { settings: { mode: 'model', provider: 'fixture-models', model: 'fixture', connectionId: 'connection' }, messages: [], images: [image] } };
    const bytes = new TextEncoder().encode(JSON.stringify(envelope).padEnd(scenario.byteLength, ' '));
    const observed: unknown[] = [];
    const client = createOmModelClient({ serverOrigin: 'http://127.0.0.1:31000', observer: { observe(event) { observed.push(event); } },
        deadline: () => ({ signal: new AbortController().signal, dispose() {} }),
        async fetch(url) { expect(String(url)).toContain('/runs/run/context'); return new Response(bytes); } });
    const result = await client.load({ run, signal: new AbortController().signal });
    expect(result).toMatchObject(scenario.accepted ? envelope : { ok: false, error: { code: 'unavailable' } });
    expect(JSON.stringify(observed)).not.toContain(image.data);
});

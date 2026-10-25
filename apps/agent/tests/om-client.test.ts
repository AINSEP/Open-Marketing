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

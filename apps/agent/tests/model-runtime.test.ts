/** Written-only A1 proof: ONE fixture suite for memory and loopback broker transport. */
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { providerTurnAdapters } from '@jini-ai/agent-runtime/providers/tool-turn';
import type { ProviderTurnAdapters } from '@jini-ai/agent-runtime/providers/tool-turn';
import type { Outcome, RunEvent, StartRunRequest } from '@open-marketing/contracts';
import { createModelRuntime, type ModelClient } from '../src/runtime/model.js';
import { createOmModelClient } from '../src/om-client/index.js';

const bearer = 'run-fixture-'.padEnd(64, 'x');
const providerKey = 'sealed-fixture-provider-key';

function value<T>(required: { result: Outcome<T> }): T {
    if (!required.result.ok) throw new Error(required.result.error.message);
    return required.result.value;
}

function run(required: { id?: string }): StartRunRequest {
    const runId = required.id ?? 'run';
    return { protocolVersion: 1, agentInstanceId: 'agent', conversationId: 'conversation', runId, runBearer: bearer, prompt: 'Find my campaign',
        context: { scope: { ownerId: 'owner', workspaceId: 'workspace' }, principal: { kind: 'agent', agentInstanceId: 'agent', runId }, runId, correlationId: 'correlation', traceId: 'trace' },
        grant: { protocolVersion: 1, grantId: 'grant', agentInstanceId: 'agent', conversationId: 'conversation', runId,
            scope: { ownerId: 'owner', workspaceId: 'workspace' }, capabilities: ['context', 'events', 'model'], expiresAt: 10000, authenticationEpoch: 1000, revoked: false } };
}

function frame(required: { data: Record<string, unknown> }): string {
    return 'event: ' + required.data.type + '\ndata: ' + JSON.stringify(required.data) + '\n\n';
}

/** Real Anthropic wire frames parsed by the published Jini adapter, never a mocked model loop. */
function responseText(required: { tool: boolean }): string {
    const frames: Record<string, unknown>[] = [
        { type: 'message_start', message: { id: 'message', role: 'assistant', content: [], usage: { input_tokens: 1 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: required.tool ? 'Checking. ' : 'Campaign is paused.' } },
        { type: 'content_block_stop', index: 0 },
    ];
    if (required.tool) frames.push(
        { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'provider-call', name: 'om_campaigns_get', input: {} } },
        { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"campaignId":"campaign"}' } },
        { type: 'content_block_stop', index: 1 },
    );
    frames.push({ type: 'message_delta', delta: { stop_reason: required.tool ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 1 } }, { type: 'message_stop' });
    return frames.map(data => frame({ data })).join('');
}

/** Jini consumes an async-iterable body; read the web stream through its reader instead of casting. */
async function* chunksOf(required: { stream: ReadableStream<Uint8Array> }): AsyncGenerator<Uint8Array> {
    const reader = required.stream.getReader();
    for (let next = await reader.read(); !next.done; next = await reader.read()) yield next.value;
}

function pinned(required: { response: Response }) {
    const { response } = required;
    return { ok: response.ok, status: response.status, text: () => response.text(), body: response.body ? chunksOf({ stream: response.body }) : null };
}

interface GatewayRequest { url: string; headers: Headers; body: string; signal: AbortSignal }

/** Local gateway double only. Server tests independently exercise the real broker; app
 * implementation imports cannot cross the agent/server boundary, including in tests.
 */
async function gatewayRequest(required: { incoming: IncomingMessage; outgoing: ServerResponse; respond(input: GatewayRequest): Promise<Response> }): Promise<void> {
    const controller = new AbortController();
    required.outgoing.once('close', () => controller.abort());
    try {
        const chunks: Buffer[] = [];
        for await (const chunk of required.incoming) chunks.push(Buffer.from(chunk));
        const response = await required.respond({ url: required.incoming.url!, headers: new Headers({ 'x-api-key': String(required.incoming.headers['x-api-key']) }),
            body: Buffer.concat(chunks).toString('utf8'), signal: controller.signal });
        required.outgoing.writeHead(response.status, { 'content-type': response.headers.get('content-type')! });
        required.outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch { required.outgoing.destroy(); }
}

/** Jini -> OM-shaped gateway fixture, with actual tool-result feedback and abort propagation. */
async function fixture(required: { transport: 'memory' | 'http'; blocked?: boolean; pending?: boolean }) {
    const controller = new AbortController();
    const upstreamRequests: { url: string; headers: Readonly<Record<string, string>>; body: string; signal: AbortSignal }[] = [];
    const agentRequests: { url: string; apiKey: string; body: string }[] = [];
    const published: RunEvent[] = [];
    const executions: unknown[] = [];
    const clock = { now: () => 1000 };
    let nextId = 0;
    const ids = { next: () => 'id-' + ++nextId };
    async function respond(request: GatewayRequest): Promise<Response> {
        if (request.headers.get('x-api-key') !== bearer) return Response.json({ ok: false }, { status: 403 });
        const input = { url: 'https://api.anthropic.com/v1/messages', headers: { 'x-api-key': providerKey }, body: request.body, signal: request.signal };
        upstreamRequests.push(input);
        if (required.blocked) return new Promise<Response>((_resolve, reject) => input.signal.addEventListener('abort', () => reject(new Error('fixture interrupted')), { once: true }));
        return new Response(responseText({ tool: upstreamRequests.length === 1 }), { headers: { 'content-type': 'text/event-stream' } });
    }
    const server = createServer((incoming, outgoing) => { void gatewayRequest({ incoming, outgoing, respond }); });
    if (required.transport === 'http') await new Promise<void>(resolveListening => server.listen(0, '127.0.0.1', resolveListening));
    const address = server.address();
    const port = address && typeof address !== 'string' ? address.port : 32000;
    const brokerBaseUrl = 'http://127.0.0.1:' + port + '/api/agent/v1/model';
    const adapters: ProviderTurnAdapters = { ...providerTurnAdapters, anthropic: (input, options) => providerTurnAdapters.anthropic(input, { ...options,
        extraHeaders: { 'x-correlation-id': 'correlation', 'x-trace-id': 'trace' },
        async fetchImpl({ url, init }) {
            agentRequests.push({ url, apiKey: new Headers(init.headers).get('x-api-key')!, body: String(init.body) });
            if (required.transport === 'http') return pinned({ response: await fetch(url, init) });
            return pinned({ response: await respond({ url, headers: new Headers(init.headers), body: String(init.body), signal: init.signal! }) });
        },
    }) };
    const client: ModelClient = { brokerBaseUrl, system: 'Use OM tools.',
        tools: [{ name: 'om_campaigns_get', description: 'Read campaign', effects: ['read'], inputSchema: { type: 'object', properties: { campaignId: { type: 'string' } } } }],
        deadline: () => ({ signal: controller.signal, dispose() {} }),
        async load() { return { ok: true, value: { settings: { mode: 'model', provider: 'acme-models', model: 'claude-sonnet-5-5', connectionId: 'connection' }, protocol: 'anthropic', messages: [] } }; },
        async publish({ event }) { published.push(event); return { ok: true, value: undefined }; },
        async executeTool({ call }) { executions.push(call); return { ok: true, value: required.pending ? { status: 'pending', operationId: call.operationId } : { status: 'completed', output: { campaignId: 'campaign', state: 'paused' } } }; },
    };
    const runtime = createModelRuntime({ clock, ids, client, adapters });
    async function events() { return value({ result: await runtime.events({ runId: 'run', after: 0, limit: 100 }) }); }
    return { runtime, client, adapters, published, upstreamRequests, agentRequests, executions, events, controller,
        async dispose() {
            controller.abort(); await runtime.dispose({});
            server.closeAllConnections();
            if (server.listening) await new Promise<void>(resolveClosed => server.close(() => resolveClosed()));
        } };
}

for (const transport of ['memory', 'http'] as const) describe('model runtime / ' + transport, () => {
    it('streams a real Jini turn and feeds the actual tool result into request two', async () => {
        const f = await fixture({ transport });
        try {
            expect(await f.runtime.startRun(run({}))).toEqual({ ok: true, value: { runId: 'run', status: 'pending' } });
            await vi.waitFor(async () => expect((await f.events()).at(-1)?.kind).toBe('ended'));
            expect(f.agentRequests).toHaveLength(2);
            expect(f.upstreamRequests).toHaveLength(2);
            expect(f.agentRequests.every(request => request.apiKey === bearer && request.url.endsWith('/api/agent/v1/model/acme-models/v1/messages'))).toBe(true);
            const second = JSON.parse(f.upstreamRequests[1].body);
            expect(second.messages.at(-1)).toEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'provider-call', content: '{"campaignId":"campaign","state":"paused"}' }] });
            expect(second.model).toBe('claude-sonnet-5-5'); expect(second.max_tokens).toBe(4096);
            expect(f.executions).toHaveLength(1);
            expect(f.published.map(event => event.kind)).toEqual(['started', 'delta', 'tool_requested', 'tool_result', 'delta', 'ended']);
            expect(f.published.map(event => event.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
            expect(JSON.stringify(await f.events())).toContain('Campaign is paused.');
            expect(JSON.stringify(f.published)).not.toContain(providerKey); expect(JSON.stringify(f.published)).not.toContain(bearer);
        } finally { await f.dispose(); }
    });

    it('cancellation aborts the broker request and prevents late delta/ended', async () => {
        const f = await fixture({ transport, blocked: true });
        try {
            value({ result: await f.runtime.startRun(run({})) });
            await vi.waitFor(() => expect(f.upstreamRequests).toHaveLength(1));
            expect(await f.runtime.cancelRun({ protocolVersion: 1, runId: 'run', reason: 'owner' })).toMatchObject({ ok: true, value: { status: 'cancelled' } });
            await vi.waitFor(() => expect(f.upstreamRequests[0].signal.aborted).toBe(true));
            expect((await f.events()).map(event => event.kind)).toEqual(['started', 'cancelled']);
        } finally { await f.dispose(); }
    });
});

it('rejects expired, revoked, misbound, missing-token and sandbox-only grants without egress', async () => {
    const f = await fixture({ transport: 'memory' });
    try {
        const input = run({});
        for (const invalid of [{ ...input, runBearer: undefined }, { ...input, runId: 'foreign' }, { ...input, grant: { ...input.grant, revoked: true } },
            { ...input, grant: { ...input.grant, expiresAt: 1000 } }, { ...input, grant: { ...input.grant, capabilities: ['context', 'events'] } },
            { ...input, context: { ...input.context, scope: { ownerId: 'foreign', workspaceId: 'workspace' } } }]) expect((await f.runtime.startRun(invalid)).ok).toBe(false);
        expect(f.upstreamRequests).toEqual([]);
        const outside = createModelRuntime({ clock: { now: () => 1000 }, ids: { next: () => 'id' }, adapters: f.adapters,
            client: { ...f.client, brokerBaseUrl: 'https://vendor.invalid' } });
        expect((await outside.startRun(input)).ok).toBe(false); await outside.dispose({});
    } finally { await f.dispose(); }
});

it('refuses model context without a protocol before any model egress', async () => {
    const f = await fixture({ transport: 'memory' });
    f.client.load = async () => ({ ok: true, value: { settings: { mode: 'model', provider: 'anthropic', model: 'claude-sonnet-5-5', connectionId: 'connection' }, messages: [] } });
    try {
        value({ result: await f.runtime.startRun(run({})) });
        await vi.waitFor(async () => expect((await f.events()).at(-1)).toMatchObject({ kind: 'error', payload: { code: 'unavailable' } }));
        expect(f.upstreamRequests).toHaveLength(0);
        expect(f.agentRequests).toHaveLength(0);
    } finally { await f.dispose(); }
});

it('does not invent a tool result or follow-up request for pending approval', async () => {
    const f = await fixture({ transport: 'memory', pending: true });
    try {
        value({ result: await f.runtime.startRun(run({})) });
        await vi.waitFor(async () => expect((await f.events()).at(-1)?.kind).toBe('error'));
        expect(f.upstreamRequests).toHaveLength(1);
        expect((await f.events()).map(event => event.kind)).toEqual(['started', 'delta', 'tool_requested', 'error']);
    } finally { await f.dispose(); }
});

it('holds the real Jini tool callback open and sends the approved output in the next provider request', async () => {
    const f = await fixture({ transport: 'memory', pending: true });
    const approved = Promise.withResolvers<void>();
    const intervals: number[] = [];
    f.client.wait = async input => { intervals.push(input.intervalMs); await approved.promise; };
    f.client.readCard = async input => ({ ok: true, value: { cardId: 'card', operationId: input.operationId,
        argumentsDigest: 'a'.repeat(64), arguments: { tool: 'om_campaigns_get', input: { campaignId: 'campaign' } },
        classification: 'write', allowedChoices: ['allow', 'cancel'], expiresAt: 10000 } });
    f.client.operation = async input => ({ ok: true, value: { status: 'completed', operationId: input.operationId,
        output: { campaignId: 'campaign', state: 'paused', approved: true } } });
    try {
        value({ result: await f.runtime.startRun(run({})) });
        await vi.waitFor(async () => expect((await f.events()).some(event => (event.payload as { type?: string }).type === 'confirmation')).toBe(true));
        expect(f.upstreamRequests).toHaveLength(1);
        expect((await f.events()).some(event => event.kind === 'ended')).toBe(false);
        approved.resolve();
        await vi.waitFor(async () => expect((await f.events()).at(-1)?.kind).toBe('ended'));
        expect(intervals).toEqual([1000]); expect(f.executions).toHaveLength(1);
        const second = JSON.parse(f.upstreamRequests[1].body);
        expect(second.messages.at(-1).content[0].content).toBe('{"campaignId":"campaign","state":"paused","approved":true}');
        expect((await f.events()).some(event => (event.payload as { type?: string; status?: string }).type === 'confirmation_resolved'
            && (event.payload as { status?: string }).status === 'completed')).toBe(true);
    } finally { approved.resolve(); await f.dispose(); }
});

it('run cancellation interrupts an approval wait and refuses a late completed result', async () => {
    const f = await fixture({ transport: 'memory', pending: true });
    const waiting = Promise.withResolvers<void>();
    let polls = 0;
    f.client.wait = async input => {
        waiting.resolve();
        await new Promise<void>(resolve => input.signal.addEventListener('abort', () => resolve(), { once: true }));
    };
    f.client.operation = async input => { polls++; return { ok: true, value: { status: 'completed', operationId: input.operationId, output: { shouldNotArrive: true } } }; };
    try {
        value({ result: await f.runtime.startRun(run({})) }); await waiting.promise;
        value({ result: await f.runtime.cancelRun({ protocolVersion: 1, runId: 'run', reason: 'owner' }) });
        await vi.waitFor(async () => expect((await f.events()).at(-1)?.kind).toBe('cancelled'));
        expect(polls).toBe(0); expect(f.upstreamRequests).toHaveLength(1);
        expect((await f.events()).some(event => (event.payload as { result?: { status?: string } }).result?.status === 'completed')).toBe(false);
    } finally { await f.dispose(); }
});

it('refuses an operation result with a different identity and never sends it to the model', async () => {
    const f = await fixture({ transport: 'memory', pending: true });
    f.client.wait = async () => undefined;
    f.client.operation = async () => ({ ok: true, value: { status: 'completed', operationId: 'foreign', output: { stolen: true } } });
    try {
        value({ result: await f.runtime.startRun(run({})) });
        await vi.waitFor(async () => expect((await f.events()).at(-1)?.kind).toBe('error'));
        expect(f.upstreamRequests).toHaveLength(1);
        expect(JSON.stringify(await f.events())).not.toContain('stolen');
    } finally { await f.dispose(); }
});

it('stops approval polling at the accepted run deadline without a follow-up provider request', async () => {
    const f = await fixture({ transport: 'memory', pending: true });
    let now = 1000; let polls = 0;
    f.client.wait = async () => { now = 10000; };
    f.client.operation = async input => { polls++; return { ok: true, value: { status: 'completed', operationId: input.operationId, output: {} } }; };
    const runtime = createModelRuntime({ clock: { now: () => now }, ids: { next: () => 'operation' }, client: f.client, adapters: f.adapters });
    try {
        value({ result: await runtime.startRun(run({})) });
        await vi.waitFor(async () => expect(value({ result: await runtime.events({ runId: 'run', after: 0, limit: 100 }) }).at(-1)?.kind).toBe('error'));
        expect(polls).toBe(0); expect(f.upstreamRequests).toHaveLength(1);
    } finally { await runtime.dispose({}); await f.dispose(); }
});

it('uses only fixed authenticated OM MCP/operation routes and validates the SDK-enclosed outcome', async () => {
    const paths: string[] = []; const tokens: string[] = [];
    const client = createOmModelClient({ serverOrigin: 'http://127.0.0.1:31000', observer: { observe() {} },
        deadline: () => ({ signal: new AbortController().signal, dispose() {} }),
        async fetch(url, options) {
            const path = new URL(String(url)).pathname; paths.push(path); tokens.push(new Headers(options?.headers).get('authorization') ?? '');
            if (path.endsWith('/operations/operation')) return Response.json({ ok: true, value: { status: 'completed', operationId: 'operation', output: { saved: 7 } } });
            const rpc = JSON.parse(String(options?.body)) as { id: string; method: string };
            if (rpc.method === 'tools/list') return Response.json({ jsonrpc: '2.0', id: rpc.id, result: { tools: [{ name: 'execute_tool',
                description: 'Execute an OM tool', inputSchema: { type: 'object' }, annotations: { readOnlyHint: false } }] } });
            return Response.json({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: JSON.stringify({ ok: true, value: { status: 'pending', operationId: 'operation', cardId: 'card' } }) }] } });
        } });
    const input = { run: run({}), signal: new AbortController().signal };
    expect(value({ result: await client.loadTools!(input) }).map(tool => tool.name)).toEqual(['execute_tool']);
    expect(await client.executeTool({ ...input, call: { name: 'execute_tool', operationId: 'operation', input: { name: 'fixture_write', input: { value: 7 }, operationId: 'operation' } } }))
        .toEqual({ ok: true, value: { status: 'pending', operationId: 'operation', cardId: 'card' } });
    expect(await client.operation!({ ...input, operationId: 'operation' })).toEqual({ ok: true, value: { status: 'completed', operationId: 'operation', output: { saved: 7 } } });
    expect(paths).toEqual(['/api/agent/v1/mcp', '/api/agent/v1/mcp', '/api/agent/v1/runs/run/operations/operation']);
    expect(tokens.every(token => token === 'Bearer ' + bearer)).toBe(true);
});

it('reserves a terminal error at the event cap and rejects duplicate run IDs', async () => {
    const f = await fixture({ transport: 'memory' });
    const runtime = createModelRuntime({ clock: { now: () => 1000 }, ids: { next: () => 'id' }, client: f.client,
        adapters: { ...f.adapters, async anthropic(input) {
            for (let index = 0; index < 8192; index++) input.onEvent({ type: 'text_delta', delta: 'x' });
            return { stopReason: 'end_turn', toolTurns: 0 };
        } } });
    try {
        value({ result: await runtime.startRun(run({})) });
        expect(await runtime.startRun(run({}))).toMatchObject({ ok: false, error: { code: 'conflict' } });
        await vi.waitFor(async () => {
            const tail = value({ result: await runtime.events({ runId: 'run', after: 8000, limit: 1000 }) });
            expect(tail.at(-1)).toMatchObject({ sequence: 8192, kind: 'error' });
            expect(tail.some(event => event.kind === 'ended')).toBe(false);
        });
        expect(f.upstreamRequests).toEqual([]);
    } finally { await runtime.dispose({}); await f.dispose(); }
});

it('bounds retained bytes and keeps a terminal error when a provider floods large deltas', async () => {
    const f = await fixture({ transport: 'memory' });
    const runtime = createModelRuntime({ clock: { now: () => 1000 }, ids: { next: () => 'id' }, client: f.client,
        adapters: { ...f.adapters, async anthropic(input) {
            for (let index = 0; index < 100; index++) input.onEvent({ type: 'text_delta', delta: 'x'.repeat(65000) });
            return { stopReason: 'end_turn', toolTurns: 0 };
        } } });
    try {
        value({ result: await runtime.startRun(run({})) });
        await vi.waitFor(async () => {
            const events = value({ result: await runtime.events({ runId: 'run', after: 0, limit: 1000 }) });
            expect(events.at(-1)?.kind).toBe('error');
            expect(events.reduce((total, event) => total + new TextEncoder().encode(JSON.stringify(event)).length, 0)).toBeLessThanOrEqual(2097152);
        });
    } finally { await runtime.dispose({}); await f.dispose(); }
});

it('admits more than 32 completed turns, evicting oldest settled runs while retaining active work', async () => {
    const f = await fixture({ transport: 'memory' });
    const load = f.client.load; const held = Promise.withResolvers<Awaited<ReturnType<ModelClient['load']>>>();
    f.client.load = input => input.run.runId === 'active' ? held.promise : load(input);
    const released = vi.fn(); f.client.deadline = () => ({ signal: f.controller.signal, dispose: released });
    try {
        value({ result: await f.runtime.startRun(run({ id: 'active' })) });
        for (let index = 0; index < 34; index++) {
            value({ result: await f.runtime.startRun(run({ id: 'retained-' + index })) });
            await vi.waitFor(() => expect(released).toHaveBeenCalledTimes(index + 1));
        }
        expect(value({ result: await f.runtime.events({ runId: 'active', after: 0, limit: 100 }) }).map(event => event.kind)).toEqual(['started']);
        expect(await f.runtime.events({ runId: 'retained-2', after: 0, limit: 100 })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
        const expired = { ...run({ id: 'expired' }), deadlineAt: 1000 };
        expect(await f.runtime.startRun(expired)).toMatchObject({ ok: false, error: { code: 'expired' } });
        expect(await f.runtime.startRun(run({ id: 'retained-33' }))).toMatchObject({ ok: false, error: { code: 'conflict' } });
        expect(value({ result: await f.runtime.events({ runId: 'retained-3', after: 0, limit: 100 }) }).at(-1)?.kind).toBe('ended');
    } finally { held.resolve({ ok: false, error: { code: 'cancelled', message: 'fixture cleanup', retryable: false } }); await f.dispose(); }
});

it('protects all active runs and cancelled work until its asynchronous cleanup completes', async () => {
    const f = await fixture({ transport: 'memory' });
    const held = Promise.withResolvers<Awaited<ReturnType<ModelClient['load']>>>();
    f.client.load = () => held.promise;
    const released = vi.fn(); f.client.deadline = () => ({ signal: f.controller.signal, dispose: released });
    try {
        for (let index = 0; index < 32; index++) value({ result: await f.runtime.startRun(run({ id: 'held-' + index })) });
        expect(await f.runtime.startRun(run({ id: 'overflow' }))).toMatchObject({ ok: false, error: { code: 'limit_exceeded' } });
        value({ result: await f.runtime.cancelRun({ protocolVersion: 1, runId: 'held-0', reason: 'owner' }) });
        expect(await f.runtime.startRun(run({ id: 'overflow' }))).toMatchObject({ ok: false, error: { code: 'limit_exceeded' } });
        expect(value({ result: await f.runtime.events({ runId: 'held-0', after: 0, limit: 100 }) }).at(-1)?.kind).toBe('cancelled');
        held.resolve({ ok: false, error: { code: 'cancelled', message: 'fixture released', retryable: false } });
        await vi.waitFor(() => expect(released).toHaveBeenCalledTimes(33));
        value({ result: await f.runtime.startRun(run({ id: 'overflow' })) });
        expect(await f.runtime.events({ runId: 'held-0', after: 0, limit: 100 })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    } finally { held.resolve({ ok: false, error: { code: 'cancelled', message: 'fixture cleanup', retryable: false } }); await f.dispose(); }
});

it('does not evict terminal runs whose final publication is still unsettled', async () => {
    const f = await fixture({ transport: 'memory' }); const held = Promise.withResolvers<Outcome<void>>();
    const publish = f.client.publish; f.client.publish = input => input.event.kind === 'ended' ? held.promise : publish(input);
    try {
        for (let index = 0; index < 32; index++) value({ result: await f.runtime.startRun(run({ id: 'publishing-' + index })) });
        await vi.waitFor(async () => {
            for (let index = 0; index < 32; index++) expect(value({ result: await f.runtime.events({ runId: 'publishing-' + index, after: 0, limit: 100 }) }).at(-1)?.kind).toBe('ended');
        });
        expect(await f.runtime.startRun(run({ id: 'overflow' }))).toMatchObject({ ok: false, error: { code: 'limit_exceeded' } });
    } finally { held.resolve({ ok: true, value: undefined }); await f.dispose(); }
});

/** Native wire responses exercise the published parsers and their tool-result continuation. */
function nativeResponseText(required: { provider: 'openai' | 'google'; tool: boolean }): string {
    const text = required.tool ? 'Checking. ' : 'Campaign is paused.';
    if (required.provider === 'google') return 'data: ' + JSON.stringify({ candidates: [{ content: { role: 'model', parts: [
        { text }, ...(required.tool ? [{ functionCall: { id: 'provider-call', name: 'om_campaigns_get', args: { campaignId: 'campaign' } } }] : []),
    ] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3 } }) + '\n\n';
    return 'data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: text,
        ...(required.tool ? { tool_calls: [{ index: 0, id: 'provider-call', type: 'function', function: { name: 'om_campaigns_get', arguments: '{"campaignId":"campaign"}' } }] } : {}),
    }, finish_reason: required.tool ? 'tool_calls' : 'stop' }] }) + '\n\ndata: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":3}}\n\ndata: [DONE]\n\n';
}

it.each(['openai', 'google'] as const)('runs the real Jini %s adapter through fixture transport and feeds back the tool result', async provider => {
    const f = await fixture({ transport: 'memory' });
    const seen: { url: string; headers: Headers; body: string }[] = [];
    // Both foreign adapter callbacks delegate only transport; provider parsing and looping stay real.
    function respond(required: { url: string; init: RequestInit }) {
        seen.push({ url: required.url, headers: new Headers(required.init.headers), body: String(required.init.body) });
        return pinned({ response: new Response(nativeResponseText({ provider, tool: seen.length === 1 }), { headers: { 'content-type': 'text/event-stream' } }) });
    }
    const adapters: ProviderTurnAdapters = { ...f.adapters,
        openai: (input, options) => providerTurnAdapters.openai(input, { ...options, fetchImpl: async input => respond(input) }),
        google: (input, options) => providerTurnAdapters.google(input, { ...options, fetchImpl: async input => respond(input) }),
    };
    let id = 0;
    const runtime = createModelRuntime({ clock: { now: () => 1000 }, ids: { next: () => 'native-event-' + ++id }, adapters,
        client: { ...f.client, async load() { return { ok: true, value: { settings: { mode: 'model', provider, model: provider === 'openai' ? 'gpt-5.2' : 'gemini-2.5-flash', connectionId: 'own-key', effort: 'high' }, protocol: provider, messages: [] } }; } } });
    try {
        expect((await runtime.startRun(run({}))).ok).toBe(true);
        await vi.waitFor(async () => expect(value({ result: await runtime.events({ runId: 'run', after: 0, limit: 100 }) }).at(-1)?.kind).toBe('ended'));
        expect(seen).toHaveLength(2);
        const broker = f.client.brokerBaseUrl + '/' + provider;
        const suffix = provider === 'openai' ? '/chat/completions' : '/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse';
        expect(seen.map(request => request.url)).toEqual([broker + suffix, broker + suffix]);
        const authentication = provider === 'openai' ? 'authorization' : 'x-goog-api-key';
        expect(seen.map(request => request.headers.get(authentication))).toEqual(Array(2).fill(provider === 'openai' ? 'Bearer ' + bearer : bearer));
        const first = JSON.parse(seen[0].body); const second = JSON.parse(seen[1].body);
        if (provider === 'openai') {
            expect(first).toMatchObject({ model: 'gpt-5.2', max_completion_tokens: 4096, stream: true, stream_options: { include_usage: true } });
            expect(second.messages.at(-1)).toEqual({ role: 'tool', tool_call_id: 'provider-call', content: '{"campaignId":"campaign","state":"paused"}' });
        }
        if (provider === 'google') {
            expect(first.generationConfig).toEqual({ maxOutputTokens: 4096 });
            expect(second.contents.at(-1)).toEqual({ role: 'user', parts: [{ functionResponse: { id: 'provider-call', name: 'om_campaigns_get', response: { content: '{"campaignId":"campaign","state":"paused"}', isError: false } } }] });
        }
        expect(f.executions).toHaveLength(1);
        expect(f.published.map(event => event.kind)).toEqual(['started', 'delta', 'tool_requested', 'tool_result', 'delta', 'ended']);
        expect(JSON.stringify(f.published)).toContain('Campaign is paused.');
        expect(JSON.stringify(f.published)).not.toContain(bearer);
        expect(seen.map(request => request.body).join('')).not.toContain(bearer);
        expect(seen.map(request => request.body).join('')).not.toContain(providerKey);
        expect(f.upstreamRequests).toHaveLength(0);
    } finally { await runtime.dispose({}); await f.dispose(); }
});

it('passes current images through the real Jini adapter only on the final user message', async () => {
    const f = await fixture({ transport: 'memory' });
    const image = { mimeType: 'image/png' as const, data: 'aGVsbG8=' };
    f.client.load = async () => ({ ok: true, value: {
        settings: { mode: 'model', provider: 'acme-models', model: 'claude-sonnet-5-5', connectionId: 'connection' }, protocol: 'anthropic',
        messages: [{ id: 'old', role: 'user', text: 'Previous question' }, { id: 'reply', role: 'assistant', text: 'Previous answer' }], images: [image],
    } });
    try {
        value({ result: await f.runtime.startRun(run({})) });
        await vi.waitFor(async () => expect((await f.events()).at(-1)?.kind).toBe('ended'));
        const messages = JSON.parse(f.agentRequests[0].body).messages;
        expect(messages.slice(0, 2)).toEqual([{ role: 'user', content: 'Previous question' }, { role: 'assistant', content: 'Previous answer' }]);
        expect(messages.at(-1)).toEqual({ role: 'user', content: [
            { type: 'text', text: 'Find my campaign' }, { type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.data } },
        ] });
        expect(JSON.stringify(f.published)).not.toContain(image.data);
    } finally { await f.dispose(); }
});

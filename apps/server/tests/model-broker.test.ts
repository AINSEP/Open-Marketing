/** Fixture-only broker/Node transport assertions. Written for Coordinator execution. */
import { createServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import type { Outcome, RunGrantMetadata } from '@open-marketing/contracts';
import { createNodeHttpListener } from '../src/inbound/http.js';
import { handleModelRequest, type ModelUpstream } from '../src/inbound/model.js';
import type { HttpResponse } from '../src/ports.js';

const path = '/api/agent/v1/model/anthropic/v1/messages';
const token = 'fixture-run-token'.padEnd(64, 'x');
const secret = 'server-fixture-secret';
const stopped = 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
const message = { model: 'claude-sonnet-5-5', max_tokens: 4096, stream: true, messages: [{ role: 'user', content: 'fixture' }] };

function value<T>(required: { result: Outcome<T> }): T {
    if (!required.result.ok) throw new Error(required.result.error.message);
    return required.result.value;
}

function webResponse(required: { response: HttpResponse }): Response {
    const { response } = required;
    if (!response.stream) return Response.json(response.body, { status: response.status });
    const stream = response.stream;
    const iterator = stream.chunks[Symbol.asyncIterator]();
    return new Response(new ReadableStream<Uint8Array>({
        async pull(controller) {
            try {
                const next = await iterator.next();
                if (next.done) { controller.close(); await stream.cancel({}); }
                else controller.enqueue(next.value);
            } catch (error) { controller.error(error); await stream.cancel({}); }
        },
        async cancel() { await stream.cancel({}); await iterator.return?.(); },
    }), { status: response.status, headers: { 'content-type': response.contentType! } });
}

/** Both request transports reach the same real broker, with a controllable upstream fixture. */
async function fixture(required: { transport: 'memory' | 'http' }) {
    const grant: RunGrantMetadata = { protocolVersion: 1, grantId: 'grant', agentInstanceId: 'agent', runId: 'run', conversationId: 'conversation',
        scope: { ownerId: 'owner', workspaceId: 'workspace' }, capabilities: ['model'], expiresAt: 10000, revoked: false, authenticationEpoch: 1000 };
    let now = 1000;
    const deadlineController = new AbortController();
    const upstreamRequests: Parameters<ModelUpstream['send']>[0][] = [];
    const deadlines: number[] = [];
    let disposedDeadlines = 0;
    const credentials = vi.fn(async () => ({ ok: true as const, value: { apiKey: secret, model: 'claude-sonnet-5-5' } }));
    const send = vi.fn<ModelUpstream['send']>(async input => {
        upstreamRequests.push(input);
        return new Response(stopped, { headers: { 'content-type': 'text/event-stream', 'set-cookie': 'secret=' + secret, 'x-vendor-key': secret } });
    });
    const observed: unknown[] = [];
    const clock = { now: () => now };
    const upstream: ModelUpstream = { send, deadline({ timeoutMs }) { deadlines.push(timeoutMs); return { signal: deadlineController.signal, dispose() { disposedDeadlines++; } }; } };
    async function handle(request: Parameters<typeof handleModelRequest>[0]['request']) {
        if (request.path === '/ordinary') {
            const body = await request.readBody!({});
            return { status: body.ok ? 200 : 400, body };
        }
        return handleModelRequest({ request, clock, upstream,
            observer: { observe(event) { observed.push(event); } },
            credentials: { resolveProviderKey: credentials }, grants: { async verify({ authorization }) {
                if (authorization !== 'Bearer ' + token) return { ok: false, error: { code: 'forbidden', message: 'Fixture run token denied', retryable: false } };
                return { ok: true, value: structuredClone(grant) };
            } } });
    }
    const listener = createNodeHttpListener({ host: '127.0.0.1', port: 0, ids: { next: () => 'generated-id' }, observer: { observe() {} },
        effects: { createServer, schedule({ callback, delayMs }) { const timer = setTimeout(callback, delayMs); return () => clearTimeout(timer); } } });
    if (required.transport === 'http') value({ result: await listener.start({ handle }) });
    async function request(input: { body?: unknown; headers?: Record<string, string>; method?: 'GET' | 'POST'; path?: string; signal?: AbortSignal }) {
        const headers = { 'x-api-key': token, 'content-type': 'application/json', ...input.headers };
        if (required.transport === 'http') return fetch(listener.origin({})! + (input.path ?? path), {
            method: input.method ?? 'POST', headers, body: input.method === 'GET' ? undefined : JSON.stringify(input.body ?? message), signal: input.signal,
        });
        return webResponse({ response: await handle({ method: input.method ?? 'POST', path: input.path ?? path, headers, body: input.body ?? message, signal: input.signal }) });
    }
    return { request, handle, grant, credentials, send, upstreamRequests, observed, deadlines, deadlineController,
        advance(input: { now: number }) { now = input.now; },
        disposedDeadlines: () => disposedDeadlines,
        async dispose() { deadlineController.abort(); await listener.stop({}); } };
}

for (const transport of ['memory', 'http'] as const) describe('model broker / ' + transport, () => {
    it('replaces caller credentials, preserves the selected model and fixed URL, and drops upstream headers', async () => {
        const f = await fixture({ transport });
        try {
            const response = await f.request({ headers: { authorization: 'Bearer owner-fixture', cookie: 'provider=' + secret,
                'anthropic-beta': 'untrusted', 'x-correlation-id': 'correlation', 'x-trace-id': 'trace' } });
            expect(response.status).toBe(200); expect(await response.text()).toBe(stopped);
            expect(f.upstreamRequests).toHaveLength(1);
            expect(f.upstreamRequests[0]).toMatchObject({ url: 'https://api.anthropic.com/v1/messages',
                headers: { 'x-api-key': secret, 'anthropic-version': '2023-06-01', 'x-correlation-id': 'correlation', 'x-trace-id': 'trace', 'x-om-run-id': 'run' } });
            expect(JSON.parse(f.upstreamRequests[0].body)).toEqual(message);
            expect(f.upstreamRequests[0].headers).not.toHaveProperty('authorization');
            expect(f.upstreamRequests[0].headers).not.toHaveProperty('cookie');
            expect(f.upstreamRequests[0].headers).not.toHaveProperty('anthropic-beta');
            expect(response.headers.get('set-cookie')).toBeNull(); expect(response.headers.get('x-vendor-key')).toBeNull();
            expect(f.deadlines).toEqual([9000]); expect(f.disposedDeadlines()).toBe(1);
            expect(JSON.stringify(f.observed)).not.toContain(secret); expect(JSON.stringify(f.observed)).not.toContain(token);
        } finally { await f.dispose(); }
    });

    it('denies non-run, missing-capability, expired and revoked authority before key lookup', async () => {
        const f = await fixture({ transport });
        try {
            expect((await f.request({ headers: { 'x-api-key': 'service-control-token'.padEnd(64, 'x') } })).status).toBe(403);
            f.grant.revoked = true; expect((await f.request({})).status).toBe(403);
            f.grant.revoked = false; f.grant.expiresAt = 1000; expect((await f.request({})).status).toBe(403);
            f.grant.expiresAt = 10000; f.grant.capabilities = ['context', 'events']; expect((await f.request({})).status).toBe(403);
            expect(f.credentials).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
        } finally { await f.dispose(); }
    });

    it('rechecks authority after resolving the key and does not dispatch a revoked run', async () => {
        const f = await fixture({ transport });
        try {
            f.credentials.mockImplementation(async () => { f.grant.revoked = true; return { ok: true, value: { apiKey: secret, model: message.model } }; });
            expect((await f.request({})).status).toBe(403); expect(f.send).not.toHaveBeenCalled(); expect(f.disposedDeadlines()).toBe(1);
        } finally { await f.dispose(); }
    });

    it('redacts key/token fragments split across byte chunks without breaking UTF-8 SSE', async () => {
        const f = await fixture({ transport });
        try {
            const wire = 'data: {"type":"content_block_delta","delta":{"text":"café ' + secret + ' ' + token + '"}}\n\n' + stopped;
            const bytes = new TextEncoder().encode(wire);
            f.send.mockImplementation(async input => {
                f.upstreamRequests.push(input);
                return new Response(new ReadableStream<Uint8Array>({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
            });
            const response = await f.request({}); const text = await response.text();
            expect(text).toContain('café [redacted] [redacted]'); expect(text).toContain(stopped);
            expect(text).not.toContain(secret); expect(text).not.toContain(token);
        } finally { await f.dispose(); }
    });

    it('rejects malformed/oversized wire bodies and a mismatched settings model', async () => {
        const f = await fixture({ transport });
        try {
            for (const body of [{ ...message, max_tokens: 4097 }, { ...message, stream: false }, { ...message, apiKey: secret }, { ...message, messages: [] }]) {
                expect((await f.request({ body })).status).toBe(400);
            }
            expect((await f.request({ body: { ...message, messages: [{ role: 'user', content: 'x'.repeat(270000) }] } })).status).toBe(413);
            expect((await f.request({ body: { ...message, model: 'caller-selected-other-model' } })).status).toBe(503);
            expect(f.send).not.toHaveBeenCalled();
        } finally { await f.dispose(); }
    });

    it('maps provider errors to opaque failures without forwarding their bodies or retrying', async () => {
        const f = await fixture({ transport });
        try {
            f.send.mockImplementation(async input => { f.upstreamRequests.push(input); return new Response(secret + token, { status: 401 }); });
            const response = await f.request({}); expect(response.status).toBe(502);
            expect(await response.json()).toMatchObject({ ok: false, error: { code: 'unavailable', retryable: false } });
            expect(f.send).toHaveBeenCalledTimes(1); expect(f.upstreamRequests[0].signal.aborted).toBe(true);
        } finally { await f.dispose(); }
    });

    it('rejects clean EOF before message_stop and cancels the upstream reader', async () => {
        const f = await fixture({ transport });
        try {
            f.send.mockImplementation(async input => { f.upstreamRequests.push(input); return new Response('data: {"type":"content_block_delta"}\n\n', { headers: { 'content-type': 'text/event-stream' } }); });
            await expect(f.request({}).then(response => response.text())).rejects.toThrow();
            await vi.waitFor(() => expect(f.upstreamRequests[0].signal.aborted).toBe(true));
            expect(f.send).toHaveBeenCalledTimes(1);
        } finally { await f.dispose(); }
    });

    it('disconnect and injected deadline abort an idle stream and cancel its reader', async () => {
        const f = await fixture({ transport });
        try {
            const cancelled = vi.fn();
            f.send.mockImplementation(async input => {
                f.upstreamRequests.push(input);
                return new Response(new ReadableStream<Uint8Array>({
                    start(controller) { controller.enqueue(new TextEncoder().encode('data: {"type":"ping"}\n\n')); },
                    cancel: cancelled,
                }), { headers: { 'content-type': 'text/event-stream' } });
            });
            const response = await f.request({});
            const reader = response.body!.getReader();
            expect((await reader.read()).done).toBe(false);
            await reader.cancel();
            await vi.waitFor(() => expect(f.upstreamRequests[0].signal.aborted).toBe(true));
            expect(cancelled).toHaveBeenCalledTimes(1);
            const timed = await f.request({});
            const timedReader = timed.body!.getReader();
            expect((await timedReader.read()).done).toBe(false);
            f.deadlineController.abort();
            await expect(timedReader.read()).rejects.toThrow();
            expect(f.send).toHaveBeenCalledTimes(2);
        } finally { await f.dispose(); }
    });
});

it('the HTTP body increase applies only to the exact model route', async () => {
    const f = await fixture({ transport: 'http' });
    try {
        const body = { ...message, messages: [{ role: 'user', content: 'x'.repeat(150000) }] };
        const model = await f.request({ body }); expect(model.status).toBe(200); await model.text();
        const ordinary = await f.request({ body, path: '/ordinary' }); expect(ordinary.status).toBe(400);
        expect(await ordinary.json()).toMatchObject({ ok: false, error: { code: 'limit_exceeded' } });
    } finally { await f.dispose(); }
});

it('revocation during streaming fails without a second dispatch', async () => {
    const f = await fixture({ transport: 'memory' });
    try {
        let release!: () => void;
        const ready = Promise.withResolvers<void>();
        f.send.mockImplementation(async input => { f.upstreamRequests.push(input); return new Response(new ReadableStream<Uint8Array>({
            start(controller) { release = () => { f.grant.revoked = true; controller.enqueue(new TextEncoder().encode(stopped)); controller.close(); }; ready.resolve(); },
        }), { headers: { 'content-type': 'text/event-stream' } }); });
        const response = await f.request({}); await ready.promise; release();
        await expect(response.text()).rejects.toThrow(); expect(f.send).toHaveBeenCalledTimes(1);
        expect(f.upstreamRequests[0].signal.aborted).toBe(true);
    } finally { await f.dispose(); }
});

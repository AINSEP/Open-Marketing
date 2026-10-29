/** Fixture-only broker/Node transport assertions. Written for Coordinator execution. */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { modelProviderSchema } from '@open-marketing/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { Outcome, RunGrantMetadata } from '@open-marketing/contracts';
import { createNodeHttpListener } from '../src/inbound/http.js';
import { handleModelRequest, type ModelCredentials, type ModelUpstream } from '../src/inbound/model.js';
import type { HttpResponse } from '../src/ports.js';
import { captureUsage, emptyUsage } from '../src/model-protocols.js';
import { appendUsage, requestEstimate } from '../src/model-usage.js';

const path = '/api/agent/v1/model/anthropic/v1/messages';
const token = 'fixture-run-token'.padEnd(64, 'x');
const secret = 'server-fixture-secret';
const stopped = 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
const message = { model: 'claude-sonnet-5-5', max_tokens: 4096, stream: true, messages: [{ role: 'user', content: 'fixture' }] };

/** Real declaration data, with fixture credentials; no provider request is sent by this reader. */
function credentialsFixture(required: { provider: string; model?: string; effort?: string }) {
    const manifest = JSON.parse(readFileSync(new URL(`../../../content/agent-plugins/${required.provider}/plugin.json`, import.meta.url), 'utf8'));
    const declaration = modelProviderSchema.parse(manifest.extensions['io.github.ainsep.openmarketing'].modelProvider);
    return { apiKey: secret, declaration, settings: { mode: 'model' as const, provider: required.provider,
        model: required.model ?? declaration.models[0].id, connectionId: 'fixture', effort: required.effort } };
}

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
async function fixture(required: { transport: 'memory' | 'http'; usage?: Parameters<typeof handleModelRequest>[0]['usage'] }) {
    const grant: RunGrantMetadata = { protocolVersion: 1, grantId: 'grant', agentInstanceId: 'agent', runId: 'run', conversationId: 'conversation',
        scope: { ownerId: 'owner', workspaceId: 'workspace' }, capabilities: ['model'], expiresAt: 10000, revoked: false, authenticationEpoch: 1000 };
    let now = 1000;
    const deadlineController = new AbortController();
    const upstreamRequests: Parameters<ModelUpstream['send']>[0][] = [];
    const deadlines: number[] = [];
    let disposedDeadlines = 0;
    const credentials = vi.fn<ModelCredentials['resolveProviderKey']>(async () => ({ ok: true as const, value: credentialsFixture({ provider: 'anthropic', model: message.model }) }));
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
        return handleModelRequest({ request, clock, upstream, usage: required.usage,
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
    it.each([true, false, undefined])('preserves optional strict tool field %s through the broker', async strict => {
        const f = await fixture({ transport });
        try {
            const tool = { name: 'fixture_tool', description: 'Fixture', input_schema: { type: 'object' }, ...(strict === undefined ? {} : { strict }) };
            const body = { ...message, tools: [tool] };
            const response = await f.request({ body });
            expect(response.status).toBe(200); expect(await response.text()).toBe(stopped);
            expect(f.upstreamRequests).toHaveLength(1);
            expect(JSON.parse(f.upstreamRequests[0].body)).toEqual(body);
        } finally { await f.dispose(); }
    });

    it('rejects invalid strict flags and mixed-validity tool batches before egress', async () => {
        const f = await fixture({ transport });
        try {
            const tool = { name: 'fixture_tool', input_schema: { type: 'object' }, strict: true };
            for (const invalid of [{ strict: 'true' }, { strict: null }, { strict: 1 }, { unknown: true }, { name: 'x'.repeat(257) }, { description: 'x'.repeat(4097) }]) {
                expect((await f.request({ body: { ...message, tools: [tool, { ...tool, ...invalid }] } })).status).toBe(400);
            }
            expect((await f.request({ body: { ...message, tools: Array(101).fill(tool) } })).status).toBe(400);
            expect(f.credentials).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
        } finally { await f.dispose(); }
    });

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

    it.each(['anthropic', 'openai', 'google'] as const)('routes %s with matching auth, effort and durable usage before final delivery', async provider => {
        const evidence: unknown[][] = [];
        const db: NonNullable<Parameters<typeof handleModelRequest>[0]['usage']>['db'] = { async query(input) { evidence.push(input.values!); return { rows: [], rowCount: 1 }; } };
        let id = 0;
        const f = await fixture({ transport, usage: { db, ids: { next: () => 'request-' + ++id } } });
        const models = { anthropic: message.model, openai: 'gpt-5.2', google: 'gemini-2.5-flash' };
        const paths = { anthropic: path, openai: '/api/agent/v1/model/openai/chat/completions', google: '/api/agent/v1/model/google/v1beta/models/gemini-2.5-flash:streamGenerateContent' };
        const payloads = { anthropic: message, openai: { model: models.openai, stream: true, stream_options: { include_usage: true }, max_completion_tokens: 4096, messages: message.messages }, google: { contents: [{ role: 'user', parts: [{ text: 'fixture' }] }], generationConfig: { maxOutputTokens: 4096 } } };
        const frames = { anthropic: 'data: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":5}}}\n\ndata: {"type":"message_delta","usage":{"output_tokens":3}}\n\n' + stopped,
            openai: 'data: {"choices":[{"finish_reason":"stop"}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":3}}\n\ndata: [DONE]\n\n',
            google: 'data: {"candidates":[{"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":3,"thoughtsTokenCount":2}}\n\n' };
        f.credentials.mockResolvedValue({ ok: true, value: credentialsFixture({ provider, model: models[provider], effort: 'high' }) });
        f.send.mockImplementation(async input => { f.upstreamRequests.push(input); return new Response(frames[provider], { headers: { 'content-type': 'text/event-stream' } }); });
        try {
            const response = await f.request({ path: paths[provider], body: payloads[provider], headers: { authorization: 'Bearer ' + token, 'x-goog-api-key': token } });
            expect(response.status).toBe(200); await response.text();
            expect(evidence.map(row => row[1])).toEqual(['intent', 'completion']); expect(BigInt(JSON.parse(String(evidence[1][9])).costUsdMicros)).toBeGreaterThan(0n);
            const native = f.upstreamRequests[0]; const body = JSON.parse(native.body);
            if (provider === 'anthropic') { expect(native.url).toBe('https://api.anthropic.com/v1/messages'); expect(body.output_config).toEqual({ effort: 'high' }); }
            if (provider === 'openai') { expect(native.url).toBe('https://api.openai.com/v1/chat/completions'); expect(native.headers.authorization).toBe('Bearer ' + secret); expect(body.reasoning_effort).toBe('high'); expect(body.stream_options.include_usage).toBe(true); }
            if (provider === 'google') { expect(native.url).toContain('https://generativelanguage.googleapis.com/'); expect(native.headers['x-goog-api-key']).toBe(secret); expect(body.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 3072 }); }
            expect(native.body).not.toContain(secret); expect(native.body).not.toContain(token);
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
            f.credentials.mockImplementation(async () => { f.grant.revoked = true; return { ok: true, value: credentialsFixture({ provider: 'anthropic', model: message.model }) }; });
            expect((await f.request({})).status).toBe(403); expect(f.send).not.toHaveBeenCalled(); expect(f.disposedDeadlines()).toBe(1);
        } finally { await f.dispose(); }
    });

    it('rechecks revocation after a deferred intent write and sends nothing', async () => {
        const writing = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const evidence: unknown[][] = [];
        const db: NonNullable<Parameters<typeof handleModelRequest>[0]['usage']>['db'] = { async query(input) {
            writing.resolve(); await release.promise; evidence.push(input.values!);
            return { rows: [], rowCount: 1 };
        } };
        const f = await fixture({ transport, usage: { db, ids: { next: () => 'deferred-intent' } } });
        try {
            const response = f.request({});
            await writing.promise;
            expect(f.send).not.toHaveBeenCalled();
            f.grant.revoked = true;
            release.resolve();
            expect((await response).status).toBe(403);
            expect(evidence.map(row => row[1])).toEqual(['intent']);
            expect(f.send).not.toHaveBeenCalled();
            expect(f.disposedDeadlines()).toBe(1);
        } finally { release.resolve(); await f.dispose(); }
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
            expect((await f.request({ body: { ...message, messages: [{ role: 'user', content: 'x'.repeat(8388609) }] } })).status).toBe(413);
            expect((await f.request({ body: { ...message, model: 'caller-selected-other-model' } })).status).toBe(400);
            expect(f.send).not.toHaveBeenCalled();
        } finally { await f.dispose(); }
    });

    it('admits image wire blocks through the 8 MiB cap and rejects cap plus one', async () => {
        const f = await fixture({ transport });
        try {
            const body = { ...message, messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: '' } }] }] };
            const overhead = Buffer.byteLength(JSON.stringify(body));
            body.messages[0].content[0].source.data = 'A'.repeat(8388608 - overhead);
            const accepted = await f.request({ body });
            expect(accepted.status).toBe(200); await accepted.text();
            expect(JSON.parse(f.upstreamRequests[0].body).messages).toEqual(body.messages);
            body.messages[0].content[0].source.data += 'A';
            expect((await f.request({ body })).status).toBe(413);
            expect(f.send).toHaveBeenCalledTimes(1);
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

it.each(['anthropic', 'openai', 'google'] as const)('holds %s terminal frames until the completion receipt is persisted', async provider => {
    const writing = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const evidence: unknown[][] = [];
    const db: NonNullable<Parameters<typeof handleModelRequest>[0]['usage']>['db'] = { async query(input) {
        if (input.values![1] === 'completion') { writing.resolve(); await release.promise; }
        evidence.push(input.values!); return { rows: [], rowCount: 1 };
    } };
    const f = await fixture({ transport: 'memory', usage: { db, ids: { next: () => 'held-completion' } } });
    const models = { anthropic: message.model, openai: 'gpt-5.2', google: 'gemini-2.5-flash' };
    const paths = { anthropic: path, openai: '/api/agent/v1/model/openai/chat/completions', google: '/api/agent/v1/model/google/v1beta/models/gemini-2.5-flash:streamGenerateContent' };
    const bodies = { anthropic: message, openai: { model: models.openai, stream: true, stream_options: { include_usage: true }, max_completion_tokens: 4096, messages: message.messages }, google: { contents: [{ role: 'user', parts: [{ text: 'fixture' }] }], generationConfig: { maxOutputTokens: 4096 } } };
    const frames = { anthropic: stopped, openai: 'data: {"choices":[{"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', google: 'data: {"candidates":[{"finishReason":"STOP"}]}\n\n' };
    const terminal = { anthropic: 'message_stop', openai: '[DONE]', google: '"finishReason":"STOP"' };
    let delivered = '';
    f.credentials.mockResolvedValue({ ok: true, value: credentialsFixture({ provider, model: models[provider] }) });
    f.send.mockResolvedValue(new Response(frames[provider], { headers: { 'content-type': 'text/event-stream' } }));
    try {
        // Consume the broker iterator directly to exclude HTTP/web-stream prefetch from the ordering assertion.
        const response = await f.handle({ method: 'POST', path: paths[provider], body: bodies[provider], headers: { 'x-api-key': token, authorization: 'Bearer ' + token, 'x-goog-api-key': token } });
        expect(response.status).toBe(200);
        const consumption = (async () => {
            for await (const bytes of response.stream!.chunks) delivered += new TextDecoder().decode(bytes);
        })();
        await writing.promise;
        expect(evidence.map(row => row[1])).toEqual(['intent']);
        expect(delivered).not.toContain(terminal[provider]);
        release.resolve(); await consumption;
        expect(evidence.map(row => row[1])).toEqual(['intent', 'completion']);
        expect(delivered).toContain(terminal[provider]);
        await response.stream!.cancel({});
    } finally { release.resolve(); await f.dispose(); }
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

it('replaces cumulative snapshots and never charges reasoning/cache tokens twice', async () => {
 const usage = emptyUsage();
 for (const output of [3, 7, 7]) captureUsage({ protocol: 'openai', usage, data: JSON.stringify({ usage: { prompt_tokens: 100, completion_tokens: output, prompt_tokens_details: { cached_tokens: 20 }, completion_tokens_details: { reasoning_tokens: 4 } } }) });
 expect(usage.output).toBe(7);
 expect(requestEstimate({ pricing: credentialsFixture({ provider: 'openai' }).declaration.models[0].pricing, usage })).toBe('242'); // 80*1.75 + 20*0.175 + 7*14 = 241.5 micros, half-even
 const unknown = emptyUsage();
 expect(requestEstimate({ usage: unknown })).toBeUndefined();
 expect(() => captureUsage({ protocol: 'openai', usage, data: '{"usage":{"prompt_tokens":-1,"completion_tokens":7}}' })).toThrow();
});

it('routes a neutral provider and non-pinned model by its declared protocol and endpoint', async () => {
 const f = await fixture({ transport: 'memory' });
 const declaration = modelProviderSchema.parse({ protocol: 'openai', endpoint: 'https://models.example.test', label: 'Acme models', models: [{
  id: 'acme-chat-3', label: 'Acme chat', efforts: [{ id: 'high', label: 'High', request: { model: 'forged', stream: false,
   max_completion_tokens: 1, messages: [], reasoning_effort: 'high' } }] }] });
 const settings = { mode: 'model' as const, provider: 'acme-models', model: 'acme-chat-3', effort: 'high', connectionId: 'fixture' };
 const body = { model: settings.model, stream: true, max_completion_tokens: 4096, stream_options: { include_usage: true }, messages: message.messages };
 f.credentials.mockResolvedValue({ ok: true, value: { apiKey: secret, settings, declaration } });
 f.send.mockImplementation(async input => { f.upstreamRequests.push(input); return new Response('data: {"choices":[{"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }); });
 try {
  const route = '/api/agent/v1/model/acme-models/chat/completions';
  const response = await f.request({ path: route, body, headers: { authorization: 'Bearer ' + token } });
  expect(response.status).toBe(200); await response.text();
  expect(f.upstreamRequests[0].url).toBe('https://models.example.test/v1/chat/completions');
  expect(JSON.parse(f.upstreamRequests[0].body)).toEqual({ ...body, reasoning_effort: 'high' });
  expect((await f.request({ path: route.replace('acme-models', 'other-provider'), body, headers: { authorization: 'Bearer ' + token } })).status).toBe(400);
  expect((await f.request({ path: route, body: { ...body, model: 'other-model' }, headers: { authorization: 'Bearer ' + token } })).status).toBe(400);
  expect((await f.request({ path: '/api/agent/v1/model/acme-models/v1/messages', body: { ...message, model: settings.model } })).status).toBe(400);
  expect(f.send).toHaveBeenCalledTimes(1);
 } finally { await f.dispose(); }
});

it('merges a declared google effort recursively while validated contents, tools and token bounds win', async () => {
 const f = await fixture({ transport: 'memory' });
 const declaration = modelProviderSchema.parse({ protocol: 'google', endpoint: 'https://models.example.test', label: 'Fixture', models: [{
  id: 'custom-flash', label: 'Custom flash', efforts: [{ id: 'high', label: 'High', request: { contents: [], tools: [],
   generationConfig: { maxOutputTokens: 1, thinkingConfig: { thinkingBudget: 3072 } } } }] }] });
 const settings = { mode: 'model' as const, provider: 'acme-models', model: 'custom-flash', effort: 'high', connectionId: 'fixture' };
 const tools = [{ functionDeclarations: [{ name: 'fixture', parameters: { type: 'object' } }] }];
 const body = { contents: [{ role: 'user', parts: [{ text: 'fixture' }] }], tools, generationConfig: { maxOutputTokens: 4096 } };
 f.credentials.mockResolvedValue({ ok: true, value: { apiKey: secret, settings, declaration } });
 f.send.mockImplementation(async input => { f.upstreamRequests.push(input); return new Response('data: {"candidates":[{"finishReason":"STOP"}]}\n\n', { headers: { 'content-type': 'text/event-stream' } }); });
 try {
  const route = '/api/agent/v1/model/acme-models/v1beta/models/custom-flash:streamGenerateContent';
  const response = await f.request({ path: route, body, headers: { 'x-goog-api-key': token } });
  expect(response.status).toBe(200); await response.text();
  expect(f.upstreamRequests[0].url).toBe('https://models.example.test/v1beta/models/custom-flash:streamGenerateContent?alt=sse');
  expect(JSON.parse(f.upstreamRequests[0].body)).toEqual({ ...body, generationConfig: { maxOutputTokens: 4096, thinkingConfig: { thinkingBudget: 3072 } } });
  expect((await f.request({ path: route.replace('custom-flash:', 'other-flash:'), body, headers: { 'x-goog-api-key': token } })).status).toBe(400);
  expect(f.send).toHaveBeenCalledTimes(1);
 } finally { await f.dispose(); }
});

it('prices declared cache-write categories and keeps absent consumed rates unknown in receipts', async () => {
 const usage = emptyUsage();
 captureUsage({ protocol: 'anthropic', usage, data: JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 10,
  cache_read_input_tokens: 5, cache_creation_input_tokens: 5, cache_creation: { ephemeral_5m_input_tokens: 2, ephemeral_1h_input_tokens: 3 } } } }) });
 captureUsage({ protocol: 'anthropic', usage, data: '{"type":"message_delta","usage":{"output_tokens":4}}' });
 captureUsage({ protocol: 'anthropic', usage, data: '{"type":"message_stop"}' });
 const pricing = { inputUsdPerMTok: '2', outputUsdPerMTok: '10', cachedInputUsdPerMTok: '0.10',
  cacheWriteUsdPerMTok: { '5m': '2.50', '1h': '4' }, source: 'https://models.example.test/prices', observedOn: '2026-10-28' };
 const f = await fixture({ transport: 'memory' });
 const rows: unknown[][] = [];
 const db: NonNullable<Parameters<typeof handleModelRequest>[0]['usage']>['db'] = { async query(input) { rows.push(input.values!); return { rows: [], rowCount: 1 }; } };
 try {
  const cases = [pricing, undefined, { ...pricing, cacheWriteUsdPerMTok: { '5m': '2.50' } }, { ...pricing, cachedInputUsdPerMTok: undefined }];
  for (const [index, rates] of cases.entries()) await appendUsage({ db, grant: f.grant, requestId: String(index), kind: 'completion', provider: 'acme-models', model: 'custom-chat', now: 1000, usage, pricing: rates });
  const receipts = rows.map(row => JSON.parse(String(row[9])));
  expect(usage).toMatchObject({ input: 20, output: 4, cachedRead: 5, cacheWrite: { '5m': 2, '1h': 3 } });
  expect(receipts[0]).toMatchObject({ costUsdMicros: '78', source: pricing.source, observedOn: pricing.observedOn,
   rates: { inputUsdPerMTok: '2', cacheWriteUsdPerMTok: pricing.cacheWriteUsdPerMTok } });
  for (const receipt of receipts.slice(1)) expect(receipt.costUsdMicros).toBeUndefined();
  expect(receipts[0]).not.toHaveProperty('pricingDate');
 } finally { await f.dispose(); }
});

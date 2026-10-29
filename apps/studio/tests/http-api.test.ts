/** Written-only adapter contract and hostile wire tests. No live server/vendor network. */
import { describe, expect, it } from 'vitest';
import type { ApprovalResponse, Outcome, ObserverEvent } from '@open-marketing/contracts';
import { createHttpStudioApi, createSampleStudioApi, parseStudioSnapshot } from '../src/shared/api/index.js';
import type { StudioSnapshot, StudioApiPort } from '../src/shared/api/index.js';
import { testRuntime } from './support/runtime.js';

it('sends the owner stage path/body, validates its response, and keeps sample leads unavailable', async () => {
    const host = testRuntime();
    const calls: { path: string; init?: RequestInit }[] = [];
    let malformed = false;
    const lead = { leadId: 'lead-1', source: { kind: 'form', ref: 'submission-1' }, stage: 'qualified', revision: 2, erased: false, attribution: { campaign: null } };
    const api = createHttpStudioApi({ baseUrl: 'http://127.0.0.1:4321', runtime: host.runtime, observer: { observe() {} },
        fetch: async (input, init) => { calls.push({ path: new URL(String(input)).pathname, init });
            return Response.json({ ok: true, value: malformed ? { ...lead, revision: '2' } : lead }); } });
    const request = { leadId: 'lead-1', to: 'qualified' as const, expectedRevision: 1, changeId: 'change-1' };
    expect(await api.setLeadStage!({ request })).toEqual({ ok: true, value: lead });
    expect(calls[0].path).toBe('/api/leads/stage');
    expect(calls[0].init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual(request);
    malformed = true;
    expect(await api.setLeadStage!({ request: { ...request, changeId: 'change-2' } })).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    expect(await createSampleStudioApi({ runtime: host.runtime }).setLeadStage!({ request })).toMatchObject({ ok: false, error: { code: 'unavailable' } });
    expect(host.pending()).toBe(0);
});

function value<T>(required: { result: Outcome<T> }): T {
    if (!required.result.ok) throw new Error(required.result.error.message);
    return required.result.value;
}

/** Native fetch double wraps the existing sample public API; fixtures never bypass its validation. */
function sampleTransport(required: { sample: StudioApiPort; calls: RequestInit[] }): typeof fetch {
    return async (input, init) => {
        required.calls.push(init ?? {});
        const path = new URL(String(input)).pathname;
        if (path === '/api/studio/snapshot') return Response.json(await required.sample.snapshot({ signal: init?.signal ?? undefined }));
        const response: ApprovalResponse = JSON.parse(String(init?.body));
        return Response.json(await required.sample.approve({ response }));
    };
}

/** Same snapshot/approval boundary assertions run on the sample and HTTP implementation. */
for (const kind of ['sample', 'http'] as const) {
    describe(kind + ' StudioApiPort boundary', () => {
        it('returns validated repeatable snapshots and records only the exact offered approval', async () => {
            const host = testRuntime();
            const sample = createSampleStudioApi({ runtime: host.runtime });
            const calls: RequestInit[] = [];
            const api = kind === 'sample' ? sample : createHttpStudioApi({ baseUrl: 'http://127.0.0.1:4321',
                fetch: sampleTransport({ sample, calls }), runtime: host.runtime, observer: { observe() {} } });
            const first = value({ result: await api.snapshot({}) });
            expect(value({ result: await api.snapshot({}) })).toEqual(first);
            expect(parseStudioSnapshot({ input: first }).ok).toBe(true);
            const card = first.cards.find(card => card.classification === 'spend');
            expect(card).toBeDefined();
            if (!card) throw new Error('Missing fixture spend card');
            const response: ApprovalResponse = { cardId: card.cardId, operationId: card.operationId, argumentsDigest: card.argumentsDigest, choice: 'allow' };
            expect(await api.approve({ response: { ...response, argumentsDigest: 'f'.repeat(64) } })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
            expect(await api.approve({ response: { ...response, choice: 'always_allow' } })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
            expect(await api.approve({ response })).toEqual({ ok: true, value: { status: 'recorded' } });
            expect(host.pending()).toBe(0);
        });
    });
}

it('uses same-origin cookies and injected tracing without reading tokens or following redirects', async () => {
    const host = testRuntime();
    const sample = createSampleStudioApi({ runtime: host.runtime });
    const calls: RequestInit[] = [];
    const observed: ObserverEvent[] = [];
    const api = createHttpStudioApi({ baseUrl: 'http://127.0.0.1:4321', fetch: sampleTransport({ sample, calls }), runtime: host.runtime,
        observer: { observe: event => { observed.push(event); } } });
    expect((await api.snapshot({})).ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'GET', credentials: 'same-origin', redirect: 'manual' });
    const headers = new Headers(calls[0].headers);
    expect(headers.has('authorization')).toBe(false);
    expect(headers.has('cookie')).toBe(false);
    expect(headers.get('x-correlation-id')).toMatch(/^test-/);
    expect(headers.get('x-trace-id')).toMatch(/^test-/);
    expect(observed).toHaveLength(1);
    expect(observed[0].outcome).toBe('succeeded');
});

it('rejects malformed, oversized, secret-bearing and contradictory responses without a sample fallback', async () => {
    const host = testRuntime();
    const sample = createSampleStudioApi({ runtime: host.runtime });
    const snapshot: StudioSnapshot = value({ result: await sample.snapshot({}) });
    const responses = [
        { response: () => new Response('invalid'), code: 'protocol_mismatch' },
        { response: () => Response.json({ ok: true, value: snapshot, unknown: true }), code: 'protocol_mismatch' },
        { response: () => Response.json({ ok: true, value: snapshot }, { status: 500 }), code: 'protocol_mismatch' },
        { response: () => new Response(null, { status: 302, headers: { location: 'https://evil.example' } }), code: 'protocol_mismatch' },
        { response: () => new Response('x'.repeat(262145)), code: 'limit_exceeded' },
        { response: () => Response.json({ ok: true, value: { ...snapshot, workspace: 'Bearer private-fixture' } }), code: 'invalid_input' },
        { response: () => Response.json({ ok: true, value: { ...snapshot, cards: [...snapshot.cards, { invalid: true }] } }), code: 'invalid_input' },
    ];
    for (const fixture of responses) {
        const api = createHttpStudioApi({ baseUrl: 'http://127.0.0.1:4321', runtime: host.runtime, observer: { observe() {} }, fetch: async () => fixture.response() });
        expect(await api.snapshot({})).toMatchObject({ ok: false, error: { code: fixture.code } });
    }
    expect(host.pending()).toBe(0);
});

it('validates configuration and approval inputs before fetching', async () => {
    const host = testRuntime();
    let calls = 0;
    const deps = { runtime: host.runtime, observer: { observe() {} }, fetch: async () => { calls++; throw new Error('No fetch expected'); } };
    for (const baseUrl of ['file:///tmp', 'http://user:pass@localhost', 'http://localhost/path', 'http://localhost?query=1', 'invalid']) {
        expect(await createHttpStudioApi({ ...deps, baseUrl }).snapshot({})).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    }
    const api = createHttpStudioApi({ ...deps, baseUrl: 'http://127.0.0.1:4321' });
    expect(await api.snapshot({ signal: AbortSignal.abort() })).toMatchObject({ ok: false, error: { code: 'cancelled' } });
    expect(await api.approve({ response: { cardId: 'card', operationId: 'operation', argumentsDigest: 'invalid', choice: 'allow' } })).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    expect(calls).toBe(0);
});

it('dispatches assistant requests once and reports transport failures without sample fallback', async () => {
    const host = testRuntime();
    const calls: { path: string; method: string | undefined; body: BodyInit | null | undefined }[] = [];
    const api = createHttpStudioApi({ baseUrl: 'http://127.0.0.1:4321', runtime: host.runtime, observer: { observe() {} },
        async fetch(url, init) {
            const target = new URL(String(url));
            calls.push({ path: target.pathname + target.search, method: init?.method, body: init?.body });
            throw new Error('Fixture server unavailable');
        } });
    expect(await api.start({ message: { id: 'message', role: 'user', text: 'fixture' }, conversationId: 'chat', signal: new AbortController().signal })).toMatchObject({ ok: false, error: { code: 'unavailable' } });
    expect(await api.cancel({ runId: 'run', reason: 'owner' })).toMatchObject({ ok: false, error: { code: 'unavailable' } });
    const events = [];
    for await (const event of api.events({ runId: 'run', after: 0, signal: new AbortController().signal })) events.push(event);
    expect(events).toEqual([{ ok: false, error: { code: 'unavailable', message: 'Server response unavailable', retryable: false } }]);
    expect(calls).toEqual([
        { path: '/api/runs', method: 'POST', body: JSON.stringify({ prompt: 'fixture', conversationId: 'chat' }) },
        { path: '/api/runs/run/cancel', method: 'POST', body: '{}' },
        { path: '/api/runs/run/events?after=0', method: 'GET', body: undefined },
    ]);
    expect(host.pending()).toBe(0);
});

it('deadlines and abort release resources, and uncertain writes are sent once', async () => {
    const host = testRuntime();
    let calls = 0;
    const fetchUntilAbort: typeof fetch = async (_input, init) => {
        calls++;
        return new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('fixture timeout')), { once: true }));
    };
    const api = createHttpStudioApi({ baseUrl: 'http://127.0.0.1:4321', fetch: fetchUntilAbort, runtime: host.runtime, observer: { observe() {} } });
    const pending = api.approve({ response: { cardId: 'card', operationId: 'operation', argumentsDigest: 'a'.repeat(64), choice: 'allow' } });
    host.advance({ ms: 15000 });
    expect(await pending).toMatchObject({ ok: false, error: { code: 'unavailable', message: expect.stringContaining('outcome unknown') } });
    expect(calls).toBe(1);
    expect(host.pending()).toBe(0);
    const controller = new AbortController();
    const read = api.snapshot({ signal: controller.signal });
    controller.abort();
    expect(await read).toMatchObject({ ok: false, error: { code: 'cancelled' } });
    expect(host.pending()).toBe(0);
});

it('holds the deadline through streamed response consumption and rejects uncertain acknowledgements', async () => {
    const host = testRuntime();
    let cancelled = false;
    const responseReady = Promise.withResolvers<void>();
    const api = createHttpStudioApi({ baseUrl: 'http://127.0.0.1:4321', runtime: host.runtime, observer: { observe() {} },
        fetch: async (_input, init) => {
            const body = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(new TextEncoder().encode('{"ok":true,'));
                    init?.signal?.addEventListener('abort', () => { cancelled = true; controller.error(new Error('fixture body timeout')); }, { once: true });
                },
            });
            responseReady.resolve();
            return new Response(body);
        },
    });
    const pending = api.approve({ response: { cardId: 'card', operationId: 'operation', argumentsDigest: 'a'.repeat(64), choice: 'allow' } });
    await responseReady.promise;
    host.advance({ ms: 15000 });
    expect(await pending).toMatchObject({ ok: false, error: { code: 'unavailable', message: expect.stringContaining('outcome unknown') } });
    expect(cancelled).toBe(true);
    expect(host.pending()).toBe(0);
});

/** Written-only I4 runtime/control coverage. Coordinator builds before executing. */
import { createServer } from 'node:http';
import { expect, it, describe, vi } from 'vitest';
import type { ClockPort, Outcome, RunEvent, StartRunRequest } from '@open-marketing/contracts';
import { createSandboxRuntime, type SandboxContextClient } from '../src/runtime/sandbox.js';
import { createAgentApp } from '../src/composition/index.js';
import { parseAgentEnvironment } from '../src/composition/serve.js';
import { createAgentHttpListener } from '../src/inbound/http.js';
import { handleControl } from '../src/inbound/control.js';
import type { HttpRequest } from '../src/ports.js';

function value<T>(required: { result: Outcome<T> }): T {
    if (!required.result.ok) throw new Error(required.result.error.message);
    return required.result.value;
}

function run(required: { id?: string; expiresAt?: number }): StartRunRequest {
    const runId = required.id ?? 'run';
    return { protocolVersion: 1, agentInstanceId: 'instance', conversationId: 'conversation', runId, prompt: 'fixture-sensitive-prompt',
        context: { scope: { ownerId: 'owner', workspaceId: 'workspace' }, principal: { kind: 'agent', agentInstanceId: 'instance', runId }, correlationId: 'correlation', traceId: 'trace', runId },
        grant: { protocolVersion: 1, grantId: 'grant-' + runId, agentInstanceId: 'instance', conversationId: 'conversation', runId,
            scope: { ownerId: 'owner', workspaceId: 'workspace' }, capabilities: ['context', 'events'], expiresAt: required.expiresAt ?? 10000, authenticationEpoch: 1000, revoked: false } };
}

/** Deferred context is the real cancellation/expiry seam; event assertions use runtime outputs. */
function fixture(_required: Record<string, never>) {
    let now = 1000;
    const { promise: entered, resolve: loadEntered } = Promise.withResolvers<void>();
    const { promise: done, resolve: finished } = Promise.withResolvers<void>();
    const { promise: context, resolve: release } = Promise.withResolvers<Outcome<{ mode: 'local-sandbox' }>>();
    const published: RunEvent[] = [];
    const callbackRequests: StartRunRequest[] = [];
    const client: SandboxContextClient = {
        async load(input) {
            callbackRequests.push(input.run); loadEntered();
            input.signal.addEventListener('abort', () => release({ ok: false, error: { code: 'cancelled', message: 'fixture abort', retryable: false } }), { once: true });
            return context;
        },
        async publish({ event }) { published.push(event); if (['ended', 'error'].includes(event.kind)) finished(); return { ok: true, value: undefined }; },
    };
    const clock: ClockPort = { now: () => now };
    let nextId = 0;
    const runtime = createSandboxRuntime({ clock, ids: { next: () => 'event-' + ++nextId }, contextClient: client });
    return { runtime, entered, done, published, callbackRequests, release,
        advance(input: { now: number }) { now = input.now; } };
}

/** ONE control suite runs against the in-memory dispatcher and the real Node HTTP adapter. */
for (const transport of ['memory', 'http'] as const) describe('sandbox control / ' + transport, () => {
    it('reports actual readiness, admits a scoped run and returns ordered polling events', async () => {
        const fixtureRun = fixture({});
        const token = 'a'.repeat(64);
        const credential = { kind: 'service-control' as const, bearer: token };
        const auth = { verify({ supplied }: { supplied: string | undefined }) {
            return supplied === 'Bearer ' + token ? { ok: true as const, value: undefined }
                : { ok: false as const, error: { code: 'unauthenticated' as const, message: 'fixture auth', retryable: false } };
        } };
        const listener = createAgentHttpListener({ createServer, token });
        const app = createAgentApp({ listener, runtime: fixtureRun.runtime, credential, auth, runtimeAvailable: true });
        async function request(input: HttpRequest) {
            if (transport === 'memory') return handleControl({ request: input, runtime: fixtureRun.runtime, auth, credential, runtimeAvailable: true });
            const url = new URL(input.path, listener.origin({})!);
            if (input.query) url.search = new URLSearchParams(Object.entries(input.query).map(([key, entry]) => [key, String(entry)])).toString();
            const response = await fetch(url, { method: input.method, headers: { authorization: input.authorization ?? '', 'content-type': 'application/json' }, body: input.body === undefined ? undefined : JSON.stringify(input.body) });
            return { status: response.status, body: await response.json() as unknown };
        }
        try {
            if (transport === 'http') value({ result: await app.start({}) });
            const health = await request({ method: 'GET', path: '/internal/v1/health', authorization: 'Bearer ' + token });
            expect(health).toEqual({ status: 200, body: { ok: true, value: { protocolVersion: 1, ready: true, runtime: 'available' } } });
            expect((await request({ method: 'POST', path: '/internal/v1/runs', body: {} })).status).toBe(401);
            expect((await request({ method: 'POST', path: '/internal/v1/runs', authorization: 'Bearer ' + token, body: { ...run({}), unexpected: 'vendor-tool' } })).status).toBe(400);
            expect(await request({ method: 'POST', path: '/internal/v1/runs', authorization: 'Bearer ' + token, body: run({}) })).toEqual({ status: 200, body: { ok: true, value: { runId: 'run', status: 'pending' } } });
            await fixtureRun.entered;
            fixtureRun.release({ ok: true, value: { mode: 'local-sandbox' } }); await fixtureRun.done;
            const events = await request({ method: 'GET', path: '/internal/v1/runs/run/events', authorization: 'Bearer ' + token, query: { runId: 'run', after: 1, limit: 100 } });
            expect(events.status).toBe(200);
            expect(events.body).toMatchObject({ ok: true, value: [{ sequence: 2, kind: 'delta' }, { sequence: 3, kind: 'ended' }] });
            expect(JSON.stringify(events.body)).toContain('Sandbox response');
            expect(JSON.stringify(events.body)).not.toContain('fixture-sensitive-prompt');
            expect(fixtureRun.callbackRequests[0].prompt).toBe('[sandbox prompt omitted]');
            expect((await request({ method: 'GET', path: '/internal/v1/runs/other/events', authorization: 'Bearer ' + token, query: { runId: 'run', after: 0, limit: 100 } })).status).toBe(400);
        } finally { fixtureRun.release({ ok: true, value: { mode: 'local-sandbox' } }); await fixtureRun.runtime.dispose({}); if (transport === 'http') await app.stop({}); }
    });
});

it('cancels a blocked context call and never emits a later successful delta/ended', async () => {
    const f = fixture({});
    try {
        value({ result: await f.runtime.startRun(run({})) }); await f.entered;
        expect(await f.runtime.cancelRun({ protocolVersion: 1, runId: 'run', reason: 'owner' })).toEqual({ ok: true, value: { runId: 'run', status: 'cancelled' } });
        expect(value({ result: await f.runtime.events({ runId: 'run', after: 0, limit: 100 }) }).map(event => event.kind)).toEqual(['started', 'cancelled']);
        await f.runtime.dispose({});
        expect(f.published.map(event => event.kind)).toEqual(['started']);
    } finally { await f.runtime.dispose({}); }
});

it('rejects cross-field/expired/revoked grants, duplicate starts and the 33rd active run', async () => {
    const f = fixture({});
    try {
        for (const invalid of [run({ expiresAt: 1000 }), { ...run({}), runId: 'foreign' }, { ...run({}), grant: { ...run({}).grant, revoked: true } },
            { ...run({}), grant: { ...run({}).grant, capabilities: ['context', 'events', 'vendor'] } }]) expect((await f.runtime.startRun(invalid)).ok).toBe(false);
        for (let index = 0; index < 32; index++) expect((await f.runtime.startRun(run({ id: 'run-' + index }))).ok).toBe(true);
        expect(await f.runtime.startRun(run({ id: 'run-0' }))).toMatchObject({ ok: false, error: { code: 'conflict' } });
        expect(await f.runtime.startRun(run({ id: 'run-32' }))).toMatchObject({ ok: false, error: { code: 'limit_exceeded' } });
        expect((await f.runtime.events({ runId: 'missing', after: 0, limit: 100 })).ok).toBe(false);
    } finally { f.release({ ok: true, value: { mode: 'local-sandbox' } }); await f.runtime.dispose({}); }
});

it('admits more than 32 completed sandbox turns and rejects invalid input without evicting history', async () => {
    const f = fixture({}); f.release({ ok: true, value: { mode: 'local-sandbox' } });
    try {
        for (let index = 0; index < 34; index++) {
            value({ result: await f.runtime.startRun(run({ id: 'retained-' + index })) });
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(value({ result: await f.runtime.events({ runId: 'retained-' + index, after: 0, limit: 100 }) }).at(-1)?.kind).toBe('ended');
        }
        expect(await f.runtime.events({ runId: 'retained-1', after: 0, limit: 100 })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
        expect(await f.runtime.startRun({ ...run({ id: 'invalid' }), prompt: '' })).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
        expect(await f.runtime.startRun(run({ id: 'expired', expiresAt: 1000 }))).toMatchObject({ ok: false, error: { code: 'forbidden' } });
        expect(value({ result: await f.runtime.events({ runId: 'retained-2', after: 0, limit: 100 }) }).at(-1)?.kind).toBe('ended');
    } finally { await f.runtime.dispose({}); }
});

it.each([999, 1000])('rejects elapsed sandbox deadline %i before callbacks or history eviction', async deadlineAt => {
    const f = fixture({}); f.release({ ok: true, value: { mode: 'local-sandbox' } });
    try {
        for (let index = 0; index < 32; index++) {
            value({ result: await f.runtime.startRun(run({ id: 'retained-' + index })) });
            await new Promise<void>(resolve => setImmediate(resolve));
        }
        const history = value({ result: await f.runtime.events({ runId: 'retained-0', after: 0, limit: 100 }) });
        expect(history.at(-1)?.kind).toBe('ended');
        f.published.length = 0; f.callbackRequests.length = 0;
        expect(await f.runtime.startRun({ ...run({ id: 'elapsed-deadline' }), deadlineAt })).toMatchObject({ ok: false, error: { code: 'expired' } });
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(f.published).toHaveLength(0);
        expect(f.callbackRequests).toHaveLength(0);
        expect(value({ result: await f.runtime.events({ runId: 'retained-0', after: 0, limit: 100 }) })).toEqual(history);
        expect(await f.runtime.events({ runId: 'elapsed-deadline', after: 0, limit: 100 })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    } finally { await f.runtime.dispose({}); }
});

it('retains cancelled sandbox work while blocked and disposal waits for its cleanup', async () => {
    const held = Promise.withResolvers<Outcome<{ mode: 'local-sandbox' }>>(); const signals: AbortSignal[] = [];
    const runtime = createSandboxRuntime({ clock: { now: () => 1000 }, ids: { next: () => 'event' }, contextClient: {
        async load(input) { signals.push(input.signal); return held.promise; }, async publish() { return { ok: true, value: undefined }; },
    } });
    try {
        for (let index = 0; index < 32; index++) value({ result: await runtime.startRun(run({ id: 'held-' + index })) });
        value({ result: await runtime.cancelRun({ protocolVersion: 1, runId: 'held-0', reason: 'owner' }) });
        expect(await runtime.startRun(run({ id: 'overflow' }))).toMatchObject({ ok: false, error: { code: 'limit_exceeded' } });
        expect(value({ result: await runtime.events({ runId: 'held-0', after: 0, limit: 100 }) }).at(-1)?.kind).toBe('cancelled');
        let disposed = false; const disposal = runtime.dispose({}).then(() => { disposed = true; });
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(disposed).toBe(false); expect(signals).toHaveLength(32); expect(signals.every(signal => signal.aborted)).toBe(true);
        held.resolve({ ok: true, value: { mode: 'local-sandbox' } }); await disposal;
        expect(await runtime.events({ runId: 'held-0', after: 0, limit: 100 })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    } finally { held.resolve({ ok: true, value: { mode: 'local-sandbox' } }); await runtime.dispose({}); }
});

it('expiry during context and a server outage produce terminal error instead of a sandbox response', async () => {
    const f = fixture({});
    try {
        value({ result: await f.runtime.startRun(run({})) }); await f.entered;
        f.advance({ now: 10000 }); f.release({ ok: true, value: { mode: 'local-sandbox' } }); await f.done;
        const events = value({ result: await f.runtime.events({ runId: 'run', after: 0, limit: 100 }) });
        expect(events.map(event => event.kind)).toEqual(['started', 'error']);
        expect(events.some(event => event.kind === 'ended')).toBe(false);
    } finally { await f.runtime.dispose({}); }
    const unavailable = createSandboxRuntime({ clock: { now: () => 1000 }, ids: { next: () => 'event' }, contextClient: {
        async load() { throw new Error('fixture server outage'); }, async publish() { return { ok: true, value: undefined }; },
    } });
    value({ result: await unavailable.startRun(run({})) });
    await vi.waitFor(async () => expect(value({ result: await unavailable.events({ runId: 'run', after: 0, limit: 100 }) }).map(event => event.kind)).toEqual(['started', 'error']));
    await unavailable.dispose({});
});

it('validates sandbox-only environment and refuses vendor/production runtime selection', () => {
    const env = { OM_MODE: 'local-sandbox', OM_AGENT_CONTROL_TOKEN: 'a'.repeat(64), OM_AGENT_GRANT_KEY: 'b'.repeat(64), OM_AGENT_INSTANCE_ID: 'd1b7e940-4ead-4e2f-aaba-ecfaad60f301', OM_AGENT_SERVER_URL: 'http://127.0.0.1:32000' };
    expect(parseAgentEnvironment({ env }).ok).toBe(true);
    for (const invalid of [{ ...env, OM_MODE: 'production' }, { ...env, OM_AGENT_SERVER_URL: 'https://vendor.invalid/' }, { ...env, OM_AGENT_CONTROL_TOKEN: undefined }]) expect(parseAgentEnvironment({ env: invalid }).ok).toBe(false);
});

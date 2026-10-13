/** Written-only I4 process/authority/CLI coverage. Build agent/features before execution. */
import { expect, it, describe } from 'vitest';
import { randomBytes, randomUUID, createHmac } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { CallContext, ClockPort, Outcome, RunEvent, StartRunRequest } from '@open-marketing/contracts';
import { startRunSchema, parseBoundary } from '@open-marketing/contracts';
import { createLocalAgent, createNodeAgentEffects, type AgentEffects } from '../src/composition/agent.js';
import { bootServer } from '../src/composition/index.js';
import { createNodeBootIo } from '../src/composition/serve.js';
import { createNodeHttpListener } from '../src/inbound/http.js';
import { handleOmRequest } from '../src/inbound/om.js';
import { readLocalOwner } from '../src/composition/local-auth.js';
import { loadCliEnvironment } from '../src/composition/cli.js';
import { runOmCli, type CliRuntime } from '../src/cli/index.js';
import { routes, type HttpRuntime } from '../src/cli/http.js';

const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));
const sandboxText = 'Sandbox response: OM agent subprocess is connected. No model or business action was executed.';

function value<T>(required: { result: Outcome<T> }): T {
    if (!required.result.ok) throw new Error(required.result.error.message);
    return required.result.value;
}

function deadline(required: { timeoutMs: number }) {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), required.timeoutMs);
    return { signal: controller.signal, dispose: () => clearTimeout(timer) };
}

/** Concrete memory child double for ONE shared supervisor contract suite. Only OM callbacks
 * are possible; the cancellation controller also blocks late publications after owner revocation.
 */
function memoryEffects(required: { ids: HttpRuntime['ids'] }): AgentEffects {
    const states = new Map<string, { request: StartRunRequest; events: RunEvent[]; controller: AbortController; work: Promise<void> }>();
    let launch: Parameters<AgentEffects['launch']>[0];
    async function execute(input: { request: StartRunRequest; events: RunEvent[]; controller: AbortController }) {
        const request = input.request;
        const authorization = 'Bearer ' + createHmac('sha256', launch.grantKey).update(request.grant.grantId).digest('hex');
        const headers = { authorization, 'content-type': 'application/json' };
        const prefix = launch.serverUrl + '/api/agent/v1/runs/' + request.runId;
        async function publish(eventInput: { kind: RunEvent['kind']; payload: RunEvent['payload'] }) {
            const event: RunEvent = { protocolVersion: 1, eventId: required.ids.next({}), runId: request.runId, sequence: input.events.length + 1,
                correlationId: request.context.correlationId, traceId: request.context.traceId, ...eventInput };
            input.events.push(event);
            const response = await fetch(prefix + '/events', { method: 'POST', headers, body: JSON.stringify(event), signal: input.controller.signal });
            if (!response.ok) throw new Error('Fixture callback denied');
            await response.body?.cancel();
        }
        try {
            await publish({ kind: 'started', payload: {} });
            const response = await fetch(prefix + '/context', { headers, signal: input.controller.signal });
            await response.body?.cancel();
            if (!response.ok || input.controller.signal.aborted) return;
            await publish({ kind: 'delta', payload: { text: sandboxText } }); await publish({ kind: 'ended', payload: {} });
        } catch { /* A deliberately aborted double has no later success event. */ }
    }
    const memoryFetch: typeof fetch = async (urlInput, options) => {
        const url = new URL(String(urlInput));
        let result: unknown;
        if (url.pathname === '/internal/v1/health') result = { ok: true, value: { protocolVersion: 1, ready: true, runtime: 'available' } };
        else if (url.pathname === '/internal/v1/runs') {
            const request = value({ result: parseBoundary({ schema: startRunSchema, input: JSON.parse(String(options?.body)) as unknown }) });
            const events: RunEvent[] = [];
            const state = { request, events, controller: new AbortController(), work: Promise.resolve() };
            states.set(request.runId, state); state.work = execute(state);
            result = { ok: true, value: { runId: request.runId, status: 'pending' } };
        } else {
            const runId = decodeURIComponent(url.pathname.split('/')[4]); const state = states.get(runId);
            if (!state) throw new Error('Unknown fixture run');
            if (url.pathname.endsWith('/cancel')) { state.controller.abort(); result = { ok: true, value: { runId, status: 'cancelled' } }; }
            else result = { ok: true, value: state.events.filter(event => event.sequence > Number(url.searchParams.get('after'))) };
        }
        return Response.json(result);
    };
    return { runtime: { fetch: memoryFetch, ids: required.ids, env: {}, deadline: { create: deadline } }, async launch(input) {
        launch = input;
        return { ok: true, value: { origin: 'http://127.0.0.1:31000', pid: 1234, async stop() {
            for (const state of states.values()) state.controller.abort();
            await Promise.all([...states.values()].map(state => state.work)); states.clear(); input.exited();
            return { ok: true, value: undefined };
        } } };
    } };
}

/** Real server callback transport, injected time, and either a real child or memory child. */
async function processFixture(required: { adapter: 'memory' | 'process' }) {
    const ids = { next: () => randomUUID() };
    let now = Date.now();
    const clock: ClockPort = { now: () => now };
    const context: CallContext = { scope: { ownerId: randomUUID(), workspaceId: randomUUID() }, principal: { kind: 'owner', ownerId: 'fixture-owner' }, correlationId: 'correlation', traceId: 'trace' };
    let launchInput!: Parameters<AgentEffects['launch']>[0];
    let pid = 0;
    const requests: StartRunRequest[] = [];
    const effects = required.adapter === 'process' ? createNodeAgentEffects({ projectRoot, ids }) : memoryEffects({ ids });
    const runtime: HttpRuntime = { ...effects.runtime, async fetch(url, options) {
        if (new URL(String(url)).pathname === '/internal/v1/runs') requests.push(value({ result: parseBoundary({ schema: startRunSchema, input: JSON.parse(String(options?.body)) as unknown }) }));
        return effects.runtime.fetch(url, options);
    } };
    const agent = createLocalAgent({ effects: { ...effects, runtime, async launch(input) { launchInput = input; const result = await effects.launch(input); if (result.ok) pid = result.value.pid; return result; } },
        clock, ids, observer: { observe() {} }, randomToken: () => randomBytes(32).toString('hex') });
    let release!: () => void;
    let enter!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const listener = createNodeHttpListener({ host: '127.0.0.1', port: 0, ids, observer: { observe() {} }, effects: createNodeBootIo({ projectRoot, studioRoot: '', ready() {} }) });
    value({ result: await listener.start({ handle: request => handleOmRequest({ request, grants: agent.grants, clock,
        callbacks: { record: agent.callbacks.record, async context(input) { enter(); await blocked; return agent.callbacks.context(input); } } }) }) });
    const origin = listener.origin({})!;
    const started = await agent.start({ serverUrl: origin });
    if (!started.ok) { release(); await agent.stop({}); await listener.stop({}); throw new Error(started.error.message); }
    return { agent, context, entered, release, origin, pid, requests,
        async disconnectServer() { const closing = listener.stop({}); release(); await closing; },
        advance(input: { now: number }) { now = input.now; },
        grantToken(input: { grantId: string }) { return 'Bearer ' + createHmac('sha256', launchInput.grantKey).update(input.grantId).digest('hex'); },
        credentials: () => launchInput,
        async close() { release(); await agent.stop({}); await listener.stop({}); },
    };
}

/** ONE AgentEffects/supervisor suite for native process and memory double. */
for (const adapter of ['memory', 'process'] as const) describe('local agent supervisor / ' + adapter, () => {
    it('scopes grants, rejects replays with changed payloads and revokes immediately on cancellation', async () => {
        const f = await processFixture({ adapter });
        try {
            const receipt = value({ result: await f.agent.owner.start({ context: f.context, prompt: 'fixture prompt' }) }); await f.entered;
            const page = value({ result: await f.agent.owner.events({ context: f.context, runId: receipt.runId, after: 0 }) });
            expect(page.status).toBe('running'); expect(page.events.map(event => event.kind)).toEqual(['started']);
            const startedEvent = page.events[0];
            const control = f.credentials();
            const authorization = f.grantToken({ grantId: f.requests[0].grant.grantId });
            const callback = f.origin + '/api/agent/v1/runs/' + receipt.runId + '/events';
            const headers = { authorization, 'content-type': 'application/json' };
            expect((await fetch(callback, { method: 'POST', headers, body: JSON.stringify(startedEvent) })).status).toBe(200);
            expect((await fetch(callback, { method: 'POST', headers, body: JSON.stringify({ ...startedEvent, sequence: 2, kind: 'delta', payload: { text: sandboxText } }) })).status).toBe(409);
            expect((await fetch(callback, { method: 'POST', headers, body: JSON.stringify({ ...startedEvent, eventId: 'different', sequence: 2, kind: 'ended' }) })).status).toBe(409);
            expect((await fetch(f.origin + '/api/agent/v1/runs/foreign/events', { method: 'POST', headers, body: '{}' })).status).toBe(403);
            for (const path of ['/api/agent/v1/mcp', '/api/agent/v1/model/generate', '/api/runs', '/api/safety/approvals/card/answer']) {
                expect((await fetch(f.origin + path, { method: 'POST', headers, body: '{}' })).status).toBe(403);
            }
            expect(control.instanceId).not.toBe(f.context.scope.ownerId);
            const wrongToken = await fetch(f.origin + '/api/agent/v1/runs/' + receipt.runId + '/context', { headers: { authorization: 'Bearer ' + control.controlToken } });
            expect(wrongToken.status).toBe(401);
            const foreign = await f.agent.owner.events({ context: { ...f.context, scope: { ...f.context.scope, workspaceId: randomUUID() } }, runId: receipt.runId, after: 0 });
            expect(foreign).toMatchObject({ ok: false, error: { code: 'forbidden' } });
            expect(value({ result: await f.agent.owner.cancel({ context: f.context, runId: receipt.runId }) })).toEqual({ runId: receipt.runId, status: 'cancelled' });
            expect((await fetch(callback, { method: 'POST', headers, body: JSON.stringify(startedEvent) })).status).toBe(403);
            f.release();
            const cancelled = value({ result: await f.agent.owner.events({ context: f.context, runId: receipt.runId, after: 0 }) });
            expect(cancelled.status).toBe('cancelled'); expect(cancelled.events.map(event => event.kind)).toEqual(['started', 'cancelled']);
            expect(value({ result: await f.agent.owner.cancel({ context: f.context, runId: receipt.runId }) }).status).toBe('cancelled');
            expect(startedEvent.sequence).toBe(1);
        } finally { await f.close(); }
    });
    it('expires scoped authority while context is blocked and shows interruption instead of success', async () => {
        const f = await processFixture({ adapter });
        try {
            const receipt = value({ result: await f.agent.owner.start({ context: f.context, prompt: 'fixture prompt' }) }); await f.entered;
            const authorization = f.grantToken({ grantId: f.requests[0].grant.grantId });
            f.advance({ now: f.requests[0].grant.expiresAt });
            const callback = await fetch(f.origin + '/api/agent/v1/runs/' + receipt.runId + '/events', { method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: '{}' });
            expect(callback.status).toBe(403);
            expect(value({ result: await f.agent.owner.events({ context: f.context, runId: receipt.runId, after: 0 }) }).status).toBe('interrupted');
            expect((await f.agent.callbacks.context({ grant: f.requests[0].grant })).ok).toBe(false);
        } finally { await f.close(); }
    });
});

it('a server callback outage is recovered as an error through real authenticated child polling', async () => {
    const f = await processFixture({ adapter: 'process' });
    try {
        const receipt = value({ result: await f.agent.owner.start({ context: f.context, prompt: 'fixture prompt' }) }); await f.entered;
        await f.disconnectServer();
        let page = value({ result: await f.agent.owner.events({ context: f.context, runId: receipt.runId, after: 0 }) });
        for (let attempt = 0; attempt < 100 && page.status === 'running'; attempt++) {
            await new Promise<void>(resolve => setTimeout(resolve, 20));
            page = value({ result: await f.agent.owner.events({ context: f.context, runId: receipt.runId, after: 0 }) });
        }
        expect(page.status).toBe('interrupted'); expect(page.events.some(event => event.kind === 'ended')).toBe(false);
    } finally { await f.close(); }
});

it('CLI interruption cancels exactly once; malformed/foreign events print no partial transcript', async () => {
    const controller = new AbortController(); const paths: string[] = []; const output: string[] = [];
    const runtime: CliRuntime = { env: { OM_SERVER_URL: 'http://127.0.0.1:31000', OM_OWNER_TOKEN: 'fixture-owner' }, ids: { next: () => 'trace' }, clock: { now: () => 1000 },
        deadline: { create: deadline }, signal: controller.signal, confirm: async () => false, readPrompt: async function* () {},
        stdout: { write: ({ text }) => { output.push(text); } }, stderr: { write() {} }, async fetch(url) {
            const path = new URL(String(url)).pathname; paths.push(path);
            if (path === '/api/runs') { controller.abort(); return Response.json({ ok: true, value: { runId: 'run', status: 'pending' } }); }
            return Response.json({ ok: true, value: { runId: 'run', status: 'cancelled' } });
        } };
    expect(await runOmCli({ argv: ['ask', 'fixture prompt'], runtime })).toMatchObject({ ok: false, error: { code: 'cancelled' } });
    expect(paths).toEqual(['/api/runs', '/api/runs/run/cancel']);
    output.length = 0;
    const foreign: CliRuntime = { ...runtime, signal: undefined, async fetch(url) {
        if (new URL(String(url)).pathname === '/api/runs') return Response.json({ ok: true, value: { runId: 'run', status: 'pending' } });
        return Response.json({ ok: true, value: { runId: 'run', status: 'completed', events: [
            { protocolVersion: 1, eventId: 'a', runId: 'other', sequence: 1, kind: 'delta', correlationId: 'trace', traceId: 'trace', payload: { text: 'should-not-print' } },
        ] } });
    } };
    expect(await runOmCli({ argv: ['ask', 'fixture prompt'], runtime: foreign })).toMatchObject({ ok: false, error: { code: 'protocol_mismatch' } });
    expect(output.join('')).not.toContain('should-not-print');
});

it('a killed real child interrupts active runs, never restarts, and stop reaps it', async () => {
    const f = await processFixture({ adapter: 'process' });
    try {
        expect(f.pid).not.toBe(process.pid); expect(f.pid).toBeGreaterThan(0);
        const receipt = value({ result: await f.agent.owner.start({ context: f.context, prompt: 'fixture prompt' }) }); await f.entered;
        process.kill(f.pid, 'SIGKILL');
        const page = value({ result: await f.agent.owner.events({ context: f.context, runId: receipt.runId, after: 0 }) });
        expect(page.status).toBe('interrupted'); expect(page.events.some(event => event.kind === 'ended')).toBe(false);
        expect((await f.agent.owner.start({ context: f.context, prompt: 'again' })).ok).toBe(false);
    } finally { await f.close(); }
    expect(() => process.kill(f.pid, 0)).toThrow();
});

it('boot wires a real child, HTTP owner routes and om ask prompt-file polling; JSON remains one receipt', async () => {
    const directory = await fs.mkdtemp(join(tmpdir(), 'om-i4-'));
    const studioRoot = join(directory, 'studio'); const stateRoot = join(directory, 'state');
    await fs.mkdir(studioRoot); await fs.writeFile(join(studioRoot, 'index.html'), '<title>OM I4 fixture</title>');
    const promptPath = join(directory, 'prompt.txt'); await fs.writeFile(promptPath, 'fixture-sensitive-prompt');
    const clock: ClockPort = { now: () => Date.now() }; const ids = { next: () => randomUUID() };
    const result = await bootServer({ env: { OM_STATE_ROOT: stateRoot }, clock, ids, observer: { observe() {} }, io: createNodeBootIo({ projectRoot, studioRoot, ready() {} }) });
    try {
        const boot = value({ result }); const origin = new URL(boot.studioUrl).origin;
        const owner = value({ result: await readLocalOwner({ fs, stateRoot }) });
        const env = value({ result: await loadCliEnvironment({ env: { OM_STATE_ROOT: stateRoot }, fs, home: directory }) });
        const output: string[] = []; const errors: string[] = [];
        const runtime: CliRuntime = { env, ids, clock, fetch, deadline: { create: deadline }, confirm: async () => false,
            stdout: { write: ({ text }) => { output.push(text); } }, stderr: { write: ({ text }) => { errors.push(text); } },
            async *readPrompt({ path }) { yield await fs.readFile(path); } };
        value({ result: await runOmCli({ argv: ['ask', '--prompt-file', promptPath], runtime }) });
        expect(output.join('')).toContain('Sandbox response:'); expect(output.join('')).toContain('[Sandbox] ended');
        expect(output.join('')).not.toContain('fixture-sensitive-prompt'); expect(errors).toEqual([]);
        output.length = 0;
        value({ result: await runOmCli({ argv: ['ask', '--prompt-file', promptPath, '--json'], runtime }) });
        expect(output).toHaveLength(1);
        const receipt = JSON.parse(output[0]); expect(routes.ask.schema.safeParse(receipt.value).success).toBe(true);
        const headers = { authorization: 'Bearer ' + owner.token, 'content-type': 'application/json' };
        expect((await fetch(origin + '/api/runs', { method: 'POST', headers, body: JSON.stringify({ prompt: 'fixture', workspaceId: 'foreign' }) })).status).toBe(400);
        expect((await fetch(origin + '/api/runs', { method: 'POST', body: '{malformed' })).status).toBe(401);
        expect((await fetch(origin + '/api/runs/' + receipt.value.runId + '/events?after=-1', { headers })).status).toBe(400);
        expect((await fetch(origin + '/api/runs/' + receipt.value.runId + '/navigation', { method: 'POST', headers, body: '{}' })).status).toBe(403);
        expect((await fetch(origin + '/api/agent/v1/mcp', { method: 'POST', headers, body: '{}' })).status).toBe(401);
    } finally { if (result.ok) await result.value.stop({}); await fs.rm(directory, { recursive: true, force: true }); }
});

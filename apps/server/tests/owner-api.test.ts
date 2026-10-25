/** Written-only I2 HTTP/CLI coverage. Public feature dist exports must be built by Coordinator. */
import { expect, it, vi } from 'vitest';
import { createNoopObservabilityPort } from '@jini-ai/diagnostics/observability';
import { createRecentEvents } from '../src/recent-events.js';
import type { OwnerServices } from '../src/inbound/owner.js';
import Database from 'better-sqlite3';
import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { removeStateRoot } from './state-root.js';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { CallContext, Outcome, ObserverEvent } from '@open-marketing/contracts';
import { createSqlCampaignRepo, type CampaignSqlPort } from '@open-marketing/campaigns';
import { createSqlSafetyRepo, createMemoryConfirmationExchange, digestArguments, type EffectRequest } from '@open-marketing/safety';
import { bootServer } from '../src/composition/index.js';
import { createNodeBootIo } from '../src/composition/serve.js';
import { readLocalOwner, createLocalAuth } from '../src/composition/local-auth.js';
import { bindServerDatabase } from '../src/composition/database.js';
import { createNodeHttpListener } from '../src/inbound/http.js';
import { handleOwnerRequest } from '../src/inbound/owner.js';
import { runOmCli } from '../src/cli/index.js';
import type { CliRuntime } from '../src/cli/index.js';
import { routes } from '../src/cli/http.js';

function value<T>(required: { result: Outcome<T> }): T {
    if (!required.result.ok) throw new Error(required.result.error.code + ': ' + required.result.error.message);
    return required.result.value;
}

/** One real checked kernel/handle; public repository fixtures and real HTTP use the same services. */
async function ownerFixture(_required: Record<string, never>) {
    const native = new Database(':memory:');
    const context: CallContext = { scope: { ownerId: randomUUID(), workspaceId: randomUUID() }, principal: { kind: 'owner', ownerId: '' }, correlationId: 'correlation', traceId: 'trace' };
    context.principal = { kind: 'owner', ownerId: context.scope.ownerId };
    const otherContext: CallContext = { ...context, scope: { ...context.scope, workspaceId: randomUUID() } };
    const clock = { now: () => 1000 };
    const ids = { next: () => randomUUID() };
    const events: ObserverEvent[] = [];
    const observer = { observe: (event: ObserverEvent) => { events.push(event); } };
    const recentEvents = createRecentEvents({ clock, observer });
    for (const path of ['campaigns', 'safety']) native.exec(await fs.readFile(new URL(`../../../features/${path}/migrations/0001_${path}.sql`, import.meta.url), 'utf8'));
    const db = bindServerDatabase({ native, context, observer });
    const campaignDb: CampaignSqlPort = { query: <Row extends Record<string, unknown>>(input: { text: string; values?: unknown[] }) =>
        db.unit.transaction({ work: ({ session }) => session.query<Row>(input) }) };
    const campaigns = createSqlCampaignRepo({ db: campaignDb }, { observer });
    const safety = createSqlSafetyRepo({ db: { transaction: ({ execute }) => db.unit.transaction({ work: ({ session }) => execute({ session: {
        query: ({ sql, parameters }) => session.query({ text: sql, values: [...parameters] }),
    } }) }) }, clock, ids, observer, ownerTimezone: 'UTC' });
    const confirmations = createMemoryConfirmationExchange({ clock, ids });
    const services: OwnerServices = { campaigns, safety, confirmations, recentEvents };
    const token = 'a'.repeat(64);
    const auth = createLocalAuth({ credentials: { ...context.scope, token }, clock, bootstrapToken: 'b'.repeat(64) });
    const io = createNodeBootIo({ projectRoot: '', studioRoot: '', ready() {} });
    const listener = createNodeHttpListener({ host: '127.0.0.1', port: 0, effects: io, ids, observer });
    let bodyReads = 0;
    value({ result: await listener.start({ handle: async request => {
        const authenticated = auth.verify({ request, origin: listener.origin({})! });
        if (!authenticated.ok) return { status: 401, body: authenticated };
        const readBody = request.readBody;
        return handleOwnerRequest({ request: { ...request, readBody: readBody ? input => { bodyReads++; return readBody(input); } : undefined },
            context, services });
    } }) });
    const origin = listener.origin({})!;
    const output: string[] = [];
    const runtime: CliRuntime = { env: { OM_SERVER_URL: origin, OM_OWNER_TOKEN: token }, fetch, clock, ids,
        deadline: { create: () => ({ signal: AbortSignal.timeout(15000), dispose() {} }) },
        stdout: { write: ({ text }) => { output.push(text); } }, stderr: { write() {} }, confirm: async () => true, readPrompt: async function* () {} };
    return { native, context, otherContext, campaigns, safety, confirmations, events, origin, runtime, output, services, recentEvents,
        reads: () => bodyReads,
        async get(required: { path: string }) { return fetch(origin + required.path, { headers: { authorization: 'Bearer ' + token } }); },
        async post(required: { path: string; body: unknown }) { return fetch(origin + required.path, { method: 'POST', headers: {
            authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify(required.body) }); },
        async close() { await listener.stop({}); recentEvents.dispose({}); confirmations.reset({}); native.close(); },
    };
}

const draft = { operationId: 'fixture-campaign', connectionId: 'fixture-connection', accountId: 'fixture-account',
    name: 'Local campaign', objective: 'signups', creativeIds: ['fixture-creative'], creativeDigest: 'c'.repeat(64), placements: ['search'] };

function effect(required: { operationId: string }): EffectRequest {
    const args = { action: 'fixture_write' };
    return { arguments: args, pluginDigest: 'b'.repeat(64), schemaFingerprint: 'c'.repeat(64), operationScope: 'fixture.v1', envelope: {
        operationId: required.operationId, connectionId: 'fixture-connection', accountId: 'fixture-account', effects: ['write'],
        argumentsDigest: value({ result: digestArguments({ arguments: args }) }), moneyExposure: null, requiredLimit: null,
    } };
}

it('lists persisted campaigns with scoped pagination, CLI parity and actual observed status', async () => {
    const fixture = await ownerFixture({});
    try {
        const saved = value({ result: await fixture.campaigns.save({ context: fixture.context, draft }) });
        value({ result: await fixture.campaigns.save({ context: fixture.context, draft: { ...draft, operationId: 'second-campaign' } }) });
        const foreign = value({ result: await fixture.campaigns.save({ context: fixture.otherContext, draft: { ...draft, operationId: 'foreign' } }) });
        value({ result: await fixture.campaigns.observe({ context: fixture.context, state: { campaignId: saved.campaignId, state: 'active', observedAt: 1000, providerReference: 'fixture' } }) });
        const first = await (await fixture.get({ path: '/api/campaigns?limit=1' })).json();
        expect(first.ok).toBe(true);
        expect(first.value.items).toHaveLength(1);
        const second = await (await fixture.get({ path: '/api/campaigns?limit=1&cursor=' + encodeURIComponent(first.value.cursor) })).json();
        expect(second.value.cursor).toBeNull();
        expect(second.value.items[0].id).not.toBe(first.value.items[0].id);
        value({ result: await runOmCli({ argv: ['campaigns', 'show', saved.campaignId, '--json'], runtime: fixture.runtime }) });
        const row = JSON.parse(fixture.output.join(''));
        expect(row).toEqual({ ok: true, value: { id: saved.campaignId, title: draft.name, detail: draft.objective, status: 'active' } });
        expect((await fixture.get({ path: '/api/campaigns/' + foreign.campaignId })).status).toBe(404);
        for (const query of ['limit=0', 'limit=101', 'limit=1&limit=2', 'limit=1&workspaceId=foreign']) expect((await fixture.get({ path: '/api/campaigns?' + query })).status).toBe(400);
        const snapshot = await (await fixture.get({ path: '/api/studio/snapshot' })).json();
        expect(routes.snapshot.schema.safeParse(snapshot.value).success).toBe(true);
        expect(snapshot.value.mode).toBe('connected');
        expect(snapshot.value.pages).toBeUndefined();
        expect(snapshot.value.rows.campaigns).toContainEqual(row.value);
        expect(snapshot.value.cards).toEqual([]);
    } finally { await fixture.close(); }
});

it('reads and answers existing exact cards over HTTP/CLI without enqueuing or reserving any effect', async () => {
    const fixture = await ownerFixture({});
    try {
        const card = value({ result: await fixture.confirmations.present({ context: fixture.context, request: effect({ operationId: 'reviewed' }) }) });
        const foreign = value({ result: await fixture.confirmations.present({ context: fixture.otherContext, request: effect({ operationId: 'foreign-review' }) }) });
        expect((await fixture.get({ path: '/api/safety/approvals/' + foreign.cardId })).status).toBe(404);
        expect((await (await fixture.get({ path: '/api/safety/approvals?limit=10' })).json()).value.items).toEqual([card]);
        expect((await (await fixture.get({ path: '/api/studio/snapshot' })).json()).value.cards).toEqual([card]);
        const response = { cardId: card.cardId, operationId: card.operationId, argumentsDigest: card.argumentsDigest, choice: 'allow' };
        expect((await fixture.post({ path: '/api/safety/approvals/' + card.cardId + '/answer', body: { ...response, argumentsDigest: 'f'.repeat(64) } })).status).toBe(403);
        expect((await fixture.post({ path: '/api/safety/approvals/' + card.cardId + '/answer', body: { ...response, cardId: foreign.cardId } })).status).toBe(409);
        value({ result: await runOmCli({ argv: ['approvals', 'answer', card.cardId, '--choice', 'allow', '--confirm-digest', card.argumentsDigest, '--json'], runtime: fixture.runtime }) });
        expect(JSON.parse(fixture.output.join(''))).toEqual({ ok: true, value: { status: 'recorded' } });
        expect((await (await fixture.get({ path: '/api/safety/approvals' })).json()).value.items).toEqual([]);
        expect((await fixture.post({ path: '/api/safety/approvals/' + card.cardId + '/answer', body: response })).status).toBe(409);
        expect(value({ result: await fixture.safety.snapshot({ context: fixture.context, accountId: draft.accountId }) }).reserved.minorUnits).toBe(0);
        expect(fixture.native.prepare('SELECT COUNT(*) AS count FROM safety_journal').get()).toEqual({ count: 0 });
    } finally { await fixture.close(); }
});

it('authenticates before reading bodies and records only a local halt while remote stop remains pending', async () => {
    const fixture = await ownerFixture({});
    try {
        const denied = await fetch(fixture.origin + '/api/safety/halt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'invalid' });
        expect(denied.status).toBe(401);
        expect(fixture.reads()).toBe(0);
        expect((await fixture.post({ path: '/api/safety/halt', body: { accountId: draft.accountId, workspaceId: 'foreign' } })).status).toBe(400);
        value({ result: await runOmCli({ argv: ['ads', 'halt', '--account', draft.accountId, '--json'], runtime: fixture.runtime }) });
        expect(JSON.parse(fixture.output.join(''))).toEqual({ ok: true, value: { accountId: draft.accountId, status: 'pending' } });
        expect(await fixture.safety.getHalt({ context: fixture.context, accountId: draft.accountId })).toMatchObject({ ok: true, value: { remoteStatus: 'pending' } });
        expect(await fixture.safety.snapshot({ context: fixture.context, accountId: draft.accountId })).toMatchObject({ ok: true, value: { halted: true } });
        fixture.output.length = 0;
        value({ result: await runOmCli({ argv: ['settings', 'generation', 'show', '--json'], runtime: fixture.runtime }) });
        expect(JSON.parse(fixture.output.join(''))).toEqual(await (await fixture.get({ path: '/api/safety/allowance' })).json());
        expect((await fixture.post({ path: '/api/runs', body: { prompt: 'fixture' } })).status).toBe(503);
    } finally { await fixture.close(); }
});

it('real boot serves studio HTTP configuration, keeps read-only allowance free of writes and persists halt across restart', async () => {
    const directory = await fs.mkdtemp(join(tmpdir(), 'om-i2-'));
    const studioRoot = join(directory, 'studio');
    const stateRoot = join(directory, 'state');
    await fs.mkdir(studioRoot);
    await fs.writeFile(join(studioRoot, 'index.html'), '<!doctype html><html><head><title>fixture</title></head><body></body></html>');
    const handles: Database.Database[] = [];
    const events: ObserverEvent[] = [];
    const io = createNodeBootIo({ projectRoot: fileURLToPath(new URL('../../../', import.meta.url)), studioRoot, ready() {} });
    const input = { env: { OM_STATE_ROOT: stateRoot }, io: { ...io, openSqlite(required: { path: string }) { const native = io.openSqlite(required); handles.push(native); return native; } },
        ids: { next: () => randomUUID() }, clock: { now: () => 1000 }, observer: { observe: (event: ObserverEvent) => { events.push(event); } } };
    let server = value({ result: await bootServer(input) });
    try {
        const owner = value({ result: await readLocalOwner({ fs, stateRoot }) });
        let origin = new URL(server.studioUrl).origin;
        const headers = { authorization: 'Bearer ' + owner.token, 'content-type': 'application/json', 'x-correlation-id': 'owner-test-correlation', 'x-trace-id': 'owner-test-trace' };
        const html = await (await fetch(origin + '/', { headers })).text();
        expect(html).toContain('<head><meta name="om-server-url" content="/">');
        const snapshot = await (await fetch(origin + '/api/studio/snapshot', { headers })).json();
        expect(snapshot.value.workspace).toBe(owner.workspaceId);
        const localEvent = { kind: 'product', name: 'screen.viewed', at: 1000, screen: 'settings' };
        expect((await fetch(origin + '/api/dev/events', { method: 'POST', headers, body: JSON.stringify(localEvent) })).status).toBe(200);
        await fetch(origin + '/api/safety/approvals/missing/answer', { method: 'POST', headers, body: JSON.stringify({ cardId: 'missing', operationId: 'missing', argumentsDigest: 'a'.repeat(64), choice: 'allow' }) });
        expect((await (await fetch(origin + '/api/dev/events', { headers })).json()).value.items).toEqual([localEvent,
            { kind: 'trace', name: 'approval.submit', at: 1000, correlationId: 'owner-test-correlation', traceId: 'owner-test-trace', outcome: 'error' }]);
        expect(snapshot.value.allowance.remaining.minorUnits).toBe(1000);
        expect(handles[0].prepare('SELECT COUNT(*) AS count FROM safety_state').get()).toEqual({ count: 0 });
        expect(await (await fetch(origin + '/api/safety/halt', { method: 'POST', headers, body: JSON.stringify({ accountId: 'local-account' }) })).json()).toEqual({ ok: true, value: { accountId: 'local-account', status: 'pending' } });
        expect(events).toContainEqual({ operation: 'safety.sql.transaction', outcome: 'ok', correlationId: 'owner-test-correlation', traceId: 'owner-test-trace', runId: undefined });
        await server.stop({});
        server = value({ result: await bootServer(input) });
        origin = new URL(server.studioUrl).origin;
        expect((await (await fetch(origin + '/api/dev/events', { headers })).json()).value.items).toEqual([]);
        expect(await (await fetch(origin + '/api/safety/halt', { method: 'POST', headers, body: JSON.stringify({ accountId: 'local-account' }) })).json()).toEqual({ ok: true, value: { accountId: 'local-account', status: 'pending' } });
        expect(handles[1].prepare('SELECT COUNT(*) AS count FROM safety_journal').get()).toEqual({ count: 1 });
    } finally { await server.stop({}); await removeStateRoot({ path: directory }); }
});

it('authenticates event ingestion before body reads, enforces origin/bytes and rejects trace claims', async () => {
    const fixture = await ownerFixture({});
    try {
        const path = '/api/dev/events'; const event = { kind: 'product', name: 'screen.viewed', at: 1, screen: 'settings' };
        expect((await fetch(fixture.origin + path, { method: 'POST', body: 'invalid' })).status).toBe(401);
        expect((await fetch(fixture.origin + path)).status).toBe(401); expect(fixture.reads()).toBe(0);
        expect((await fetch(fixture.origin + path, { method: 'POST', headers: { authorization: 'Bearer ' + 'a'.repeat(64), origin: 'https://foreign.test' }, body: '{}' })).status).toBe(403);
        expect((await fixture.post({ path, body: event })).status).toBe(200);
        expect((await fixture.post({ path, body: { ...event, token: 'private' } })).status).toBe(400);
        expect((await fixture.post({ path, body: { kind: 'trace', name: 'approval.submit', at: 1, correlationId: 'c', traceId: 't', outcome: 'recorded' } })).status).toBe(400);
        expect((await fixture.post({ path, body: { ...event, private: 'x'.repeat(2048) } })).status).toBe(413);
        expect((await (await fixture.get({ path })).json()).value).toEqual({ items: [event] });
        const headers = { authorization: 'Bearer ' + 'a'.repeat(64), 'content-type': 'application/json' };
        expect((await fetch(fixture.origin + path, { method: 'POST', headers, body: JSON.stringify(event).padEnd(2048) })).status).toBe(200);
        expect((await fetch(fixture.origin + path, { method: 'POST', headers, body: JSON.stringify(event).padEnd(2049) })).status).toBe(413);
    } finally { await fixture.close(); }
});

it.each(['none', 'create', 'end', 'observer', 'clock'].flatMap(fault => [false, true].map(catalog => ({ fault, catalog }))))('preserves catalog=$catalog with $fault diagnostic failure', async ({ fault, catalog }) => {
    const fixture = await ownerFixture({});
    const confirm = vi.spyOn(fixture.confirmations, 'confirm');
    try {
        const card = value({ result: await fixture.confirmations.present({ context: fixture.context, request: effect({ operationId: 'instrumented' }) }) });
        const unused = async () => { throw new Error('Unexpected fixture call'); };
        if (catalog) fixture.services.tools = { card: async () => ({ ok: true, value: card }), answer: input => fixture.confirmations.confirm(input),
            list: unused, describe: unused, dispatch: unused, operation: unused, restore: unused, cancel: unused, dispose: unused };
        const end = vi.fn(() => { if (fault === 'end') throw new Error('fixture'); });
        const trackRequest = vi.fn(() => { if (fault === 'create') throw new Error('fixture'); return { end }; });
        fixture.services.observability = { ...createNoopObservabilityPort({}), trackRequest };
        fixture.services.recentEvents = createRecentEvents({ clock: { now() { if (fault === 'clock') throw new Error('fixture'); return 1000; } },
            observer: { observe(event) { if (fault === 'observer') throw new Error('fixture'); fixture.events.push(event); } } });
        const body = { cardId: card.cardId, operationId: card.operationId, argumentsDigest: card.argumentsDigest, choice: 'allow' };
        expect(await (await fixture.post({ path: '/api/safety/approvals/' + card.cardId + '/answer', body })).json()).toEqual({ ok: true, value: { status: 'recorded' } });
        expect(confirm).toHaveBeenCalledTimes(1);
        expect(confirm.mock.calls[0][0].context).toEqual(fixture.context);
        expect(trackRequest).toHaveBeenCalledWith({ method: 'POST', path: '/api/safety/approvals/:id/answer' }, { requestId: fixture.context.correlationId });
        expect(end).toHaveBeenCalledTimes(fault === 'create' ? 0 : 1);
        if (fault !== 'create') expect(end).toHaveBeenCalledWith({ statusCode: 200, routePattern: '/api/safety/approvals/:id/answer' });
        const repeated = await fixture.post({ path: '/api/safety/approvals/' + card.cardId + '/answer', body });
        expect(repeated.status).toBe(409); expect(confirm).toHaveBeenCalledTimes(2);
        if (fault !== 'create') expect(end).toHaveBeenLastCalledWith({ statusCode: 409, routePattern: '/api/safety/approvals/:id/answer' });
        expect(fixture.services.recentEvents.recent({}).items).toEqual(fault === 'clock' ? [] : [
            { kind: 'trace', name: 'approval.submit', at: 1000, correlationId: 'correlation', traceId: 'trace', outcome: 'recorded' },
            { kind: 'trace', name: 'approval.submit', at: 1000, correlationId: 'correlation', traceId: 'trace', outcome: 'error' }]);
    } finally { confirm.mockRestore(); await fixture.close(); }
});

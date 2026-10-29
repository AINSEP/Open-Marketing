/** Written-only I2 HTTP/CLI coverage. Public feature dist exports must be built by Coordinator. */
import { expect, it, vi } from 'vitest';
import { createRecentEvents } from '../src/recent-events.js';
import { createSqliteChatStore } from '@jini-ai/chat/store/sqlite';
import { createDurableRunStore, createChatRunLedger } from '@jini-ai/chat/store/runtime';
import type { StorageKernel } from '@jini-ai/db/kernel';
import { uploadMedia } from '@jini-ai/cms/media';
import { createMemoryJiniDependencies, createMemoryJiniMedia, createMemoryMediaRepo, createMemoryMediaAudit, createMemoryGuardedAssetImport, createMemoryImageTransform, createMediaLibrary } from '@open-marketing/media-library';
import { createAssistantRuns, type AssistantDatabase } from '../src/runs.js';
import { createConversations } from '../src/conversations.js';
import type { AssistantContext, RunGrantMetadata } from '@open-marketing/contracts';
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
import { readLocalOwner, createLocalAuth, localApprover } from '../src/composition/local-auth.js';
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
    const recentEvents = createRecentEvents({});
    for (const path of ['campaigns', 'safety']) native.exec(await fs.readFile(new URL(`../../../features/${path}/migrations/0001_${path}.sql`, import.meta.url), 'utf8'));
    const db = bindServerDatabase({ native, context, observer });
    const campaignDb: CampaignSqlPort = { query: <Row extends Record<string, unknown>>(input: { text: string; values?: unknown[] }) =>
        db.unit.transaction({ work: ({ session }) => session.query<Row>(input) }) };
    const campaigns = createSqlCampaignRepo({ db: campaignDb }, { observer });
    const safety = createSqlSafetyRepo({ db: db.unit, clock, ids, observer, ownerTimezone: 'UTC' });
    const answers: unknown[] = [];
    const confirmations = createMemoryConfirmationExchange({ clock, ids, async recordAnswer(input) { answers.push(structuredClone(input)); return { ok: true, value: undefined }; } });
    const approver = localApprover({ credentials: { ...context.scope, token: "a".repeat(64) } });
    const services: OwnerServices = { campaigns, safety, confirmations, recentEvents, approver };
    const token = 'a'.repeat(64);
    const auth = createLocalAuth({ credentials: { ...context.scope, token }, clock, bootstrapToken: 'b'.repeat(64) });
    const io = createNodeBootIo({ projectRoot: '', studioRoot: '', ready() {} });
    const listener = createNodeHttpListener({ host: '127.0.0.1', port: 0, effects: io, ids, observer });
    let bodyReads = 0;
    value({ result: await listener.start({ handle: async request => {
        const authenticated = auth.verify({ request, origin: listener.origin({})! });
        if (!authenticated.ok) return { status: 401, body: authenticated };
        const readBody = request.readBody;
        const readRawBody = request.readRawBody;
        return handleOwnerRequest({ request: { ...request, readRawBody: readRawBody ? input => { bodyReads++; return readRawBody(input); } : undefined, readBody: readBody ? input => { bodyReads++; return readBody(input); } : undefined },
            context, services });
    } }) });
    const origin = listener.origin({})!;
    const output: string[] = [];
    const runtime: CliRuntime = { env: { OM_SERVER_URL: origin, OM_OWNER_TOKEN: token }, fetch, clock, ids,
        deadline: { create: () => ({ signal: AbortSignal.timeout(15000), dispose() {} }) },
        stdout: { write: ({ text }) => { output.push(text); } }, stderr: { write() {} }, confirm: async () => true, readPrompt: async function* () {} };
    return { native, db, clock, ids, observer, token, context, otherContext, campaigns, safety, confirmations, answers, approver, events, origin, runtime, output, services, recentEvents,
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

it.each([false, true])('rejects forged and missing trusted approvers on catalog=%s answer paths', async catalog => {
    const fixture = await ownerFixture({});
    try {
        const card = value({ result: await fixture.confirmations.present({ context: fixture.context, request: effect({ operationId: 'identity-bound' }) }) });
        const unused = async () => { throw new Error('Unexpected fixture call'); };
        if (catalog) fixture.services.tools = { card: async () => ({ ok: true, value: card }), answer: input => fixture.confirmations.confirm(input),
            list: unused, describe: unused, dispatch: unused, operation: unused, restore: unused, cancel: unused, dispose: unused };
        const body = { cardId: card.cardId, operationId: card.operationId, argumentsDigest: card.argumentsDigest, choice: 'allow' };
        const path = '/api/safety/approvals/' + card.cardId + '/answer';
        expect((await fixture.post({ path, body: { ...body, approver: fixture.approver } })).status).toBe(400);
        const { approver: _approver, ...missingIdentity } = fixture.services;
        expect(await handleOwnerRequest({ request: { method: 'POST', path, body }, context: fixture.context, services: missingIdentity })).toMatchObject({ status: 401, body: { ok: false, error: { code: 'unauthenticated' } } });
        expect(fixture.answers).toEqual([]);
        expect((await fixture.post({ path, body })).status).toBe(200);
        expect(fixture.answers).toEqual([{ context: fixture.context, answer: { response: body, approver: fixture.approver, answeredAt: 1000 } }]);
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
        expect((await (await fetch(origin + '/api/dev/events', { headers })).json()).value.items).toEqual([localEvent]);
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

it.each([false, true])('answers once and rejects repeated answers on catalog=%s paths', async catalog => {
    const fixture = await ownerFixture({});
    const confirm = vi.spyOn(fixture.confirmations, 'confirm');
    try {
        const card = value({ result: await fixture.confirmations.present({ context: fixture.context, request: effect({ operationId: 'instrumented' }) }) });
        const unused = async () => { throw new Error('Unexpected fixture call'); };
        if (catalog) fixture.services.tools = { card: async () => ({ ok: true, value: card }), answer: input => fixture.confirmations.confirm(input),
            list: unused, describe: unused, dispatch: unused, operation: unused, restore: unused, cancel: unused, dispose: unused };
        const body = { cardId: card.cardId, operationId: card.operationId, argumentsDigest: card.argumentsDigest, choice: 'allow' };
        expect(await (await fixture.post({ path: '/api/safety/approvals/' + card.cardId + '/answer', body })).json()).toEqual({ ok: true, value: { status: 'recorded' } });
        expect(confirm).toHaveBeenCalledTimes(1);
        expect(confirm.mock.calls[0][0].context).toEqual(fixture.context);
        expect(confirm.mock.calls[0][0].approver).toEqual(fixture.approver);
        expect(fixture.answers).toEqual([{ context: fixture.context, answer: { response: body, approver: fixture.approver, answeredAt: 1000 } }]);
        const repeated = await fixture.post({ path: '/api/safety/approvals/' + card.cardId + '/answer', body });
        expect(repeated.status).toBe(409); expect(confirm).toHaveBeenCalledTimes(2);
    } finally { confirm.mockRestore(); await fixture.close(); }
});

const attachmentBytes = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQx8AAAAASUVORK5CYII=', 'base64'));

it('authenticates image uploads before body reads and enforces the raw 1 MiB cap', async () => {
    const f = await ownerFixture({});
    const upload = vi.fn().mockResolvedValue({ ok: true, value: { record: { id: 'asset' } } });
    f.services.media = { uploadImage: upload };
    try {
        const url = f.origin + '/api/attachments?name=private-name.png';
        expect((await fetch(url, { method: 'POST', body: attachmentBytes })).status).toBe(401);
        expect(f.reads()).toBe(0); expect(upload).not.toHaveBeenCalled();
        const headers = { authorization: 'Bearer ' + f.token, 'content-type': 'application/zip' };
        expect((await fetch(url, { method: 'POST', headers, body: new Uint8Array(1048577) })).status).toBe(413);
        expect(upload).not.toHaveBeenCalled();
        const accepted = await fetch(url, { method: 'POST', headers, body: attachmentBytes });
        expect(await accepted.json()).toEqual({ ok: true, value: { path: 'asset', name: 'private-name.png', kind: 'image', size: attachmentBytes.length } });
        expect(upload.mock.calls[0][0]).toMatchObject({ filename: 'private-name.png', contentTypes: ['image/png', 'image/jpeg', 'image/webp'] });
        expect(JSON.stringify(f.events)).not.toContain('private-name');
        for (const name of ['bad%00name.png', 'bad%2Fname.png']) expect((await fetch(f.origin + '/api/attachments?name=' + name, { method: 'POST', headers, body: attachmentBytes })).status).toBe(400);
        expect(upload).toHaveBeenCalledTimes(1);
    } finally { await f.close(); }
});

it.each([
    { code: 'invalid_input', message: 'Unsupported image format', status: 400, expected: 'Unsupported image format' },
    { code: 'unavailable', message: 'private upstream failure', status: 503, expected: 'Image upload unavailable' },
])('returns the safe image upload refusal for $code', async ({ code, message, status, expected }) => {
    const f = await ownerFixture({});
    f.services.media = { uploadImage: vi.fn().mockResolvedValue({ ok: false, error: { code, message } }) };
    try {
        const response = await fetch(f.origin + '/api/attachments?name=image.png', { method: 'POST',
            headers: { authorization: 'Bearer ' + f.token }, body: attachmentBytes });
        expect(response.status).toBe(status);
        expect(await response.json()).toEqual({ ok: false, error: { code, message: expected, retryable: false } });
    } finally { await f.close(); }
});

/** Existing real SQLite/Jini acceptance plus canonical memory media; no process/model effects. */
async function attachmentRunFixture() {
    const f = await ownerFixture({});
    for (const file of ['0001_assistant.sql', '0005_chat_backend.sql']) f.native.exec(await fs.readFile(new URL('../migrations/' + file, import.meta.url), 'utf8'));
    const kernel = f.db.kernel as unknown as StorageKernel<AssistantDatabase>;
    const conversations = createConversations({ kernel, ids: f.ids, observer: f.observer,
        db: { query: input => f.db.unit.transaction({ work: ({ session }) => session.query(input) }) },
        stores: ({ scope }) => createSqliteChatStore({ kernel, scope }, { clock: { nowMs: () => 1000 } }),
        integrations: { async list() { return { ok: true, value: { items: [], cursor: null } }; } } });
    const deps = createMemoryJiniDependencies({ clock: f.clock, ids: f.ids });
    const media = createMediaLibrary({ media: createMemoryJiniMedia({ scope: f.context.scope, dependencies: deps }),
        repo: createMemoryMediaRepo({ scope: f.context.scope }), audit: createMemoryMediaAudit({ scope: f.context.scope }),
        importer: createMemoryGuardedAssetImport({ scope: f.context.scope }), transforms: createMemoryImageTransform({ scope: f.context.scope, dependencies: deps }) });
    const asset = await uploadMedia({ deps, input: { workspaceId: f.context.scope.workspaceId, bytes: attachmentBytes, contentType: 'image/png', filename: 'canonical.png', createdByPrincipal: f.context.scope.ownerId } });
    const foreign = await uploadMedia({ deps, input: { workspaceId: f.otherContext.scope.workspaceId, bytes: attachmentBytes, contentType: 'image/png', filename: 'foreign.png', createdByPrincipal: f.context.scope.ownerId } });
    let modelContext: AssistantContext = { settings: { mode: 'model', model: 'fixture-model', provider: 'fixture-provider', connectionId: 'connection' }, protocol: 'anthropic', messages: [] };
    conversations.settings = async () => ({ ok: true, value: { settings: modelContext.settings, ready: true, status: modelContext.settings.mode === 'model' ? 'ready' : 'sandbox' } });
    conversations.modelContext = async () => ({ ok: true, value: modelContext });
    const runs = createAssistantRuns({ kernel, conversations, media, clock: f.clock, ids: f.ids, observer: f.observer,
        durable: createDurableRunStore({ kernel, isDaemonRunId: () => true }),
        ledger: createChatRunLedger({ kernel, isDaemonRunId: () => true }, { now: () => 1000 }) });
    const launch = vi.fn<Parameters<typeof runs.start>[0]['launch']>(async input => ({ ok: true, value: { runId: input.runId, status: 'pending', conversationId: input.conversationId } }));
    return { ...f, runs, launch, conversations, deps, asset: asset.media, foreign: foreign.media,
        ref: { path: asset.media.id, name: 'caller-name.png', kind: 'image' as const, size: 1 },
        sandbox() { modelContext = { settings: { mode: 'sandbox', model: 'sandbox', connectionId: null }, messages: [] }; } };
}
it('rejects missing/foreign attachments and partial-invalid batches before acceptance or launch', async () => {
    const f = await attachmentRunFixture();
    try {
        for (const path of ['missing', f.foreign.id]) {
            expect(await f.runs.start({ context: f.context, prompt: 'Look', attachments: [f.ref, { ...f.ref, path }], launch: f.launch })).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
        }
        expect(f.launch).not.toHaveBeenCalled();
        expect(f.native.prepare('SELECT COUNT(*) AS count FROM om_assistant_runs').get()).toEqual({ count: 0 });
        expect(f.native.prepare('SELECT COUNT(*) AS count FROM ai_chat_messages').get()).toEqual({ count: 0 });
    } finally { await f.close(); }
});
it('rejects Sandbox images explicitly without launching', async () => {
    const f = await attachmentRunFixture(); f.sandbox();
    try {
        expect(await f.runs.start({ context: f.context, prompt: 'Look', attachments: [f.ref], launch: f.launch })).toMatchObject({ ok: false, error: { message: 'Image attachments need a model connection.' } });
        expect(f.launch).not.toHaveBeenCalled();
    } finally { await f.close(); }
});
it('freezes canonical refs and resolves only the current run images; trashed assets fail opaque', async () => {
    const f = await attachmentRunFixture();
    try {
        const receipt = value({ result: await f.runs.start({ context: f.context, prompt: 'Look', attachments: [f.ref], launch: f.launch }) });
        const grant: RunGrantMetadata = { protocolVersion: 1, grantId: 'grant', agentInstanceId: 'agent', scope: f.context.scope,
            conversationId: receipt.conversationId!, runId: receipt.runId, capabilities: ['context', 'model'], authenticationEpoch: 1000, expiresAt: 10000, revoked: false };
        const resolved = value({ result: await f.runs.context({ grant }) });
        expect(resolved).toMatchObject({ attachments: [{ path: f.asset.id, name: 'canonical.png', size: attachmentBytes.length }],
            images: [{ mimeType: 'image/png', data: Buffer.from(attachmentBytes).toString('base64') }] });
        const row = f.native.prepare('SELECT settings_json FROM om_assistant_runs WHERE run_id = ?').get(receipt.runId) as { settings_json: string };
        expect(row.settings_json).not.toContain('base64'); expect(row.settings_json).not.toContain(Buffer.from(attachmentBytes).toString('base64'));
        const saved = await f.conversations.store({ context: f.context }).messages({ conversationId: receipt.conversationId! });
        expect(saved.find(message => message.role === 'user')?.attachments).toEqual([{ ...f.ref, name: 'canonical.png', size: attachmentBytes.length }]);
        expect((await f.runs.context({ grant: { ...grant, scope: f.otherContext.scope } })).ok).toBe(false);
        expect((await f.runs.context({ grant: { ...grant, runId: 'other-run' } })).ok).toBe(false);
        const textRun = value({ result: await f.runs.start({ context: f.context, prompt: 'Next', launch: f.launch }) });
        expect(value({ result: await f.runs.context({ grant: { ...grant, runId: textRun.runId } }) })).not.toHaveProperty('images');
        await f.deps.mediaRepo.save({ ...f.asset, status: 'trashed' });
        expect(await f.runs.context({ grant })).toMatchObject({ ok: false, error: { message: 'Run context unavailable' } });
        expect(JSON.stringify(f.events)).not.toContain('canonical.png');
    } finally { await f.close(); }
});

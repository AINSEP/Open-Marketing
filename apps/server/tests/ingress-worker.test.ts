/** Written-only I3 integration: Coordinator builds feature dist exports before running. */
import { expect, it } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { CallContext, ClockPort, ObserverEvent } from '@open-marketing/contracts';
import { createSqlMeasureRepo, createSqlTrackedLink, type MeasureSqlDatabase } from '@open-marketing/measure';
import { bootServer, type BootedServer, type ServerBootIo } from '../src/composition/index.js';
import { createNodeBootIo } from '../src/composition/serve.js';
import { createLocalAuth, provisionLocalOwner } from '../src/composition/local-auth.js';
import { bindServerDatabase, provisionWorkspace } from '../src/composition/database.js';
import { bindForms, seedSandboxForm } from '../src/composition/forms.js';
import { bindIdentity, createVisitTokens, localKey, processingAllowed } from '../src/composition/identity.js';
import { bindPrivacy } from '../src/composition/privacy.js';
import { createFormWorkers } from '../src/composition/workers.js';
import { createNodeHttpListener } from '../src/inbound/http.js';
import { handlePublicRequest } from '../src/inbound/public.js';
import { handleOwnerRequest } from '../src/inbound/owner.js';
import { createSqlCampaignRepo } from '@open-marketing/campaigns';
import { createMemoryConfirmationExchange, createSqlSafetyRepo } from '@open-marketing/safety';
import { runMigrations } from '../src/platform/jini-compat/db/src/index.js';
import { loadMigrations } from '../src/composition/migrations.js';

/** Real boot/HTTP/kernel/file; host scheduler is manually advanced, never a fake outbox. */
async function fixture(_input: Record<string, never>) {
    const directory = await fs.mkdtemp(join(tmpdir(), 'om-i3-'));
    const studioRoot = join(directory, 'studio');
    const stateRoot = join(directory, 'state');
    await fs.mkdir(studioRoot);
    await fs.writeFile(join(studioRoot, 'index.html'), '<!doctype html><head></head><body>Fixture</body>');
    let now = 1792000000123;
    const clock: ClockPort = { now: () => now };
    const ids = { next: () => randomUUID() };
    const events: ObserverEvent[] = [];
    const observer = { observe: (event: ObserverEvent) => { events.push(event); } };
    let native!: Database.Database;
    let workerCallback: (() => void) | undefined;
    let finished: (() => void) | undefined;
    const nodeIo = createNodeBootIo({ projectRoot: fileURLToPath(new URL('../../../', import.meta.url)), studioRoot, ready() {} });
    const io: ServerBootIo = { ...nodeIo, openSqlite(input) { native = nodeIo.openSqlite(input); return native; },
        schedule(input) {
            if (input.delayMs !== 250) return nodeIo.schedule(input);
            workerCallback = input.callback;
            finished?.();
            finished = undefined;
            return () => { workerCallback = undefined; };
        } };
    let stop: () => Promise<unknown>;
    let composed: ReturnType<typeof compose>;
    let origin = '';
    const provisioned = await provisionLocalOwner({ fs, stateRoot, ids, randomToken: io.randomToken });
    if (!provisioned.ok) throw new Error('Missing fixture credentials');
    const credentials = provisioned.value;
    const context: CallContext = { scope: { ownerId: credentials.ownerId, workspaceId: credentials.workspaceId },
        principal: { kind: 'owner', ownerId: credentials.ownerId }, correlationId: 'ingress-correlation', traceId: 'ingress-trace' };
    async function start() {
        native = io.openSqlite({ path: join(stateRoot, 'fixture.sqlite') });
        native.pragma('foreign_keys = ON');
        const database = bindServerDatabase({ native, observer, context });
        const migrations = await loadMigrations({ readSql: ({ path }) => fs.readFile(join(io.projectRoot, path), 'utf8') });
        await runMigrations({ pool: database.pool, migrations });
        await provisionWorkspace({ database: database.workspace, scope: context.scope });
        composed = compose({ database });
        await seedSandboxForm({ binding: composed.forms, context, clock, ids });
        const campaigns = composed.campaigns;
        const safety = createSqlSafetyRepo({ db: { transaction: ({ execute }) => database.unit.transaction({ work: ({ session }) => execute({ session: { query: ({ sql, parameters }) => session.query({ text: sql, values: [...parameters] }) } }) }) }, clock, ids, ownerTimezone: 'UTC', observer });
        const confirmations = createMemoryConfirmationExchange({ clock, ids });
        const listener = createNodeHttpListener({ effects: io, host: '127.0.0.1', port: 0, ids, observer });
        const auth = createLocalAuth({ credentials, clock, bootstrapToken: io.randomToken({}) });
        const started = await listener.start({ async handle(request) {
            const current = listener.origin({})!;
            const trace = { ...context, correlationId: request.headers?.['x-correlation-id'] ?? context.correlationId, traceId: request.headers?.['x-trace-id'] ?? context.traceId };
            if (request.path.startsWith('/api/')) {
                const allowed = auth.verify({ request, origin: current });
                if (!allowed.ok) return { status: 401, body: allowed };
                return handleOwnerRequest({ request, context: trace, services: { campaigns, safety, confirmations, formSubjects: composed.forms.subjects } });
            }
            return handlePublicRequest({ request, context: trace, forms: composed.forms, identity: composed.identity, visits: composed.visits, clock, campaigns,
                links: composed.links });
        } });
        if (!started.ok) throw new Error('Listener failed');
        origin = listener.origin({})!;
        const workers = createFormWorkers({ unit: database.unit, context, clock, ids, observer, forms: composed.forms, schedule: io.schedule });
        workers.start({});
        stop = async () => { await listener.stop({}); await workers.stop({}); composed.privacy.participants.dispose({}); confirmations.reset({}); native.close(); };
    }
    function compose(input: { database: ReturnType<typeof bindServerDatabase> }) {
        const database = input.database;
        const visits = createVisitTokens({ key: localKey({ ownerToken: credentials.token, domain: 'visits' }), clock, ids });
        const digestKey = localKey({ ownerToken: credentials.token, domain: 'contacts' });
        const identity = bindIdentity({ unit: database.unit, clock, ids, observer, digestKey, tokens: visits.tokens });
        const forms = bindForms({ database, clock, ids, observer, digestKey, tokens: visits.tokens });
        const measureDb: MeasureSqlDatabase = { query: input => database.unit.transaction({ work: ({ session }) => session.query(input) }),
            transaction: ({ work }) => database.unit.transaction({ work: ({ session }) => work(session) }) };
        const measure = createSqlMeasureRepo({ database: measureDb, jobs: { async enqueue() { throw new Error('No conversions'); } } });
        const campaigns = createSqlCampaignRepo({ db: { query: input => database.unit.transaction({ work: ({ session }) => session.query(input) }) } });
        const links = createSqlTrackedLink({ database: measureDb, ids, baseUrl: 'https://sandbox.example.test/l/', allowedOrigins: ['https://sandbox.example.test'] });
        return { forms, identity, visits, database, campaigns, links, privacy: bindPrivacy({ unit: database.unit, identity, subjects: forms.subjects, measure, clock, ids, observer }) };
    }
    try { await start(); } catch (error) { if (native?.open) native.close(); await fs.rm(directory, { recursive: true, force: true }); throw error; }
    return {
        context, clock, events, adapters: () => composed,
        get native() { return native; }, get origin() { return origin; },
        headers: { authorization: 'Bearer ' + credentials.token },
        async drain() {
            if (!workerCallback) throw new Error('Worker not scheduled');
            const next = new Promise<void>(resolve => { finished = resolve; });
            workerCallback();
            await next;
        },
        advance(input: { ms: number }) { now += input.ms; },
        async restart() { await stop(); await start(); },
        async close() { await stop(); await fs.rm(directory, { recursive: true, force: true }); },
    };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
/** Extract only server-issued hidden IDs/token from a real rendered form. */
async function form(required: { fixture: Fixture }) {
    const response = await fetch(required.fixture.origin + '/f/lead');
    expect(response.status).toBe(200);
    const html = await response.text();
    const fields = Object.fromEntries(['om_publication', '_attempt', 'om_vt'].map(name => {
        const value = new RegExp('name="' + name + '" value="([^"]+)"').exec(html)?.[1];
        if (!value) throw new Error('Missing form metadata');
        return [name, value];
    }));
    return { html, fields, cookie: response.headers.get('set-cookie')!.split(';')[0] };
}
async function submit(required: { fixture: Fixture; fields: Record<string, string> }) {
    const response = await fetch(required.fixture.origin + '/f/lead', { method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-correlation-id': 'lead-correlation', 'x-trace-id': 'lead-trace' }, body: new URLSearchParams(required.fields) });
    const receipt = z.object({ ok: z.literal(true), value: z.object({ status: z.enum(['accepted', 'duplicate']), receipt: z.object({ submissionId: z.string(), publicationId: z.string(), jobId: z.string() }) }) }).parse(await response.json());
    expect(response.status).toBe(202);
    return receipt.value.receipt;
}
function count(required: { fixture: Fixture; table: 'contact_subject' | 'policy_evidence' | 'om_form_subject_receipts' | 'job' | 'om_form_submissions' }) {
    return z.object({ n: z.number() }).parse(required.fixture.native.prepare('SELECT COUNT(*) AS n FROM ' + required.table).get()).n;
}

it('public lead acceptance is async, exact, linked to a landing, visible in studio and replay-safe after restart', async () => {
    const f = await fixture({});
    try {
        const page = await form({ fixture: f });
        expect(page.html).not.toMatch(/checked(?:=|\s|>)/);
        const snippet = await fetch(f.origin + '/web-events.js');
        expect(snippet.status).toBe(200);
        expect(await snippet.text()).toContain('om.web.landing');
        const initial = f.adapters();
        const campaign = await initial.campaigns.save({ context: f.context, draft: { operationId: 'sandbox-campaign', connectionId: 'sandbox', accountId: 'sandbox', name: 'Sandbox campaign', objective: 'leads', creativeIds: ['fixture-creative'], creativeDigest: 'a'.repeat(64), placements: ['search'] } });
        if (!campaign.ok) throw new Error('Campaign fixture failed');
        const link = await initial.links.create({ context: f.context, request: { destinationUrl: 'https://sandbox.example.test/lead', campaignId: campaign.value.campaignId, utm: {} } });
        if (!link.ok) throw new Error('Link fixture failed');
        const landing = await fetch(f.origin + '/c', { method: 'POST', headers: { cookie: page.cookie, 'content-type': 'application/json' },
            body: JSON.stringify({ eventId: 'landing-one', schema: 'om.web.landing', version: 1, source: 'first-party', name: 'landing', properties: { linkId: link.value.linkId, campaignId: campaign.value.campaignId, fbclid: 'untrusted-click' }, occurredAt: f.clock.now({}) }) });
        expect(landing.status).toBe(202);
        const fields = { ...page.fields, email: 'Lead@Example.test', marketing: 'on' };
        const receipt = await submit({ fixture: f, fields });
        expect(count({ fixture: f, table: 'contact_subject' })).toBe(0);
        expect(count({ fixture: f, table: 'job' })).toBe(1);
        expect(JSON.stringify(f.native.prepare('SELECT payload FROM job').all())).not.toContain('Example.test');
        await f.drain();
        expect(count({ fixture: f, table: 'contact_subject' })).toBe(1);
        expect(count({ fixture: f, table: 'policy_evidence' })).toBe(2);
        const evidence = f.native.prepare('SELECT payload FROM policy_evidence ORDER BY kind').all();
        expect(JSON.stringify(evidence)).toContain('wordingDigest');
        expect(JSON.stringify(evidence)).toContain('wordingVersion');
        expect(JSON.stringify(evidence)).toContain('withdrawn');
        const binding = f.adapters();
        const subject = await binding.identity.contacts.resolve({ context: f.context, identifier: { kind: 'email', raw: 'lead@example.test' } });
        if (!subject.ok) throw new Error('Missing contact');
        const touches = await binding.identity.touches.touchesFor({ context: f.context, subjectId: subject.value.subjectId, window: { start: 0, end: f.clock.now({}) + 1 }, limit: 10 });
        expect(touches).toMatchObject({ ok: true, value: [{ linkId: link.value.linkId, campaignId: campaign.value.campaignId }] });
        expect(JSON.stringify(f.native.prepare('SELECT payload FROM web_event').all())).not.toContain('untrusted-click');
        expect(JSON.stringify(f.native.prepare('SELECT click_identifiers FROM web_touch').all())).not.toContain('untrusted-click');
        const snapshot = await fetch(f.origin + '/api/studio/snapshot', { headers: f.headers });
        expect(await snapshot.json()).toMatchObject({ ok: true, value: { rows: { activity: [{ id: receipt.submissionId, status: 'accepted' }] } } });
        expect(f.events).toEqual(expect.arrayContaining([expect.objectContaining({ operation: 'server.forms.worker', correlationId: 'lead-correlation', traceId: 'lead-trace', outcome: 'accepted' })]));
        await f.restart();
        expect(await submit({ fixture: f, fields })).toEqual(receipt);
        const replay = await f.adapters().forms.accept({ context: f.context, ...receipt });
        expect(replay).toMatchObject({ ok: true, value: { subjectId: subject.value.subjectId } });
        expect(count({ fixture: f, table: 'policy_evidence' })).toBe(2);
    } finally { await f.close(); }
});

it('worker failure rolls back contact/evidence/visit; retry and lost acknowledgement do not duplicate acceptance', async () => {
    const f = await fixture({});
    try {
        const page = await form({ fixture: f });
        const receipt = await submit({ fixture: f, fields: { ...page.fields, email: 'rollback@example.test', measurement: 'on' } });
        f.native.exec("CREATE TRIGGER fail_capture BEFORE INSERT ON policy_evidence BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
        await f.drain();
        expect(count({ fixture: f, table: 'contact_subject' })).toBe(0);
        expect(count({ fixture: f, table: 'policy_evidence' })).toBe(0);
        expect(count({ fixture: f, table: 'om_form_subject_receipts' })).toBe(0);
        f.native.exec('DROP TRIGGER fail_capture');
        f.advance({ ms: 1100 });
        await f.drain();
        const binding = f.adapters();
        const accepted = await binding.forms.accept({ context: f.context, ...receipt });
        expect(accepted.ok).toBe(true);
        // Commit happened but the caller lost the acknowledgement: retry reads the durable receipt.
        expect(await binding.forms.accept({ context: f.context, ...receipt })).toEqual(accepted);
        expect(count({ fixture: f, table: 'contact_subject' })).toBe(1);
        expect(count({ fixture: f, table: 'policy_evidence' })).toBe(2);
        expect(count({ fixture: f, table: 'om_form_subject_receipts' })).toBe(1);
    } finally { await f.close(); }
});

it('duplicate fields, wrong scope, forged/expired visits and address properties fail before ingress persistence', async () => {
    const f = await fixture({});
    try {
        const page = await form({ fixture: f });
        const data = new URLSearchParams({ ...page.fields, email: 'denied@example.test' });
        data.append('email', 'another@example.test');
        const duplicate = await fetch(f.origin + '/f/lead', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: data });
        expect(duplicate.status).toBe(400);
        const forged = { ...page.fields, email: 'denied@example.test', om_vt: page.fields.om_vt + '0' };
        expect((await fetch(f.origin + '/f/lead', { method: 'POST', body: new URLSearchParams(forged) })).status).toBe(403);
        const binding = f.adapters();
        expect(await binding.visits.tokens.verify({ context: { ...f.context, scope: { ...f.context.scope, workspaceId: randomUUID() } }, visitToken: page.fields.om_vt })).toMatchObject({ ok: false });
        f.advance({ ms: 3600001 });
        expect(await binding.visits.tokens.verify({ context: f.context, visitToken: page.fields.om_vt })).toMatchObject({ ok: false });
        const collected = await fetch(f.origin + '/c', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ eventId: 'bad-event', schema: 'om.web.landing', version: 1, source: 'first-party', name: 'landing', occurredAt: f.clock.now({}), properties: { email: 'denied@example.test' } }) });
        expect(collected.status).toBe(400);
        expect(count({ fixture: f, table: 'om_form_submissions' })).toBe(0);
        expect((await fetch(f.origin + '/api/studio/snapshot')).status).toBe(401);
    } finally { await f.close(); }
});

it('privacy blocks before phases, failed removal remains blocked, retry purges answers/identifiers/visits and prevents revival', async () => {
    const f = await fixture({});
    try {
        const page = await form({ fixture: f });
        const receipt = await submit({ fixture: f, fields: { ...page.fields, email: 'erase@example.test', marketing: 'on' } });
        await f.drain();
        const binding = f.adapters();
        const accepted = await binding.forms.accept({ context: f.context, ...receipt });
        if (!accepted.ok) throw new Error('Acceptance failed');
        const request = await binding.privacy.privacy.requestErasure({ context: f.context, subjectId: accepted.value.subjectId });
        if (!request.ok) throw new Error('Erasure failed');
        expect(request.value.participants.map(item => item.participantId)).toEqual(expect.arrayContaining(['contacts', 'forms', 'web-events', 'measure', 'policy', 'jobs']));
        expect(await processingAllowed({ policy: binding.identity.policy, context: f.context, subjectId: accepted.value.subjectId })).toEqual({ ok: true, value: false });
        const advance = () => binding.privacy.privacy.advance({ context: f.context, requestId: request.value.requestId });
        expect((await advance()).ok).toBe(true); // plan retains suppression digests
        expect((await advance()).ok).toBe(true); // no external copies in this local inventory
        f.native.exec("CREATE TRIGGER fail_purge BEFORE UPDATE OF data_json ON om_form_submissions BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
        expect(await advance()).toMatchObject({ ok: true, value: { status: 'failed', phase: 'purgeLocal' } });
        expect(await processingAllowed({ policy: binding.identity.policy, context: f.context, subjectId: accepted.value.subjectId })).toEqual({ ok: true, value: false });
        f.native.exec('DROP TRIGGER fail_purge');
        expect((await advance()).ok).toBe(true);
        expect(await advance()).toMatchObject({ ok: true, value: { status: 'complete', retainedSuppression: [expect.objectContaining({ keyVersion: 'local-v1', reason: 'erasure' })] } });
        expect(f.native.prepare('SELECT data_json, source_ip FROM om_form_submissions').get()).toEqual({ data_json: '{}', source_ip: null });
        expect(await binding.identity.contacts.upsert({ context: f.context, identifiers: [{ kind: 'email', raw: 'erase@example.test' }] })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
        expect(await binding.identity.identifiers.identifiersFor({ context: { scope: f.context.scope, serviceId: 'local', correlationId: 'c', traceId: 't' }, subjectId: accepted.value.subjectId, destination: 'meta', purpose: 'measurement' })).toMatchObject({ ok: false });
        binding.privacy.participants.dispose({});
    } finally { await f.close(); }
});

it('the actual boot root seeds the public form and starts/stops its acceptance worker without owner authentication', async () => {
    const directory = await fs.mkdtemp(join(tmpdir(), 'om-i3-boot-'));
    const studioRoot = join(directory, 'studio');
    await fs.mkdir(studioRoot);
    await fs.writeFile(join(studioRoot, 'index.html'), '<!doctype html><head></head>');
    let server: BootedServer | undefined;
    let next: (() => void) | undefined;
    let settled: (() => void) | undefined;
    const nativeIo = createNodeBootIo({ projectRoot: fileURLToPath(new URL('../../../', import.meta.url)), studioRoot, ready() {} });
    const io: ServerBootIo = { ...nativeIo, schedule(input) {
        if (input.delayMs !== 250) return nativeIo.schedule(input);
        next = input.callback;
        settled?.(); settled = undefined;
        return () => { next = undefined; };
    } };
    try {
        const booted = await bootServer({ env: { OM_STATE_ROOT: join(directory, 'state'), OM_PORT: '0' }, io,
            clock: { now: () => 1792000000123 }, ids: { next: () => randomUUID() }, observer: { observe() {} } });
        if (!booted.ok) throw new Error(booted.error.message);
        server = booted.value;
        const origin = new URL(server.studioUrl).origin;
        const page = await fetch(origin + '/f/lead');
        expect(page.status).toBe(200);
        const html = await page.text();
        const fields = Object.fromEntries(['om_publication', '_attempt', 'om_vt'].map(name => [name, new RegExp('name="' + name + '" value="([^"]+)"').exec(html)![1]]));
        const submitted = await fetch(origin + '/f/lead', { method: 'POST', body: new URLSearchParams({ ...fields, email: 'boot@example.test' }) });
        expect(submitted.status).toBe(202);
        expect(next).toBeTypeOf('function');
        const complete = new Promise<void>(resolve => { settled = resolve; });
        next!(); await complete;
        const credentials = await provisionLocalOwner({ fs, stateRoot: join(directory, 'state'), ids: { next: () => randomUUID() }, randomToken: io.randomToken });
        if (!credentials.ok) throw new Error('Credentials unavailable');
        const observed = await fetch(origin + '/api/studio/snapshot', { headers: { authorization: 'Bearer ' + credentials.value.token } });
        expect(await observed.json()).toMatchObject({ ok: true, value: { rows: { activity: [expect.objectContaining({ title: 'Sandbox lead accepted' })] } } });
        expect(await server.stop({})).toEqual({ ok: true, value: undefined });
        expect(next).toBeUndefined();
    } finally { await server?.stop({}); await fs.rm(directory, { recursive: true, force: true }); }
});

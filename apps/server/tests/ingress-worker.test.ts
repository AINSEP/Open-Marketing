import { createLeadsService, createSqlLeadsRepo } from '@open-marketing/leads';
import { createSqlContactRepo } from '@open-marketing/contacts';
import { createSqlJobRepo, jobTenant } from '@open-marketing/jobs';
import { formRetryPolicy } from '../src/composition/forms.js';
import { createSubjectLane } from '../src/composition/subject-lane.js';
/** Written-only I3 integration: Coordinator builds feature dist exports before running. */
import { expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { removeStateRoot } from './state-root.js';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { metricBatchSchema, encodeCampaignKey, type CallContext, type ClockPort, type ObserverEvent } from '@open-marketing/contracts';
import { createSqlMeasureRepo, createSqlTrackedLink, createMeasurementShareabilityAdapter, type MeasureSqlDatabase } from '@open-marketing/measure';
import { bootServer, type BootedServer, type ServerBootIo } from '../src/composition/index.js';
import { createNodeBootIo } from '../src/composition/serve.js';
import { createLocalAuth, provisionLocalOwner } from '../src/composition/local-auth.js';
import { bindServerDatabase, provisionWorkspace } from '../src/composition/database.js';
import { bindForms, seedSandboxForm } from '../src/composition/forms.js';
import { bindIdentity, createVisitTokens, localKey, processingAllowed, withWebsiteContext } from '../src/composition/identity.js';
import { bindPrivacy } from '../src/composition/privacy.js';
import { createFormWorkers } from '../src/composition/workers.js';
import { createNodeHttpListener } from '../src/inbound/http.js';
import { handlePublicRequest, OM_CONSENT_POLICY } from '../src/inbound/public.js';
import type { ConsentRecord } from '@jini-ai/cookie-consent/server';
import { handleOwnerRequest } from '../src/inbound/owner.js';
import { createSqlCampaignRepo } from '@open-marketing/campaigns';
import { createMemoryConfirmationExchange, createSqlSafetyRepo } from '@open-marketing/safety';
import { runMigrations } from '../src/platform/jini-compat/db/src/index.js';
import { loadMigrations } from '../src/composition/migrations.js';

/** Captured approval evidence; each fixture owns its audit records. */
function answerAudit() {
    const answers: unknown[] = [];
    return { answers, async recordAnswer(input: { answer: unknown }) {
        answers.push(structuredClone(input.answer));
        return { ok: true as const, value: undefined };
    } };
}

/** Visitor's own Jini choice cookie; `stored: false` is an unconfirmed (pending) durable grant. */
function jiniChoice(required: { at: number; marketing?: boolean; stored?: boolean }): string {
    const marketing = required.marketing ?? true;
    const choice = { v: 1, p: OM_CONSENT_POLICY, c: { functional: marketing, analytics: marketing, marketing }, t: required.at, a: marketing ? 'accept' : 'reject',
        ...(required.stored === false ? { q: 1 } : { r: 'fixture-receipt-0001' }) };
    return 'jini_choices=' + encodeURIComponent(JSON.stringify(choice));
}
/** In-memory Jini receipt store double (ConsentRecordPort). */
function consentStore() {
    const records: ConsentRecord[] = [];
    return { records, async save(input: { record: ConsentRecord }) { records.push(structuredClone(input.record)); } };
}

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
        const safety = createSqlSafetyRepo({ db: database.unit, clock, ids, ownerTimezone: 'UTC', observer });
        const confirmations = createMemoryConfirmationExchange({ ...answerAudit(), clock, ids });
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
                links: composed.links, consent: composed.consent });
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
        const subjectLane = createSubjectLane({ resolveSubject: createSqlContactRepo({ uow: database.reads }).get });
        const identity = bindIdentity({ unit: database.unit, subjectLane, clock, ids, observer, digestKey, tokens: visits.tokens });
        const forms = bindForms({ database, subjectLane, clock, ids, observer, digestKey, tokens: visits.tokens });
        const measureDb: MeasureSqlDatabase = database.workspace;
        const measure = createSqlMeasureRepo({ database: measureDb, jobs: { async enqueue() { throw new Error('No conversions'); } } });
        const campaigns = createSqlCampaignRepo({ db: { query: input => database.unit.transaction({ work: ({ session }) => session.query(input) }) } });
        const links = createSqlTrackedLink({ database: measureDb, ids, baseUrl: 'https://sandbox.example.test/l/', allowedOrigins: ['https://sandbox.example.test'] });
        return { forms, identity, visits, database, campaigns, links, subjectLane, consent: { store: consentStore(), ids: () => randomUUID() },
            jobs: createSqlJobRepo({ database: database.unit, clock, ids, retryPolicy: formRetryPolicy }),
            privacy: bindPrivacy({ unit: database.unit, subjectLane, identity, subjects: forms.subjects, measure, clock, ids, observer }) };
    }
    try { await start(); } catch (error) { if (native?.open) native.close(); await removeStateRoot({ path: directory }); throw error; }
    return {
        context, clock, events, adapters: () => composed,
        get native() { return native; }, get origin() { return origin; },
        headers: { authorization: 'Bearer ' + credentials.token },
        granted: () => jiniChoice({ at: now }),
        async drain() {
            if (!workerCallback) throw new Error('Worker not scheduled');
            const next = new Promise<void>(resolve => { finished = resolve; });
            workerCallback();
            await next;
        },
        advance(input: { ms: number }) { now += input.ms; },
        async restart() { await stop(); await start(); },
        async close() { await stop(); await removeStateRoot({ path: directory }); },
    };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
/** Seed real subject-bearing outbox intent; tests control the attempt boundary explicitly. */
async function subjectJob(required: { f: Fixture; subjectId: string; id: string; state?: 'leased' | 'dispatching' }) {
    const { f } = required;
    const jobs = f.adapters().jobs;
    const queued = await jobs.enqueue({ context: f.context, job: { handler: 'measure.conversion', operationId: required.id,
        idempotencyKey: required.id, argumentsDigest: 'a'.repeat(64), payload: { subjectId: required.subjectId, eventId: required.id, deliveryId: required.id } } });
    if (!queued.ok) throw new Error('Missing queued job');
    if (!required.state) return queued.value.jobId;
    const claimed = await jobs.claim({ worker: { workerId: 'fixture' } });
    if (!claimed.ok || !claimed.value || claimed.value.lease.id !== queued.value.jobId) throw new Error('Missing lease');
    if (required.state === 'dispatching') await jobs.outbox.beginDispatch({ tenantId: jobTenant({ context: f.context }), id: queued.value.jobId,
        token: claimed.value.lease.leaseToken!, now: f.clock.now({}) });
    return queued.value.jobId;
}
/** Extract server-issued form IDs; loading the page grants no tracking consent. */
async function form(required: { fixture: Fixture }) {
    const response = await fetch(required.fixture.origin + '/f/lead');
    expect(response.status).toBe(200);
    const html = await response.text();
    const fields = Object.fromEntries(['om_publication', '_attempt'].map(name => {
        const value = new RegExp('name="' + name + '" value="([^"]+)"').exec(html)?.[1];
        if (!value) throw new Error('Missing form metadata');
        return [name, value];
    }));
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(html).not.toContain('name="om_vt"');
    return { html, fields };
}
async function submit(required: { fixture: Fixture; fields: Record<string, string>; cookie?: string }) {
    const response = await fetch(required.fixture.origin + '/f/lead', { method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-correlation-id': 'lead-correlation', 'x-trace-id': 'lead-trace', ...(required.cookie ? { cookie: required.cookie } : {}) }, body: new URLSearchParams(required.fields) });
    const receipt = z.object({ ok: z.literal(true), value: z.object({ status: z.enum(['accepted', 'duplicate']), receipt: z.object({ submissionId: z.string(), publicationId: z.string(), jobId: z.string() }) }) }).parse(await response.json());
    expect(response.status).toBe(202);
    return receipt.value.receipt;
}
function count(required: { fixture: Fixture; table: 'contact_subject' | 'policy_evidence' | 'om_form_subject_receipts' | 'job' | 'om_form_submissions' | 'lead' | 'web_visit' | 'web_event' | 'web_touch' }) {
    return z.object({ n: z.number() }).parse(required.fixture.native.prepare('SELECT COUNT(*) AS n FROM ' + required.table).get()).n;
}

it('public lead acceptance is async, exact, linked to a landing, visible in studio and replay-safe after restart', async () => {
    const f = await fixture({});
    try {
        const snippet = await fetch(f.origin + '/web-events.js');
        expect(snippet.status).toBe(200);
        expect(await snippet.text()).toContain('om.web.landing');
        const initial = f.adapters();
        const campaign = await initial.campaigns.save({ context: f.context, draft: { operationId: 'sandbox-campaign', connectionId: 'sandbox', accountId: 'sandbox', name: 'Sandbox campaign', objective: 'leads', creativeIds: ['fixture-creative'], creativeDigest: 'a'.repeat(64), placements: ['search'] } });
        if (!campaign.ok) throw new Error('Campaign fixture failed');
        const link = await initial.links.create({ context: f.context, request: { destinationUrl: 'https://sandbox.example.test/lead', campaignId: campaign.value.campaignId, utm: {} } });
        if (!link.ok) throw new Error('Link fixture failed');
        const landing = await fetch(f.origin + '/c', { method: 'POST', headers: { 'content-type': 'application/json', cookie: f.granted() },
            body: JSON.stringify({ consent: true, eventId: 'landing-one', schema: 'om.web.landing', version: 1, source: 'first-party', name: 'landing', properties: { linkId: link.value.linkId, campaignId: campaign.value.campaignId,
                utm_source: 'google-ads', utm_medium: 'cpc', om_a: 'account', utm_id: 'campaign', pageUrl: 'https://sandbox.example.test/lead', gclid: 'first-party-click', fbclid: 'untrusted-click', fbc: 'legacy-click', fbp: 'legacy-browser' }, occurredAt: f.clock.now({}) }) });
        expect(landing.status).toBe(202);
        expect(await landing.json()).toEqual({ ok: true, value: { accepted: true } });
        const cookie = landing.headers.get('set-cookie')!.split(';')[0] + '; ' + f.granted();
        const page = await form({ fixture: f });
        expect(page.html.slice(0, page.html.indexOf('<section id="jini-consent"'))).not.toMatch(/checked(?:=|\s|>)/);
        const fields = { ...page.fields, email: 'Lead@Example.test', marketing: 'on' };
        const receipt = await submit({ fixture: f, fields, cookie });
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
        const storedClicks = JSON.stringify(f.native.prepare('SELECT click_identifiers FROM web_touch').all());
        expect(storedClicks).toContain('untrusted-click');
        expect(storedClicks).toContain('first-party-click');
        expect(storedClicks).not.toContain('legacy-click');
        expect(storedClicks).not.toContain('legacy-browser');
        const snapshot = await fetch(f.origin + '/api/studio/snapshot', { headers: f.headers });
        expect(await snapshot.json()).toMatchObject({ ok: true, value: { rows: { activity: [{ id: receipt.submissionId, status: 'accepted' }] } } });
        expect(f.events).toEqual(expect.arrayContaining([expect.objectContaining({ operation: 'server.forms.worker', correlationId: 'lead-correlation', traceId: 'lead-trace', outcome: 'accepted' })]));
        await f.restart();
        // The fixture listener chooses a new port; keep the original consented token for replay.
        const replayCookie = 'om_visit_' + new URL(f.origin).port + '=' + cookie.slice(cookie.indexOf('=') + 1, cookie.indexOf(';')) + '; ' + f.granted();
        expect(await submit({ fixture: f, fields, cookie: replayCookie })).toEqual(receipt);
        const replay = await f.adapters().forms.accept({ context: f.context, ...receipt });
        expect(replay).toMatchObject({ ok: true, value: { subjectId: subject.value.subjectId } });
        expect(count({ fixture: f, table: 'policy_evidence' })).toBe(2);
    } finally { await f.close(); }
});

it.each([
    { origin: 'https://sandbox.example.test', status: 'ready' },
    { origin: undefined, status: 'missing' },
    { origin: 'https://other.example.test', status: 'missing' },
])('binds heartbeat metadata to the validated transport origin: $status / $origin', async ({ origin, status }) => {
    const f = await fixture({});
    try {
        const binding = f.adapters();
        const campaign = encodeCampaignKey({ key: { pluginId: 'google-ads', accountId: 'account', vendorCampaignId: 'campaign' } });
        if (!campaign.ok) throw new Error('Invalid fixture key');
        const get = vi.spyOn(binding.campaigns, 'get');
        const response = await handlePublicRequest({ context: f.context, ...binding, clock: f.clock,
            request: { method: 'POST', path: '/c', headers: { cookie: f.granted(), ...(origin ? { origin } : {}) }, body: {
                consent: true, eventId: 'origin-landing', schema: 'om.web.landing', version: 1, source: 'first-party', name: 'landing', occurredAt: f.clock.now({}),
                properties: { campaignId: campaign.value, utm_source: 'google-ads', utm_medium: 'paid', om_a: 'account', utm_id: 'campaign',
                    pageUrl: 'https://sandbox.example.test/lead?private=value#fragment', gclid: 'untrusted' },
            } } });
        expect(response).toMatchObject({ status: 202, body: { ok: true, value: { accepted: true } } });
        expect(JSON.stringify(f.native.prepare('SELECT click_identifiers FROM web_touch').all())).toContain('untrusted');
        expect(get).not.toHaveBeenCalled();
        expect(await binding.identity.webEvents.destinationReadiness({ context: f.context, destinationUrl: 'https://sandbox.example.test/lead' }))
            .toMatchObject({ ok: true, value: { status } });
        const payload = JSON.stringify(f.native.prepare('SELECT payload FROM web_event').all());
        expect(payload).not.toContain('private');
        expect(payload).not.toContain('untrusted');
        expect(await binding.identity.webEvents.destinationReadiness({ context: { ...f.context, scope: { ...f.context.scope, workspaceId: randomUUID() } }, destinationUrl: 'https://sandbox.example.test/lead' }))
            .toMatchObject({ ok: true, value: { status: 'missing' } });
    } finally { await f.close(); }
});

it.each([undefined, false, 'true'])('rejects collection without literal consent before cookie or persistence: %j', async consent => {
    const f = await fixture({});
    try {
        const body = { consent, eventId: 'denied-landing', schema: 'om.web.landing', version: 1, source: 'first-party', name: 'landing',
            occurredAt: f.clock.now({}), properties: { utm_source: 'fixture-ads', utm_medium: 'paid', om_a: 'account', utm_id: 'campaign', gclid: 'click' } };
        const headers = { 'content-type': 'application/json' };
        const denied = await fetch(f.origin + '/c', { method: 'POST', headers, body: JSON.stringify(body) });
        expect(denied.status).toBe(400);
        expect(await denied.json()).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
        expect(denied.headers.get('set-cookie')).toBeNull();
        for (const table of ['web_visit', 'web_event', 'web_touch'] as const) expect(count({ fixture: f, table })).toBe(0);
        const accepted = await fetch(f.origin + '/c', { method: 'POST', headers: { ...headers, cookie: f.granted() },
            body: JSON.stringify({ ...body, consent: true, eventId: 'consented-landing' }) });
        expect(accepted.status).toBe(202);
        const cookie = accepted.headers.get('set-cookie')!.split(';')[0] + '; ' + f.granted();
        const deniedWithCookie = await fetch(f.origin + '/c', { method: 'POST', headers: { ...headers, cookie }, body: JSON.stringify(body) });
        expect(deniedWithCookie.status).toBe(400);
        expect(deniedWithCookie.headers.get('set-cookie')).toBeNull();
        for (const table of ['web_visit', 'web_event', 'web_touch'] as const) expect(count({ fixture: f, table })).toBe(1);
    } finally { await f.close(); }
});

it('leaves hosted GET untracked with the nonce\'d banner CSP and issues Secure visits after a stored grant', async () => {
    const f = await fixture({});
    try {
        const response = await handlePublicRequest({ context: f.context, ...f.adapters(), clock: f.clock, publicOrigin: 'https://public.example',
            request: { method: 'GET', path: '/f/lead', headers: { host: 'public.example' } } });
        expect(response.status).toBe(200);
        expect(response.headers?.['set-cookie']).toBeUndefined();
        expect(response.body).not.toContain('name="om_vt"');
        const nonce = /style-src 'nonce-([^']+)'/.exec(response.headers?.['content-security-policy'] ?? '')?.[1];
        expect(nonce).toBeTruthy();
        expect(response.headers?.['content-security-policy']).toBe("default-src 'none'; script-src 'self'; style-src 'nonce-" + nonce + "'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
        expect(response.body).toContain('<style data-jini-consent-style nonce="' + nonce + '"');
        expect(response.body).toContain('id="jini-consent-config"');
        expect(response.body).toContain('<script src="/consent/client.min.js"');
        for (const table of ['web_visit', 'web_event', 'web_touch'] as const) expect(count({ fixture: f, table })).toBe(0);
        const collected = await handlePublicRequest({ context: f.context, ...f.adapters(), clock: f.clock, publicOrigin: 'https://public.example',
            request: { method: 'POST', path: '/c', headers: { host: 'public.example', cookie: f.granted() }, body: { consent: true, eventId: 'secure-landing',
                schema: 'om.web.landing', version: 1, source: 'first-party', name: 'landing', occurredAt: f.clock.now({}), properties: {} } } });
        expect(collected.status).toBe(202);
        expect(collected.headers?.['set-cookie']).toContain('; Secure');
    } finally { await f.close(); }
});

it.each([
    { name: 'no choice', choice: 'none', signal: {} },
    { name: 'pending grant', choice: 'pending', signal: {} },
    { name: 'US region hint without a choice', choice: 'usHint', signal: {} },
    { name: 'reject', choice: 'reject', signal: {} },
    { name: 'GPC', choice: 'granted', signal: { 'sec-gpc': '1' } },
    { name: 'DNT', choice: 'granted', signal: { dnt: '1' } },
] as const)('writes no visit, cookie or touch without a stored marketing grant: $name', async ({ choice, signal }) => {
    const f = await fixture({});
    try {
        const cookies = { none: '', usHint: 'jini_region=us', pending: jiniChoice({ at: f.clock.now({}), stored: false }), reject: jiniChoice({ at: f.clock.now({}), marketing: false }), granted: f.granted() };
        const body = JSON.stringify({ consent: true, eventId: 'gated-landing', schema: 'om.web.landing', version: 1, source: 'first-party', name: 'landing', occurredAt: f.clock.now({}), properties: { gclid: 'click' } });
        const denied = await fetch(f.origin + '/c', { method: 'POST', headers: { 'content-type': 'application/json', ...(signal as Record<string, string>), cookie: cookies[choice] }, body });
        expect(denied.status).toBe(403);
        expect(denied.headers.get('set-cookie')).toBeNull();
        for (const table of ['web_visit', 'web_event', 'web_touch'] as const) expect(count({ fixture: f, table })).toBe(0);
        const granted = await fetch(f.origin + '/c', { method: 'POST', headers: { 'content-type': 'application/json', cookie: f.granted() }, body });
        expect(granted.status).toBe(202);
        expect(count({ fixture: f, table: 'web_touch' })).toBe(1);
    } finally { await f.close(); }
});

it('stores a same-origin Jini receipt, serves the client and clears the visit cookie on DELETE /c', async () => {
    const f = await fixture({});
    try {
        const receipt = await fetch(f.origin + '/consent', { method: 'POST', headers: { origin: f.origin, 'content-type': 'application/json' },
            body: JSON.stringify({ policy: OM_CONSENT_POLICY, action: 'accept' }) });
        expect(receipt.status).toBe(201);
        const records = f.adapters().consent.store.records;
        expect(records).toEqual([expect.objectContaining({ policyVersion: OM_CONSENT_POLICY, action: 'accept', choices: { necessary: true, functional: true, analytics: true, marketing: true } })]);
        expect(await receipt.json()).toEqual({ id: records[0].id });
        const stale = await fetch(f.origin + '/consent', { method: 'POST', headers: { origin: f.origin, 'content-type': 'application/json' }, body: JSON.stringify({ policy: 'old', action: 'accept' }) });
        expect(stale.status).toBe(409);
        expect(records).toHaveLength(1);
        const client = await fetch(f.origin + '/consent/client.min.js');
        expect(client.status).toBe(200);
        expect(client.headers.get('content-type')).toContain('text/javascript');
        expect((await client.text()).length).toBeGreaterThan(1000);
        const landing = await fetch(f.origin + '/c', { method: 'POST', headers: { 'content-type': 'application/json', cookie: f.granted() },
            body: JSON.stringify({ consent: true, eventId: 'withdrawn-landing', schema: 'om.web.landing', version: 1, source: 'first-party', name: 'landing', occurredAt: f.clock.now({}), properties: {} }) });
        const visit = landing.headers.get('set-cookie')!.split(';')[0];
        const withdrawn = await fetch(f.origin + '/c', { method: 'DELETE', headers: { origin: f.origin, cookie: visit } });
        expect(withdrawn.status).toBe(204);
        expect(withdrawn.headers.get('set-cookie')).toBe(visit.split('=')[0] + '=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
        expect(count({ fixture: f, table: 'web_touch' })).toBe(1);
        expect((await fetch(f.origin + '/f/lead', { method: 'DELETE', headers: { origin: f.origin } })).status).toBe(400);
    } finally { await f.close(); }
});

it('accepts a form POST without a grant unattributed even with a valid visit cookie', async () => {
    const f = await fixture({});
    try {
        const binding = f.adapters();
        const { visit, token } = binding.visits.issue({ context: f.context });
        expect(await binding.identity.webRepo.saveVisit({ context: f.context, visit })).toMatchObject({ ok: true });
        const page = await form({ fixture: f });
        const cookie = 'om_visit_' + new URL(f.origin).port + '=' + token;
        const receipt = await submit({ fixture: f, fields: { ...page.fields, email: 'ungranted@example.test', om_vt: token }, cookie });
        expect(await binding.forms.accept({ context: f.context, ...receipt })).toMatchObject({ ok: true });
        expect(f.native.prepare('SELECT subject_id FROM web_visit').all()).toEqual([{ subject_id: null }]);
    } finally { await f.close(); }
});

it('captures the user agent only on consented /c, rejects a browser-supplied one, enriches identifiers after binding and erases them', async () => {
    const f = await fixture({});
    try {
        const binding = f.adapters();
        const host = new URL(f.origin).host;
        const landing = (input: { eventId: string; cookie?: string; properties?: Record<string, string> }) => handlePublicRequest({ context: f.context, ...binding, clock: f.clock,
            request: { method: 'POST', path: '/c', headers: { host, origin: 'https://sandbox.example.test', 'user-agent': '  Fixture-Agent/1.0  ', ...(input.cookie ? { cookie: input.cookie } : {}) }, body: {
                consent: true, eventId: input.eventId, schema: 'om.web.landing', version: 1, source: 'first-party', name: 'landing', occurredAt: f.clock.now({}),
                properties: { pageUrl: 'https://sandbox.example.test/lead?private=value', ...input.properties } } } });
        expect((await landing({ eventId: 'ungranted' })).status).toBe(403);
        expect((await landing({ eventId: 'spoofed', cookie: f.granted(), properties: { client_user_agent: 'Spoofed/1.0' } })).status).toBe(400);
        for (const table of ['web_visit', 'web_event', 'web_touch'] as const) expect(count({ fixture: f, table })).toBe(0);
        const collected = await landing({ eventId: 'consented', cookie: f.granted() });
        expect(collected.status).toBe(202);
        expect(JSON.parse(z.object({ click_identifiers: z.string() }).parse(f.native.prepare('SELECT click_identifiers FROM web_touch').get()).click_identifiers))
            .toEqual({ client_user_agent: 'Fixture-Agent/1.0', event_source_url: 'https://sandbox.example.test/lead' });
        expect(JSON.stringify(f.native.prepare('SELECT payload FROM web_event').all())).not.toContain('Fixture-Agent');
        const cookie = collected.headers!['set-cookie'].split(';')[0] + '; ' + f.granted();
        const page = await form({ fixture: f });
        const receipt = await submit({ fixture: f, fields: { ...page.fields, email: 'ua-lead@example.test' }, cookie });
        await f.drain();
        const accepted = await binding.forms.accept({ context: f.context, ...receipt });
        if (!accepted.ok) throw new Error('Acceptance failed');
        const service = { scope: f.context.scope, serviceId: 'measure-worker', correlationId: 'c', traceId: 't' };
        const found = { subjectId: accepted.value.subjectId, identifiers: { email: 'hashed-email' }, identifierDigests: { email: 'a'.repeat(64) } };
        expect(await withWebsiteContext({ webEvents: binding.identity.webEvents, clock: f.clock, context: service, found })).toEqual({ subjectId: accepted.value.subjectId,
            identifiers: { email: 'hashed-email', client_user_agent: 'Fixture-Agent/1.0', event_source_url: 'https://sandbox.example.test/lead' },
            identifierDigests: { email: 'a'.repeat(64), client_user_agent: createHash('sha256').update('Fixture-Agent/1.0').digest('hex'), event_source_url: createHash('sha256').update('https://sandbox.example.test/lead').digest('hex') } });
        expect(await withWebsiteContext({ webEvents: binding.identity.webEvents, clock: f.clock, context: service, found: { ...found, subjectId: 'unbound-subject' } })).toEqual({ ...found, subjectId: 'unbound-subject' });
        const request = await binding.privacy.privacy.requestErasure({ context: f.context, subjectId: accepted.value.subjectId });
        if (!request.ok) throw new Error('Erasure failed');
        for (let step = 0; step < 6; step++) {
            const advanced = await binding.privacy.privacy.advance({ context: f.context, requestId: request.value.requestId });
            if (advanced.ok && advanced.value.status === 'complete') break;
        }
        expect(f.native.prepare('SELECT click_identifiers FROM web_touch').all()).toEqual([{ click_identifiers: '{}' }]);
        expect(await withWebsiteContext({ webEvents: binding.identity.webEvents, clock: f.clock, context: service, found })).toEqual(found);
        binding.privacy.participants.dispose({});
    } finally { await f.close(); }
});

it.each(['expired', 'duplicate', 'forged'])('keeps a form lead unattributed with an unusable visit cookie: %s', async reason => {
    const f = await fixture({});
    try {
        const binding = f.adapters();
        const { visit, token } = binding.visits.issue({ context: f.context });
        expect(await binding.identity.webRepo.saveVisit({ context: f.context, visit })).toMatchObject({ ok: true });
        const validCookie = 'om_visit_' + new URL(f.origin).port + '=' + token;
        if (reason === 'expired') f.advance({ ms: 3600001 });
        let cookie = f.granted() + '; ' + validCookie;
        if (reason === 'duplicate') cookie += '; ' + validCookie;
        if (reason === 'forged') cookie += '0';
        const page = await form({ fixture: f });
        const receipt = await submit({ fixture: f, fields: { ...page.fields, email: 'unattributed@example.test' }, cookie });
        expect(await binding.forms.accept({ context: f.context, ...receipt })).toMatchObject({ ok: true });
        const leads = await leadService({ f }).list({ context: f.context, query: { page: { limit: 50 } } });
        expect(leads).toMatchObject({ ok: true, value: { items: [{ attribution: { campaign: null, touchId: null, touchedAt: null } }] } });
        expect(JSON.parse(z.object({ data_json: z.string() }).parse(f.native.prepare('SELECT data_json FROM om_form_submissions').get()).data_json)).not.toHaveProperty('om_vt');
        expect(f.native.prepare('SELECT subject_id FROM web_visit').all()).toEqual([{ subject_id: null }]);
        expect(count({ fixture: f, table: 'web_visit' })).toBe(1);
    } finally { await f.close(); }
});

it('attributes a bare OM campaign ID only after a scoped lookup and rejects unknown or foreign IDs', async () => {
    const f = await fixture({});
    try {
        const binding = f.adapters();
        const foreign = { ...f.context, scope: { ...f.context.scope, workspaceId: randomUUID() } };
        const draft = { operationId: 'direct-campaign', connectionId: 'sandbox', accountId: 'sandbox', name: 'Direct campaign', objective: 'leads' as const,
            creativeIds: ['fixture-creative'], creativeDigest: 'a'.repeat(64), placements: ['search'] };
        const own = await binding.campaigns.save({ context: f.context, draft });
        const other = await binding.campaigns.save({ context: foreign, draft: { ...draft, operationId: 'foreign-campaign' } });
        if (!own.ok || !other.ok) throw new Error('Missing fixture campaigns');
        const record = vi.spyOn(binding.identity.webEvents, 'recordTouch');
        const get = vi.spyOn(binding.campaigns, 'get');
        for (const campaignId of ['missing-campaign', other.value.campaignId]) {
            const rejected = await handlePublicRequest({ context: f.context, ...binding, clock: f.clock, request: { method: 'POST', path: '/c', headers: { cookie: f.granted() }, body: {
                consent: true, eventId: 'rejected-' + campaignId, schema: 'om.web.landing', version: 1, source: 'first-party', name: 'landing', occurredAt: f.clock.now({}), properties: { campaignId },
            } } });
            expect(rejected.status).toBe(403);
        }
        expect(record).not.toHaveBeenCalled();
        expect(f.native.prepare('SELECT COUNT(*) AS n FROM web_event').get()).toEqual({ n: 0 });
        const request = { method: 'POST' as const, path: '/c', headers: { cookie: f.granted() }, body: { consent: true, eventId: 'direct-landing', schema: 'om.web.landing', version: 1,
            source: 'first-party', name: 'landing', occurredAt: f.clock.now({}), properties: { campaignId: own.value.campaignId } } };
        const response = await handlePublicRequest({ context: f.context, ...binding, clock: f.clock, request });
        expect(response).toMatchObject({ status: 202, body: { ok: true, value: { accepted: true } } });
        expect(get).toHaveBeenLastCalledWith({ context: f.context, campaignId: own.value.campaignId });
        expect(f.native.prepare('SELECT campaign_id FROM web_touch').all()).toEqual([{ campaign_id: own.value.campaignId }]);
    } finally { await f.close(); }
});

it('rejects a tracked-link campaign outside scope and a conflicting campaign claim before collection', async () => {
    const f = await fixture({});
    try {
        const binding = f.adapters();
        const foreign = { ...f.context, scope: { ...f.context.scope, workspaceId: randomUUID() } };
        const campaign = await binding.campaigns.save({ context: foreign, draft: { operationId: 'foreign-campaign', connectionId: 'sandbox', accountId: 'sandbox', name: 'Foreign campaign', objective: 'leads', creativeIds: ['fixture-creative'], creativeDigest: 'a'.repeat(64), placements: ['search'] } });
        if (!campaign.ok) throw new Error('Missing foreign campaign');
        const link = await binding.links.create({ context: f.context, request: { destinationUrl: 'https://sandbox.example.test/lead', campaignId: campaign.value.campaignId, utm: {} } });
        if (!link.ok) throw new Error('Missing fixture link');
        const base = { consent: true, eventId: 'foreign-campaign', schema: 'om.web.landing', version: 1, source: 'first-party', name: 'landing', occurredAt: f.clock.now({}) };
        for (const campaignId of [undefined, 'conflicting-campaign']) {
            const response = await fetch(f.origin + '/c', { method: 'POST', headers: { 'content-type': 'application/json', cookie: f.granted() }, body: JSON.stringify({ ...base, properties: { linkId: link.value.linkId, campaignId } }) });
            expect(response.status).toBe(403);
        }
        expect(f.native.prepare('SELECT COUNT(*) AS n FROM web_event').get()).toEqual({ n: 0 });
    } finally { await f.close(); }
});

it.each(['unchecked', 'withdrawn'] as const)('retains the accepted lead receipt when conversion sharing is %s', async sharing => {
    const f = await fixture({});
    try {
        const page = await form({ fixture: f });
        const fields: Record<string, string> = { ...page.fields, email: 'independent@example.test' };
        if (sharing === 'withdrawn') fields.measurement = 'on';
        const receipt = await submit({ fixture: f, fields });
        await f.drain();
        const binding = f.adapters();
        const accepted = await binding.forms.accept({ context: f.context, ...receipt });
        if (!accepted.ok) throw new Error('Missing accepted lead receipt');
        const subjectId = accepted.value.subjectId;
        const conversion = { eventId: 'lead-sharing', definitionId: 'signup', subjectId, destination: 'meta', purpose: 'measurement',
            occurredAt: f.clock.now({}), identifierDigests: { email: 'a'.repeat(64) } };
        const policy = createMeasurementShareabilityAdapter({ clock: f.clock, async loadEvidence(input) {
            const snapshot = await binding.identity.policy.snapshot({ context: input.context, subjectId: input.event.subjectId });
            return snapshot.ok ? { ok: true, value: { policy: snapshot.value,
                lineage: [{ subject: { scope: input.context.scope, subjectId: input.event.subjectId }, erasure: 'none' }] } } : snapshot;
        } });
        if (sharing === 'withdrawn') {
            expect(await policy.assess({ context: f.context, event: conversion })).toEqual({ ok: true, value: { allowed: true } });
            expect(await binding.identity.policy.appendEvidence({ context: f.context, evidence: { id: 'withdraw-lead-sharing', scope: f.context.scope,
                subjectId, kind: 'withdrawal', recordedAt: f.clock.now({}), sourceId: 'owner',
                consent: { scope: 'destination', target: 'meta', purpose: 'measurement', status: 'withdrawn', start: f.clock.now({}), end: f.clock.now({}) + 1000 } } })).toMatchObject({ ok: true });
        }
        expect(await policy.assess({ context: f.context, event: conversion })).toEqual({ ok: true, value: { allowed: false, reason: 'consent_withdrawn' } });
        expect(await binding.forms.accept({ context: f.context, ...receipt })).toEqual(accepted);
        expect(count({ fixture: f, table: 'om_form_subject_receipts' })).toBe(1);
        expect(f.native.prepare('SELECT state FROM job WHERE id=?').get(receipt.jobId)).toEqual({ state: 'succeeded' });
        const snapshot = await fetch(f.origin + '/api/studio/snapshot', { headers: f.headers });
        expect(await snapshot.json()).toMatchObject({ ok: true, value: { rows: { activity: [{ id: receipt.submissionId, status: 'accepted' }] } } });
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
        expect(f.native.prepare('SELECT state,attempts FROM job WHERE id=?').get(receipt.jobId)).toEqual({ state: 'retry', attempts: 1 });
        f.native.exec('DROP TRIGGER fail_capture');
        f.advance({ ms: 1100 });
        await f.drain();
        const binding = f.adapters();
        expect(f.native.prepare('SELECT state,attempts FROM job WHERE id=?').get(receipt.jobId)).toEqual({ state: 'succeeded', attempts: 2 });
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
        const binding = f.adapters();
        const { token } = binding.visits.issue({ context: f.context });
        const data = new URLSearchParams({ ...page.fields, email: 'denied@example.test' });
        data.append('email', 'another@example.test');
        const duplicate = await fetch(f.origin + '/f/lead', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: data });
        expect(duplicate.status).toBe(400);
        const forged = { ...page.fields, email: 'denied@example.test', om_vt: token + '0' };
        expect((await fetch(f.origin + '/f/lead', { method: 'POST', headers: { cookie: f.granted() }, body: new URLSearchParams(forged) })).status).toBe(403);
        expect(await binding.visits.tokens.verify({ context: { ...f.context, scope: { ...f.context.scope, workspaceId: randomUUID() } }, visitToken: token })).toMatchObject({ ok: false });
        f.advance({ ms: 3600001 });
        expect(await binding.visits.tokens.verify({ context: f.context, visitToken: token })).toMatchObject({ ok: false });
        const collected = await fetch(f.origin + '/c', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ consent: true, eventId: 'bad-event', schema: 'om.web.landing', version: 1, source: 'first-party', name: 'landing', occurredAt: f.clock.now({}), properties: { email: 'denied@example.test' } }) });
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
        const fields = Object.fromEntries(['om_publication', '_attempt'].map(name => [name, new RegExp('name="' + name + '" value="([^"]+)"').exec(html)![1]]));
        const submitted = await fetch(origin + '/f/lead', { method: 'POST', body: new URLSearchParams({ ...fields, email: 'boot@example.test' }) });
        expect(submitted.status).toBe(202);
        expect(next).toBeTypeOf('function');
        const credentials = await provisionLocalOwner({ fs, stateRoot: join(directory, 'state'), ids: { next: () => randomUUID() }, randomToken: io.randomToken });
        if (!credentials.ok) throw new Error('Credentials unavailable');
        // The worker runs one job per tick and boot also queues alert evaluation, so tick until the form job has completed.
        let observed: Response | undefined; let body: unknown;
        for (let tick = 0; tick < 6; tick++) {
            const complete = new Promise<void>(resolve => { settled = resolve; });
            next!(); await complete;
            observed = await fetch(origin + '/api/studio/snapshot', { headers: { authorization: 'Bearer ' + credentials.value.token } });
            body = await observed.json();
            if ((body as { value?: { rows?: { activity?: unknown[] } } }).value?.rows?.activity?.length) break;
        }
        expect(body).toMatchObject({ ok: true, value: { rows: { activity: [expect.objectContaining({ title: 'Sandbox lead accepted' })] } } });
        expect(await server.stop({})).toEqual({ ok: true, value: undefined });
        expect(next).toBeUndefined();
    } finally { await server?.stop({}); await removeStateRoot({ path: directory }); }
});

it('atomically suppresses a merged family, cancels queued work, fences attempts and preserves all states after restart', async () => {
    const f = await fixture({});
    try {
        const binding = f.adapters();
        const a = await binding.identity.contacts.upsert({ context: f.context, identifiers: [{ kind: 'email', raw: 'a@example.test' }] });
        const b = await binding.identity.contacts.upsert({ context: f.context, identifiers: [{ kind: 'email', raw: 'b@example.test' }] });
        if (!a.ok || !b.ok) throw new Error('Missing subjects');
        expect(await binding.identity.contacts.merge({ context: f.context, sourceSubjectId: b.value.subjectId, targetSubjectId: a.value.subjectId })).toMatchObject({ ok: true });
        const leased = await subjectJob({ f, subjectId: a.value.subjectId, id: 'leased', state: 'leased' });
        const dispatching = await subjectJob({ f, subjectId: b.value.subjectId, id: 'dispatching', state: 'dispatching' });
        const queued = await subjectJob({ f, subjectId: b.value.subjectId, id: 'queued' });
        const request = await binding.privacy.privacy.requestErasure({ context: f.context, subjectId: b.value.subjectId });
        expect(request).toMatchObject({ ok: true, value: { status: 'pending' } });
        expect(f.native.prepare("SELECT event_type,state FROM job_attempt WHERE event_type='cancel' ORDER BY state").all())
            .toEqual([{ event_type: 'cancel', state: 'cancelled' }, { event_type: 'cancel', state: 'reconcile' }, { event_type: 'cancel', state: 'reconcile' }]);
        await f.restart();
        const jobs = f.adapters().jobs;
        for (const id of [leased, dispatching]) expect(await jobs.outbox.get({ tenantId: jobTenant({ context: f.context }), id }))
            .toMatchObject({ state: 'reconcile', leaseToken: null, leaseExpiresAt: null });
        expect(await jobs.outbox.get({ tenantId: jobTenant({ context: f.context }), id: queued })).toMatchObject({ state: 'cancelled' });
        expect(await jobs.claim({ worker: { workerId: 'restarted' } })).toEqual({ ok: true, value: null });
        expect(await processingAllowed({ policy: f.adapters().identity.policy, context: f.context, subjectId: a.value.subjectId })).toEqual({ ok: true, value: false });
    } finally { await f.close(); }
});

it('rolls back the whole erasure request on suppression, cancellation journal or request persistence failure', async () => {
    const f = await fixture({});
    try {
        const binding = f.adapters();
        const subject = await binding.identity.contacts.upsert({ context: f.context, identifiers: [{ kind: 'email', raw: 'atomic@example.test' }] });
        if (!subject.ok) throw new Error('Missing subject');
        await subjectJob({ f, subjectId: subject.value.subjectId, id: 'pending' });
        for (const trigger of [
            "BEFORE INSERT ON policy_evidence WHEN NEW.kind='suppression'",
            "BEFORE INSERT ON job_attempt WHEN NEW.event_type='cancel'",
            "BEFORE INSERT ON privacy_request",
        ]) {
            f.native.exec("CREATE TRIGGER fail_erasure " + trigger + " BEGIN SELECT RAISE(ABORT,'fixture erasure failure'); END");
            expect(await binding.privacy.privacy.requestErasure({ context: f.context, subjectId: subject.value.subjectId })).toMatchObject({ ok: false });
            expect(f.native.prepare('SELECT COUNT(*) AS n FROM privacy_request').get()).toEqual({ n: 0 });
            expect(f.native.prepare('SELECT COUNT(*) AS n FROM policy_evidence').get()).toEqual({ n: 0 });
            expect(f.native.prepare("SELECT COUNT(*) AS n FROM job_attempt WHERE event_type='cancel'").get()).toEqual({ n: 0 });
            expect(f.native.prepare('SELECT state FROM job').get()).toEqual({ state: 'pending' });
            expect(f.native.inTransaction).toBe(false);
            f.native.exec('DROP TRIGGER fail_erasure');
        }
    } finally { await f.close(); }
});

it('recovers a crash around dispatch-start after reopening SQLite without replaying either attempt', async () => {
    const f = await fixture({});
    try {
        const subject = await f.adapters().identity.contacts.upsert({ context: f.context, identifiers: [{ kind: 'email', raw: 'restart@example.test' }] });
        if (!subject.ok) throw new Error('Missing subject');
        const before = await subjectJob({ f, subjectId: subject.value.subjectId, id: 'before', state: 'leased' });
        const after = await subjectJob({ f, subjectId: subject.value.subjectId, id: 'after', state: 'dispatching' });
        await f.restart();
        f.advance({ ms: formRetryPolicy.leaseMs });
        const jobs = f.adapters().jobs;
        expect(await jobs.claim({ worker: { workerId: 'recovery' } })).toEqual({ ok: true, value: null });
        for (const id of [before, after]) expect(await jobs.outbox.get({ tenantId: jobTenant({ context: f.context }), id })).toMatchObject({ state: 'reconcile', leaseToken: null });
        expect(f.native.prepare("SELECT event_type FROM job_attempt WHERE event_type='recovery'").all()).toHaveLength(2);
    } finally { await f.close(); }
});

it('holds form withdrawal outside SQLite until the active subject attempt finishes', async () => {
    const f = await fixture({}); const entered = Promise.withResolvers<void>(); const resume = Promise.withResolvers<void>();
    let attempt: Promise<unknown> | undefined; let acceptance: Promise<unknown> | undefined;
    try {
        const page = await form({ fixture: f });
        const binding = f.adapters();
        const subject = await binding.identity.contacts.upsert({ context: f.context, identifiers: [{ kind: 'email', raw: 'withdraw@example.test' }] });
        if (!subject.ok) throw new Error('Missing subject');
        const receipt = await submit({ fixture: f, fields: { ...page.fields, email: 'withdraw@example.test' } });
        attempt = binding.subjectLane.run({ context: f.context, subjectIds: [subject.value.subjectId], work: async () => { entered.resolve(); await resume.promise; return { ok: true, value: undefined }; } });
        await entered.promise;
        acceptance = binding.forms.accept({ context: f.context, ...receipt });
        const other = await binding.identity.contacts.upsert({ context: f.context, identifiers: [{ kind: 'email', raw: 'unrelated@example.test' }] });
        expect(other).toMatchObject({ ok: true });
        expect(f.native.inTransaction).toBe(false);
        expect(f.native.prepare('SELECT COUNT(*) AS n FROM policy_evidence').get()).toEqual({ n: 0 });
        resume.resolve(); await attempt;
        expect(await acceptance).toMatchObject({ ok: true, value: { subjectId: subject.value.subjectId } });
        expect(JSON.stringify(f.native.prepare('SELECT payload FROM policy_evidence').all())).toContain('withdrawn');
    } finally { resume.resolve(); await attempt; await acceptance; await f.close(); }
});

it('rolls back identity drift in acceptance and retries once under the newly resolved subject lane', async () => {
    const f = await fixture({});
    try {
        const page = await form({ fixture: f });
        const receipt = await submit({ fixture: f, fields: { ...page.fields, email: 'drift@example.test' } });
        const binding = f.adapters(); const run = binding.subjectLane.run;
        const families: (readonly string[])[] = [];
        let createdId = '';
        binding.subjectLane.run = async (input, options) => {
            families.push(input.subjectIds);
            if (families.length === 1) {
                const created = await binding.identity.contacts.upsert({ context: f.context, identifiers: [{ kind: 'email', raw: 'drift@example.test' }] });
                if (!created.ok) throw new Error('Missing injected identity');
                createdId = created.value.subjectId;
            }
            return run(input, options);
        };
        expect(await binding.forms.accept({ context: f.context, ...receipt })).toEqual({ ok: true, value: { subjectId: createdId } });
        expect(families).toEqual([[], [createdId]]);
        expect(count({ fixture: f, table: 'contact_subject' })).toBe(1);
        expect(count({ fixture: f, table: 'policy_evidence' })).toBe(2);
        expect(count({ fixture: f, table: 'om_form_subject_receipts' })).toBe(1);
    } finally { await f.close(); }
});

/** Reuse the actual lifecycle and SQL repository without a second fixture lead store. */
function leadService(required: { f: Fixture }) {
    return createLeadsService({ repo: createSqlLeadsRepo({ unitOfWork: required.f.adapters().database.unit }),
        clock: required.f.clock, ids: { next: () => randomUUID() } });
}

it('captures one new form lead through worker retry, receipt replay and restart', async () => {
    const f = await fixture({});
    try {
        const page = await form({ fixture: f });
        const receipt = await submit({ fixture: f, fields: { ...page.fields, email: 'one-lead@example.test' } });
        f.native.exec("CREATE TRIGGER fail_lead BEFORE INSERT ON lead BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
        await f.drain();
        expect(count({ fixture: f, table: 'lead' })).toBe(0);
        expect(count({ fixture: f, table: 'om_form_subject_receipts' })).toBe(0);
        expect(count({ fixture: f, table: 'contact_subject' })).toBe(0);
        f.native.exec('DROP TRIGGER fail_lead');
        f.advance({ ms: 1100 });
        await f.drain();
        const accepted = await f.adapters().forms.accept({ context: f.context, ...receipt });
        expect(accepted.ok).toBe(true);
        const leads = await leadService({ f }).list({ context: f.context, query: { page: { limit: 50 } } });
        expect(leads).toMatchObject({ ok: true, value: { items: [{ stage: 'new', revision: 1,
            source: { kind: 'form', ref: receipt.submissionId }, attribution: { campaign: null } }] } });
        expect(count({ fixture: f, table: 'lead' })).toBe(1);
        await f.restart();
        expect(await f.adapters().forms.accept({ context: f.context, ...receipt })).toEqual(accepted);
        expect(count({ fixture: f, table: 'lead' })).toBe(1);
        expect(f.native.prepare('SELECT COUNT(*) AS n FROM lead_stage_event').get()).toEqual({ n: 1 });
    } finally { await f.close(); }
});

it('a conflicting source rolls back acceptance without adding a lead or receipt', async () => {
    const f = await fixture({});
    try {
        const page = await form({ fixture: f });
        const receipt = await submit({ fixture: f, fields: { ...page.fields, email: 'conflict-lead@example.test' } });
        const leads = leadService({ f });
        expect(await leads.capture({ context: f.context, subjectId: 'other-subject', source: { kind: 'form', ref: receipt.submissionId },
            occurredAt: f.clock.now({}), attribution: { campaign: null, touchId: null, touchedAt: null, modelVersion: 'last_paid_touch_30d.v1' } })).toMatchObject({ ok: true });
        expect(await f.adapters().forms.accept({ context: f.context, ...receipt })).toMatchObject({ ok: false, error: { code: 'conflict' } });
        expect(count({ fixture: f, table: 'om_form_subject_receipts' })).toBe(0);
        expect(count({ fixture: f, table: 'contact_subject' })).toBe(0);
        expect(count({ fixture: f, table: 'policy_evidence' })).toBe(0);
        // The pre-existing conflicting lead is preserved; no acceptance lead was committed.
        expect(count({ fixture: f, table: 'lead' })).toBe(1);
        expect(f.native.prepare('SELECT subject_id FROM lead').get()).toEqual({ subject_id: 'other-subject' });
    } finally { await f.close(); }
});

/** Seed schema-validated metrics evidence, observed only in this fixture's workspace. */
function observedLeadCampaign(required: { f: Fixture; foreign?: boolean }) {
    const { f } = required;
    const key = { pluginId: 'fixture-ads', accountId: 'fixture-account', vendorCampaignId: 'paid-campaign' };
    const encoded = encodeCampaignKey({ key });
    if (!encoded.ok) throw new Error('Invalid campaign fixture');
    const batch = metricBatchSchema.parse({ schema: 'report.metrics.v1', pluginId: key.pluginId, accountId: key.accountId,
        connectionId: 'fixture-connection', currency: 'USD', timezone: 'UTC', grain: 'campaign',
        days: { start: '2026-10-14', end: '2026-10-15' }, retrievedAt: f.clock.now({}), dataThrough: f.clock.now({}),
        complete: true, freshness: 'fresh', finality: 'provisional', restated: false,
        mapping: { pluginId: key.pluginId, version: 'v1', grains: { campaign: {} } },
        rows: [{ day: '2026-10-14', entity: { grain: 'campaign', vendorCampaignId: key.vendorCampaignId }, metrics: {} }] });
    f.native.prepare('INSERT INTO measure_metrics_batch VALUES (?,?,?,?,?,?,?,?,?)').run(
        JSON.stringify([f.context.scope.ownerId, required.foreign ? 'foreign-workspace' : f.context.scope.workspaceId]),
        'lead-sync', key.pluginId, 'fixture-connection', key.accountId, 'campaign', f.clock.now({}), '{}', JSON.stringify(batch));
    return { key, encoded: encoded.value };
}

it.each([
    { age: 0, evidence: 'observed', attributed: true },
    { age: 30 * 86400000, evidence: 'observed', attributed: true },
    { age: 30 * 86400000 + 1, evidence: 'observed', attributed: false },
    { age: 0, evidence: 'foreign', attributed: false },
    { age: 0, evidence: 'missing', attributed: false },
    { age: 0, evidence: 'failed', attributed: false },
    { age: 0, evidence: 'saturated', attributed: true },
    { age: 0, evidence: 'over-limit', attributed: true },
])('freezes scoped paid evidence, preserving the enquiry: $evidence / age $age', async ({ age, evidence, attributed }) => {
    const f = await fixture({});
    try {
        const page = await form({ fixture: f });
        const campaign = observedLeadCampaign({ f, foreign: evidence === 'foreign' });
        if (evidence === 'missing') f.native.prepare('DELETE FROM measure_metrics_batch').run();
        if (evidence === 'failed') f.native.prepare("UPDATE measure_metrics_batch SET batch_json='{}'").run();
        const binding = f.adapters();
        const { visit, token } = binding.visits.issue({ context: f.context });
        expect(await binding.identity.webRepo.saveVisit({ context: f.context, visit })).toMatchObject({ ok: true });
        const cookie = 'om_visit_' + new URL(f.origin).port + '=' + token + '; ' + f.granted();
        const total = evidence === 'over-limit' ? 101 : evidence === 'saturated' ? 100 : 2;
        for (let i = 0; i < total; i++) {
            const occurredAt = f.clock.now({}) - age;
            // Reverse insertion proves repository tie ordering selects the highest touch ID.
            const id = 'paid-' + String(total - i - 1).padStart(3, '0');
            expect(await binding.identity.webRepo.recordTouch({ context: f.context,
                event: { eventId: id, schema: 'om.web.landing', version: 1, source: 'first-party', name: 'landing',
                    anonymousId: visit.anonymousId, properties: { campaignId: campaign.encoded }, occurredAt, receivedAt: f.clock.now({}), cursor: 0, traceId: f.context.traceId },
                touch: { touchId: id, eventId: id, occurredAt, campaignId: campaign.encoded, linkId: null, clickIdentifiers: {} } })).toMatchObject({ ok: true });
        }
        const receipt = await submit({ fixture: f, fields: { ...page.fields, email: 'paid-lead@example.test' }, cookie });
        // An observed claim must succeed without connection_busy: membership borrows the session.
        expect(await binding.forms.accept({ context: f.context, ...receipt })).toMatchObject({ ok: true });
        const leads = await leadService({ f }).list({ context: f.context, query: { page: { limit: 50 } } });
        expect(leads).toMatchObject({ ok: true, value: { items: [{ attribution: attributed
            ? { campaign: campaign.key, touchId: 'paid-' + String(total - 1).padStart(3, '0'), touchedAt: f.clock.now({}) - age }
            : { campaign: null, touchId: null, touchedAt: null } }] } });
    } finally { await f.close(); }
});

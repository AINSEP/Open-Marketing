import { createSqlContactRepo } from '@open-marketing/contacts';
import { createSqlJobRepo, jobTenant } from '@open-marketing/jobs';
import { bindIdentity, createVisitTokens } from '../src/composition/identity.js';
import { createSubjectLane } from '../src/composition/subject-lane.js';
import { formRetryPolicy } from '../src/composition/forms.js';
/** R2 fixtures use real safety/measure/jobs services and plugin codecs; all egress is injected. */
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import type { CallContext, ClockPort, HaltStopRequest, Outcome, UnitOfWork } from '@open-marketing/contracts';
import { createMemoryAccountDispatchLock, createMemoryConfirmationExchange, createMemorySafetyAudit, createMemorySafetyRepo,
    createMemorySpendPolicy, createMemoryPlatformLimitEvidence, createMemoryVerifiedEffectResolver, createSafetyService, digestArguments } from '@open-marketing/safety';
import { createMemoryConversionDeliveryState, createMemoryConversionVerification, createMemoryMeasurementGrant, createSqlMeasureAudit, createMeasurementShareabilityAdapter } from '@open-marketing/measure';
import type { ConversionDeliveryPort, ConversionInput, MeasureGrant } from '@open-marketing/measure';
import { createSqlFormsStorage } from '@open-marketing/forms';
import { bindPrivacy } from '../src/composition/privacy.js';
import { bindAgentPluginBackends, bindAgentPluginJobs, countAddonJobs } from '../src/composition/agent-plugin-backends.js';
import { bindAgentPluginHaltJobs, createFormWorkers } from '../src/composition/workers.js';
import { bindServerDatabase, provisionWorkspace } from '../src/composition/database.js';
import { migrationManifest } from '../src/composition/migrations.js';
import * as linkedInSource from '../../../content/agent-plugins/linkedin-ads/io.github.ainsep.openmarketing/src/index.js';
import * as tikTokSource from '../../../content/agent-plugins/tiktok-ads/io.github.ainsep.openmarketing/src/index.js';

/** Captured approval evidence; each fixture owns its audit records. */
function answerAudit() {
    const answers: unknown[] = [];
    return { answers, async recordAnswer(input: { answer: unknown }) {
        answers.push(structuredClone(input.answer));
        return { ok: true as const, value: undefined };
    } };
}

const context: CallContext = { scope: { ownerId: 'owner', workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }, principal: { kind: 'owner', ownerId: 'owner' }, correlationId: 'correlation', traceId: 'trace' };
const serviceContext = { scope: context.scope, serviceId: 'om-halt-worker', correlationId: context.correlationId, traceId: context.traceId };
const clock = { now: () => 1000 };
const observer = { observe() {} };
function value<T>(required: { result: Outcome<T> }): T { if (!required.result.ok) throw new Error(required.result.error.message); return required.result.value; }

async function fixture(required: { pluginId?: string; module?: object; clock?: ClockPort; onFetch?(): Promise<void> } = {}) {
    const fixtureClock = required.clock ?? clock;
    const selectedPlugin = required.pluginId ?? 'linkedin-ads';
    const native = new Database(':memory:');
    native.pragma('foreign_keys = ON');
    for (const entry of migrationManifest) native.exec(readFileSync(new URL('../../../' + entry.path, import.meta.url), 'utf8'));
    const database = bindServerDatabase({ native, observer, context });
    await provisionWorkspace({ database: database.workspace, scope: context.scope });
    const ids = { next: () => randomUUID() };
    const contactRepo = createSqlContactRepo({ uow: database.unit });
    value({ result: await contactRepo.upsert({ context, subject: { scope: context.scope, subjectId: 'subject', createdAt: 1000, creationOrder: 0, mergedInto: null, lineage: [] },
        identifiers: [{ identifierId: 'email', subjectId: 'subject', kind: 'email', normalizedValue: 'fixture@example.test', normalizationVersion: 'v1', identifierDigest: 'a'.repeat(64), keyVersion: 'local-v1' }] }) });
    const subjectLane = createSubjectLane({ resolveSubject: contactRepo.get });
    const identity = bindIdentity({ unit: database.unit, clock: fixtureClock, ids, observer, digestKey: new Uint8Array([1]),
        tokens: createVisitTokens({ key: new Uint8Array([1]), clock: fixtureClock, ids }).tokens, subjectLane });
    const jobs = createSqlJobRepo({ database: database.unit, clock: fixtureClock, ids, retryPolicy: formRetryPolicy });
    const locks = createMemoryAccountDispatchLock({ ids });
    const repo = createMemorySafetyRepo({ clock: fixtureClock, ids, ownerTimezone: 'UTC' });
    const calls: { url: string; options?: RequestInit }[] = [];
    const credentials: string[] = [];
    let admitted = true; let tokenCallback = async () => {}; let bindingCallback = async () => {};
    const backend = bindAgentPluginBackends({ projectRoot: '/fixture', clock: fixtureClock, observer, mode: 'production', accountLocks: locks, subjectLane,
        addons: { async list() { return { ok: true, value: { items: [{ kind: 'agent-plugin', id: selectedPlugin, name: selectedPlugin, description: '', version: '1', enabled: true, revision: 'a'.repeat(64) }], cursor: null } }; } },
        jobs: bindAgentPluginJobs({ unit: database.unit, clock: fixtureClock, ids, observer }), safetyRepo: repo, unit: database.unit,
        policyForTransaction: ({ unit }) => identity.forTransaction({ unit }).policy,
        async moduleDigest() { return 'd'.repeat(64); },
        async loadModule() {
            return required.module ?? (selectedPlugin === 'tiktok-ads' ? tikTokSource : linkedInSource);
        },
        async wait() { return { ok: true, value: undefined }; },
        async state({ pluginId }) { return pluginId === selectedPlugin ? { enabled: true, admitted, bundled: true, entryUrl: 'file:///fixture/' + pluginId + '/io.github.ainsep.openmarketing/dist/index.mjs', revision: 'a'.repeat(64), metadata: { conversionConfiguration: {
            accountId: '123', purpose: 'measurement', payloadSchema: 'om.conversion',
            conversionRules: { purchase: 'urn:lla:llaPartnerConversion:456' },
        } } } : null; },
        accounts: { async find({ externalAccountId }) { await bindingCallback(); return { ok: true, value: { id: 'binding', scope: context.scope, connectionId: 'connection', externalAccountId } }; } },
        integrations: { async access({ pluginId }) { credentials.push(pluginId); await tokenCallback(); return { ok: true, value: { accessToken: 'fixture-only-token' } }; } },
        fetch: async (url, options) => {
            expect(native.inTransaction).toBe(false); calls.push({ url: String(url), options }); await required.onFetch?.();
            if (String(url) === 'https://api.linkedin.com/rest/adAccounts/123' && options?.method === 'GET') return new Response(JSON.stringify({ id: '123', currency: 'USD' }), { status: 200 });
            return new Response(null, { status: 201 });
        },
    });
    return { native, database, ids, locks, repo, backend, calls, credentials, subjectLane, identity, jobs, clock: fixtureClock, pluginId: selectedPlugin,
        onBinding(input: { callback(): Promise<void> }) { bindingCallback = input.callback; },
        unadmit() { admitted = false; }, onToken(input: { callback(): Promise<void> }) { tokenCallback = input.callback; }, close() { native.close(); } };
}
function safety(required: { f: Awaited<ReturnType<typeof fixture>>; requests: HaltStopRequest[] }) {
    const { f } = required;
    return createSafetyService({ repo: f.repo, accountLocks: f.locks, clock, ids: f.ids, audit: createMemorySafetyAudit({}),
        confirmations: createMemoryConfirmationExchange({ ...answerAudit(), clock, ids: f.ids }), policy: createMemorySpendPolicy({}), platformLimits: createMemoryPlatformLimitEvidence({}),
        effects: { ...createMemoryVerifiedEffectResolver({}), async verifyHaltStop({ request }) {
            return required.requests.some(known => JSON.stringify(known) === JSON.stringify(request)) ? { ok: true, value: undefined }
                : { ok: false, error: { code: 'forbidden', message: 'Unverified fixture target', retryable: false } };
        } } }, { haltServiceId: serviceContext.serviceId });
}

it('commits halt before enqueue, obtains a fresh worker permit, and never replays an uncertain stop', async () => {
    const f = await fixture({ pluginId: 'tiktok-ads' }); const requests: HaltStopRequest[] = []; const order: string[] = [];
    const service = safety({ f, requests });
    const definitions = value({ result: await f.backend.definitions({ context }) });
    const revision = definitions[0].revision!;
    const halt = bindAgentPluginHaltJobs({ unit: f.database.unit, clock, ids: f.ids, observer, accountLocks: f.locks, safety: service,
        async targets({ receipt }) {
            expect(value({ result: await f.repo.snapshot({ context, accountId: '123' }) }).halted).toBe(true);
            expect(f.native.prepare("SELECT count(*) AS count FROM job").get()).toEqual({ count: 0 });
            order.push('local-halt');
            const args = { adAccountId: '123', entityIds: ['456'], action: 'pause' as const };
            const request: HaltStopRequest = { ...args, operationId: 'stop', scope: context.scope, connectionId: 'connection',
                haltId: receipt.haltId, haltEpoch: receipt.epoch, pluginDigest: revision, bindingId: 'tiktok-ads.stop.v1', argumentsDigest: value({ result: digestArguments({ arguments: args }) }) };
            requests.push(request);
            return { ok: true, value: [{ pluginId: 'tiktok-ads', request }] };
        },
        async stop(input) { order.push('remote-stop'); return f.backend.haltStop(input); },
    });
    const workers = createFormWorkers({ unit: f.database.unit, clock, ids: f.ids, observer, context, halt,
        forms: { async accept() { throw new Error('Unexpected forms job'); } }, schedule() { throw new Error('Manual worker only'); } });
    try {
        expect(await halt.halt({ context, adAccountId: '123' })).toMatchObject({ ok: true, value: { remoteStatus: 'pending' } });
        expect(order).toEqual(['local-halt']); expect(f.calls).toEqual([]);
        expect(f.native.prepare("SELECT operation,state FROM job").all()).toEqual([{ operation: 'agent-plugin.halt-stop', state: 'pending' }]);
        await workers.processOne();
        expect(order).toEqual(['local-halt', 'remote-stop']);
        expect(f.calls).toHaveLength(1);
        expect(JSON.parse(String(f.calls[0].options?.body))).toEqual({ advertiser_id: '123', campaign_ids: ['456'], operation_status: 'DISABLE' });
        expect(f.native.prepare("SELECT state FROM job WHERE operation='agent-plugin.halt-stop'").get()).toEqual({ state: 'reconcile' });
        await workers.processOne();
        expect(f.calls).toHaveLength(1);
        // A lost/invalid acknowledgement cannot mark the durable halt stopped.
        expect(value({ result: await f.repo.getHalt({ context, accountId: '123' }) }).remoteStatus).toBe('pending');
        const pause = definitions.find(tool => tool.name === 'vendor_tiktok_ads_tiktok_ads_pause_entity')!;
        expect(await pause.invoke({ context, input: { operationId: 'after-halt', connectionId: 'connection', accountId: '123', arguments: { kind: 'pause-entity', entityType: 'campaign', entityId: '456' } } })).toMatchObject({ ok: false });
        expect(f.calls).toHaveLength(1);
    } finally { await workers.stop({}); f.close(); }
});

it('does not enqueue mixed-invalid halt targets and keeps local halt when remote work is unavailable', async () => {
    const f = await fixture(); const requests: HaltStopRequest[] = [];
    const service = safety({ f, requests });
    const halt = bindAgentPluginHaltJobs({ unit: f.database.unit, clock, ids: f.ids, observer, accountLocks: f.locks, safety: service,
        async targets({ receipt }) {
            const args = { adAccountId: '123', entityIds: ['456'], action: 'pause' as const };
            const request = { ...args, operationId: 'stop', scope: context.scope, connectionId: 'connection', haltId: receipt.haltId,
                haltEpoch: receipt.epoch, pluginDigest: 'a'.repeat(64), bindingId: 'linkedin-ads.stop.v1', argumentsDigest: value({ result: digestArguments({ arguments: args }) }) };
            return { ok: true, value: [{ pluginId: 'linkedin-ads', request }, { pluginId: 'tiktok-ads', request: { ...request, operationId: 'other', haltEpoch: receipt.epoch + 1 } }] };
        }, stop: input => f.backend.haltStop(input) });
    try {
        expect(await halt.halt({ context, adAccountId: '123' })).toMatchObject({ ok: false });
        expect(value({ result: await f.repo.snapshot({ context, accountId: '123' }) }).halted).toBe(true);
        expect(f.native.prepare('SELECT count(*) AS count FROM job').get()).toEqual({ count: 0 });
        expect(f.calls).toEqual([]);
    } finally { f.close(); }
});

it('rejects a stale halt epoch and unadmitted stop before token/network access', async () => {
    const f = await fixture(); const requests: HaltStopRequest[] = [];
    const service = safety({ f, requests });
    try {
        const receipt = value({ result: await service.haltAccount({ context, adAccountId: '123' }) });
        const args = { adAccountId: '123', entityIds: ['456'], action: 'pause' as const };
        const request = { ...args, operationId: 'stop', scope: context.scope, connectionId: 'connection', haltId: receipt.haltId, haltEpoch: receipt.epoch,
            pluginDigest: value({ result: await f.backend.definitions({ context }) })[0].revision!, bindingId: 'linkedin-ads.stop.v1', argumentsDigest: value({ result: digestArguments({ arguments: args }) }) };
        requests.push(request);
        const permit = value({ result: await service.authorizeHaltStop({ context: serviceContext, request }) });
        f.unadmit();
        expect(await f.backend.haltStop({ context: { ...context, principal: { kind: 'service', serviceId: serviceContext.serviceId } }, pluginId: 'linkedin-ads', permit })).toMatchObject({ ok: false });
        const stale = { ...request, haltEpoch: request.haltEpoch + 1 };
        requests.push(stale); // Verified target evidence still cannot override the current local halt epoch.
        expect(await service.authorizeHaltStop({ context: serviceContext, request: stale })).toMatchObject({ ok: false });
        expect(f.credentials).toEqual([]); expect(f.calls).toEqual([]);
    } finally { f.close(); }
});

const event: ConversionInput = { eventId: 'event', definitionId: 'purchase', subjectId: 'subject', occurredAt: 1000, destination: 'linkedin-ads', purpose: 'measurement', identifierDigests: { email: 'a'.repeat(64) } };
const grant: MeasureGrant = { kind: 'measurement', grantId: 'grant', scope: context.scope, connectionId: 'connection', accountId: '123', definitionIds: ['purchase'], destination: 'linkedin-ads', purpose: 'measurement', payloadSchema: 'om.conversion', payloadVersion: 1, expiresAt: 100000, revoked: false };
async function conversions(required: { f: Awaited<ReturnType<typeof fixture>>; local?: boolean; beforeAssess?(): Promise<void>; beforeAppend?(): Promise<void>;
    admissionErasure?: 'pending' | 'erased'; failAdmissionEvidence?: boolean }) {
    const clock = required.f.clock;
    const event = { ...conversionRequest.event, destination: required.f.pluginId };
    const grant = { ...conversionRequest.grant, destination: required.f.pluginId };
    let allowed = true; let withdrawAtAudit = false;
    const records: unknown[] = [];
    const ledger = createMemoryConversionDeliveryState({});
    const grants = createMemoryMeasurementGrant({ grants: [grant] });
    value({ result: await required.f.identity.policy.appendEvidence({ context, evidence: { id: 'sharing-consent', scope: context.scope, subjectId: event.subjectId,
        kind: 'consent', recordedAt: 1000, sourceId: 'fixture', consent: { scope: 'destination', target: event.destination, purpose: event.purpose,
            status: 'granted', start: 1000, end: 100000 } } }) });
    // The grant is deliberately in memory; production grant persistence is outside this lane.
    // Policy and audit always bind the given unit, including the final admission's joined session.
    function authority({ unit }: { unit: UnitOfWork }) {
        const identity = required.f.identity.forTransaction({ unit });
        const audit = createSqlMeasureAudit({ database: {
            query: input => unit.transaction({ work: ({ session }) => session.query(input) }),
            transaction: unit.transaction,
        }, clock, ids: required.f.ids }, { observer });
        const loadEvidence: Parameters<typeof createMeasurementShareabilityAdapter>[0]['loadEvidence'] = async input => {
            await required.beforeAssess?.();
            if ('query' in unit && required.failAdmissionEvidence) return { ok: false, error: { code: 'unavailable', message: 'Evidence read failed', retryable: false } };
            const snapshot = await identity.policy.snapshot({ context: input.context, subjectId: input.event.subjectId });
            if (!snapshot.ok) return snapshot;
            const subject = await identity.contactsRepo.get({ context: input.context, subjectId: input.event.subjectId });
            if (!subject.ok) return subject;
            if (!subject.value) return { ok: false, error: { code: 'unavailable', message: 'Missing subject', retryable: false } };
            const subjectIds = [...new Set([subject.value.subjectId, ...subject.value.lineage.map(item => item.sourceSubjectId)])];
            const consents = [...snapshot.value.consents];
            if (!allowed) consents.push({ scope: 'destination', target: event.destination, purpose: event.purpose, status: 'withdrawn', start: 1000, end: 100000 });
            return { ok: true, value: { policy: { ...snapshot.value, consents },
                lineage: subjectIds.map(subjectId => ({ subject: { scope: input.context.scope, subjectId }, erasure: 'query' in unit ? required.admissionErasure ?? 'none' : 'none' })) } };
        };
        return { grants, loadEvidence,
            audit: { async record(input: { context: CallContext; operationId: string; outcome: string }) {
                if (['egress_admitted', 'egress_denied'].includes(input.outcome)) expect(required.f.native.inTransaction).toBe(true);
                records.push(input); if (withdrawAtAudit) allowed = false;
                return audit.record(input);
            } },
        };
    }
    const queued = value({ result: await required.f.jobs.enqueue({ context, job: { handler: 'measure.conversion', operationId: 'delivery',
        idempotencyKey: 'conversion:delivery', argumentsDigest: 'c'.repeat(64), payload: { subjectId: event.subjectId, eventId: event.eventId, deliveryId: 'delivery' } } }) });
    const leased = value({ result: await required.f.jobs.claim({ worker: { workerId: 'measure-worker' } }) });
    if (!leased || leased.lease.id !== queued.jobId) throw new Error('Missing conversion claim');
    const claim = { jobId: queued.jobId, leaseToken: leased.lease.leaseToken! };
    const rootAuthority = authority({ unit: required.f.database.unit });
    const claimedDispatcher = required.f.backend.conversions({ clock, runtimeMode: required.local ? 'local-sandbox' : 'production-server', payloadSchema: 'om.conversion',
        identifiers: { async identifiersFor() { return { ok: true, value: { subjectId: 'subject', identifiers: { email: 'b'.repeat(64) }, identifierDigests: event.identifierDigests } }; } },
        verification: createMemoryConversionVerification({ events: [{ scope: context.scope, event }] }),
        ...rootAuthority, policy: createMeasurementShareabilityAdapter({ clock, loadEvidence: rootAuthority.loadEvidence }), authority,
        ledger: { read: input => ledger.read(input), async begin(input) { records.push(input.record); return ledger.begin(input); }, async append(input) { records.push(input.record); await required.beforeAppend?.(); return ledger.append(input); } },
    });
    const dispatcher = { dispatch(input: typeof conversionRequest, options?: { signal?: AbortSignal }) { return claimedDispatcher.dispatch({ ...input, claim }, options); } };
    return { dispatcher, claimedDispatcher, claim, records, withdraw() { allowed = false; }, withdrawAtAudit() { withdrawAtAudit = true; } };
}
const conversionRequest = { context: { ...serviceContext, serviceId: 'measure-worker' }, event, grant, deliveryId: 'delivery' };

it.each([
    { result: 'delivered', reason: 'protocol_mismatch' },
    { result: 'unknown', reason: 'unavailable' },
    { result: 'throw', reason: 'unavailable' },
    { result: 'malformed', reason: 'unavailable' },
] as const)('records $reason when a plugin returns $result without native egress', async ({ result, reason }) => {
    const f = await fixture({ module: { createConversionDelivery() { return {
        async deliver() {
            if (result === 'throw') throw new Error('fixture-secret');
            if (result === 'malformed') return { ok: true, value: { status: 'not_sent', reason: 'forbidden' } };
            return { ok: true, value: { status: result } };
        },
    }; } } });
    const c = await conversions({ f });
    try {
        expect(await c.dispatcher.dispatch(conversionRequest)).toEqual({ ok: true, value: { status: 'not_sent', reason } });
        expect(f.calls).toEqual([]);
        expect(await f.jobs.outbox.get({ tenantId: jobTenant({ context }), id: c.claim.jobId })).toMatchObject({ state: 'failed', leaseToken: null });
        expect(c.records).toContainEqual(expect.objectContaining({ status: 'not_sent', reason }));
        expect(JSON.stringify(c.records)).not.toContain('fixture-secret');
    } finally { f.close(); }
});
it('keeps a native-fetch exception uncertain and completes the outbox for reconciliation', async () => {
    const f = await fixture({ async onFetch() { throw new Error('fixture-secret response lost'); } });
    const c = await conversions({ f });
    try {
        expect(await c.dispatcher.dispatch(conversionRequest)).toEqual({ ok: true, value: { status: 'unknown' } });
        expect(f.calls).toHaveLength(1);
        expect(await f.jobs.outbox.get({ tenantId: jobTenant({ context }), id: c.claim.jobId })).toMatchObject({ state: 'reconcile', leaseToken: null });
        expect(c.records).toContainEqual(expect.objectContaining({ status: 'unknown' }));
        expect(JSON.stringify(c.records)).not.toContain('fixture-secret');
    } finally { f.close(); }
});
it.each([
    { method: 'GET', requestObject: false },
    { method: 'POST', requestObject: false },
    { method: 'POST', requestObject: true },
])('claim-less readback enforces $method ($requestObject Request) without outbox changes', async ({ method, requestObject }) => {
    const diagnostics = { accepted: true, processed: null, attributed: null, observedAt: 1000 };
    const f = await fixture({ module: { createConversionDelivery(ports: { fetch: typeof fetch }) { return {
        async deliver() {
            await ports.fetch('https://fixture.invalid/conversions', { method: 'POST' });
            return { ok: true, value: { status: 'delivered', receiptId: 'saved-receipt', diagnostics } };
        },
        async reconcile(input: Parameters<NonNullable<ConversionDeliveryPort['reconcile']>>[0]) {
            expect(input.receiptId).toBe('saved-receipt');
            expect(input.event).not.toHaveProperty('identifiers');
            if (requestObject) await ports.fetch(new Request('https://fixture.invalid/status', { method }));
            else await ports.fetch('https://fixture.invalid/status', { method });
            return { ok: true, value: { status: 'delivered', receiptId: input.receiptId, diagnostics: { ...diagnostics, processed: true } } };
        },
    }; } } });
    const c = await conversions({ f });
    try {
        const sent = await c.dispatcher.dispatch(conversionRequest);
        expect(sent).toMatchObject({ ok: true, value: { status: 'delivered', receiptId: 'saved-receipt' } });
        const job = await f.jobs.outbox.get({ tenantId: jobTenant({ context }), id: c.claim.jobId });
        const attempts = f.native.prepare('SELECT * FROM job_attempt ORDER BY rowid').all();
        const records = c.records.length;
        const result = await c.claimedDispatcher.reconcile(conversionRequest);
        if (method === 'GET') expect(result).toMatchObject({ ok: true, value: { receiptId: 'saved-receipt', diagnostics: { processed: true } } });
        else expect(result).toEqual(sent);
        expect(f.calls.map(call => call.options?.method ?? 'GET')).toEqual(method === 'GET' ? ['POST', 'GET'] : ['POST']);
        expect(c.records.length).toBe(records + (method === 'GET' ? 1 : 0));
        expect(await f.jobs.outbox.get({ tenantId: jobTenant({ context }), id: c.claim.jobId })).toEqual(job);
        expect(f.native.prepare('SELECT * FROM job_attempt ORDER BY rowid').all()).toEqual(attempts);
    } finally { f.close(); }
});

it('hands the worker lease to A3 for exactly one dispatch-start and durable completion', async () => {
    const f = await fixture(); const c = await conversions({ f });
    // The shared direct-A3 fixture claims its job; release that fixture claim so the worker claims it.
    f.native.prepare("UPDATE job SET state='pending', lease_token=NULL, lease_expires_at=NULL WHERE id=?").run(c.claim.jobId);
    const workers = createFormWorkers({ unit: f.database.unit, clock, ids: f.ids, observer, context,
        conversions: { dispatch: c.claimedDispatcher.dispatch, async load(input) {
            expect(input).toEqual({ context: { ...serviceContext, serviceId: 'om-conversion-worker' }, subjectId: event.subjectId, eventId: event.eventId });
            expect(await f.jobs.outbox.get({ tenantId: jobTenant({ context }), id: c.claim.jobId })).toMatchObject({ state: 'leased' });
            return { ok: true, value: { event, grant } };
        } },
        forms: { async accept() { throw new Error('Unexpected forms job'); } }, schedule() { throw new Error('Manual worker only'); } });
    try {
        expect(await workers.processOne()).toEqual({ kind: 'completed', state: 'succeeded', jobId: c.claim.jobId });
        expect(f.native.prepare("SELECT state FROM job_attempt WHERE event_type='dispatch'").all()).toEqual([{ state: 'dispatching' }]);
        expect(f.native.prepare("SELECT state FROM job_attempt WHERE event_type='complete'").all()).toEqual([{ state: 'succeeded' }]);
        expect(await f.jobs.outbox.get({ tenantId: jobTenant({ context }), id: c.claim.jobId })).toMatchObject({ state: 'succeeded', leaseToken: null });
        expect(f.calls).toHaveLength(1);
        expect(await workers.processOne()).toEqual({ kind: 'idle' });
        expect(f.calls).toHaveLength(1);
    } finally { await workers.stop({}); f.close(); }
});

it('rejects a worker lease replaced during conversion loading before credentials or egress', async () => {
    const f = await fixture(); const c = await conversions({ f });
    f.native.prepare("UPDATE job SET state='pending', lease_token=NULL, lease_expires_at=NULL WHERE id=?").run(c.claim.jobId);
    const workers = createFormWorkers({ unit: f.database.unit, clock, ids: f.ids, observer, context,
        conversions: { dispatch: c.claimedDispatcher.dispatch, async load() {
            f.native.prepare("UPDATE job SET lease_token='foreign' WHERE id=?").run(c.claim.jobId);
            return { ok: true, value: { event, grant } };
        } },
        forms: { async accept() { throw new Error('Unexpected forms job'); } }, schedule() { throw new Error('Manual worker only'); } });
    try {
        expect(await workers.processOne()).toEqual({ kind: 'stale' });
        expect(f.calls).toEqual([]); expect(f.credentials).toEqual([]);
        expect(f.native.prepare("SELECT state FROM job_attempt WHERE event_type='dispatch'").all()).toEqual([]);
        expect(f.native.prepare("SELECT state FROM job_attempt WHERE event_type='complete'").all()).toEqual([]);
        expect(await f.jobs.outbox.get({ tenantId: jobTenant({ context }), id: c.claim.jobId })).toMatchObject({ state: 'leased', leaseToken: 'foreign' });
    } finally { await workers.stop({}); f.close(); }
});

it('selects a replacement conversion destination and forwards its install settings through guarded dependencies', async () => {
    const pluginId = 'fixture-conversions'; let factories = 0;
    const f = await fixture({ pluginId, module: {
        createConversionDelivery(ports: Parameters<typeof linkedInSource.createConversionDelivery>[0]) {
            factories++;
            expect(ports.configuration).toMatchObject({ scope: context.scope, connectionId: 'connection', accountId: '123', settings: {
                conversionConfiguration: { accountId: '123', purpose: 'measurement', payloadSchema: 'om.conversion',
                    conversionRules: { purchase: 'urn:lla:llaPartnerConversion:456' } },
            } });
            expect(typeof ports.authority.dispatch).toBe('function');
            return {
                async deliver(input: Parameters<ConversionDeliveryPort['deliver']>[0], options?: { signal?: AbortSignal }) {
                    expect(input.grant.destination).toBe(pluginId);
                    const access = await ports.credentials.access({ connectionId: input.grant.connectionId, accountId: input.grant.accountId }, options);
                    if (!access.ok) return access;
                    await ports.fetch('https://fixture.invalid/conversions', { method: 'POST', signal: options?.signal });
                    return { ok: true as const, value: { status: 'delivered' as const } };
                },
                async reconcile() { return { ok: true as const, value: { status: 'unknown' as const } }; },
            };
        },
    } });
    const c = await conversions({ f });
    try {
        expect(await c.dispatcher.dispatch({ ...conversionRequest, event: { ...event, destination: pluginId }, grant: { ...grant, destination: pluginId } })).toEqual({ ok: true, value: { status: 'delivered' } });
        expect(factories).toBe(1);
        expect(f.credentials).toEqual([pluginId]);
        expect(f.calls).toHaveLength(1);
        expect(f.calls[0].url).toBe('https://fixture.invalid/conversions');
        expect(admissionRows({ f })).toHaveLength(1);
    } finally { f.close(); }
});

it('rechecks consent at dispatch and after token resolution, with zero egress after withdrawal', async () => {
    for (const phase of ['audit', 'credentials'] as const) {
        const f = await fixture(); const c = await conversions({ f });
        try {
            if (phase === 'audit') c.withdrawAtAudit();
            else f.onToken({ async callback() { c.withdraw(); } });
            const result = await c.dispatcher.dispatch(conversionRequest);
            expect(result).toEqual({ ok: true, value: { status: 'not_sent', reason: 'forbidden' } });
            if (phase === 'credentials') expect(f.credentials).toEqual(['linkedin-ads']);
            expect(await f.jobs.outbox.get({ tenantId: jobTenant({ context }), id: c.claim.jobId })).toMatchObject({ state: 'denied', leaseToken: null });
            expect(f.calls).toEqual([]);
            expect(JSON.stringify(c.records)).not.toContain('b'.repeat(64));
        } finally { f.close(); }
    }
});

it('delivers contacts digests through the plugin once and never resends a delivered identity', async () => {
    const f = await fixture(); let atFetch = false;
    const snapshot = f.repo.snapshot;
    f.repo.snapshot = async (input, options) => { const result = await snapshot(input, options); atFetch = true; return result; };
    const c = await conversions({ f, async beforeAssess() { if (atFetch) expect(f.native.inTransaction).toBe(true); } });
    try {
        expect(await c.dispatcher.dispatch(conversionRequest)).toEqual({ ok: true, value: { status: 'delivered' } });
        expect(f.calls).toHaveLength(1);
        expect(JSON.parse(String(f.calls[0].options?.body))).toEqual({ conversion: 'urn:lla:llaPartnerConversion:456', conversionHappenedAt: 1000, eventId: 'event', user: { userIds: [{ idType: 'SHA256_EMAIL', idValue: 'b'.repeat(64) }] } });
        atFetch = false;
        expect(await c.dispatcher.dispatch(conversionRequest)).toMatchObject({ ok: false, error: { code: 'conflict' } });
        expect(f.calls).toHaveLength(1);
        expect(JSON.stringify(c.records)).not.toContain('b'.repeat(64));
        expect(JSON.stringify(c.records)).not.toContain('fixture-only-token');
    } finally { f.close(); }
});

it('refuses conversion egress when halt commits after an earlier unhalted snapshot', async () => {
    const f = await fixture(); const c = await conversions({ f }); const service = safety({ f, requests: [] });
    const captured = Promise.withResolvers<void>(); const resume = Promise.withResolvers<void>();
    const snapshot = f.repo.snapshot; let first = true;
    f.repo.snapshot = async (input, options) => {
        const result = await snapshot(input, options);
        if (first) { first = false; captured.resolve(); await resume.promise; }
        return result;
    };
    const delivering = c.dispatcher.dispatch(conversionRequest);
    try {
        await captured.promise;
        expect(await service.haltAccount({ context, adAccountId: '123' })).toMatchObject({ ok: true });
        expect(value({ result: await snapshot({ context, accountId: '123' }) }).halted).toBe(true);
        resume.resolve();
        expect(await delivering).toEqual({ ok: true, value: { status: 'not_sent', reason: 'forbidden' } });
        expect(f.calls).toEqual([]);
        expect(await f.jobs.outbox.get({ tenantId: jobTenant({ context }), id: c.claim.jobId })).toMatchObject({ state: 'denied', leaseToken: null });
        expect(await c.dispatcher.dispatch(conversionRequest)).toMatchObject({ ok: false, error: { code: 'conflict' } });
        expect(f.calls).toEqual([]);
    } finally { resume.resolve(); await delivering; f.close(); }
});

it('refuses conversion egress when the plugin is unadmitted during the final consent await', async () => {
    const f = await fixture(); const entered = Promise.withResolvers<void>(); const resume = Promise.withResolvers<void>();
    const snapshot = f.repo.snapshot; let atFetch = false;
    f.repo.snapshot = async (input, options) => { const result = await snapshot(input, options); atFetch = true; return result; };
    const c = await conversions({ f, async beforeAssess() { if (atFetch) { entered.resolve(); await resume.promise; } } });
    const delivering = c.dispatcher.dispatch(conversionRequest);
    try {
        await entered.promise;
        expect(f.credentials).toEqual(['linkedin-ads']);
        f.unadmit(); resume.resolve();
        expect(await delivering).toEqual({ ok: true, value: { status: 'not_sent', reason: 'forbidden' } });
        expect(f.calls).toEqual([]);
        expect(await safety({ f, requests: [] }).haltAccount({ context, adAccountId: '123' })).toMatchObject({ ok: true });
    } finally { resume.resolve(); await delivering; f.close(); }
});

it('holds the shared halt barrier until an in-flight conversion fetch finishes', async () => {
    const entered = Promise.withResolvers<void>(); const resume = Promise.withResolvers<void>();
    let conversionLockId: string | undefined; let heldThroughFetch = false;
    const f = await fixture({ async onFetch() { entered.resolve(); await resume.promise; heldThroughFetch = conversionLockId !== undefined; } });
    const c = await conversions({ f }); const service = safety({ f, requests: [] });
    const acquire = f.locks.acquire; const release = f.locks.release; const haltWaiting = Promise.withResolvers<void>();
    f.locks.acquire = async (input, options) => {
        const acquiring = acquire(input, options);
        if (input.context.principal.kind === 'owner') haltWaiting.resolve();
        const result = await acquiring;
        if (result.ok && input.context.principal.kind === 'service') conversionLockId = result.value.lockId;
        return result;
    };
    f.locks.release = input => { if (input.lockId === conversionLockId) conversionLockId = undefined; return release(input); };
    const delivering = c.dispatcher.dispatch(conversionRequest);
    let halting: ReturnType<typeof service.haltAccount> | undefined;
    try {
        await entered.promise;
        halting = service.haltAccount({ context, adAccountId: '123' });
        await haltWaiting.promise;
        expect(value({ result: await f.repo.snapshot({ context, accountId: '123' }) }).halted).toBe(false);
        resume.resolve();
        expect(await delivering).toEqual({ ok: true, value: { status: 'delivered' } });
        expect(heldThroughFetch).toBe(true);
        expect(await halting).toMatchObject({ ok: true });
        expect(value({ result: await f.repo.snapshot({ context, accountId: '123' }) }).halted).toBe(true);
        expect(f.calls).toHaveLength(1);
    } finally { resume.resolve(); await delivering; await halting; f.close(); }
});

it('local mode and unadmitted conversion backends make zero credential/network calls', async () => {
    for (const local of [true, false]) {
        const f = await fixture(); const c = await conversions({ f, local });
        try {
            if (!local) f.unadmit();
            await c.dispatcher.dispatch(conversionRequest);
            expect(f.credentials).toEqual([]); expect(f.calls).toEqual([]);
        } finally { f.close(); }
    }
});


it('serializes an in-flight ordinary write with local halt and rejects later writes', async () => {
    const f = await fixture(); const service = safety({ f, requests: [] });
    const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
    const pause = value({ result: await f.backend.definitions({ context }) }).find(tool => tool.name === 'vendor_linkedin_ads_pause')!;
    const input = { operationId: 'in-flight', connectionId: 'connection', accountId: '123', arguments: { kind: 'pause', campaignId: '456' } };
    try {
        f.onToken({ async callback() { entered.resolve(); await release.promise; } });
        const writing = pause.invoke({ context, input });
        await entered.promise;
        const halting = service.haltAccount({ context, adAccountId: '123' });
        expect(value({ result: await f.repo.snapshot({ context, accountId: '123' }) }).halted).toBe(false);
        release.resolve();
        expect(await writing).toMatchObject({ ok: true });
        expect(await halting).toMatchObject({ ok: true });
        expect(f.calls).toHaveLength(2);
        expect(f.calls.map(call => call.options?.method)).toEqual(['GET', 'POST']);
        expect(await pause.invoke({ context, input: { ...input, operationId: 'later-write' } })).toMatchObject({ ok: false });
        expect(f.calls).toHaveLength(2);
    } finally { release.resolve(); f.close(); }
});

it('dispatches the canonical safety-issued permit through the LinkedIn halt capability', async () => {
    const f = await fixture(); const requests: HaltStopRequest[] = [];
    const service = safety({ f, requests });
    try {
        const receipt = value({ result: await service.haltAccount({ context, adAccountId: '123' }) });
        const args = { adAccountId: '123', entityIds: ['456'], action: 'pause' as const };
        const request = { ...args, operationId: 'canonical-stop', scope: context.scope, connectionId: 'connection', haltId: receipt.haltId, haltEpoch: receipt.epoch,
            pluginDigest: value({ result: await f.backend.definitions({ context }) })[0].revision!, bindingId: 'linkedin-ads.stop.v1', argumentsDigest: value({ result: digestArguments({ arguments: args }) }) };
        requests.push(request);
        const permit = value({ result: await service.authorizeHaltStop({ context: serviceContext, request }) });
        expect(await f.backend.haltStop({ context: { ...context, principal: { kind: 'service', serviceId: serviceContext.serviceId } }, pluginId: 'linkedin-ads', permit })).toEqual({ ok: true, value: { status: 'unknown', entityIds: ['456'] } });
        expect(f.calls).toHaveLength(1);
        expect(f.calls[0].options?.method).toBe('POST');
        expect(f.credentials).toEqual(['linkedin-ads']);
    } finally { f.close(); }
});

/** Real SQLite writes compete with final admission; fetch must always see a committed audit.
 * A future Postgres adapter must run these cases with SERIALIZABLE or a shared subject row lock. */
async function withdrawConsent(required: { f: Awaited<ReturnType<typeof fixture>>; subjectId?: string }) {
    return required.f.identity.policy.appendEvidence({ context, evidence: { id: 'withdrawal', scope: context.scope, subjectId: required.subjectId ?? 'subject', kind: 'withdrawal',
        recordedAt: clock.now(), sourceId: 'owner', consent: { scope: 'destination', target: 'linkedin-ads', purpose: 'measurement', status: 'withdrawn', start: 1000, end: 100000 } } });
}
function admissionRows(required: { f: Awaited<ReturnType<typeof fixture>> }) {
    return required.f.native.prepare("SELECT operation_id,outcome,context_json FROM measure_egress_audit WHERE outcome='egress_admitted' ORDER BY rowid").all();
}
it('rejects a lease that expires while final policy evidence is awaited, without starting fetch', async () => {
    let now = 1000;
    const f = await fixture({ clock: { now: () => now } });
    const entered = Promise.withResolvers<void>(); const resume = Promise.withResolvers<void>();
    const c = await conversions({ f, async beforeAssess() {
        if (!f.native.inTransaction) return;
        entered.resolve(); await resume.promise;
    } });
    const leased = await f.jobs.outbox.get({ tenantId: jobTenant({ context }), id: c.claim.jobId });
    const delivering = c.dispatcher.dispatch(conversionRequest);
    try {
        await entered.promise;
        now = leased!.leaseExpiresAt! + 1;
        resume.resolve();
        expect(await delivering).toMatchObject({ ok: false, error: { code: 'conflict' } });
        expect(f.calls).toEqual([]); expect(admissionRows({ f })).toEqual([]);
        expect(f.native.prepare("SELECT state FROM job_attempt WHERE event_type='dispatch'").all()).toEqual([]);
        expect(await f.jobs.outbox.get({ tenantId: jobTenant({ context }), id: c.claim.jobId })).toMatchObject({ state: 'leased' });
    } finally { resume.resolve(); await delivering; f.close(); }
});

/** Both mutations use identity's real lane. A merge must finish before withdrawing through its alias. */
async function raceWithdrawal(required: { f: Awaited<ReturnType<typeof fixture>>; subjectId: string; kind: 'withdrawal' | 'merge' }) {
    if (required.kind === 'merge') value({ result: await required.f.identity.contacts.merge({ context, sourceSubjectId: required.subjectId, targetSubjectId: 'subject' }) });
    return withdrawConsent(required);
}

it.each([{ kind: 'withdrawal' }, { kind: 'merge' }] as const)('serializes conversion dispatch against alias $kind and blocks fresh work after withdrawal commits', async ({ kind }) => {
    const entered = Promise.withResolvers<void>(); const resume = Promise.withResolvers<void>();
    const order: string[] = [];
    const f = await fixture({ async onFetch() {
        expect(f.native.prepare("SELECT kind FROM policy_evidence WHERE id='withdrawal'").get()).toBeUndefined();
        order.push('fetch');
    } });
    const alias = value({ result: await f.identity.contacts.upsert({ context, identifiers: [{ kind: 'email', raw: 'race-alias@example.test' }] }) });
    if (kind === 'withdrawal') value({ result: await f.identity.contacts.merge({ context, sourceSubjectId: alias.subjectId, targetSubjectId: 'subject' }) });
    const c = await conversions({ f });
    f.onBinding({ async callback() {
        if (!admissionRows({ f }).length || f.calls.length) return;
        expect(f.native.inTransaction).toBe(false); entered.resolve(); await resume.promise;
    } });
    const delivering = c.dispatcher.dispatch(conversionRequest);
    let mutating: ReturnType<typeof raceWithdrawal> | undefined;
    try {
        await entered.promise;
        mutating = raceWithdrawal({ f, subjectId: alias.subjectId, kind }).then(result => {
            value({ result }); order.push('withdrawal-committed'); return result;
        });
        // Drain SQLite promise work: bypassing the lane would commit before this next turn.
        await new Promise<void>(resolve => setImmediate(resolve));
        // A separate SQLite read completes while the mutation waits for the dispatch's lane.
        expect(await f.jobs.outbox.get({ tenantId: jobTenant({ context }), id: c.claim.jobId })).toMatchObject({ state: 'dispatching' });
        expect(f.native.prepare("SELECT kind FROM policy_evidence WHERE id='withdrawal'").get()).toBeUndefined();
        expect(value({ result: await f.identity.contactsRepo.get({ context, subjectId: alias.subjectId }) })?.subjectId)
            .toBe(kind === 'withdrawal' ? 'subject' : alias.subjectId);
        expect(order).toEqual([]);
        resume.resolve();
        expect(await delivering).toEqual({ ok: true, value: { status: 'delivered' } });
        expect(await mutating).toMatchObject({ ok: true });
        expect(order).toEqual(['fetch', 'withdrawal-committed']);
        const deliveryId = 'after-withdrawal';
        const queued = value({ result: await f.jobs.enqueue({ context, job: { handler: 'measure.conversion', operationId: deliveryId,
            idempotencyKey: deliveryId, argumentsDigest: 'e'.repeat(64), payload: { subjectId: event.subjectId, eventId: event.eventId, deliveryId } } }) });
        const leased = value({ result: await f.jobs.claim({ worker: { workerId: 'measure-worker' } }) });
        expect(leased?.lease.id).toBe(queued.jobId);
        expect(await c.claimedDispatcher.dispatch({ ...conversionRequest, deliveryId, claim: { jobId: queued.jobId, leaseToken: leased!.lease.leaseToken! } }))
            .toMatchObject({ ok: false, error: { code: 'forbidden' } });
        expect(f.calls).toHaveLength(1); expect(order).toEqual(['fetch', 'withdrawal-committed']);
    } finally { resume.resolve(); await delivering; await mutating; f.close(); }
});

it('commits withdrawal first, durably denies the claim, and makes zero sends', async () => {
    const f = await fixture(); const c = await conversions({ f });
    try {
        expect(await withdrawConsent({ f })).toMatchObject({ ok: true });
        expect(await c.dispatcher.dispatch(conversionRequest)).toMatchObject({ ok: false, error: { code: 'forbidden' } });
        expect(f.credentials).toEqual([]); expect(f.calls).toEqual([]); expect(admissionRows({ f })).toEqual([]);
        expect(await f.jobs.outbox.get({ tenantId: jobTenant({ context }), id: c.claim.jobId })).toMatchObject({ state: 'denied', leaseToken: null });
    } finally { f.close(); }
});
it('commits erasure first and fences the existing leased conversion without sending', async () => {
    const f = await fixture(); const c = await conversions({ f });
    const privacy = bindPrivacy({ unit: f.database.unit, identity: f.identity, subjectLane: f.subjectLane,
        subjects: createSqlFormsStorage({ unitOfWork: f.database.unit }).subjects, measure: { async purgeSubject() { return { ok: true, value: undefined }; } }, clock, ids: f.ids, observer });
    try {
        expect(await privacy.privacy.requestErasure({ context, subjectId: 'subject' })).toMatchObject({ ok: true });
        expect(await c.dispatcher.dispatch(conversionRequest)).toMatchObject({ ok: false, error: { code: 'conflict' } });
        expect(f.calls).toEqual([]); expect(f.credentials).toEqual([]); expect(admissionRows({ f })).toEqual([]);
        expect(await f.jobs.outbox.get({ tenantId: jobTenant({ context }), id: c.claim.jobId })).toMatchObject({ state: 'reconcile', leaseToken: null });
    } finally { privacy.participants.dispose({}); f.close(); }
});
it('closes the admission-to-fetch gap while unrelated subjects can commit with SQLite closed', async () => {
    const entered = Promise.withResolvers<void>(); const resume = Promise.withResolvers<void>();
    const f = await fixture(); const c = await conversions({ f });
    f.onBinding({ async callback() {
        if (admissionRows({ f }).length && !f.calls.length) { expect(f.native.inTransaction).toBe(false); entered.resolve(); await resume.promise; }
    } });
    const delivering = c.dispatcher.dispatch(conversionRequest);
    let withdrawing: ReturnType<typeof withdrawConsent> | undefined;
    try {
        await entered.promise;
        withdrawing = withdrawConsent({ f });
        const other = value({ result: await f.identity.contacts.upsert({ context, identifiers: [{ kind: 'email', raw: 'other@example.test' }] }) });
        expect(await f.identity.policy.appendEvidence({ context, evidence: { id: 'unrelated', scope: context.scope, subjectId: other.subjectId,
            recordedAt: 1000, kind: 'suppression', sourceId: 'owner', suppression: { channel: 'email', start: 0, end: 100000 } } })).toMatchObject({ ok: true });
        expect(f.calls).toEqual([]);
        expect(f.native.prepare("SELECT kind FROM policy_evidence WHERE id='withdrawal'").get()).toBeUndefined();
        expect(f.native.inTransaction).toBe(false);
        resume.resolve();
        expect(await delivering).toEqual({ ok: true, value: { status: 'delivered' } });
        expect(await withdrawing).toMatchObject({ ok: true });
        expect(f.native.prepare("SELECT kind FROM policy_evidence WHERE id='withdrawal'").get()).toEqual({ kind: 'withdrawal' });
        expect(f.calls).toHaveLength(1); expect(admissionRows({ f })).toHaveLength(1);
        expect(JSON.stringify(admissionRows({ f }))).not.toContain('b'.repeat(64));
        expect(JSON.stringify(admissionRows({ f }))).not.toContain('fixture-only-token');
    } finally { resume.resolve(); await delivering; await withdrawing; f.close(); }
});
it('fails closed on admission audit failure and cannot egress or nest a root transaction', async () => {
    const f = await fixture(); const c = await conversions({ f });
    try {
        f.native.exec("CREATE TRIGGER refuse_admission BEFORE INSERT ON measure_egress_audit WHEN NEW.outcome='egress_admitted' BEGIN SELECT RAISE(ABORT,'fixture audit failure'); END");
        expect(await c.dispatcher.dispatch(conversionRequest)).toEqual({ ok: true, value: { status: 'not_sent', reason: 'forbidden' } });
        expect(f.calls).toEqual([]); expect(admissionRows({ f })).toEqual([]);
        expect(f.native.prepare("SELECT state FROM job_attempt WHERE event_type='dispatch'").all()).toEqual([]);
        expect(f.native.inTransaction).toBe(false);
    } finally { f.close(); }
});

it.each(['pending', 'erased'] as const)('evaluates current %s erasure inside admission and commits denial without starting dispatch', async admissionErasure => {
    const f = await fixture(); const c = await conversions({ f, admissionErasure });
    try {
        expect(await c.dispatcher.dispatch(conversionRequest)).toMatchObject({ ok: true, value: { status: 'not_sent', reason: 'forbidden' } });
        expect(f.calls).toEqual([]);
        expect(f.native.prepare("SELECT state FROM job_attempt WHERE event_type='dispatch'").all()).toEqual([]);
        expect(await f.jobs.outbox.get({ tenantId: jobTenant({ context }), id: c.claim.jobId })).toMatchObject({ state: 'denied', leaseToken: null });
        expect(f.native.prepare("SELECT operation_id,outcome FROM measure_egress_audit WHERE outcome LIKE 'egress_%'").all())
            .toEqual([{ operation_id: 'delivery', outcome: 'egress_denied' }]);
    } finally { f.close(); }
});

it('rolls back admission on a current-evidence failure and records a definite refusal', async () => {
    const f = await fixture(); const c = await conversions({ f, failAdmissionEvidence: true });
    try {
        expect(await c.dispatcher.dispatch(conversionRequest)).toEqual({ ok: true, value: { status: 'not_sent', reason: 'forbidden' } });
        expect(f.calls).toEqual([]); expect(admissionRows({ f })).toEqual([]);
        expect(f.native.prepare("SELECT state FROM job_attempt WHERE event_type='dispatch'").all()).toEqual([]);
        expect(await f.jobs.outbox.get({ tenantId: jobTenant({ context }), id: c.claim.jobId })).toMatchObject({ state: 'denied', leaseToken: null });
    } finally { f.close(); }
});

it('rolls back failed admission evidence and separately completes the definite refusal', async () => {
    const f = await fixture(); const c = await conversions({ f, admissionErasure: 'pending' });
    try {
        f.native.exec("CREATE TRIGGER refuse_denial BEFORE INSERT ON measure_egress_audit WHEN NEW.outcome='egress_denied' BEGIN SELECT RAISE(ABORT,'fixture audit failure'); END");
        expect(await c.dispatcher.dispatch(conversionRequest)).toEqual({ ok: true, value: { status: 'not_sent', reason: 'forbidden' } });
        expect(f.credentials).toEqual(['linkedin-ads']); expect(f.calls).toEqual([]);
        expect(f.native.prepare("SELECT outcome FROM measure_egress_audit WHERE outcome LIKE 'egress_%'").all()).toEqual([]);
        expect(f.native.prepare("SELECT state FROM job_attempt WHERE state='denied'").all()).toEqual([{ state: 'denied' }]);
        expect(await f.jobs.outbox.get({ tenantId: jobTenant({ context }), id: c.claim.jobId })).toMatchObject({ state: 'denied', leaseToken: null });
    } finally { f.close(); }
});

it.each(['missing', 'token', 'expired', 'identity', 'dispatching', 'tenant'] as const)('rejects a %s outbox claim before egress', async invalid => {
    const f = await fixture(); const c = await conversions({ f });
    try {
        let request = { ...conversionRequest, claim: c.claim };
        switch (invalid) {
            case 'missing': request = { ...conversionRequest, claim: undefined! }; break;
            case 'token': request.claim = { ...c.claim, leaseToken: 'foreign-token' }; break;
            case 'expired': f.native.prepare('UPDATE job SET lease_expires_at=? WHERE id=?').run(clock.now(), c.claim.jobId); break;
            case 'identity': request = { ...request, event: { ...event, eventId: 'other-event' } }; break;
            case 'dispatching': await f.jobs.outbox.beginDispatch({ id: c.claim.jobId, tenantId: jobTenant({ context }), token: c.claim.leaseToken, now: clock.now() }); break;
            case 'tenant': f.native.prepare('UPDATE job SET tenant_id=? WHERE id=?').run('foreign', c.claim.jobId); break;
        }
        expect(await c.claimedDispatcher.dispatch(request)).toMatchObject({ ok: false });
        expect(f.calls).toEqual([]); expect(f.credentials).toEqual([]);
        expect(admissionRows({ f })).toEqual([]);
    } finally { f.close(); }
});

it('records exactly one dispatch transition and checks abortion immediately after final admission', async () => {
    const f = await fixture(); const c = await conversions({ f }); const controller = new AbortController();
    try {
        f.onBinding({ async callback() { if (admissionRows({ f }).length) controller.abort(); } });
        expect(await c.dispatcher.dispatch(conversionRequest, { signal: controller.signal })).toEqual({ ok: true, value: { status: 'not_sent', reason: 'forbidden' } });
        expect(f.calls).toEqual([]);
        expect(f.native.prepare("SELECT state FROM job_attempt WHERE event_type='dispatch'").all()).toEqual([{ state: 'dispatching' }]);
        expect(await f.jobs.outbox.get({ tenantId: jobTenant({ context }), id: c.claim.jobId })).toMatchObject({ state: 'denied', leaseToken: null });
    } finally { f.close(); }
});

it('honors withdrawal through an alias before canonical conversion dispatch', async () => {
    const f = await fixture(); const c = await conversions({ f });
    try {
        const alias = value({ result: await f.identity.contacts.upsert({ context, identifiers: [{ kind: 'email', raw: 'alias@example.test' }] }) });
        expect(await f.identity.contacts.merge({ context, sourceSubjectId: alias.subjectId, targetSubjectId: 'subject' })).toMatchObject({ ok: true, value: { subjectId: 'subject' } });
        expect(await withdrawConsent({ f, subjectId: alias.subjectId })).toMatchObject({ ok: true });
        expect(await c.dispatcher.dispatch(conversionRequest)).toMatchObject({ ok: false, error: { code: 'forbidden' } });
        expect(f.calls).toEqual([]);
    } finally { f.close(); }
});

it('retains the subject lane until the delivery ledger and outbox outcome are durable', async () => {
    const f = await fixture(); const entered = Promise.withResolvers<void>(); const resume = Promise.withResolvers<void>();
    const c = await conversions({ f, async beforeAppend() { entered.resolve(); await resume.promise; } });
    const delivering = c.dispatcher.dispatch(conversionRequest);
    let withdrawing: ReturnType<typeof withdrawConsent> | undefined;
    try {
        await entered.promise;
        expect(f.calls).toHaveLength(1); expect(f.native.inTransaction).toBe(false);
        withdrawing = withdrawConsent({ f });
        // This later transaction completes while the withdrawal waits on the subject lane.
        expect(await f.jobs.outbox.get({ tenantId: jobTenant({ context }), id: c.claim.jobId })).toMatchObject({ state: 'dispatching' });
        expect(f.native.prepare("SELECT kind FROM policy_evidence WHERE id='withdrawal'").get()).toBeUndefined();
        resume.resolve(); expect(await delivering).toEqual({ ok: true, value: { status: 'delivered' } });
        expect(await withdrawing).toMatchObject({ ok: true });
        expect(await f.jobs.outbox.get({ tenantId: jobTenant({ context }), id: c.claim.jobId })).toMatchObject({ state: 'succeeded' });
    } finally { resume.resolve(); await delivering; await withdrawing; f.close(); }
});

/** Outbox lookup regressions use actual persisted jobs; no capability dispatch or vendor call. */
it('activity follows direct plugin identities, scope, uncertain states and nested campaign constituents', async () => {
    const f = await fixture();
    const activity = (input: { context: CallContext; kind: 'agent-plugin'; id: string }) => countAddonJobs({ ...input, unit: f.database.unit, observer });
    const lookup = { context, kind: 'agent-plugin' as const, id: 'linkedin-ads' };
    try {
        expect(await activity(lookup)).toEqual({ ok: true, value: 0 });
        value({ result: await f.jobs.enqueue({ context, job: { handler: 'agent-plugin.invoke', operationId: 'direct', idempotencyKey: 'activity-direct', argumentsDigest: 'a'.repeat(64),
            payload: { pluginId: 'linkedin-ads', input: {} } } }) });
        expect(await activity(lookup)).toEqual({ ok: true, value: 1 });
        expect(await activity({ ...lookup, id: 'tiktok-ads' })).toEqual({ ok: true, value: 0 });
        expect(await activity({ ...lookup, context: { ...context, scope: { ...context.scope, ownerId: 'other' } } })).toEqual({ ok: true, value: 0 });
        f.native.prepare("UPDATE job SET state='reconcile' WHERE idempotency_key='activity-direct'").run();
        expect(await activity(lookup)).toEqual({ ok: true, value: 1 });
        const call = { arguments: { tool: 'vendor_tiktok_ads_campaign_deploy_paused', input: {} }, pluginDigest: 'b'.repeat(64), schemaFingerprint: 'c'.repeat(64),
            envelope: { operationId: 'child', connectionId: 'connection', accountId: '123', effects: ['ad_spend'], argumentsDigest: 'd'.repeat(64), moneyExposure: null, requiredLimit: null } };
        const request = { ...call, pausedCampaignCalls: [call] };
        value({ result: await f.jobs.enqueue({ context, job: { handler: 'agent-plugin.invoke', operationId: 'parent', idempotencyKey: 'activity-parent', argumentsDigest: 'e'.repeat(64),
            payload: { pluginId: 'om-campaigns', input: { arguments: { request } } } } }) });
        expect(await activity({ ...lookup, id: 'tiktok-ads' })).toEqual({ ok: true, value: 1 });
        expect(await activity(lookup)).toEqual({ ok: true, value: 1 });
        f.native.prepare("UPDATE job SET state='succeeded'").run();
        expect(await activity(lookup)).toEqual({ ok: true, value: 0 });
    } finally { f.close(); }
});

it.each(['creative.generate', 'measure.conversion', 'campaign.create'])('unresolved %s work denies cleanup rather than assuming zero activity', async handler => {
    const f = await fixture(); const activity = (input: { context: CallContext; kind: 'agent-plugin'; id: string }) => countAddonJobs({ ...input, unit: f.database.unit, observer });
    try {
        value({ result: await f.jobs.enqueue({ context, job: { handler, operationId: 'unresolved', idempotencyKey: 'unresolved', argumentsDigest: 'a'.repeat(64), payload: { generationId: 'generation' } } }) });
        expect(await activity({ context, kind: 'agent-plugin', id: 'linkedin-ads' })).toMatchObject({ ok: false, error: { code: 'unavailable', retryable: false } });
    } finally { f.close(); }
});

it.each(['invalid-json', 'oversized', 'missing-constituents', 'wrong-handler', 'overflow'])('invalid activity %s fails closed', async attack => {
    const f = await fixture(); const activity = (input: { context: CallContext; kind: 'agent-plugin'; id: string }) => countAddonJobs({ ...input, unit: f.database.unit, observer });
    try {
        value({ result: await f.jobs.enqueue({ context, job: { handler: 'agent-plugin.invoke', operationId: 'invalid', idempotencyKey: 'invalid', argumentsDigest: 'a'.repeat(64), payload: { pluginId: 'om-campaigns', input: {} } } }) });
        if (attack === 'invalid-json') f.native.prepare('UPDATE job SET payload=?').run('{');
        if (attack === 'oversized') f.native.prepare('UPDATE job SET payload=?').run(' '.repeat(65537));
        if (attack === 'wrong-handler') f.native.prepare('UPDATE job SET payload=?').run(JSON.stringify({ handler: 'wrong', payload: { pluginId: 'linkedin-ads' } }));
        if (attack === 'overflow') {
            const row = f.native.prepare('SELECT * FROM job LIMIT 1').get() as Record<string, unknown>;
            const insert = f.native.prepare('INSERT INTO job(id,tenant_id,idempotency_key,request_digest,operation,payload,state,attempts,available_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)');
            f.native.transaction(() => { for (let index = 0; index < 1000; index++) insert.run('overflow-' + index, row.tenant_id, 'overflow-' + index,
                row.request_digest, row.operation, row.payload, 'pending', 0, 1000, 1000); })();
        }
        expect(await activity({ context, kind: 'agent-plugin', id: 'linkedin-ads' })).toMatchObject({ ok: false });
    } finally { f.close(); }
});

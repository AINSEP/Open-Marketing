/** R2 fixtures use real safety/measure/jobs services and plugin codecs; all egress is injected. */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import type { CallContext, HaltStopRequest, Outcome, UnitOfWork } from '@open-marketing/contracts';
import { createMemoryAccountDispatchLock, createMemoryConfirmationExchange, createMemorySafetyAudit, createMemorySafetyRepo,
    createMemorySpendPolicy, createMemoryPlatformLimitEvidence, createMemoryVerifiedEffectResolver, createSafetyService, digestArguments } from '@open-marketing/safety';
import { createMemoryConversionDeliveryState, createMemoryConversionVerification, createMemoryMeasurementGrant, createSqlMeasureAudit } from '@open-marketing/measure';
import type { ConversionInput, MeasureGrant } from '@open-marketing/measure';
import { createSqlPolicyRepo } from '@open-marketing/policy';
import { createErasureParticipantRegistry, createMemoryPrivacyRepo, createPrivacyService } from '@open-marketing/privacy';
import { bindAgentPluginBackends, bindAgentPluginJobs } from '../src/composition/agent-plugin-backends.js';
import { bindAgentPluginHaltJobs, createFormWorkers } from '../src/composition/workers.js';
import { bindServerDatabase, provisionWorkspace } from '../src/composition/database.js';
import { migrationManifest } from '../src/composition/migrations.js';

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

async function fixture(required: { pluginId?: 'linkedin-ads' | 'tiktok-ads'; onFetch?(): Promise<void> } = {}) {
    const selectedPlugin = required.pluginId ?? 'linkedin-ads';
    const native = new Database(':memory:');
    native.pragma('foreign_keys = ON');
    for (const entry of migrationManifest) native.exec(readFileSync(new URL('../../../' + entry.path, import.meta.url), 'utf8'));
    const database = bindServerDatabase({ native, observer, context });
    await provisionWorkspace({ database: database.workspace, scope: context.scope });
    const ids = { next: () => randomUUID() };
    const locks = createMemoryAccountDispatchLock({ ids });
    const repo = createMemorySafetyRepo({ clock, ids, ownerTimezone: 'UTC' });
    const calls: { url: string; options?: RequestInit }[] = [];
    const credentials: string[] = [];
    let admitted = true; let tokenCallback = async () => {};
    const require = createRequire(import.meta.url);
    const backend = bindAgentPluginBackends({ projectRoot: '/fixture', clock, observer, mode: 'production', accountLocks: locks,
        jobs: bindAgentPluginJobs({ unit: database.unit, clock, ids, observer }), safetyRepo: repo, unit: database.unit,
        policyForTransaction: ({ unit }) => createSqlPolicyRepo({ pool: unit, observer }),
        async moduleDigest() { return 'd'.repeat(64); },
        async loadModule() {
            if (selectedPlugin === 'tiktok-ads') return require('../../../content/agent-plugins/tiktok-ads/io.github.ainsep.openmarketing/dist/index.mjs') as object;
            return require('../../../content/agent-plugins/linkedin-ads/io.github.ainsep.openmarketing/dist/index.mjs') as object;
        },
        async wait() { return { ok: true, value: undefined }; },
        async state({ pluginId }) { return pluginId === selectedPlugin ? { enabled: true, admitted, bundled: true, revision: 'a'.repeat(64), metadata: { currency: 'USD', conversionConfiguration: {
            scope: context.scope, connectionId: 'connection', accountId: '123', currency: 'USD', apiVersion: '202610', bindingId: 'linkedin-ads.stop.v1',
            destination: 'linkedin', purpose: 'measurement', payloadSchema: 'om.conversion', mode: 'production-server',
            conversionRules: { purchase: 'urn:lla:llaPartnerConversion:456' },
        } } } : null; },
        accounts: { async find({ externalAccountId }) { return { ok: true, value: { id: 'binding', scope: context.scope, connectionId: 'connection', externalAccountId } }; } },
        integrations: { async access({ pluginId }) { credentials.push(pluginId); await tokenCallback(); return { ok: true, value: { accessToken: 'fixture-only-token' } }; } },
        fetch: async (url, options) => { expect(native.inTransaction).toBe(false); calls.push({ url: String(url), options }); await required.onFetch?.(); return new Response(null, { status: 201 }); },
    });
    return { native, database, ids, locks, repo, backend, calls, credentials,
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
        expect(await pause.invoke({ context, input: { operationId: 'after-halt', connectionId: 'connection', accountId: '123', currency: 'USD', arguments: { kind: 'pause-entity', entityType: 'campaign', entityId: '456' } } })).toMatchObject({ ok: false });
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

const event: ConversionInput = { eventId: 'event', definitionId: 'purchase', subjectId: 'subject', occurredAt: 1000, destination: 'linkedin', purpose: 'measurement', identifierDigests: { email: 'a'.repeat(64) } };
const grant: MeasureGrant = { kind: 'measurement', grantId: 'grant', scope: context.scope, connectionId: 'connection', accountId: '123', definitionIds: ['purchase'], destination: 'linkedin', purpose: 'measurement', payloadSchema: 'om.conversion', payloadVersion: 1, expiresAt: 100000, revoked: false };
function conversions(required: { f: Awaited<ReturnType<typeof fixture>>; local?: boolean; beforeAssess?(): Promise<void> }) {
    let allowed = true; let withdrawAtAudit = false;
    const records: unknown[] = [];
    const ledger = createMemoryConversionDeliveryState({});
    const grants = createMemoryMeasurementGrant({ grants: [grant] });
    // The grant is deliberately in memory; production grant persistence is outside this lane.
    // Policy and audit always bind the given unit, including the final admission's joined session.
    function authority({ unit }: { unit: UnitOfWork }) {
        const policy = createSqlPolicyRepo({ pool: unit, observer });
        const audit = createSqlMeasureAudit({ database: {
            query: input => unit.transaction({ work: ({ session }) => session.query(input) }),
            transaction: ({ work }) => unit.transaction({ work: ({ session }) => work(session) }),
        }, clock, ids: required.f.ids }, { observer });
        return { grants,
            policy: { async assess(input: { context: CallContext; event: ConversionInput }) {
                await required.beforeAssess?.();
                const snapshot = await policy.snapshot({ context: input.context, subjectId: input.event.subjectId });
                if (!snapshot.ok) return snapshot;
                const withdrawn = snapshot.value.consents.some(consent => consent.status === 'withdrawn' && consent.target === input.event.destination && consent.purpose === input.event.purpose);
                return { ok: true as const, value: { allowed: allowed && !withdrawn } };
            } },
            audit: { async record(input: { context: CallContext; operationId: string; outcome: string }) {
                if (input.outcome === 'egress_admitted') expect(required.f.native.inTransaction).toBe(true);
                records.push(input); if (withdrawAtAudit) allowed = false;
                return audit.record(input);
            } },
        };
    }
    const dispatcher = required.f.backend.conversions({ clock, runtimeMode: required.local ? 'local-sandbox' : 'production-server', payloadSchema: 'om.conversion',
        identifiers: { async identifiersFor() { return { ok: true, value: { subjectId: 'subject', identifiers: { email: 'b'.repeat(64) }, identifierDigests: event.identifierDigests } }; } },
        verification: createMemoryConversionVerification({ events: [{ scope: context.scope, event }] }),
        ...authority({ unit: required.f.database.unit }), authority,
        ledger: { async begin(input) { records.push(input.record); return ledger.begin(input); }, async append(input) { records.push(input.record); return ledger.append(input); } },
    });
    return { dispatcher, records, withdraw() { allowed = false; }, withdrawAtAudit() { withdrawAtAudit = true; } };
}
const conversionRequest = { context: { ...serviceContext, serviceId: 'measure-worker' }, event, grant, deliveryId: 'delivery' };

it('rechecks consent at dispatch and after token resolution, with zero egress after withdrawal', async () => {
    for (const phase of ['audit', 'credentials'] as const) {
        const f = await fixture(); const c = conversions({ f });
        try {
            if (phase === 'audit') c.withdrawAtAudit();
            else f.onToken({ async callback() { c.withdraw(); } });
            const result = await c.dispatcher.dispatch(conversionRequest);
            if (phase === 'audit') expect(result).toMatchObject({ ok: false, error: { code: 'forbidden' } });
            else { expect(f.credentials).toEqual(['linkedin-ads']); expect(result).toMatchObject({ ok: true, value: { status: 'unknown' } }); }
            expect(f.calls).toEqual([]);
            expect(JSON.stringify(c.records)).not.toContain('b'.repeat(64));
        } finally { f.close(); }
    }
});

it('delivers contacts digests through the plugin once and never resends a delivered identity', async () => {
    const f = await fixture(); let atFetch = false;
    const snapshot = f.repo.snapshot;
    f.repo.snapshot = async (input, options) => { const result = await snapshot(input, options); atFetch = true; return result; };
    const c = conversions({ f, async beforeAssess() { if (atFetch) expect(f.native.inTransaction).toBe(true); } });
    try {
        expect(await c.dispatcher.dispatch(conversionRequest)).toEqual({ ok: true, value: { status: 'delivered' } });
        expect(f.calls).toHaveLength(1);
        expect(JSON.parse(String(f.calls[0].options?.body))).toEqual({ conversion: 'urn:lla:llaPartnerConversion:456', conversionHappenedAt: 1000, eventId: 'event', user: { userIds: [{ idType: 'SHA256_EMAIL', idValue: 'b'.repeat(64) }] } });
        atFetch = false;
        expect(await c.dispatcher.dispatch(conversionRequest)).toEqual({ ok: true, value: { status: 'delivered' } });
        expect(f.calls).toHaveLength(1);
        expect(JSON.stringify(c.records)).not.toContain('b'.repeat(64));
        expect(JSON.stringify(c.records)).not.toContain('fixture-only-token');
    } finally { f.close(); }
});

it('refuses conversion egress when halt commits after an earlier unhalted snapshot', async () => {
    const f = await fixture(); const c = conversions({ f }); const service = safety({ f, requests: [] });
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
        expect(await delivering).toEqual({ ok: true, value: { status: 'unknown' } });
        expect(f.calls).toEqual([]);
        expect(await c.dispatcher.dispatch(conversionRequest)).toEqual({ ok: true, value: { status: 'unknown' } });
        expect(f.calls).toEqual([]);
    } finally { resume.resolve(); await delivering; f.close(); }
});

it('refuses conversion egress when the plugin is unadmitted during the final consent await', async () => {
    const f = await fixture(); const entered = Promise.withResolvers<void>(); const resume = Promise.withResolvers<void>();
    const snapshot = f.repo.snapshot; let atFetch = false;
    f.repo.snapshot = async (input, options) => { const result = await snapshot(input, options); atFetch = true; return result; };
    const c = conversions({ f, async beforeAssess() { if (atFetch) { entered.resolve(); await resume.promise; } } });
    const delivering = c.dispatcher.dispatch(conversionRequest);
    try {
        await entered.promise;
        expect(f.credentials).toEqual(['linkedin-ads']);
        f.unadmit(); resume.resolve();
        expect(await delivering).toEqual({ ok: true, value: { status: 'unknown' } });
        expect(f.calls).toEqual([]);
        expect(await safety({ f, requests: [] }).haltAccount({ context, adAccountId: '123' })).toMatchObject({ ok: true });
    } finally { resume.resolve(); await delivering; f.close(); }
});

it('holds the shared halt barrier until an in-flight conversion fetch finishes', async () => {
    const entered = Promise.withResolvers<void>(); const resume = Promise.withResolvers<void>();
    let conversionLockId: string | undefined; let heldThroughFetch = false;
    const f = await fixture({ async onFetch() { entered.resolve(); await resume.promise; heldThroughFetch = conversionLockId !== undefined; } });
    const c = conversions({ f }); const service = safety({ f, requests: [] });
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
        const f = await fixture(); const c = conversions({ f, local });
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
    const input = { operationId: 'in-flight', connectionId: 'connection', accountId: '123', currency: 'USD', arguments: { kind: 'pause', campaignId: '456' } };
    try {
        f.onToken({ async callback() { entered.resolve(); await release.promise; } });
        const writing = pause.invoke({ context, input });
        await entered.promise;
        const halting = service.haltAccount({ context, adAccountId: '123' });
        expect(value({ result: await f.repo.snapshot({ context, accountId: '123' }) }).halted).toBe(false);
        release.resolve();
        expect(await writing).toMatchObject({ ok: true });
        expect(await halting).toMatchObject({ ok: true });
        expect(f.calls).toHaveLength(1);
        expect(await pause.invoke({ context, input: { ...input, operationId: 'later-write' } })).toMatchObject({ ok: false });
        expect(f.calls).toHaveLength(1);
    } finally { release.resolve(); f.close(); }
});

it('keeps canonical halt permits fail-closed when LinkedIn uses an incompatible insertion-order digest', async () => {
    const f = await fixture(); const requests: HaltStopRequest[] = [];
    const service = safety({ f, requests });
    try {
        const receipt = value({ result: await service.haltAccount({ context, adAccountId: '123' }) });
        const args = { adAccountId: '123', entityIds: ['456'], action: 'pause' as const };
        const request = { ...args, operationId: 'canonical-stop', scope: context.scope, connectionId: 'connection', haltId: receipt.haltId, haltEpoch: receipt.epoch,
            pluginDigest: value({ result: await f.backend.definitions({ context }) })[0].revision!, bindingId: 'linkedin-ads.stop.v1', argumentsDigest: value({ result: digestArguments({ arguments: args }) }) };
        requests.push(request);
        const permit = value({ result: await service.authorizeHaltStop({ context: serviceContext, request }) });
        expect(await f.backend.haltStop({ context: { ...context, principal: { kind: 'service', serviceId: serviceContext.serviceId } }, pluginId: 'linkedin-ads', permit })).toMatchObject({ ok: false, error: { code: 'conflict' } });
        expect(f.calls).toEqual([]); expect(f.credentials).toEqual([]);
    } finally { f.close(); }
});

/** Real SQLite writes compete with final admission; fetch must always see a committed audit.
 * A future Postgres adapter must run these cases with SERIALIZABLE or a shared subject row lock. */
async function withdrawConsent(required: { f: Awaited<ReturnType<typeof fixture>> }) {
    const policy = createSqlPolicyRepo({ pool: required.f.database.unit, observer });
    return policy.appendEvidence({ context, evidence: { id: 'withdrawal', scope: context.scope, subjectId: 'subject', kind: 'withdrawal',
        recordedAt: clock.now(), sourceId: 'owner', consent: { scope: 'destination', target: 'linkedin', purpose: 'measurement', status: 'withdrawn', start: 1000, end: 100000 } } });
}
function admissionRows(required: { f: Awaited<ReturnType<typeof fixture>> }) {
    return required.f.native.prepare("SELECT operation_id,outcome,context_json FROM measure_egress_audit WHERE outcome='egress_admitted' ORDER BY rowid").all();
}
it('blocks a conversion when consent withdrawal commits before final admission', async () => {
    const f = await fixture(); const c = conversions({ f });
    try {
        f.onToken({ async callback() {
            expect(admissionRows({ f })).toEqual([]);
            expect(await withdrawConsent({ f })).toMatchObject({ ok: true });
        } });
        expect(await c.dispatcher.dispatch(conversionRequest)).toEqual({ ok: true, value: { status: 'unknown' } });
        expect(f.credentials).toEqual(['linkedin-ads']);
        expect(f.calls).toEqual([]); expect(admissionRows({ f })).toEqual([]);
    } finally { f.close(); }
});
it('blocks a conversion when erasure is requested before final admission', async () => {
    const f = await fixture(); const c = conversions({ f });
    const participants = createErasureParticipantRegistry({});
    value({ result: participants.register({ participant: { id: 'fixture', async run() { return { ok: true, value: { complete: true, removedCount: 0 } }; } } }) });
    const policy = createSqlPolicyRepo({ pool: f.database.unit, observer });
    const privacy = createPrivacyService({ repo: createMemoryPrivacyRepo({}), participants, clock, ids: f.ids,
        block: { async block(input) {
            const saved = await policy.appendEvidence({ context: input.context, evidence: { id: input.requestId, scope: input.context.scope, subjectId: input.subjectId,
                kind: 'suppression', recordedAt: clock.now(), sourceId: 'privacy', suppression: { channel: 'om.processing', start: 1000, end: 100000 } } });
            return saved.ok ? { ok: true, value: undefined } : saved;
        } } });
    try {
        f.onToken({ async callback() { expect(await privacy.requestErasure({ context, subjectId: 'subject' })).toMatchObject({ ok: true }); } });
        expect(await c.dispatcher.dispatch(conversionRequest)).toEqual({ ok: true, value: { status: 'unknown' } });
        expect(f.calls).toEqual([]); expect(admissionRows({ f })).toEqual([]);
    } finally { f.close(); }
});
it('commits admission before fetch and orders a later withdrawal after that admission', async () => {
    const entered = Promise.withResolvers<void>(); const resume = Promise.withResolvers<void>();
    const f = await fixture({ async onFetch() { entered.resolve(); await resume.promise; } });
    const c = conversions({ f }); const delivering = c.dispatcher.dispatch(conversionRequest);
    try {
        await entered.promise;
        expect(admissionRows({ f })).toMatchObject([{ operation_id: 'delivery', outcome: 'egress_admitted' }]);
        expect(f.native.inTransaction).toBe(false);
        expect(await withdrawConsent({ f })).toMatchObject({ ok: true });
        // Appending withdrawal succeeds while fetch is still blocked: no writer lock crosses egress.
        expect(f.native.prepare("SELECT kind FROM policy_evidence WHERE id='withdrawal'").get()).toEqual({ kind: 'withdrawal' });
        resume.resolve();
        expect(await delivering).toEqual({ ok: true, value: { status: 'delivered' } });
        expect(await c.dispatcher.dispatch({ ...conversionRequest, deliveryId: 'later-delivery' })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
        expect(f.calls).toHaveLength(1);
        expect(admissionRows({ f })).toHaveLength(1);
        expect(JSON.stringify(admissionRows({ f }))).not.toContain('b'.repeat(64));
        expect(JSON.stringify(admissionRows({ f }))).not.toContain('fixture-only-token');
    } finally { resume.resolve(); await delivering; f.close(); }
});
it('fails closed on admission audit failure and cannot egress or nest a root transaction', async () => {
    const f = await fixture(); const c = conversions({ f });
    try {
        f.native.exec("CREATE TRIGGER refuse_admission BEFORE INSERT ON measure_egress_audit WHEN NEW.outcome='egress_admitted' BEGIN SELECT RAISE(ABORT,'fixture audit failure'); END");
        expect(await c.dispatcher.dispatch(conversionRequest)).toEqual({ ok: true, value: { status: 'unknown' } });
        expect(f.calls).toEqual([]); expect(admissionRows({ f })).toEqual([]);
        expect(f.native.inTransaction).toBe(false);
    } finally { f.close(); }
});

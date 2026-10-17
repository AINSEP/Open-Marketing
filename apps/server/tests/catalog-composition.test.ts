/** Written-only A4b regressions: real in-memory SQLite and public feature services, no vendor I/O. */
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { CallContext, ClockPort, IdPort, Outcome, ToolCall, ToolResult } from '@open-marketing/contracts';
import { createMemoryConfirmationExchange, createSqlSafetyRepo, digestArguments } from '@open-marketing/safety';
import { createSqlCampaignRepo, createMemoryCampaignJob } from '@open-marketing/campaigns';
import { createSqlMeasureRepo, createSqlTrackedLink } from '@open-marketing/measure';
import type { MeasureSqlDatabase } from '@open-marketing/measure';
import { bindServerDatabase, provisionWorkspace } from '../src/composition/database.js';
import { migrationManifest } from '../src/composition/migrations.js';
import { bindIdentity, createVisitTokens } from '../src/composition/identity.js';
import { bindForms, seedSandboxForm } from '../src/composition/forms.js';
import { bindPrivacy } from '../src/composition/privacy.js';
import { bindCatalogAudit, bindCatalogScope, bindCatalogMeasure, sandboxPlatformReports } from '../src/composition/catalog.js';
import { bindSandboxCampaigns, bindCampaignJobs } from '../src/composition/campaigns.js';
import { bindSandboxCreative } from '../src/composition/creative.js';
import { createFormWorkers } from '../src/composition/workers.js';
import { buildOmToolDefinitions, createOmTools } from '../src/om-tools.js';
import type { OmFeatureServices } from '../src/om-tools.js';
import type { OwnerServices } from '../src/inbound/owner.js';
import { generateOmToolCoverage } from '../src/om-tool-coverage.js';

function value<T>(required: { result: Outcome<T> }): T { if (!required.result.ok) throw new Error('Fixture precondition: ' + required.result.error.message); return required.result.value; }
async function fixture() {
    const native = new Database(':memory:'); native.pragma('foreign_keys = ON');
    for (const entry of migrationManifest) native.exec(readFileSync(new URL('../../../' + entry.path, import.meta.url), 'utf8'));
    const clock: ClockPort = { now: () => 1792000000123 }; const ids: IdPort = { next: () => randomUUID() }; const observer = { observe() {} };
    const owner: CallContext = { scope: { ownerId: 'owner', workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }, principal: { kind: 'owner', ownerId: 'owner' }, correlationId: 'correlation', traceId: 'trace' };
    const agent: CallContext = { ...owner, runId: 'run', principal: { kind: 'agent', runId: 'run', agentInstanceId: 'instance' } };
    const database = bindServerDatabase({ native, observer, context: owner });
    await provisionWorkspace({ database: database.workspace, scope: owner.scope });
    const safetyDb = { transaction: <T>(input: { execute: (required: { session: { query(required: { sql: string; parameters: readonly unknown[] }): Promise<{ rows: readonly Readonly<Record<string, unknown>>[] }> } }) => Promise<T> }) => database.unit.transaction({ work: ({ session }) => input.execute({ session: { query: ({ sql, parameters }) => session.query({ text: sql, values: [...parameters] }) } }) }) };
    const confirmations = createMemoryConfirmationExchange({ clock, ids });
    const safety = createSqlSafetyRepo({ db: safetyDb, clock, ids, observer, ownerTimezone: 'UTC' });
    const campaignDb = { query: <Row extends Record<string, unknown>>(input: { text: string; values?: unknown[] }) => database.unit.transaction({ work: ({ session }) => session.query<Row>(input) }) };
    const campaigns = createSqlCampaignRepo({ db: campaignDb });
    const visits = createVisitTokens({ key: new Uint8Array([1, 2, 3]), clock, ids });
    const identity = bindIdentity({ unit: database.unit, tokens: visits.tokens, clock, ids, observer, digestKey: new Uint8Array([1, 2, 3]) });
    const forms = bindForms({ database, clock, ids, observer, digestKey: new Uint8Array([1, 2, 3]), tokens: visits.tokens });
    await seedSandboxForm({ binding: forms, context: owner, clock, ids });
    const measureDb: MeasureSqlDatabase = { query: campaignDb.query, transaction: ({ work }) => database.unit.transaction({ work: ({ session }) => work(session) }) };
    const measureRepo = createSqlMeasureRepo({ database: measureDb, jobs: { async enqueue() { return { ok: false, error: { code: 'forbidden', message: 'Fixture conversion denied', retryable: false } }; } } });
    const links = createSqlTrackedLink({ database: measureDb, ids, baseUrl: 'https://sandbox.example.test/l/', allowedOrigins: ['https://sandbox.example.test'] });
    const privacy = bindPrivacy({ unit: database.unit, identity, subjects: forms.subjects, measure: measureRepo, clock, ids, observer });
    const audit = bindCatalogAudit({ unit: database.unit, clock, ids, observer });
    const creative = bindSandboxCreative({ unit: database.unit, safetyRepo: safety, confirmations, clock, ids, observer, audit });
    const services: OwnerServices & OmFeatureServices = { campaigns, safety, confirmations, contacts: identity.contacts, forms: forms.forms, webEvents: identity.webEvents,
        privacy: privacy.privacy, audit, creative, ...bindCatalogScope({ database, safetyDb, clock, ids, observer, timezone: 'UTC' }),
        campaignWorkflow: bindSandboxCampaigns({ unit: database.unit, repo: campaigns, safety, clock, ids, observer, audit }),
        measure: bindCatalogMeasure({ repo: measureRepo, links, reports: sandboxPlatformReports({ clock, ids }), clock, ids, observer, audit }) };
    const tools = createOmTools({ clock, observer, confirmations, authorize: () => ({ ok: true, value: undefined }), definitions: input => buildOmToolDefinitions({ ...input, services }) });
    const workers = createFormWorkers({ unit: database.unit, forms, creative, clock, ids, observer, context: owner, schedule: () => () => {} });
    async function call(input: { name: string; input: unknown; operationId?: string; choice?: 'allow' | 'always_allow' }): Promise<ToolResult> {
        const call: ToolCall = { name: input.name, input: input.input as ToolCall['input'], operationId: input.operationId ?? ids.next({}) };
        const initial = value({ result: await tools.dispatch({ context: agent, call }) });
        if (initial.status !== 'pending') return initial;
        const card = value({ result: await tools.card({ context: agent, operationId: call.operationId }) });
        if (!card) throw new Error('Pending card missing');
        value({ result: await tools.answer({ context: owner, response: { cardId: card.cardId, operationId: card.operationId, argumentsDigest: card.argumentsDigest, choice: input.choice ?? 'allow' } }) });
        const result = value({ result: await tools.operation({ context: agent, operationId: call.operationId }) });
        if (result.status !== 'completed') throw new Error('Catalog call failed: ' + JSON.stringify(result));
        return { status: 'completed', output: result.output };
    }
    return { native, database, ids, observer, owner, agent, services, tools, call, visits, identity, workers, forms, clock, async close() { tools.dispose({}); await workers.stop({}); privacy.participants.dispose({}); native.close(); } };
}

describe('real feature catalog composition', () => {
    it('saves and retrieves a multi-destination neutral draft locally without remote creation or outbox intent', async () => {
        const f = await fixture();
        try {
            const before = f.native.prepare('SELECT id FROM job').all();
            const campaign = { operationId: 'local-neutral', name: 'Traffic', objective: 'traffic', schedule: { window: { start: 1792100000000, end: 1792200000000 }, timezone: 'UTC' }, audience: { countries: ['US'] }, creativeIds: ['asset'], creativeDigest: 'a'.repeat(64), targets: ['meta-ads', 'linkedin-ads'].map(pluginId => ({ pluginId, connectionId: 'unconnected', accountId: '123', dailyBudget: { minorUnits: 500, currency: 'USD' }, expectedExposure: { minorUnits: 2000, currency: 'USD' } })) };
            const result = await f.call({ name: 'om_campaign_save_local', input: campaign });
            expect(result.status).toBe('completed');
            const saved = (result as unknown as { output: { campaignId: string; campaign: unknown } }).output;
            expect(saved.campaign).toEqual(campaign);
            expect(await f.call({ name: 'om_campaign_get_local', input: { campaignId: saved.campaignId } })).toMatchObject({ status: 'completed', output: saved });
            expect(f.native.prepare('SELECT id FROM job').all()).toEqual(before);
        } finally { await f.close(); }
    });
    it('closes the feature composition gaps, retaining only the separately optional add-on routes', async () => {
        const f = await fixture();
        try {
            const definitions = value({ result: await buildOmToolDefinitions({ context: f.owner, services: f.services }) });
            const rows = generateOmToolCoverage({ definitions });
            expect(rows.filter(row => row.status === 'NEEDS' && ['FEATURE_COMPOSITION', 'CREATIVE_DEPENDENCY_I2'].includes(row.needs ?? '')).map(row => row.capability)).toEqual([
                'Owner route: addons', 'Owner route: addonInstall', 'Owner route: addonSetEnabled', 'Owner route: addonUninstall', 'Owner route: integrations', 'Owner route: integrationDisconnect',
            ]);
            for (const name of ['om_contacts_resolve', 'om_forms_publish', 'om_jobs_get', 'om_jobs_list', 'om_jobs_cancel', 'om_workspaces_list', 'om_audit_list', 'om_creative_generate', 'om_creative_status', 'om_creative_cancel', 'om_measure_report_cac', 'om_paid_sending_allowance_set']) {
                expect(definitions.some(tool => tool.name === name)).toBe(true);
            }
        } finally { await f.close(); }
    });
    it('calls real contacts, form publication/preview, visitor verification and privacy services', async () => {
        const f = await fixture();
        try {
            const subject = await f.call({ name: 'om_contacts_upsert', input: { identifiers: [{ kind: 'email', raw: 'fixture@example.test' }] } });
            expect(subject.status).toBe('completed');
            const subjectId = (subject as unknown as { output: { subjectId: string } }).output.subjectId;
            expect(await f.call({ name: 'om_contacts_resolve', input: { identifier: { kind: 'email', raw: 'fixture@example.test' } } })).toMatchObject({ status: 'completed', output: { subjectId } });
            await f.call({ name: 'om_forms_publish', input: { publication: { publicationId: 'custom', formDefinitionId: 'custom-definition', slug: 'custom', version: 1, fields: [{ id: 'email', label: 'Email', type: 'email', required: true }], consent: [], publishedAt: f.clock.now({}) } } });
            expect(await f.call({ name: 'om_forms_preview', input: { slug: 'custom' } })).toMatchObject({ status: 'completed', output: { publicationId: 'custom' } });
            expect(await f.call({ name: 'om_forms_submissions', input: { publicationId: 'custom', page: { limit: 100 } } })).toMatchObject({ status: 'completed', output: { items: [] } });
            const issued = f.visits.issue({ context: f.owner });
            value({ result: await f.identity.webRepo.saveVisit({ context: f.owner, visit: issued.visit }) });
            expect(await f.call({ name: 'om_web_events_bind_visitor', input: { visitToken: issued.token, subjectId } })).toMatchObject({ status: 'completed' });
            const wrong = { ...f.owner, scope: { ...f.owner.scope, workspaceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' } };
            expect(await f.services.webEvents!.bindVisitor({ context: wrong, visitToken: issued.token, subjectId })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
            const request = await f.call({ name: 'om_privacy_request_erasure', input: { subjectId } });
            expect(request).toMatchObject({ status: 'completed', output: { status: 'pending' } });
            const requestId = (request as unknown as { output: { requestId: string } }).output.requestId;
            expect(await f.call({ name: 'om_privacy_status', input: { requestId } })).toMatchObject({ status: 'completed', output: { requestId } });
        } finally { await f.close(); }
    });
    it('redacts structured backend failures before returning creative tool results', async () => {
        const f = await fixture();
        try {
            const binding = f.services.creative!;
            binding.service = { ...binding.service, async refreshJob() { return { ok: false, error: { code: 'unavailable', retryable: true, message: 'remote fixture-secret-do-not-display' } }; } };
            const definitions = value({ result: await buildOmToolDefinitions({ context: f.owner, services: f.services }) });
            const status = definitions.find(tool => tool.name === 'om_creative_status')!;
            const result = await status.invoke({ context: f.owner, input: { generationId: 'fixture' } });
            expect(result).toMatchObject({ ok: false, error: { code: 'unavailable' } });
            expect(JSON.stringify(result)).not.toContain('fixture-secret');
        } finally { await f.close(); }
    });
    it('creates paused sandbox campaigns, proposals and scoped links/reports without enabling launch', async () => {
        const f = await fixture();
        try {
            const creativeDigest = value({ result: digestArguments({ arguments: ['sandbox-creative'] }) });
            const draft = { operationId: 'draft-operation', connectionId: 'sandbox-campaigns', accountId: 'sandbox-account', name: 'Sandbox', objective: 'awareness', creativeIds: ['sandbox-creative'], creativeDigest, placements: ['feed'] };
            const created = await f.call({ name: 'om_campaign_create_paused', input: draft });
            expect(created).toMatchObject({ status: 'completed', output: { desiredState: 'paused', observedState: 'paused' } });
            const campaignId = (created as unknown as { output: { campaignId: string } }).output.campaignId;
            expect(await f.call({ name: 'om_campaign_propose_launch', input: { campaignId, flight: { window: { start: f.clock.now({}), end: f.clock.now({}) + 10000 }, expectedExposure: { currency: 'USD', minorUnits: 10 }, timezone: 'UTC' } } })).toMatchObject({ status: 'completed', output: { campaignId } });
            expect(await f.call({ name: 'om_campaign_reconcile', input: { operationId: draft.operationId } })).toMatchObject({ status: 'completed', output: { status: 'submitted' } });
            expect(await f.call({ name: 'om_measure_create_link', input: { destinationUrl: 'https://sandbox.example.test/offer', campaignId, utm: { utm_source: 'fixture' } } })).toMatchObject({ status: 'completed' });
            expect(await f.call({ name: 'om_measure_report_cac', input: { definitionId: 'signup', accountId: 'sandbox-account', attributionWindow: '7d', window: { start: f.clock.now({}) - 1000, end: f.clock.now({}) }, currency: 'USD', timezone: 'UTC', attributionModel: 'last-touch-v1' } })).toMatchObject({ status: 'completed', output: { spend: { minorUnits: 0 }, conversions: 0, cacMinorUnits: null } });
            const definitions = value({ result: await buildOmToolDefinitions({ context: f.owner, services: f.services }) });
            expect(definitions.some(tool => tool.name === 'om_campaign_launch')).toBe(false);
            expect(await f.call({ name: 'om_halt_account', input: { accountId: 'sandbox-account' } })).toMatchObject({ output: { remoteStatus: 'pending' } });
            expect(await f.services.campaignWorkflow!.createPaused({ context: f.owner, draft: { ...draft, operationId: 'after-halt' } })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
        } finally { await f.close(); }
    });
    it('queues creative intent in the one outbox, permits normal write grants, dispatches once and cancels without refund', async () => {
        const f = await fixture();
        try {
            const input = { prompt: 'Local fixture', surface: 'image', model: 'sandbox', rightsEvidenceId: 'fixture-rights', deadlineAt: f.clock.now({}) + 60000 };
            const call: ToolCall = { name: 'om_creative_generate', operationId: 'generation-one', input };
            expect(value({ result: await f.tools.dispatch({ context: f.agent, call }) }).status).toBe('pending');
            const card = value({ result: await f.tools.card({ context: f.agent, operationId: call.operationId }) })!;
            expect(card.classification).toBe('generation'); expect(card.allowedChoices).toContain('always_allow');
            expect(f.native.prepare('SELECT COUNT(*) AS count FROM creative_generation_request').get()).toEqual({ count: 0 });
            value({ result: await f.tools.answer({ context: f.owner, response: { cardId: card.cardId, operationId: call.operationId, argumentsDigest: card.argumentsDigest, choice: 'always_allow' } }) });
            expect(value({ result: await f.tools.operation({ context: f.agent, operationId: call.operationId }) })).toMatchObject({ status: 'completed', output: { generationId: call.operationId } });
            expect(await f.call({ name: 'om_creative_status', input: { generationId: call.operationId } })).toMatchObject({ output: { state: 'pending', dispatchState: 'queued' } });
            await f.workers.processOne();
            expect(await f.call({ name: 'om_creative_status', input: { generationId: call.operationId } })).toMatchObject({ output: { dispatchState: 'submitted' } });
            expect(await f.call({ name: 'om_creative_cancel', input: { generationId: call.operationId } })).toMatchObject({ output: { state: 'cancelled', actualCost: null } });
            expect(f.native.prepare("SELECT COUNT(*) AS count FROM job WHERE operation='creative.generate'").get()).toEqual({ count: 1 });
            expect(await f.call({ name: 'om_paid_sending_allowance_get', input: {} })).toMatchObject({ output: { dailyLimit: { minorUnits: 500 } } });
            expect(await f.call({ name: 'om_jobs_list', input: { limit: 100 } })).toMatchObject({ output: { items: [{ handler: 'creative.generate', state: 'succeeded' }] } });
        } finally { await f.close(); }
    });
});

for (const adapter of ['memory', 'sql'] as const) it('campaign jobs shared creation suite / ' + adapter, async () => {
    const f = await fixture();
    try {
        const jobs = adapter === 'memory' ? createMemoryCampaignJob({}) : bindCampaignJobs({ unit: f.database.unit, repo: f.services.campaigns, clock: f.clock, ids: f.ids, observer: f.observer });
        const draft = { operationId: 'shared-draft', connectionId: 'sandbox-campaigns', accountId: 'sandbox-account', name: 'Fixture', objective: 'awareness', creativeIds: ['sandbox-creative'], creativeDigest: 'a'.repeat(64), placements: ['feed'] };
        const saved = value({ result: await f.services.campaigns.save({ context: f.owner, draft }) });
        const input = { context: f.owner, operationId: draft.operationId, argumentsDigest: createHash('sha256').update(JSON.stringify(draft)).digest('hex'), intent: { kind: 'create' as const, campaignId: saved.campaignId, draft } };
        // CampaignJobPort reads/claims carry only the scoped operation key; finish adds status.
        const key = { context: input.context, operationId: input.operationId };
        expect(await jobs.enqueue({ ...input, operationId: 'different-operation' })).toMatchObject({ ok: false, error: { code: 'conflict' } });
        expect(await jobs.enqueue({ ...input, argumentsDigest: 'b'.repeat(64) })).toMatchObject({ ok: false, error: { code: 'conflict' } });
        expect(await jobs.enqueue({ ...input, intent: { ...input.intent, draft: { ...draft, name: 'Changed' } } })).toMatchObject({ ok: false, error: { code: 'conflict' } });
        expect(await jobs.get({ context: input.context, operationId: input.operationId })).toEqual({ ok: true, value: null });
        const first = value({ result: await jobs.enqueue(input) });
        expect(await jobs.enqueue(input)).toEqual({ ok: true, value: first });
        expect(await jobs.get(input)).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
        expect(await jobs.claim(input)).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
        expect(await jobs.finish({ ...input, status: 'submitted' })).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
        expect(value({ result: await jobs.get({ context: input.context, operationId: input.operationId }) })).toMatchObject({ status: 'queued', intent: input.intent });
        const foreign: CallContext = { ...f.owner, scope: { ownerId: 'other', workspaceId: f.owner.scope.workspaceId }, principal: { kind: 'owner', ownerId: 'other' } };
        expect(await jobs.get({ context: foreign, operationId: input.operationId })).toEqual({ ok: true, value: null });
        const claims = await Promise.all([jobs.claim(key), jobs.claim(key)]);
        expect(claims.filter(result => result.ok && result.value !== null)).toHaveLength(1);
        value({ result: await jobs.finish({ ...key, status: 'submitted' }) });
        expect(value({ result: await jobs.get({ context: input.context, operationId: input.operationId }) })).toMatchObject({ status: 'submitted', intent: input.intent });
        expect(await jobs.claim(key)).toEqual({ ok: true, value: null });
    } finally { await f.close(); }
});

it('accepts parsed sandbox quotes and rejects changed price provenance before enqueue', async () => {
    const f = await fixture();
    try {
        const creative = f.services.creative!;
        const effect = value({ result: await creative.prepareEffect({ context: f.owner, call: { name: 'om_creative_generate', operationId: 'quote-provenance',
            input: { prompt: 'Fixture', surface: 'image', model: 'sandbox', rightsEvidenceId: 'rights', deadlineAt: f.clock.now({}) + 60000 } } }) });
        const generation = effect.generation!;
        expect(await creative.safety.assessGeneration({ context: f.owner, ...generation })).toMatchObject({ ok: true });
        expect(await creative.safety.assessGeneration({ context: f.owner, ...generation, request: { ...generation.request, configurationDigest: 'b'.repeat(64) } })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
        for (const quote of [
            { ...generation.quote, argumentsDigest: 'b'.repeat(64) },
            { ...generation.quote, modelConfigurationDigest: 'b'.repeat(64) },
            { ...generation.quote, pricingEvidenceId: 'substituted-evidence' },
            { ...generation.quote, upperBound: { currency: 'USD', minorUnits: 1 } },
        ]) {
            expect(await creative.safety.assessGeneration({ context: f.owner, request: generation.request, quote })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
        }
        expect(f.native.prepare("SELECT COUNT(*) AS count FROM job WHERE operation='creative.generate'").get()).toEqual({ count: 0 });
    } finally { await f.close(); }
});

it('creative worker sends unknown outcomes to reconciliation instead of blind retries', async () => {
    const f = await fixture();
    try {
        await f.call({ name: 'om_creative_generate', operationId: 'unknown-generation', input: { prompt: 'Fixture', surface: 'image', model: 'sandbox', rightsEvidenceId: 'rights', deadlineAt: f.clock.now({}) + 60000 } });
        f.services.creative!.dispatchQueued = async () => ({ ok: false, error: { code: 'unavailable', message: 'Fixture outcome unknown', retryable: false } });
        expect(await f.workers.processOne()).toMatchObject({ kind: 'completed', state: 'reconcile' });
        expect(await f.workers.processOne()).toEqual({ kind: 'idle' });
        expect(await f.call({ name: 'om_jobs_list', input: { limit: 100 } })).toMatchObject({ output: { items: [{ state: 'reconcile', attempts: 1 }] } });
    } finally { await f.close(); }
});

it('refuses expired sandbox quotes at the deadline and afterwards without dispatch or enqueue', async () => {
    const f = await fixture();
    try {
        const creative = f.services.creative!;
        const effect = value({ result: await creative.prepareEffect({ context: f.owner, call: { name: 'om_creative_generate', operationId: 'expired-quote',
            input: { prompt: 'Fixture', surface: 'image', model: 'sandbox', rightsEvidenceId: 'rights', deadlineAt: f.clock.now({}) + 60000 } } }) });
        expect(await creative.safety.assessGeneration({ context: f.owner, ...effect.generation! })).toMatchObject({ ok: true, value: { kind: 'normal_write' } });
        const card = value({ result: await creative.safety.prepareApproval({ context: f.owner, request: effect }) });
        value({ result: await f.services.confirmations!.confirm({ context: f.owner, response: { cardId: card.cardId, operationId: card.operationId, argumentsDigest: card.argumentsDigest, choice: 'allow' } }) });
        let dispatches = 0;
        for (const now of [effect.generation!.quote.expiresAt, effect.generation!.quote.expiresAt + 1]) {
            f.clock.now = () => now;
            expect(await creative.safety.assessGeneration({ context: f.owner, ...effect.generation! })).toMatchObject({ ok: false, error: { code: 'expired' } });
            expect(await creative.safety.prepareApproval({ context: f.owner, request: effect })).toMatchObject({ ok: false, error: { code: 'expired' } });
            expect(await creative.safety.withDispatch({ context: f.owner, request: { ...effect, approvalId: card.cardId, policyRevision: 0 },
                async dispatch() { dispatches++; return { ok: true, value: undefined }; } })).toMatchObject({ ok: false, error: { code: 'expired' } });
        }
        expect(dispatches).toBe(0);
        expect(f.native.prepare('SELECT COUNT(*) AS count FROM creative_generation_request').get()).toEqual({ count: 0 });
        expect(f.native.prepare("SELECT COUNT(*) AS count FROM job WHERE operation='creative.generate'").get()).toEqual({ count: 0 });
    } finally { await f.close(); }
});

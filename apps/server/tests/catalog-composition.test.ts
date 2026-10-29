import { createSqlContactRepo } from '@open-marketing/contacts';
import { createSubjectLane } from '../src/composition/subject-lane.js';
/** Written-only A4b regressions: real in-memory SQLite and public feature services, no vendor I/O. */
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { CallContext, ClockPort, IdPort, NeutralCampaignLaunch, ObserverEvent, Outcome, ToolCall, ToolResult, UnitOfWork } from '@open-marketing/contracts';
import { createMemoryConfirmationExchange, createSqlSafetyRepo, digestArguments } from '@open-marketing/safety';
import { createSqlCampaignRepo, createMemoryCampaignJob } from '@open-marketing/campaigns';
import { createSqlMeasureRepo, createSqlTrackedLink } from '@open-marketing/measure';
import type { MeasureSqlDatabase } from '@open-marketing/measure';
import type { GenerationPollRequest, GenerationStatus } from '@open-marketing/creative';
import { bindServerDatabase, provisionWorkspace } from '../src/composition/database.js';
import { migrationManifest } from '../src/composition/migrations.js';
import { bindIdentity, createVisitTokens } from '../src/composition/identity.js';
import { bindForms, seedSandboxForm } from '../src/composition/forms.js';
import { bindPrivacy } from '../src/composition/privacy.js';
import { bindCatalogAudit, bindCatalogScope, bindCatalogMeasure, bindCatalogMedia, createCatalogMediaEffects, sandboxPlatformReports } from '../src/composition/catalog.js';
import { bindSandboxCampaigns, bindCampaignJobs } from '../src/composition/campaigns.js';
import { bindSandboxCreative } from '../src/composition/creative.js';
import * as creativeComposition from '../src/composition/creative.js';
import { bootServer, type BootedServer } from '../src/composition/index.js';
import { createNodeBootIo } from '../src/composition/serve.js';
import { createFormWorkers } from '../src/composition/workers.js';
import { buildOmToolDefinitions, createOmTools } from '../src/om-tools.js';
import type { OmFeatureServices } from '../src/om-tools.js';
import { handleOwnerRequest } from '../src/inbound/owner.js';
import type { OwnerServices } from '../src/inbound/owner.js';
import { generateOmToolCoverage } from '../src/om-tool-coverage.js';

/** Captured approval evidence; each fixture owns its audit records. */
function answerAudit() {
    const answers: unknown[] = [];
    return { answers, async recordAnswer(input: { answer: unknown }) {
        answers.push(structuredClone(input.answer));
        return { ok: true as const, value: undefined };
    } };
}

function value<T>(required: { result: Outcome<T> }): T { if (!required.result.ok) throw new Error('Fixture precondition: ' + required.result.error.message); return required.result.value; }
const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQx8AAAAASUVORK5CYII=', 'base64');
const imageUrl = 'https://fixture.invalid/generated.png';
async function fixture() {
    const native = new Database(':memory:'); native.pragma('foreign_keys = ON');
    for (const entry of migrationManifest) native.exec(readFileSync(new URL('../../../' + entry.path, import.meta.url), 'utf8'));
    const clock: ClockPort = { now: () => 1792000000123 }; const ids: IdPort = { next: () => randomUUID() }; const observer = { observe() {} };
    const owner: CallContext = { scope: { ownerId: 'owner', workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }, principal: { kind: 'owner', ownerId: 'owner' }, correlationId: 'correlation', traceId: 'trace' };
    const agent: CallContext = { ...owner, runId: 'run', principal: { kind: 'agent', runId: 'run', agentInstanceId: 'instance' } };
    const database = bindServerDatabase({ native, observer, context: owner });
    await provisionWorkspace({ database: database.workspace, scope: owner.scope });
    const safetyDb = database.unit;
    const confirmations = createMemoryConfirmationExchange({ ...answerAudit(), clock, ids });
    const safety = createSqlSafetyRepo({ db: safetyDb, clock, ids, observer, ownerTimezone: 'UTC' });
    const campaignDb = database.workspace;
    const campaigns = createSqlCampaignRepo({ db: campaignDb });
    const visits = createVisitTokens({ key: new Uint8Array([1, 2, 3]), clock, ids });
    const subjectLane = createSubjectLane({ resolveSubject: createSqlContactRepo({ uow: database.unit }).get });
    const identity = bindIdentity({ unit: database.unit, subjectLane, tokens: visits.tokens, clock, ids, observer, digestKey: new Uint8Array([1, 2, 3]) });
    const forms = bindForms({ database, subjectLane, clock, ids, observer, digestKey: new Uint8Array([1, 2, 3]), tokens: visits.tokens });
    await seedSandboxForm({ binding: forms, context: owner, clock, ids });
    const measureDb: MeasureSqlDatabase = database.workspace;
    const measureRepo = createSqlMeasureRepo({ database: measureDb, jobs: { async enqueue() { return { ok: false, error: { code: 'forbidden', message: 'Fixture conversion denied', retryable: false } }; } } });
    const links = createSqlTrackedLink({ database: measureDb, ids, baseUrl: 'https://sandbox.example.test/l/', allowedOrigins: ['https://sandbox.example.test'] });
    const privacy = bindPrivacy({ unit: database.unit, subjectLane, identity, subjects: forms.subjects, measure: measureRepo, clock, ids, observer });
    const audit = bindCatalogAudit({ unit: database.unit, clock, ids, observer });
    const stateRoot = await mkdtemp(join(tmpdir(), 'om-creative-media-'));
    const fetched: string[] = [];
    let rejectImport = false;
    const mediaEffects = { ...createCatalogMediaEffects({ stateRoot, clock }),
        outboundGuard: { async send(input: { request: { url: string } }) {
            if (input.request.url !== imageUrl) throw new Error('Unconfigured fixture URL');
            fetched.push(input.request.url);
            if (rejectImport) throw new Error('Fixture import unavailable');
            return { status: 200, headers: {}, bodyText: '', bodyBytes: imageBytes, bodyBytesTruncated: false, finalUrl: imageUrl };
        } }, async decode() { return { width: 1, height: 1, frames: 1 }; } };
    const media = bindCatalogMedia({ db: campaignDb, context: owner, clock, ids, observer, audit, effects: mediaEffects });
    const creative = bindSandboxCreative({ unit: database.unit, media, safetyRepo: safety, confirmations, clock, ids, observer, audit });
    const services: OwnerServices & OmFeatureServices = { campaigns, safety, confirmations, contacts: identity.contacts, forms: forms.forms, leads: forms.leads, webEvents: identity.webEvents,
        privacy: privacy.privacy, audit, creative, media, ...bindCatalogScope({ database, safetyDb, clock, ids, observer, timezone: 'UTC' }),
        campaignWorkflow: bindSandboxCampaigns({ unit: database.unit, repo: campaigns, safety, clock, ids, observer, audit }),
        measure: bindCatalogMeasure({ repo: measureRepo, links, reports: sandboxPlatformReports({ clock, ids }), clock, observer }) };
    const tools = createOmTools({ clock, observer, confirmations, authorize: () => ({ ok: true, value: undefined }), definitions: input => buildOmToolDefinitions({ ...input, services }) });
    let scheduled: (() => void) | undefined;
    let settled: (() => void) | undefined;
    const workers = createFormWorkers({ unit: database.unit, forms, creative, clock, ids, observer, context: owner,
        schedule(input) { scheduled = input.callback; settled?.(); settled = undefined; return () => { scheduled = undefined; }; } });
    async function call(input: { name: string; input: unknown; operationId?: string; choice?: 'allow' | 'always_allow' }): Promise<ToolResult> {
        const call: ToolCall = { name: input.name, input: input.input as ToolCall['input'], operationId: input.operationId ?? ids.next({}) };
        const initial = value({ result: await tools.dispatch({ context: agent, call }) });
        if (initial.status !== 'pending') return initial;
        const card = value({ result: await tools.card({ context: agent, operationId: call.operationId }) });
        if (!card) throw new Error('Pending card missing');
        value({ result: await tools.answer({ context: owner, approver: { kind: 'local_token', ownerId: owner.scope.ownerId, deviceId: 'fixture-device', tokenId: 'fixture-token-reference' }, response: { cardId: card.cardId, operationId: card.operationId, argumentsDigest: card.argumentsDigest, choice: input.choice ?? 'allow' } }) });
        const result = value({ result: await tools.operation({ context: agent, operationId: call.operationId }) });
        if (result.status !== 'completed') throw new Error('Catalog call failed: ' + JSON.stringify(result));
        return { status: 'completed', output: result.output };
    }
    return { native, database, ids, observer, owner, agent, services, tools, call, visits, identity, workers, forms, clock, fetched,
        failImport(input: { reject: boolean }) { rejectImport = input.reject; },
        reopenMedia: () => bindCatalogMedia({ db: campaignDb, context: owner, clock, ids, observer, audit, effects: mediaEffects }),
        readMediaBlob: (input: { storageKey: string }) => createCatalogMediaEffects({ stateRoot, clock }).blobStore.get(input),
        async tick() { const done = new Promise<void>(resolve => { settled = resolve; }); scheduled!(); await done; },
        async close() { tools.dispose({}); await workers.stop({}); privacy.participants.dispose({}); native.close(); await rm(stateRoot, { recursive: true, force: true }); } };
}

/** Synthetic persisted provider observation; no tools/list or vendor acceptance is implied. */
async function unknownCreative(required: { fixture: Awaited<ReturnType<typeof fixture>>; generationId: string; prompt?: string }): Promise<GenerationStatus> {
    const f = required.fixture;
    await f.call({ name: 'om_creative_generate', operationId: required.generationId,
        input: { prompt: required.prompt ?? 'Fixture image', surface: 'image', model: 'sandbox', rightsEvidenceId: 'fixture-rights', deadlineAt: f.clock.now({}) + 60000 } });
    await f.workers.processOne();
    const row = f.native.prepare('SELECT status_json FROM creative_generation_request WHERE generation_id=?').get(required.generationId) as { status_json: string };
    const original = JSON.parse(row.status_json) as GenerationStatus;
    const status: GenerationStatus = { ...original, state: 'unknown', providerJobId: 'fixture-job',
        operation: { schemaVersion: 1, id: original.asyncOperationId!, providerId: 'fixture', routeKey: 'fixture',
            ownerRef: JSON.stringify([f.owner.scope.ownerId, f.owner.scope.workspaceId, original.generationId]), status: 'unknown',
            attempts: 1, maxAttempts: 1, deadlineAt: original.request.deadlineAt, nextPollAt: f.clock.now({}), leaseOwner: null, leaseExpiresAt: null,
            state: { jobId: 'fixture-job' }, result: null, error: { code: 'DEADLINE_EXPIRED', message: 'Synthetic unknown outcome' }, createdAt: f.clock.now({}), updatedAt: f.clock.now({}) } };
    f.native.prepare('UPDATE creative_generation_request SET status_json=? WHERE generation_id=?').run(JSON.stringify(status), required.generationId);
    return status;
}

describe('shared generation completion', () => {
    for (const mode of ['outcome', 'throw'] as const) it('reaches boot readiness after creative recovery ' + mode, async () => {
        const directory = await mkdtemp(join(tmpdir(), 'om-recovery-'));
        const studioRoot = join(directory, 'studio');
        const events: ObserverEvent[] = [];
        let server: BootedServer | undefined;
        const bind = creativeComposition.bindSandboxCreative;
        const spy = vi.spyOn(creativeComposition, 'bindSandboxCreative').mockImplementation(input => {
            const binding = bind(input);
            binding.service.recover = async () => {
                if (mode === 'throw') throw new Error('Opaque recovery failure');
                return { ok: false, error: { code: 'unavailable', message: 'Recovery unavailable', retryable: true } };
            };
            return binding;
        });
        try {
            await mkdir(studioRoot); await writeFile(join(studioRoot, 'index.html'), '<!doctype html><title>Fixture</title>');
            const ids = { next: () => randomUUID() };
            const io = createNodeBootIo({ projectRoot: fileURLToPath(new URL('../../../', import.meta.url)), studioRoot, ready() {} });
            const booted = await bootServer({ env: { OM_STATE_ROOT: join(directory, 'state'), OM_PORT: '0' }, ids,
                clock: { now: () => 1792000000123 }, observer: { observe(event) { events.push(event); } }, io: { ...io, schedule: () => () => {},
                    agentEffects: { runtime: { ids, env: {}, async fetch(url) {
                        if (new URL(String(url)).pathname !== '/internal/v1/health') throw new Error('Unexpected fixture agent request');
                        return Response.json({ ok: true, value: { protocolVersion: 1, ready: true, runtime: 'available' } });
                    },
                        deadline: { create: () => ({ signal: new AbortController().signal, dispose() {} }) } },
                        async launch() { return { ok: true, value: { origin: 'http://127.0.0.1:9999', pid: 1, async stop() { return { ok: true, value: undefined }; } } }; } } } });
            server = value({ result: booted });
            expect(events).toContainEqual(expect.objectContaining({ operation: 'server.boot', outcome: 'ready' }));
            expect(events).toContainEqual(expect.objectContaining({ operation: 'server.boot.creative', outcome: 'unavailable' }));
        } finally { spy.mockRestore(); await server?.stop({}); await rm(directory, { recursive: true, force: true }); }
    });
    for (const authority of ['revoked', 'expired'] as const) it('does not fetch a verified URL again when authority is ' + authority, async () => {
        const f = await fixture();
        try {
            const unknown = await unknownCreative({ fixture: f, generationId: 'url-authority' });
            const input = { context: { ...f.owner, principal: { kind: 'service' as const, serviceId: 'fixture-verifier' } }, generationId: unknown.generationId,
                completion: { asyncOperationId: unknown.asyncOperationId!, providerJobId: 'fixture-job',
                    output: { kind: 'url' as const, sourceUrl: imageUrl, expectedDigest: createHash('sha256').update(imageBytes).digest('hex') } } };
            f.failImport({ reject: true });
            expect(await f.services.creative!.service.ingestVerifiedCompletion(input)).toMatchObject({ ok: false });
            expect(f.fetched).toEqual([imageUrl]);
            f.failImport({ reject: false });
            if (authority === 'revoked') value({ result: await f.services.confirmations!.revoke({ context: f.owner, cardId: unknown.request.approvalId! }) });
            else { const now = f.clock.now({}); f.clock.now = () => now + 300001; }
            expect(await f.services.creative!.service.refreshJob(input)).toMatchObject({ ok: false, error: { code: authority === 'revoked' ? 'forbidden' : 'expired' } });
            expect(f.fetched).toEqual([imageUrl]);
            const row = f.native.prepare('SELECT status_json FROM creative_generation_request WHERE generation_id=?').get(unknown.generationId) as { status_json: string };
            expect(JSON.parse(row.status_json)).toMatchObject({ verifiedCompletion: input.completion, assetIds: [], operation: { status: 'unknown' } });
            expect(f.native.prepare("SELECT COUNT(*) AS count FROM job WHERE operation='creative.generate'").get()).toEqual({ count: 1 });
        } finally { await f.close(); }
    });
    for (const length of [16000, 16001, 32768]) it('preserves prompt evidence and imports at prompt length ' + length, async () => {
        const f = await fixture();
        try {
            const prompt = 'p'.repeat(length);
            const unknown = await unknownCreative({ fixture: f, generationId: 'long-prompt', prompt });
            const input = { context: { ...f.owner, principal: { kind: 'service' as const, serviceId: 'fixture-verifier' } }, generationId: unknown.generationId,
                completion: { asyncOperationId: unknown.asyncOperationId!, providerJobId: 'fixture-job',
                    output: { kind: 'url' as const, sourceUrl: imageUrl, expectedDigest: createHash('sha256').update(imageBytes).digest('hex') } } };
            const completed = value({ result: await f.services.creative!.service.ingestVerifiedCompletion(input) });
            expect(completed.request.prompt).toBe(prompt);
            expect(completed.assetIds).toHaveLength(1);
            const evidence = f.native.prepare("SELECT payload FROM om_media_evidence WHERE kind='provenance' AND operation_id=?").all(unknown.request.operationId) as { payload: string }[];
            expect(evidence.length).toBeGreaterThan(0);
            for (const row of evidence) expect(JSON.parse(row.payload)).toMatchObject({ generationId: unknown.generationId, quoteId: unknown.quote.quoteId,
                prompt: length <= 16000 ? prompt : null });
            expect(value({ result: await f.services.creative!.service.refreshJob(input) }).request.prompt).toBe(prompt);
            expect(f.fetched).toEqual([imageUrl]);
        } finally { await f.close(); }
    });
    it('polls a bounded creative page on empty outbox ticks and carries its cursor to the next tick', async () => {
        const f = await fixture();
        try {
            const requests: GenerationPollRequest[] = [];
            const creative = f.services.creative!;
            creative.service = { ...creative.service, async pollDue(input) {
                requests.push(input.request);
                return { ok: true, value: { claimed: 0, completed: 0, failed: 0, pending: 0, unknown: 0, reconcileCursor: requests.length === 1 ? 'next-generation' : null } };
            } };
            value({ result: f.workers.start({}) });
            await f.tick(); await f.tick(); await f.tick();
            expect(requests).toHaveLength(3);
            expect(requests[0]).toMatchObject({ limit: 1, leaseMs: 60000 });
            expect(requests[0].cursor).toBeUndefined();
            expect(requests[1].cursor).toBe('next-generation');
            expect(requests[2].cursor).toBeUndefined();
            expect(f.native.prepare('SELECT COUNT(*) AS count FROM job').get()).toEqual({ count: 0 });
        } finally { await f.close(); }
    });
    it('imports a verified URL into canonical SQL/file media and preserves asset identity across retry and rebind', async () => {
        const f = await fixture();
        try {
            const unknown = await unknownCreative({ fixture: f, generationId: 'late-url' });
            const worker = { ...f.owner, principal: { kind: 'service' as const, serviceId: 'fixture-verifier' } };
            const input = { context: worker, generationId: unknown.generationId,
                completion: { asyncOperationId: unknown.asyncOperationId!, providerJobId: 'fixture-job',
                    output: { kind: 'url' as const, sourceUrl: imageUrl, expectedDigest: createHash('sha256').update(imageBytes).digest('hex') } } };
            const first = value({ result: await f.services.creative!.service.ingestVerifiedCompletion(input) });
            const duplicate = value({ result: await f.services.creative!.service.ingestVerifiedCompletion(input) });
            expect(duplicate.assetIds).toEqual(first.assetIds);
            expect(first.assetIds).toHaveLength(1);
            expect(duplicate.operation).toEqual(unknown.operation);
            const assets = value({ result: await f.reopenMedia().list({ context: f.owner, query: { limit: 100 } }) });
            expect(assets.items.map(asset => asset.record.id)).toEqual(first.assetIds);
            expect(Buffer.from(await f.readMediaBlob({ storageKey: assets.items[0].blob.storageKey }))).toEqual(imageBytes);
            const status = value({ result: await f.services.creative!.service.refreshJob({ context: f.owner, generationId: unknown.generationId }) });
            expect(status.assetIds).toEqual(first.assetIds);
            expect(f.native.prepare("SELECT COUNT(*) AS count FROM job WHERE operation='creative.generate'").get()).toEqual({ count: 1 });
        } finally { await f.close(); }
    });
    it('retains verified byte output and returns an explicit unsupported boundary without inventing an asset', async () => {
        const f = await fixture();
        try {
            const unknown = await unknownCreative({ fixture: f, generationId: 'late-bytes' });
            const input = { context: { ...f.owner, principal: { kind: 'service' as const, serviceId: 'fixture-verifier' } }, generationId: unknown.generationId,
                completion: { asyncOperationId: unknown.asyncOperationId!, providerJobId: 'fixture-job',
                    output: { kind: 'bytes' as const, result: { bytesBase64: imageBytes.toString('base64'), providerNote: 'fixture' } } } };
            expect(await f.services.creative!.service.ingestVerifiedCompletion(input)).toMatchObject({ ok: false, error: { code: 'not_implemented' } });
            expect(await f.services.creative!.service.refreshJob(input)).toMatchObject({ ok: false, error: { code: 'not_implemented' } });
            const row = f.native.prepare('SELECT status_json FROM creative_generation_request WHERE generation_id=?').get(unknown.generationId) as { status_json: string };
            expect(JSON.parse(row.status_json)).toMatchObject({ verifiedCompletion: input.completion, assetIds: [], operation: { status: 'unknown' } });
            expect(f.native.prepare("SELECT COUNT(*) AS count FROM job WHERE operation='creative.generate'").get()).toEqual({ count: 1 });
        } finally { await f.close(); }
    });
});

describe('real feature catalog composition', () => {
    it.each([null, 'commit_failed', 'rollback_failed', 'release_after_failure'])('preserves measure denials only after checked rollback: %s', async code => {
        const f = await fixture();
        try {
            const repo = createSqlMeasureRepo({ database: { ...f.database.workspace, async transaction(input) {
                try { return await f.database.workspace.transaction(input); }
                catch (error) {
                    if (!code) throw error;
                    throw Object.assign(new Error('Uncertain cleanup', { cause: error instanceof Error ? error.cause : error }), { code });
                }
            } }, jobs: { async enqueue() {
                return { ok: false, error: { code: 'forbidden', message: 'Fixture conversion denied', retryable: false } };
            } } });
            const event = { eventId: 'denied', definitionId: 'signup', subjectId: 'subject', occurredAt: 100,
                destination: 'account:google', purpose: 'conversion_measurement', identifierDigests: { click_id: 'a'.repeat(64) } };
            expect(await repo.appendConversion({ source: { sourceId: 'fixture', scope: f.owner.scope, authenticationRevision: 1, context: f.owner }, event }))
                .toMatchObject({ ok: false, error: { code: code ? 'unavailable' : 'forbidden' } });
            expect(f.native.prepare('SELECT COUNT(*) AS count FROM measure_conversion_event').get()).toEqual({ count: 0 });
            const result = await f.database.unit.transaction({ work: async ({ session }) => {
                await session.query({ text: 'INSERT INTO workspace_connection_scope(owner_id,workspace_id,connection_id) VALUES($1,$2,$3)', values: [f.owner.scope.ownerId, f.owner.scope.workspaceId, 'rolled-back'] });
                return session.transaction({ work: async ({ session: joined }) => {
                    expect(joined).toBe(session);
                    return { ok: false as const, error: { code: 'conflict' as const, message: 'Denied', retryable: false } };
                } });
            } });
            expect(result.ok).toBe(false);
            expect(f.native.prepare('SELECT connection_id FROM workspace_connection_scope').all()).toEqual([]);
        } finally { await f.close(); }
    });
    it('saves and retrieves a multi-destination neutral draft locally without remote creation or outbox intent', async () => {
        const f = await fixture();
        try {
            const before = f.native.prepare('SELECT id FROM job').all();
            const campaign: NeutralCampaignLaunch = { schemaVersion: 2, operationId: 'local-neutral', name: 'Traffic', objective: 'traffic', schedule: { window: { start: 1792100000000, end: 1792200000000 }, timezone: 'UTC' }, audience: { countries: ['US'] }, ads: [{ creativeId: 'asset', destinationUrl: 'https://sandbox.example.test/offer' }], creativeDigest: 'a'.repeat(64), targets: ['meta-ads', 'linkedin-ads'].map(pluginId => ({ pluginId, connectionId: 'unconnected', accountId: '123', dailyBudget: { minorUnits: 500, currency: 'USD' }, expectedExposure: { minorUnits: 2000, currency: 'USD' } })) };
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
            // Inert stand-ins for the feature seams real composition injects (definitions are only built, never invoked here).
            const unavailable = async () => ({ ok: false as const, error: { code: 'unavailable' as const, message: 'Fixture stand-in', retryable: false } });
            const services = { ...f.services, tracking: { snippet: unavailable, readiness: unavailable }, reporting: { results: unavailable, enqueue: unavailable },
                alerts: { list: unavailable, acknowledge: unavailable } } as unknown as typeof f.services;
            const providerSettings = { unit: { transaction: unavailable }, addons: { list: unavailable }, agentPluginState: unavailable } as never;
            const definitions = value({ result: await buildOmToolDefinitions({ context: f.owner, services, providerSettings }) });
            const rows = generateOmToolCoverage({ definitions });
            // Only the add-on boundary stays optional; conversion settings and OAuth/secret status are gated by that same dependency.
            expect(rows.filter(row => row.status === 'NEEDS' && ['FEATURE_COMPOSITION', 'CREATIVE_DEPENDENCY_I2'].includes(row.needs ?? '')).map(row => row.capability)).toEqual([
                'Owner route: addons', 'Owner route: addonInstall', 'Owner route: addonSetEnabled', 'Owner route: addonUninstall', 'Owner route: integrations',
                'Owner route: integrationConversionSettings', 'Owner route: setIntegrationConversionSettings', 'Owner route: integrationPluginSecretStatus', 'Owner route: integrationDisconnect',
                'Owner route: integrationOAuthStart', 'Owner route: integrationOAuthStatus', 'Conversion settings', 'Conversion settings',
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
            value({ result: await f.tools.answer({ context: f.owner, approver: { kind: 'local_token', ownerId: f.owner.scope.ownerId, deviceId: 'fixture-device', tokenId: 'fixture-token-reference' }, response: { cardId: card.cardId, operationId: call.operationId, argumentsDigest: card.argumentsDigest, choice: 'always_allow' } }) });
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

it('returns a successful campaign dispatch fence when the clock advances after the transaction', async () => {
    const f = await fixture();
    try {
        let now = f.clock.now({});
        const unit: UnitOfWork = { async transaction(request) {
            const result = await f.database.unit.transaction(request);
            const dispatched = f.native.prepare("SELECT state FROM job WHERE operation='campaign.create'").get() as { state: string } | undefined;
            if (dispatched?.state === 'dispatching') now += 60000;
            return result;
        } };
        const jobs = bindCampaignJobs({ unit, repo: f.services.campaigns, clock: { now: () => now }, ids: f.ids, observer: f.observer });
        const draft = { operationId: 'dispatch-clock', connectionId: 'sandbox-campaigns', accountId: 'sandbox-account', name: 'Fixture', objective: 'awareness', creativeIds: ['sandbox-creative'], creativeDigest: 'a'.repeat(64), placements: ['feed'] };
        const saved = value({ result: await f.services.campaigns.save({ context: f.owner, draft }) });
        value({ result: await jobs.enqueue({ context: f.owner, operationId: draft.operationId, argumentsDigest: createHash('sha256').update(JSON.stringify(draft)).digest('hex'), intent: { kind: 'create', campaignId: saved.campaignId, draft } }) });
        const key = { context: f.owner, operationId: draft.operationId };
        expect(await jobs.claim(key)).toMatchObject({ ok: true, value: { status: 'dispatching' } });
        expect(await jobs.finish({ ...key, status: 'submitted' })).toMatchObject({ ok: false, error: { code: 'conflict' } });
        expect(await jobs.get(key)).toMatchObject({ ok: true, value: { status: 'dispatching' } });
    } finally { await f.close(); }
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
        if (adapter === 'sql') {
            const expired = bindCampaignJobs({ unit: f.database.unit, repo: f.services.campaigns, clock: { now: () => f.clock.now({}) + 60000 }, ids: f.ids, observer: f.observer });
            expect(await expired.finish({ ...key, status: 'submitted' })).toMatchObject({ ok: false, error: { code: 'conflict' } });
            expect(value({ result: await jobs.get(key) })).toMatchObject({ status: 'dispatching' });
        }
        value({ result: await jobs.finish({ ...key, status: 'unknown' }) });
        expect(value({ result: await jobs.get(key) })).toMatchObject({ status: 'unknown' });
        value({ result: await f.services.campaigns.observe({ context: f.owner, state: { campaignId: saved.campaignId, state: 'paused', observedAt: f.clock.now({}), providerReference: 'fixture-readback' } }) });
        value({ result: await jobs.finish({ ...key, status: 'submitted' }) });
        expect(await jobs.finish({ ...key, status: 'submitted' })).toEqual({ ok: true, value: undefined });
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
        value({ result: await f.services.confirmations!.confirm({ context: f.owner, approver: { kind: 'local_token', ownerId: f.owner.scope.ownerId, deviceId: 'fixture-device', tokenId: 'fixture-token-reference' }, response: { cardId: card.cardId, operationId: card.operationId, argumentsDigest: card.argumentsDigest, choice: 'allow' } }) });
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

it('real boot injects direct chart inventory into the catalog as providers enable and disable', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'om-catalog-charts-'));
    let server: BootedServer | undefined;
    try {
        const studioRoot = join(directory, 'studio'); await mkdir(studioRoot);
        await writeFile(join(studioRoot, 'index.html'), '<!doctype html><title>Chart fixture</title>');
        const io = createNodeBootIo({ projectRoot: fileURLToPath(new URL('../../../', import.meta.url)), studioRoot, ready() {} });
        server = value({ result: await bootServer({ env: { OM_STATE_ROOT: join(directory, 'state'), OM_PORT: '0' }, io: { ...io, schedule: () => () => {} },
            clock: { now: () => 1000 }, ids: { next: () => randomUUID() }, observer: { observe() {} } }) });
        const origin = new URL(server.studioUrl).origin;
        const bootstrap = await fetch(server.studioUrl, { redirect: 'manual' });
        const headers = { cookie: bootstrap.headers.get('set-cookie')!.split(';')[0], origin, 'content-type': 'application/json' };
        let sequence = 0;
        const inventory = async () => {
            const response = await fetch(origin + '/api/tools/call', { method: 'POST', headers,
                body: JSON.stringify({ name: 'om_chart_providers_list', input: {}, operationId: 'chart-read-' + ++sequence }) });
            expect(response.status).toBe(200);
            return (await response.json()).value.output;
        };
        expect(await inventory()).toEqual({ providers: [] });
        expect((await fetch(origin + '/api/addons/v1/set-enabled', { method: 'POST', headers,
            body: JSON.stringify({ kind: 'plugin', id: 'charts-recharts', enabled: true }) })).status).toBe(200);
        const http = await (await fetch(origin + '/api/addons/v1/chart-providers', { headers })).json();
        expect(http.value.providers).toHaveLength(1);
        expect(await inventory()).toEqual(http.value);
        expect((await fetch(origin + '/api/addons/v1/set-enabled', { method: 'POST', headers,
            body: JSON.stringify({ kind: 'plugin', id: 'charts-recharts', enabled: false }) })).status).toBe(200);
        expect(await inventory()).toEqual({ providers: [] });
    } finally { await server?.stop({}); await rm(directory, { recursive: true, force: true }); }
});

it('privacy purges a lead through the registered participant and prevents later stage changes', async () => {
    const f = await fixture();
    try {
        const subject = value({ result: await f.identity.contacts.upsert({ context: f.owner, identifiers: [{ kind: 'email', raw: 'lead-erasure@example.test' }] }) });
        const lead = value({ result: await f.forms.leads.capture({ context: f.owner, subjectId: subject.subjectId,
            source: { kind: 'manual', ref: 'erase-lead' }, occurredAt: f.clock.now({}),
            attribution: { campaign: null, touchId: null, touchedAt: null, modelVersion: 'last_paid_touch_30d.v1' } }) });
        const privacy = f.services.privacy!;
        const erasure = value({ result: await privacy.requestErasure({ context: f.owner, subjectId: subject.subjectId }) });
        expect(erasure.participants).toEqual(expect.arrayContaining([expect.objectContaining({ participantId: 'leads' })]));
        value({ result: await privacy.advance({ context: f.owner, requestId: erasure.requestId }) });
        value({ result: await privacy.advance({ context: f.owner, requestId: erasure.requestId }) });
        value({ result: await privacy.advance({ context: f.owner, requestId: erasure.requestId }) });
        expect(await f.forms.leads.get({ context: f.owner, leadId: lead.leadId })).toMatchObject({ ok: true, value: { erased: true, subjectId: null } });
        expect(await f.forms.leads.setStage({ context: f.owner, leadId: lead.leadId, to: 'won', expectedRevision: 1, changeId: 'after-erasure' }))
            .toMatchObject({ ok: false, error: { code: 'forbidden' } });
    } finally { await f.close(); }
});

it('lead tools isolate scope and owner stage CAS appends history without an approval card', async () => {
    const f = await fixture();
    try {
        const leads = f.forms.leads;
        const lead = value({ result: await leads.capture({ context: f.owner, subjectId: 'lead-subject',
            source: { kind: 'manual', ref: 'owner-stage' }, occurredAt: f.clock.now({}),
            attribution: { campaign: null, touchId: null, touchedAt: null, modelVersion: 'last_paid_touch_30d.v1' } }) });
        value({ result: await leads.capture({ context: { ...f.owner, scope: { ...f.owner.scope, workspaceId: 'other-workspace' } },
            subjectId: 'foreign-subject', source: { kind: 'manual', ref: 'foreign' }, occurredAt: f.clock.now({}),
            attribution: lead.attribution }) });
        expect(await f.call({ name: 'om_leads_list', input: { query: { page: { limit: 50 } } } }))
            .toMatchObject({ status: 'completed', output: { items: [{ leadId: lead.leadId }], cursor: null } });
        expect(await f.call({ name: 'om_leads_get', input: { leadId: lead.leadId } })).toMatchObject({ status: 'completed', output: { leadId: lead.leadId } });
        const input = { leadId: lead.leadId, to: 'qualified', expectedRevision: 2, changeId: 'owner-change' };
        expect(await handleOwnerRequest({ context: f.owner, services: f.services, request: { method: 'POST', path: '/api/leads/stage', body: input } }))
            .toMatchObject({ status: 409, body: { ok: false, error: { code: 'conflict' } } });
        expect(await handleOwnerRequest({ context: f.owner, services: f.services, request: { method: 'POST', path: '/api/leads/stage', body: { ...input, expectedRevision: 1 } } }))
            .toMatchObject({ status: 200, body: { ok: true, value: { stage: 'qualified', revision: 2 } } });
        expect(await f.call({ name: 'om_leads_history', input: { leadId: lead.leadId, page: { limit: 50 } } }))
            .toMatchObject({ status: 'completed', output: { items: [{ to: 'new', revision: 1 }, { to: 'qualified', revision: 2, eventId: 'owner-change' }] } });
        expect(await handleOwnerRequest({ context: f.owner, services: { ...f.services, leads: undefined }, request: { method: 'POST', path: '/api/leads/stage', body: input } }))
            .toMatchObject({ status: 503, body: { ok: false, error: { code: 'unavailable' } } });
    } finally { await f.close(); }
});

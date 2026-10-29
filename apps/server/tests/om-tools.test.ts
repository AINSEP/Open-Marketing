/** Written-only A3 contract/security/boot regressions. No vendor requests or credentials. */
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { bindServerDatabase } from '../src/composition/database.js';
import { createSqlToolOperationStore, createMemoryToolOperationStore } from '../src/tool-operations.js';
import type { ToolOperationStore } from '../src/tool-operations.js';
import { createSqlConfirmationExchange } from '@open-marketing/safety';
import type { ConfirmationExchangePort, SafetySqlDatabase } from '@open-marketing/safety';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { parseBoundary, toolDescriptorSchema, toolOperationSchema, toolResultSchema } from '@open-marketing/contracts';
import type { ApprovalResponse, CallContext, Outcome, ToolCall, ToolResult } from '@open-marketing/contracts';
import { createMemoryConfirmationExchange, createMemorySafetyRepo, createMemoryAccountDispatchLock, createMemoryPlatformLimitEvidence, createMemorySpendPolicy, createMemoryVerifiedEffectResolver, createMemorySafetyAudit, createSafetyService, digestArguments } from '@open-marketing/safety';
import { createLeadsService, createMemoryLeadsRepo } from '@open-marketing/leads';
import { createMemoryCampaignRepo } from '@open-marketing/campaigns';
import { buildOmToolDefinitions, createOmTools, discoveryTools, toolInputSchema, toolPolicy } from '../src/om-tools.js';
import type { EffectRequest, PlatformLimitEvidence } from '@open-marketing/safety';
import type { OmFeatureServices, OmToolDefinition } from '../src/om-tools.js';
import { generateOmToolCoverage, ownerRouteDisposition } from '../src/om-tool-coverage.js';
import { handleIntegrationRequest } from '../src/inbound/integrations.js';
import type { Integrations } from '../src/integrations.js';
import { routes } from '../src/cli/http.js';
import { handleOwnerRequest } from '../src/inbound/owner.js';
import { createFrontendSessions } from '../src/inbound/frontend.js';
import type { OwnerServices } from '../src/inbound/owner.js';
import { handleOmRequest } from '../src/inbound/om.js';
import { bootServer } from '../src/composition/index.js';
import { createNodeBootIo } from '../src/composition/serve.js';
import { runOmCli, type CliRuntime } from '../src/cli/index.js';
import { createContactService, createMemoryContactRepo } from '@open-marketing/contacts';
import type { AddonToolDependencies } from '../src/addon-tools.js';
import { removeStateRoot } from './state-root.js';
import { createSqliteChatStore } from '@jini-ai/chat/store/sqlite';
import { createDurableRunStore, createChatRunLedger } from '@jini-ai/chat/store/runtime';
import type { StorageKernel } from '@jini-ai/db/kernel';
import { createAssistantRuns, type AssistantDatabase } from '../src/runs.js';
import { createLocalAgent } from '../src/composition/agent.js';
import { bindCatalogMedia, createCatalogMediaEffects } from '../src/composition/catalog.js';
import { bindMeasurementGrants } from '../src/composition/conversions.js';
import { createAuditService, createMemoryAuditRepo, createMemoryAuditRedactor } from '@open-marketing/audit';
import { createConversations } from '../src/conversations.js';
import { createMediaLibrary, createMemoryJiniDependencies, createMemoryJiniMedia, createMemoryMediaRepo, createMemoryGuardedAssetImport, createMemoryImageTransform, createMemoryMediaAudit } from '@open-marketing/media-library';

const owner: CallContext = { scope: { ownerId: 'owner', workspaceId: 'workspace' }, principal: { kind: 'owner', ownerId: 'owner' }, correlationId: 'correlation', traceId: 'trace' };
const agent: CallContext = { ...owner, runId: 'run', principal: { kind: 'agent', runId: 'run', agentInstanceId: 'instance' } };
function value<T>(required: { result: Outcome<T> }): T {
    if (!required.result.ok) throw new Error(required.result.error.message);
    return required.result.value;
}
function fixture(_required: Record<string, never>) {
    let now = 1000; let sequence = 0; let active = true; let revision = '1'; let enabled = true;
    const clock = { now: () => now }; const ids = { next: () => 'id-' + ++sequence }; const observer = { observe() {} };
    const audit = answerAudit();
    let auditFailure = false;
    const confirmations = createMemoryConfirmationExchange({ clock, ids, async recordAnswer(input) {
        if (auditFailure) return { ok: false, error: { code: 'unavailable', message: 'Fixture approval audit unavailable', retryable: false } };
        return audit.recordAnswer(input);
    } });
    const effects: unknown[] = []; const contexts: CallContext[] = [];
    const schema = z.strictObject({ value: z.number() });
    const definition: { -readonly [Key in keyof OmToolDefinition]: OmToolDefinition[Key] } = { name: 'fixture_write', capability: 'Fixture write', description: 'Save the exact fixture value.',
        effects: ['write'], policy: 'write', revision: '1', inputSchema: toolInputSchema({ schema }),
        parse: input => parseBoundary({ schema, input: input.input }),
        async invoke(input) { effects.push(input.input); contexts.push(input.context); return { ok: true, value: { saved: (input.input as { value: number }).value } }; } };
    const services: OwnerServices & OmFeatureServices = { approver: { kind: 'local_token', ownerId: owner.scope.ownerId, deviceId: 'fixture-device', tokenId: 'fixture-token-reference' }, confirmations, safety: createMemorySafetyRepo({ clock, ids, ownerTimezone: 'UTC' }), campaigns: createMemoryCampaignRepo({}) };
    const tools = createOmTools({ clock, observer, confirmations,
        authorize: input => (active || input.context.principal.kind === 'owner') && input.context.scope.workspaceId === owner.scope.workspaceId && input.context.scope.ownerId === owner.scope.ownerId
            ? { ok: true, value: undefined } : { ok: false, error: { code: 'expired', message: 'Fixture revoked', retryable: false } },
        async definitions() { return { ok: true, value: enabled ? [{ ...definition, revision }] : [] }; } });
    services.tools = tools;
    const grant = { protocolVersion: 1 as const, grantId: 'grant', agentInstanceId: 'instance', scope: owner.scope,
        runId: 'run', conversationId: 'chat', capabilities: ['context', 'events', 'model', 'tools'], expiresAt: 301000, revoked: false, authenticationEpoch: 1000 };
    const grants = { async verify() { return { ok: true as const, value: grant }; } };
    const call: ToolCall = { name: definition.name, input: { value: 7 }, operationId: 'operation' };
    async function answer(input: { choice?: ApprovalResponse['choice']; context?: CallContext } = {}) {
        const card = value({ result: await tools.card({ context: owner, operationId: call.operationId }) });
        if (!card) throw new Error('Expected pending card');
        return handleOwnerRequest({ context: input.context ?? owner, services, request: { method: 'POST', path: '/api/safety/approvals/' + card.cardId + '/answer',
            body: { cardId: card.cardId, operationId: card.operationId, argumentsDigest: card.argumentsDigest, choice: input.choice ?? 'allow' } } });
    }
    return { tools, call, services, grants, grant, effects, contexts, clock, ids, observer, answer, answers: audit.answers,
        setAuditFailure(input: { fail: boolean }) { auditFailure = input.fail; },
        advance() { now = 301001; }, async revoke() { active = false; await tools.cancel({ context: owner, runId: 'run' }); }, endRun() { active = false; },
        replace() { revision = '2'; }, remove() { enabled = false; }, definition };
}

it('exposes tracking setup/readiness as schema-bound read tools through owner HTTP', async () => {
    const f = fixture({});
    const source = 'fixture installer text';
    const tracking: NonNullable<OmFeatureServices['tracking']> = {
        snippet: vi.fn(async () => ({ ok: true as const, value: { source, campaignUrlTemplates: [], consentBanner: { head: '', body: '' } } })),
        readiness: vi.fn(async () => ({ ok: true as const, value: { status: 'missing' as const, heartbeatAt: null, fallbackUrl: null } })),
    };
    const services = { ...f.services, tracking };
    const definitions = value({ result: await buildOmToolDefinitions({ context: owner, services }) });
    const tools = createOmTools({ ...f, confirmations: services.confirmations, authorize: () => ({ ok: true, value: undefined }), async definitions() { return { ok: true, value: definitions }; } });
    services.tools = tools;
    try {
        const snippet = definitions.find(tool => tool.name === 'om_web_events_snippet')!;
        expect(snippet.policy).toBe('read');
        expect(snippet.effects).toEqual(['read']);
        expect(snippet.parse({ input: {} }).ok).toBe(false);
        expect(snippet.parse({ input: { destinationUrl: 'https://site.example', connection: { connectionId: 'caller' } } }).ok).toBe(false);
        expect(snippet.parse({ input: { destinationUrl: 'https://site.example', campaignKeys: Array(3).fill({ pluginId: 'fixture', accountId: 'a', vendorCampaignId: 'c' }) } }).ok).toBe(false);
        const response = await handleOwnerRequest({ context: owner, services, request: { method: 'POST', path: '/api/tools/call',
            body: { name: snippet.name, input: { destinationUrl: 'https://site.example' }, operationId: 'tracking-http' } } });
        expect(response).toMatchObject({ status: 200, body: { ok: true, value: { status: 'completed', output: { source, campaignUrlTemplates: [] } } } });
        expect(await tools.dispatch({ context: owner, call: { name: 'om_tracking_readiness', input: { destinationUrl: 'https://site.example', fallbackSlug: 'lead' }, operationId: 'tracking-readiness' } }))
            .toMatchObject({ ok: true, value: { status: 'completed', output: { status: 'missing', heartbeatAt: null, fallbackUrl: null } } });
        expect(generateOmToolCoverage({ definitions }).find(row => row.tool === snippet.name)).toMatchObject({ studio: 'Measure setup and chat via execute_tool', cli: 'om tools list/show/call' });
    } finally { await tools.dispose({}); await f.tools.dispose({}); }
});

it('discovers the three experiment calculators as read tools and sizes through dispatch without a card', async () => {
    const f = fixture({});
    const definitions = value({ result: await buildOmToolDefinitions({ context: agent, services: f.services }) });
    const names = ['om_measure_experiment_sample_size', 'om_measure_experiment_readout', 'om_measure_creative_fatigue'];
    const tools = createOmTools({ ...f, confirmations: f.services.confirmations, authorize: () => ({ ok: true, value: undefined }),
        definitions: input => buildOmToolDefinitions({ ...input, services: f.services }) });
    try {
        expect(definitions.filter(tool => names.includes(tool.name)).map(tool => ({ name: tool.name, policy: tool.policy, effects: tool.effects })))
            .toEqual(names.map(name => ({ name, policy: 'read', effects: ['read'] })));
        expect(await tools.dispatch({ context: agent, call: { name: names[0], input: { baseline: 0.1, absoluteLift: 0.02 }, operationId: 'experiment-size' } }))
            .toMatchObject({ ok: true, value: { status: 'completed', output: { status: 'sized', sampleSizePerArm: 3841 } } });
        expect(await tools.card({ context: owner, operationId: 'experiment-size' })).toEqual({ ok: true, value: null });
        expect(f.answers).toEqual([]);
    } finally { await tools.dispose({}); await f.tools.dispose({}); }
});

it('owner list tools match HTTP campaign rows and pending cards', async () => {
    const f = fixture({});
    try {
        const saved = value({ result: await f.services.campaigns.save({ context: owner, draft: {
            operationId: 'campaign', connectionId: 'connection', accountId: 'account', name: 'Local campaign', objective: 'signups',
            creativeIds: ['creative'], creativeDigest: 'c'.repeat(64), placements: ['search'],
        } }) });
        expect(await f.tools.dispatch({ context: agent, call: f.call })).toMatchObject({ value: { status: 'pending' } });
        const card = value({ result: await f.tools.card({ context: owner, operationId: f.call.operationId }) })!;
        const definitions = value({ result: await buildOmToolDefinitions({ context: agent, services: f.services }) });
        for (const [name, path, items] of [
            ['om_campaigns_list', '/api/campaigns', [{ id: saved.campaignId, title: 'Local campaign', detail: 'signups', status: 'unknown' }]],
            ['om_approvals_list', '/api/safety/approvals', [{ cardId: card.cardId }]],
        ] as const) {
            const output = value({ result: await definitions.find(tool => tool.name === name)!.invoke({ context: agent, input: { limit: 1 } }) });
            const http = await handleOwnerRequest({ context: owner, services: f.services, request: { method: 'GET', path, query: { limit: '1' } } });
            expect(http.status).toBe(200);
            expect(http.body).toEqual({ ok: true, value: output });
            expect(output).toMatchObject({ items, cursor: null });
        }
    } finally { await f.tools.dispose({}); }
});

it('approval audit failure prevents tool continuation and preserves a pending card for retry', async () => {
    const f = fixture({});
    try {
        expect(await f.tools.dispatch({ context: agent, call: f.call })).toMatchObject({ ok: true, value: { status: 'pending' } });
        f.setAuditFailure({ fail: true });
        expect(await f.answer()).toMatchObject({ status: 503, body: { ok: false, error: { code: 'unavailable' } } });
        expect(f.effects).toEqual([]);
        expect(f.answers).toEqual([]);
        expect(await f.tools.operation({ context: owner, operationId: f.call.operationId })).toMatchObject({ ok: true, value: { status: 'pending' } });
        f.setAuditFailure({ fail: false });
        expect((await f.answer()).status).toBe(200);
        expect(f.effects).toEqual([{ value: 7 }]);
        expect(f.answers).toHaveLength(1);
    } finally { await f.tools.dispose({}); }
});

it('tool continuation uses the same response and identity snapshot as the pending audit', async () => {
    const f = fixture({});
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const evidence: unknown[] = [];
    const confirmations = createMemoryConfirmationExchange({ ...f, async recordAnswer(input) {
        evidence.push(structuredClone(input.answer)); entered.resolve(); await release.promise;
        return { ok: true, value: undefined };
    } });
    const tools = createOmTools({ ...f, confirmations, definitions: async () => ({ ok: true, value: [f.definition] }), authorize: () => ({ ok: true, value: undefined }) });
    try {
        value({ result: await tools.dispatch({ context: agent, call: f.call }) });
        const card = value({ result: await tools.card({ context: owner, operationId: f.call.operationId }) })!;
        const response: ApprovalResponse = { cardId: card.cardId, operationId: card.operationId, argumentsDigest: card.argumentsDigest, choice: 'allow' };
        const approver = { kind: 'local_token' as const, ownerId: owner.scope.ownerId, deviceId: 'device', tokenId: 'reference' };
        const expected = structuredClone({ response, approver, answeredAt: 1000 });
        const answering = tools.answer({ context: owner, response, approver });
        await entered.promise;
        response.choice = 'cancel'; approver.ownerId = 'mutated';
        release.resolve();
        expect(await answering).toEqual({ ok: true, value: undefined });
        expect(evidence).toEqual([expected]);
        expect(f.effects).toEqual([{ value: 7 }]);
    } finally { release.resolve(); await tools.dispose({}); await f.tools.dispose({}); }
});

/** Existing SQLite history and public media doubles behind the production catalog/dispatcher. */
function at1Fixture() {
    const f = fixture({});
    const native = new Database(':memory:');
    native.exec(readFileSync(new URL('../migrations/0001_assistant.sql', import.meta.url), 'utf8'));
    const database = bindServerDatabase({ native, context: owner, observer: f.observer });
    const kernel = database.kernel as unknown as StorageKernel<AssistantDatabase>;
    const conversations = createConversations({ ...f, kernel: database.kernel, db: { query: input => database.unit.transaction({ work: ({ session }) => session.query(input) }) },
        stores: ({ scope }) => createSqliteChatStore({ kernel, scope }, { clock: { nowMs: () => 1000 } }), integrations: addonFixture().integrations });
    const persistence = createAssistantRuns({ ...f, kernel, conversations, media: { readImage: async () => ({ ok: false as const, error: { code: 'unavailable' as const, message: 'unused', retryable: false } }) },
        durable: createDurableRunStore({ kernel, isDaemonRunId: () => true }), ledger: createChatRunLedger({ kernel, isDaemonRunId: () => true }) });
    const dependencies = createMemoryJiniDependencies(f);
    const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQx8AAAAASUVORK5CYII=', 'base64');
    const sourceUrl = 'https://fixture.example.test/image.png';
    const repo = createMemoryMediaRepo({ scope: owner.scope });
    const media = createMediaLibrary({ ...f, repo, media: createMemoryJiniMedia({ scope: owner.scope, dependencies }),
        audit: createMemoryMediaAudit({ scope: owner.scope }),
        importer: createMemoryGuardedAssetImport({ scope: owner.scope, dependencies, fixtures: [{ sourceUrl, bytes, image: { width: 1, height: 1, frames: 1 } }] }),
        transforms: createMemoryImageTransform({ scope: owner.scope, dependencies }) });
    const services: OwnerServices & OmFeatureServices = { ...f.services, conversations, media,
        async handleChartRequest() { return { status: 200, body: { ok: true, value: { providers: [] } } }; } };
    const tools = createOmTools({ ...f, confirmations: f.services.confirmations, authorize: () => ({ ok: true, value: undefined }),
        // The chart-provider inventory is an injected dependency; without it the tool fails closed as unavailable.
        definitions: input => buildOmToolDefinitions({ ...input, services, chartProviders: async () => ({ ok: true, value: { providers: [] } }) }) });
    const provenance = { operationId: 'import', source: 'upload', prompt: null, model: null, seed: null, cost: null, vendorTerms: null,
        rights: { evidenceId: 'rights', license: 'owned', permittedUses: ['advertising'] } };
    const request = { sourceUrl, operationId: 'import', expectedDigest: createHash('sha256').update(bytes).digest('hex'), provenance };
    const call = (input: { name: string; input: ToolCall['input']; operationId?: string; context?: CallContext }) => tools.dispatch({ context: input.context ?? agent,
        call: { name: input.name, input: input.input, operationId: input.operationId ?? input.name } });
    /** Reuse the existing exact-card continuation; assert the service result after owner approval. */
    async function approve(input: { name: string; input: ToolCall['input']; context?: CallContext }) {
        expect(await call(input)).toMatchObject({ value: { status: 'pending' } });
        const card = value({ result: await tools.card({ context: owner, operationId: input.name }) })!;
        expect(card.arguments).toEqual({ tool: input.name, input: input.input });
        await tools.answer({ context: owner, approver: { kind: 'local_token', ownerId: owner.scope.ownerId, deviceId: 'fixture-device', tokenId: 'fixture-token-reference' }, response: { cardId: card.cardId, operationId: card.operationId, argumentsDigest: card.argumentsDigest, choice: 'allow' } });
        return value({ result: await tools.operation({ context: owner, operationId: input.name }) });
    }
    return { ...f, services, tools, conversations, persistence, native, repo, request, call, approve, async close() { await tools.dispose({}); await f.tools.dispose({}); native.close(); } };
}

it('routes all ten AT1 capabilities through existing service results and one write card', async () => {
    const f = at1Fixture(); const cancelRun = vi.fn(async ({ runId }: { runId: string }) => ({ ok: true as const, value: { runId, status: 'cancelled' as const } }));
    f.services.runs = { async start() { throw new Error('Recursive run creation'); }, cancel: cancelRun,
        async events({ runId }) { return { ok: true, value: { runId, status: 'completed', events: [] } }; } };
    try {
        expect(await f.call({ name: 'om_conversations_list', input: { limit: 10 } })).toMatchObject({ value: { status: 'completed', output: { items: [] } } });
        expect((await f.conversations.list({ context: owner, query: { limit: 10 } })).ok).toBe(true);
        expect(await f.approve({ name: 'om_conversations_create', input: {} })).toMatchObject({ status: 'completed', output: { title: 'New chat' } });
        const conversation = value({ result: await f.conversations.list({ context: owner, query: { limit: 10 } }) }).items[0];
        expect(await f.call({ name: 'om_conversations_get', input: { id: conversation.conversationId, limit: 1 } })).toMatchObject({ value: { output: { conversation, messages: [] } } });
        expect(await f.call({ name: 'om_runs_events', input: { runId: 'other', after: 0 } })).toMatchObject({ value: { output: { runId: 'other', events: [] } } });
        expect(await f.call({ name: 'om_chart_providers_list', input: {} })).toMatchObject({ value: { output: { providers: [] } } });
        expect(await f.call({ name: 'om_media_list', input: { limit: 5 } })).toMatchObject({ value: { output: { items: [], cursor: null } } });
        expect(value({ result: await f.tools.describe({ context: agent, name: 'om_media_import' }) }).inputSchema).toMatchObject({ additionalProperties: false, properties: { request: { additionalProperties: false, properties: { sourceUrl: { maxLength: 2048 }, provenance: { additionalProperties: false } } } } });
        expect(await f.approve({ name: 'om_media_import', input: { request: f.request } })).toMatchObject({ status: 'completed', output: { provenance: f.request.provenance } });
        const assets = value({ result: await f.services.media!.list({ context: owner, query: { limit: 5 } }) });
        expect(assets.items).toHaveLength(1);
        const assetId = assets.items[0].record.id;
        expect(await f.approve({ name: 'om_media_crop', input: { request: { assetId, placement: 'ad-square', presetVersion: 1 } } })).toMatchObject({ status: 'completed', output: { assetId } });
        expect(await f.approve({ name: 'om_media_record_provenance', input: { link: { provenance: f.request.provenance, assetId } } })).toMatchObject({ status: 'completed', output: { recorded: true, operationId: 'import' } });
        // The import already linked this operation to the asset, so recording the identical link is idempotent: one link, no duplicate root row.
        expect(value({ result: await f.repo.evidence({ context: owner, operationId: 'import' }) }).provenance).toHaveLength(1);
        expect(cancelRun).not.toHaveBeenCalled();
        expect(await f.approve({ name: 'om_runs_cancel', input: { runId: 'other' } })).toMatchObject({ status: 'completed', output: { runId: 'other', status: 'cancelled' } });
        expect(cancelRun).toHaveBeenCalledWith({ context: { ...agent, principal: owner.principal }, runId: 'other' });
        expect(await f.call({ name: 'om_media_import', operationId: 'import-replay', input: { request: f.request } })).toMatchObject({ value: { status: 'pending' } });
    } finally { await f.close(); }
});

it('rejects foreign history, malformed media inputs and oversized history without exposing it', async () => {
    const f = at1Fixture();
    const importAsset = vi.fn(f.services.media!.importAsset); f.services.media!.importAsset = importAsset;
    try {
        const conversation = value({ result: await f.conversations.create({ context: owner }) });
        const foreign = { ...agent, scope: { ...owner.scope, workspaceId: 'foreign' } };
        expect(await f.call({ context: foreign, name: 'om_conversations_get', input: { id: conversation.conversationId, limit: 1 } })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
        expect(await f.call({ name: 'om_media_import', input: { request: { ...f.request, sourceUrl: 'invalid' } } })).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
        expect(await f.call({ name: 'om_media_import', input: { request: { ...f.request, operationId: 'different' } } })).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
        expect(importAsset).not.toHaveBeenCalled();
        expect(await f.call({ name: 'om_runs_events', input: { runId: 'run', after: -1 } })).toMatchObject({ ok: false });
        await f.conversations.store({ context: owner }).appendMessage({ conversationId: conversation.conversationId, message: { id: 'large', role: 'user', content: 'x'.repeat(65000), createdAt: 1000 } });
        expect(await f.call({ name: 'om_conversations_get', input: { id: conversation.conversationId, limit: 1 } })).toMatchObject({ ok: false });
        expect(value({ result: await f.services.confirmations.list({ context: owner, query: { limit: 100 } }) }).items).toEqual([]);
    } finally { await f.close(); }
});

it('bounds event prefixes without skipping oversized events', async () => {
    const f = at1Fixture();
    const events = Array.from({ length: 3 }, (_, index) => ({ protocolVersion: 1 as const, eventId: 'event-' + index, runId: 'run', sequence: index + 1,
        kind: 'delta' as const, correlationId: 'correlation', traceId: 'trace', payload: { text: 'x'.repeat(30000) } }));
    f.services.runs = { async start() { throw new Error('Recursive run creation'); }, async cancel() { throw new Error('Read fixture'); },
        async events({ after }) { return { ok: true, value: { runId: 'run', status: 'completed', events: events.filter(event => event.sequence > after) } }; } };
    try {
        const result = await f.call({ name: 'om_runs_events', input: { runId: 'run', after: 0 } });
        expect(result).toMatchObject({ value: { output: { status: 'running', events: [events[0]] } } });
        expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(65536);
        expect(await f.call({ name: 'om_runs_events', operationId: 'next', input: { runId: 'run', after: 1 } })).toMatchObject({ value: { output: { events: [events[1]] } } });
        events[0].payload.text = 'x'.repeat(61000);
        expect(await f.call({ name: 'om_runs_events', operationId: 'oversized', input: { runId: 'run', after: 0 } })).toMatchObject({ ok: false, error: { code: 'limit_exceeded' } });
    } finally { await f.close(); }
});

it('self-cancellation persists the controller event even when its tool cannot complete', async () => {
    const f = at1Fixture(); let accepted: import('@open-marketing/contracts').StartRunRequest | undefined;
    const local = createLocalAgent({ ...f, persistence: f.persistence, randomToken: () => 'fixture-token'.padEnd(64, 'x'),
        onRevoked: input => f.tools.cancel(input), effects: {
            async launch() { return { ok: true, value: { origin: 'http://127.0.0.1:31000', pid: 1, async stop() { return { ok: true, value: undefined }; } } }; },
            runtime: { ids: f.ids, env: {}, deadline: { create: () => ({ signal: new AbortController().signal, dispose() {} }) },
                async fetch(url, options) {
                    const path = new URL(String(url)).pathname;
                    if (path.endsWith('/health')) return Response.json({ ok: true, value: { protocolVersion: 1, ready: true, runtime: 'available' } });
                    if (path.endsWith('/cancel')) return Response.json({ ok: true, value: { runId: path.split('/')[4], status: 'cancelled' } });
                    accepted = JSON.parse(String(options?.body)) as typeof accepted;
                    return Response.json({ ok: true, value: { runId: accepted!.runId, status: 'pending' } });
                } },
        } });
    f.services.runs = local.owner;
    try {
        value({ result: await local.start({ serverUrl: 'http://127.0.0.1:32000' }) });
        const { runId } = value({ result: await local.owner.start({ context: owner, prompt: 'Cancellation fixture' }) });
        const started = { protocolVersion: 1 as const, eventId: 'started', runId, sequence: 1, kind: 'started' as const,
            correlationId: owner.correlationId, traceId: owner.traceId, payload: {} };
        value({ result: await local.callbacks.record({ grant: accepted!.grant, event: started }) });
        expect(await f.approve({ context: accepted!.context, name: 'om_runs_cancel', input: { runId } })).toMatchObject({ status: 'unknown', error: { code: 'cancelled', retryable: false } });
        const tail = value({ result: await f.persistence.events({ context: owner, runId, after: 1 }) });
        expect(tail).toMatchObject({ status: 'cancelled', events: [{ runId, sequence: 2, kind: 'cancelled', payload: {}, correlationId: owner.correlationId, traceId: owner.traceId }] });
        const stored = f.native.prepare('SELECT event_json FROM om_assistant_events WHERE run_id=? AND sequence=2').get(runId) as { event_json: string };
        expect(JSON.parse(stored.event_json)).toEqual(tail.events[0]);
        expect(await f.persistence.record({ context: owner, event: { ...started, eventId: 'late', sequence: 3, kind: 'ended' } })).toMatchObject({ ok: false, error: { code: 'expired' } });
    } finally { await local.stop({}); await f.close(); }
});

it('reserves complete result envelope headroom at the 64-KiB output boundary', async () => {
    const f = fixture({});
    let output = '"'.repeat(32255); // Serialized payload is exactly 64,512 bytes, before wrappers.
    f.definition.effects = ['read']; f.definition.policy = 'read';
    f.definition.invoke = async () => ({ ok: true, value: output });
    try {
        expect(await f.tools.dispatch({ context: agent, call: f.call })).toEqual({ ok: true, value: { status: 'completed', output } });
        output += '"';
        expect(await f.tools.dispatch({ context: agent, call: { ...f.call, operationId: 'over-bound' } })).toMatchObject({ ok: false });
    } finally { await f.tools.dispose({}); }
});

it('binds durable canonical media, crop cache and evidence through all four catalog tools', async () => {
    const f = at1Fixture(); const directory = await fs.mkdtemp(join(tmpdir(), 'om-at1-media-'));
    f.native.exec(readFileSync(new URL('../../../features/media-library/migrations/0001_media_evidence.sql', import.meta.url), 'utf8'));
    f.native.exec(readFileSync(new URL('../migrations/0004_media.sql', import.meta.url), 'utf8'));
    const database = bindServerDatabase({ native: f.native, context: owner, observer: f.observer });
    const db = { query: <Row extends Record<string, unknown>>(input: { text: string; values?: unknown[] }) => database.unit.transaction({ work: ({ session }) => session.query<Row>(input) }) };
    const audit = createAuditService({ ...f, repo: createMemoryAuditRepo(f), redactor: createMemoryAuditRedactor({}) });
    const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQx8AAAAASUVORK5CYII=', 'base64');
    const cropped = Buffer.from('fixture-codec-webp-output');
    const send = vi.fn(async () => ({ status: 200, headers: {}, bodyText: '', bodyBytes: bytes, finalUrl: f.request.sourceUrl }));
    const transform = vi.fn(async (_input: { bytes: Uint8Array; params: unknown }) => ({ bytes: cropped, contentType: 'image/webp' }));
    const nativeEffects = createCatalogMediaEffects({ stateRoot: directory, clock: f.clock });
    const effects = { ...nativeEffects, httpClient: { send }, outboundGuard: { send }, imageTransformer: { transform },
        // The injected fixture codec proves binding/geometry checks, not real pixel decoding.
        async decode(input: { bytes: Uint8Array }) { return Buffer.from(input.bytes).equals(cropped) ? { width: 1080, height: 1080, frames: 1 } : { width: 1, height: 1, frames: 1 }; } };
    const bind = () => bindCatalogMedia({ ...f, db, context: owner, audit, effects });
    f.services.media = bind();
    try {
        const definitions = value({ result: await buildOmToolDefinitions({ context: owner, services: f.services }) });
        expect(generateOmToolCoverage({ definitions }).filter(row => row.needs === 'MEDIA_DEPENDENCY_COMPOSITION')).toEqual([]);
        expect(await f.approve({ name: 'om_media_import', input: { request: f.request } })).toMatchObject({ status: 'completed', output: { provenance: f.request.provenance } });
        const asset = value({ result: await f.services.media.list({ context: owner, query: { limit: 5 } }) }).items[0];
        expect(asset.record).toMatchObject({ kind: 'media', originalFilename: null });
        expect(JSON.parse((f.native.prepare("SELECT payload FROM server_media_record WHERE kind='media'").get() as { payload: string }).payload))
            .toMatchObject({ kind: 'media', originalFilename: null });
        const request = { assetId: asset.record.id, placement: 'ad-square', presetVersion: 1 };
        expect(await f.approve({ name: 'om_media_crop', input: { request } })).toMatchObject({ status: 'completed', output: { assetId: asset.record.id } });
        expect(transform).toHaveBeenCalledWith({ bytes: expect.any(Uint8Array), params: { width: 1080, height: 1080, fit: 'cover', format: 'webp' } });
        expect(Buffer.from(transform.mock.calls[0][0].bytes)).toEqual(bytes);
        expect(await f.approve({ name: 'om_media_record_provenance', input: { link: { assetId: asset.record.id, provenance: f.request.provenance } } })).toMatchObject({ status: 'completed', output: { recorded: true } });
        expect(f.native.prepare("SELECT COUNT(*) AS count FROM server_media_record WHERE kind='media'").get()).toEqual({ count: 1 });
        expect(f.native.prepare('SELECT COUNT(*) AS count FROM om_media_evidence').get()).toEqual({ count: 3 });
        f.services.media = bindCatalogMedia({ ...f, db, context: owner, audit,
            effects: { ...effects, blobStore: createCatalogMediaEffects({ stateRoot: directory, clock: f.clock }).blobStore } });
        expect(await f.call({ name: 'om_media_list', input: { limit: 5 } })).toMatchObject({ value: { output: { items: [asset] } } });
        expect(await f.services.media.importAsset({ context: owner, request: f.request })).toMatchObject({ ok: true, value: { record: asset.record } });
        expect(await f.services.media.createCrop({ context: owner, request })).toMatchObject({ ok: true, value: { assetId: asset.record.id } });
        expect(send).toHaveBeenCalledTimes(1); expect(transform).toHaveBeenCalledTimes(1);
        expect(Buffer.from(await effects.blobStore.get({ storageKey: asset.blob.storageKey }))).toEqual(bytes);
        const foreign = { ...owner, scope: { ...owner.scope, workspaceId: 'foreign' } };
        expect(await f.services.media.list({ context: foreign, query: { limit: 5 } })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
        const definition = f.native.prepare("SELECT owner_id,workspace_id,record_key,payload FROM server_media_record WHERE kind='transform'").get() as { owner_id: string; workspace_id: string; record_key: string; payload: string };
        expect(() => f.native.prepare("UPDATE server_media_record SET payload=? WHERE kind='transform'").run(definition.payload)).toThrow();
        expect(() => f.native.prepare("DELETE FROM server_media_record WHERE kind='transform'").run()).toThrow();
    } finally { await f.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

it('uses guarded production ingress to reject a private destination before canonical storage', async () => {
    const f = at1Fixture(); const directory = await fs.mkdtemp(join(tmpdir(), 'om-at1-guard-'));
    f.native.exec(readFileSync(new URL('../../../features/media-library/migrations/0001_media_evidence.sql', import.meta.url), 'utf8'));
    f.native.exec(readFileSync(new URL('../migrations/0004_media.sql', import.meta.url), 'utf8'));
    const database = bindServerDatabase({ native: f.native, context: owner, observer: f.observer });
    const db = { query: <Row extends Record<string, unknown>>(input: { text: string; values?: unknown[] }) => database.unit.transaction({ work: ({ session }) => session.query<Row>(input) }) };
    const audit = createAuditService({ ...f, repo: createMemoryAuditRepo(f), redactor: createMemoryAuditRedactor({}) });
    f.services.media = bindCatalogMedia({ ...f, db, context: owner, audit, effects: createCatalogMediaEffects({ stateRoot: directory, clock: f.clock }) });
    try {
        expect(await f.services.media.importAsset({ context: owner, request: { ...f.request, sourceUrl: 'https://127.0.0.1/image.png' } })).toMatchObject({ ok: false });
        expect(await f.services.media.list({ context: owner, query: { limit: 5 } })).toEqual({ ok: true, value: { items: [], cursor: null } });
        expect(f.native.prepare('SELECT COUNT(*) AS count FROM server_media_record').get()).toEqual({ count: 0 });
        expect(await fs.readdir(directory)).toEqual([]);
    } finally { await f.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

for (const surface of ['direct', 'owner-http', 'mcp'] as const) describe('one OM dispatcher / ' + surface, () => {
    it('freezes reviewed arguments, waits for an owner card and returns the actual output without replay', async () => {
        const f = fixture({});
        const context = surface === 'owner-http' ? owner : agent;
        async function dispatch(input: { call: ToolCall }): Promise<Outcome<ToolResult>> {
            if (surface === 'direct') return f.tools.dispatch({ context, ...input });
            if (surface === 'owner-http') return (await handleOwnerRequest({ context, services: f.services,
                request: { method: 'POST', path: '/api/tools/call', body: input.call } })).body as Outcome<ToolResult>;
            const response = await handleOmRequest({ grants: f.grants, clock: f.clock, tools: f.tools,
                request: { method: 'POST', path: '/api/agent/v1/mcp', body: { jsonrpc: '2.0', id: 'rpc', method: 'tools/call',
                    params: { name: 'execute_tool', arguments: input.call } } } });
            expect(response.status).toBe(200);
            const rpc = response.body as { result: { content: { text: string }[] } };
            return JSON.parse(rpc.result.content[0].text) as Outcome<ToolResult>;
        }
        const result = value({ result: await dispatch({ call: f.call }) });
        expect(toolResultSchema.safeParse(result).success).toBe(true);
        expect(result.status).toBe('pending'); expect(f.effects).toEqual([]);
        const card = value({ result: await f.tools.card({ context, operationId: f.call.operationId }) });
        expect(card?.arguments).toEqual({ tool: 'fixture_write', input: { value: 7 } });
        const original = structuredClone(f.call);
        (f.call.input as { value: number }).value = 999;
        expect((await f.answer()).status).toBe(200);
        expect(f.effects).toEqual([{ value: 7 }]); expect(f.contexts[0].principal).toEqual(owner.principal);
        expect(await dispatch({ call: original })).toEqual({ ok: true, value: { status: 'completed', output: { saved: 7 } } });
        expect(f.effects).toHaveLength(1);
        expect(await dispatch({ call: f.call })).toMatchObject({ ok: false, error: { code: 'conflict' } });
        await f.tools.dispose({});
    });
});

it('serializes simultaneous duplicate identities and rejects cross-run/scope reads and answers', async () => {
    const f = fixture({});
    await Promise.all([f.tools.dispatch({ context: agent, call: f.call }), f.tools.dispatch({ context: agent, call: f.call })]);
    expect(value({ result: await f.services.confirmations.list({ context: owner, query: { limit: 100 } }) }).items).toHaveLength(1);
    expect(await f.tools.operation({ context: { ...agent, runId: 'other' }, operationId: f.call.operationId })).toMatchObject({ ok: false });
    const foreign = { ...owner, scope: { ...owner.scope, workspaceId: 'other' } };
    expect(await f.tools.operation({ context: foreign, operationId: f.call.operationId })).toMatchObject({ ok: false });
    expect((await f.answer({ context: foreign })).status).toBeGreaterThanOrEqual(400);
    expect(f.effects).toEqual([]); await f.tools.dispose({});
});

it('cancellation and expiry void cards before a late owner answer can execute', async () => {
    for (const interruption of ['cancel', 'expiry'] as const) {
        const f = fixture({}); value({ result: await f.tools.dispatch({ context: agent, call: f.call }) });
        const card = value({ result: await f.tools.card({ context: agent, operationId: f.call.operationId }) })!;
        if (interruption === 'cancel') await f.revoke(); else f.advance();
        const result = await f.tools.answer({ context: owner, approver: { kind: 'local_token', ownerId: owner.scope.ownerId, deviceId: 'fixture-device', tokenId: 'fixture-token-reference' }, response: { cardId: card.cardId, operationId: card.operationId, argumentsDigest: card.argumentsDigest, choice: 'allow' } });
        expect(result.ok).toBe(false); expect(f.effects).toEqual([]);
        expect(value({ result: await f.services.confirmations.list({ context: owner, query: { limit: 100 } }) }).items).toEqual([]);
        await f.tools.dispose({});
    }
});

it('requires fresh approval after a source revision changes or disappears', async () => {
    for (const change of ['replace', 'remove'] as const) {
        const f = fixture({}); value({ result: await f.tools.dispatch({ context: agent, call: f.call }) });
        f[change](); expect((await f.answer()).status).toBe(409); expect(f.effects).toEqual([]);
        expect(value({ result: await f.tools.operation({ context: agent, operationId: f.call.operationId }) }).status).toBe('interrupted');
        await f.tools.dispose({});
    }
});

it('denied cards and thrown outcomes cannot become completed or be blindly retried', async () => {
    const denied = fixture({}); value({ result: await denied.tools.dispatch({ context: agent, call: denied.call }) });
    expect((await denied.answer({ choice: 'cancel' })).status).toBe(200);
    expect(value({ result: await denied.tools.operation({ context: agent, operationId: denied.call.operationId }) }).status).toBe('cancelled');
    expect(denied.effects).toEqual([]); await denied.tools.dispose({});
    const f = fixture({}); f.definition.invoke = async () => { f.effects.push('entered'); throw new Error('Opaque fixture failure'); };
    value({ result: await f.tools.dispatch({ context: agent, call: f.call }) }); await f.answer();
    expect(value({ result: await f.tools.operation({ context: agent, operationId: f.call.operationId }) }).status).toBe('unknown');
    expect((await f.tools.dispatch({ context: agent, call: f.call })).ok).toBe(false); expect(f.effects).toEqual(['entered']); await f.tools.dispose({});
});

for (const interruption of ['cancel', 'revoked'] as const) it('retains an in-flight unknown write after ' + interruption + ' without replaying it', async () => {
    const f = fixture({});
    let entered!: () => void;
    let finish!: (result: Outcome<unknown>) => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const completion = new Promise<Outcome<unknown>>(resolve => { finish = resolve; });
    f.definition.invoke = async input => { f.effects.push(input.input); entered(); return completion; };
    try {
        value({ result: await f.tools.dispatch({ context: agent, call: f.call }) });
        const answering = f.answer();
        await started;
        if (interruption === 'cancel') await f.tools.cancel({ context: owner, runId: agent.runId! });
        else f.endRun();
        // A fresh owner dispatch runs cleanup while the first non-idempotent write is in flight.
        value({ result: await f.tools.dispatch({ context: owner, call: { ...f.call, operationId: 'later' } }) });
        const response = await handleOwnerRequest({ context: owner, services: f.services,
            request: { method: 'GET', path: '/api/tools/operations/' + f.call.operationId } });
        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({ ok: true, value: { status: 'unknown', operationId: f.call.operationId, error: { retryable: false } } });
        expect(toolOperationSchema.safeParse(value({ result: await f.tools.operation({ context: owner, operationId: f.call.operationId }) })).success).toBe(true);
        finish({ ok: true, value: { saved: 7 } });
        await answering;
        expect(value({ result: await f.tools.operation({ context: owner, operationId: f.call.operationId }) }).status).toBe('unknown');
        expect(await f.tools.dispatch({ context: owner, call: f.call })).toMatchObject({ ok: false, error: { retryable: false } });
        expect(f.effects).toEqual([{ value: 7 }]);
        expect(value({ result: await f.tools.card({ context: owner, operationId: f.call.operationId }) })).toBeNull();
    } finally { finish({ ok: false, error: { code: 'cancelled', message: 'Fixture cleanup', retryable: false } }); await f.tools.dispose({}); }
});

it('keeps failed or invalid write results unknown and non-retryable', async () => {
    const outcomes: Outcome<unknown>[] = [
        { ok: false, error: { code: 'unavailable', message: 'Transport disconnected after dispatch', retryable: true } },
        { ok: true, value: { invalid: undefined } },
    ];
    for (const outcome of outcomes) {
        const f = fixture({});
        f.definition.invoke = async input => { f.effects.push(input.input); return outcome; };
        try {
            value({ result: await f.tools.dispatch({ context: agent, call: f.call }) });
            await f.answer();
            expect(value({ result: await f.tools.operation({ context: owner, operationId: f.call.operationId }) })).toMatchObject({ status: 'unknown', error: { retryable: false } });
            expect(await f.tools.dispatch({ context: owner, call: f.call })).toMatchObject({ ok: false, error: { retryable: false } });
            expect(f.effects).toEqual([{ value: 7 }]);
        } finally { await f.tools.dispose({}); }
    }
});

it('validates generated input schemas and preserves their input defaults and constraints', () => {
    const inputSchema = toolInputSchema({ schema: z.strictObject({ limit: z.number().int().min(1).max(100).default(25) }) });
    expect(inputSchema).toMatchObject({ type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 } } });
    expect(inputSchema.required).toBeUndefined();
    expect(() => toolInputSchema({ schema: z.string().describe('x'.repeat(65537)) })).toThrow(z.ZodError);
});

it('classifies unknown declarations as write and fails closed without financial or typed bindings', async () => {
    expect(toolPolicy({ effects: [] })).toBe('write'); expect(toolPolicy({ effects: ['read', 'unknown'] })).toBe('write');
    expect(toolPolicy({ effects: ['unknown', 'ad_spend'] })).toBe('spend');
    expect(toolPolicy({ effects: ['read', 'destructive'] })).toBe('destructive');
    for (const effect of ['ad_spend', 'generation', 'conversion', 'halt_stop'] as const) {
        const f = fixture({}); f.definition.effects = [effect];
        expect(await f.tools.dispatch({ context: agent, call: f.call })).toMatchObject({ ok: false, error: { code: effect === 'conversion' || effect === 'halt_stop' ? 'forbidden' : 'not_implemented' } });
        expect(f.effects).toEqual([]); await f.tools.dispose({});
    }
});

it('MCP initializes/lists the declared discovery tools and validates arguments after authentication', async () => {
    const f = fixture({});
    for (const method of ['initialize', 'tools/list'] as const) {
        const response = await handleOmRequest({ grants: f.grants, clock: f.clock, tools: f.tools,
            request: { method: 'POST', path: '/api/agent/v1/mcp', body: { jsonrpc: '2.0', id: 'rpc', method,
                params: method === 'initialize' ? { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } } : {} } } });
        expect(response.status).toBe(200);
        if (method === 'tools/list') expect((response.body as { result: { tools: { name: string }[] } }).result.tools.map(tool => tool.name)).toEqual(discoveryTools.map(tool => tool.name));
    }
    let reads = 0;
    const revoked = await handleOmRequest({ grants: { async verify() { return { ok: true, value: { ...f.grant, revoked: true } }; } }, clock: f.clock, tools: f.tools,
        request: { method: 'POST', path: '/api/agent/v1/mcp', async readBody() { reads++; return { ok: true, value: {} }; } } });
    expect(revoked.status).toBe(403); expect(reads).toBe(0);
    expect((await f.tools.dispatch({ context: agent, call: { ...f.call, input: { value: 1, ownerId: 'override' } } })).ok).toBe(false);
    await f.tools.dispose({});
});

it('bounds pending operation retention and revokes every retained card on disposal', async () => {
    const f = fixture({}); const results: Outcome<ToolResult>[] = [];
    for (let index = 0; index < 257; index++) results.push(await f.tools.dispatch({ context: agent, call: { ...f.call, operationId: 'bounded-' + index } }));
    expect(results.filter(result => result.ok)).toHaveLength(256);
    expect(results[256]).toMatchObject({ ok: false, error: { code: 'limit_exceeded' } });
    expect(f.effects).toEqual([]);
    const first = value({ result: await f.services.confirmations.list({ context: owner, query: { limit: 100 } }) });
    const second = value({ result: await f.services.confirmations.list({ context: owner, query: { limit: 100, cursor: first.cursor! } }) });
    const third = value({ result: await f.services.confirmations.list({ context: owner, query: { limit: 100, cursor: second.cursor! } }) });
    expect(first.items.length + second.items.length + third.items.length).toBe(256);
    await f.tools.dispose({});
    expect(value({ result: await f.services.confirmations.list({ context: owner, query: { limit: 100 } }) }).items).toEqual([]);
    expect((await f.tools.dispatch({ context: agent, call: f.call })).ok).toBe(false);
});

it('generates checked route/capability coverage from declarations, with explicit future gaps', async () => {
    const f = fixture({}); const definitions = value({ result: await buildOmToolDefinitions({ context: owner, services: f.services }) });
    const rows = generateOmToolCoverage({ definitions });
    expect(Object.keys(ownerRouteDisposition).sort()).toEqual(Object.keys(routes).sort());
    expect(ownerRouteDisposition).toMatchObject({ integrationPluginSecretStatus: 'catalog', chartProviders: 'catalog', mailProvider: 'catalog', setMailProvider: 'catalog' });
    expect(rows.filter(row => row.capability === 'Mail provider selection')).toEqual([
        expect.objectContaining({ access: 'read', policy: 'read', status: 'NEEDS', needs: 'FEATURE_COMPOSITION' }),
        expect.objectContaining({ access: 'write', policy: 'write', status: 'NEEDS', needs: 'FEATURE_COMPOSITION' }),
    ]);
    for (const route of Object.values(routes)) expect(rows.some(row => row.http === route.path)).toBe(true);
    expect(rows.filter(row => row.tool).map(row => row.tool)).toEqual([...definitions, ...discoveryTools].map(tool => tool.name));
    expect(definitions.every(tool => toolDescriptorSchema.safeParse({ name: tool.name, description: tool.description, effects: tool.effects, inputSchema: tool.inputSchema }).success)).toBe(true);
    expect(definitions.some(tool => tool.name === 'om_runs_create' || tool.name === 'om_runs_start')).toBe(false);
    expect(definitions.map(tool => tool.name)).toEqual(expect.arrayContaining(['om_conversations_list', 'om_conversations_get', 'om_conversations_create', 'om_runs_events', 'om_runs_cancel']));
    expect(rows.some(row => row.status === 'NEEDS' && row.capability === 'Meta ads hosted binding')).toBe(true);
    expect(rows.find(row => row.capability === 'Paused/draft campaign creation')?.policy).toBe('write');
    expect(rows.find(row => row.capability === 'Campaign launch')?.policy).toBe('spend');
    expect(rows.filter(row => row.tool).every(row => row.cli === 'om tools list/show/call')).toBe(true);
    expect(rows.filter(row => row.status === 'NEEDS').every(row => !!row.needs && !!row.reason)).toBe(true);
    const mailDefinitions = value({ result: await buildOmToolDefinitions({ context: owner, services: f.services,
        providerSettings: { unit: { transaction: vi.fn() }, addons: { list: vi.fn() }, agentPluginState: vi.fn() } }) });
    expect(mailDefinitions.find(tool => tool.name === 'om_mail_provider_set')!.ownerOnly).toBe(true);
    expect(generateOmToolCoverage({ definitions: mailDefinitions }).filter(row => row.capability === 'Mail provider selection')).toEqual([
        expect.objectContaining({ tool: 'om_mail_provider_get', access: 'read', policy: 'read', status: 'connected', http: routes.mailProvider.path }),
        expect.objectContaining({ tool: 'om_mail_provider_set', access: 'write', policy: 'write', status: 'connected', http: routes.setMailProvider.path }),
    ]);
    await f.tools.dispose({});
});

it('dispatches the existing status read without a card and refuses caller-supplied routing', async () => {
    const f = fixture({});
    const definitions = value({ result: await buildOmToolDefinitions({ context: owner, services: f.services }) });
    const tools = createOmTools({ confirmations: f.services.confirmations as ReturnType<typeof createMemoryConfirmationExchange>, clock: f.clock, observer: f.observer,
        authorize: () => ({ ok: true, value: undefined }), async definitions() { return { ok: true, value: definitions }; } });
    try {
        expect(await tools.dispatch({ context: agent, call: { name: 'om_status', input: {}, operationId: 'status' } }))
            .toEqual({ ok: true, value: { status: 'completed', output: { ready: true, mode: 'local' } } });
        expect(value({ result: await f.services.confirmations.list({ context: owner, query: { limit: 100 } }) }).items).toEqual([]);
        expect(await tools.dispatch({ context: agent, call: { name: 'om_status', input: { path: '/api/safety/halt' }, operationId: 'bad-routing' } }))
            .toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    } finally { await tools.dispose({}); await f.tools.dispose({}); }
});

it('lists a seeded bundled agent-plugin source in the catalog after real boot restores its enabled state', async () => {
    const directory = await fs.mkdtemp(join(tmpdir(), 'om-a3-'));
    const studioRoot = join(directory, 'studio'); const stateRoot = join(directory, 'state');
    await fs.mkdir(studioRoot); await fs.writeFile(join(studioRoot, 'index.html'), '<!doctype html><title>A3 fixture</title>');
    const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));
    const nativeIo = createNodeBootIo({ projectRoot, studioRoot, ready() {} });
    const reads: { mock: { calls: unknown[][] } }[] = [];
    const io = { ...nativeIo, addonEffects(input: Parameters<NonNullable<typeof nativeIo.addonEffects>>[0]) {
        const effects = nativeIo.addonEffects!(input);
        const filesystem = { ...effects.filesystem };
        reads.push(vi.spyOn(filesystem, 'readFile'));
        return { ...effects, filesystem };
    } };
    const args = { env: { OM_STATE_ROOT: stateRoot }, io, clock: { now: () => 1000 }, ids: { next: () => randomUUID() }, observer: { observe() {} } };
    let server: Awaited<ReturnType<typeof bootServer>> | undefined;
    try {
        server = await bootServer(args); const first = value({ result: server });
        const bootstrap = await fetch(first.studioUrl, { redirect: 'manual' });
        const cookie = bootstrap.headers.get('set-cookie')!.split(';')[0]; const origin = new URL(first.studioUrl).origin;
        const headers = { cookie, origin, 'content-type': 'application/json' };
        const packages = await (await fetch(origin + '/api/addons/v1/packages?limit=100', { headers })).json() as { value: { items: { id: string; kind: string; revision: string }[] } };
        const seeded = packages.value.items.find(addon => addon.kind === 'agent-plugin' && addon.id === 'meta-ads');
        expect(seeded).toBeDefined(); if (!seeded) throw new Error('Bundled meta-ads was not seeded');
        // Admission metadata must survive seeding even without a manifest binding to that file.
        const snapshots = (await fs.readdir(join(stateRoot, 'addons'), { recursive: true })).filter(path => path.endsWith('/plugin.json'));
        expect(snapshots.length).toBeGreaterThanOrEqual(6);
        for (const path of snapshots) {
            const manifest = JSON.parse(await fs.readFile(join(stateRoot, 'addons', path), 'utf8'));
            const filename = 'io.github.ainsep.openmarketing/capabilities.json';
            const seededFile = join(stateRoot, 'addons', path, '..', filename);
            const sourceFile = join(projectRoot, 'content/agent-plugins', manifest.name, filename);
            // Skill-only bundled plugins (for example seo) have no capability metadata to carry through seeding.
            if (!await fs.access(sourceFile).then(() => true, () => false)) { await expect(fs.access(seededFile)).rejects.toThrow(); continue; }
            expect(await fs.readFile(seededFile, 'utf8')).toBe(await fs.readFile(sourceFile, 'utf8'));
        }
        const readCounts = reads.map(read => read.mock.calls.length);
        expect((await fetch(origin + '/api/tools?limit=100', { headers })).status).toBe(200);
        const catalogReads = reads.flatMap((read, index) => read.mock.calls.slice(readCounts[index]).map(call => String(call[0])));
        expect(catalogReads.some(path => path.endsWith('/capabilities.json'))).toBe(false);
        const enabled = await fetch(origin + '/api/addons/v1/set-enabled', { method: 'POST', headers, body: JSON.stringify({ kind: seeded.kind, id: seeded.id, enabled: true }) });
        expect(enabled.status).toBe(200); await first.stop({});
        server = await bootServer(args); const restarted = value({ result: server });
        const secondBootstrap = await fetch(restarted.studioUrl, { redirect: 'manual' });
        const secondCookie = secondBootstrap.headers.get('set-cookie')!.split(';')[0];
        const response = await fetch(new URL('/api/tools?limit=100', restarted.studioUrl), { headers: { cookie: secondCookie } });
        expect(response.status).toBe(200);
        // The catalog exceeds the 100-descriptor page maximum, so each name is looked up through the bounded substring search.
        const found = async (name: string): Promise<string[]> => {
            const page = await fetch(new URL('/api/tools?limit=100&query=' + encodeURIComponent(name), restarted.studioUrl), { headers: { cookie: secondCookie } });
            expect(page.status).toBe(200);
            return ((await page.json()) as { value: { name: string }[] }).value.map(tool => tool.name);
        };
        const expected = 'addon_agent_plugin_' + createHash('sha256').update(seeded.id).digest('hex').slice(0, 32);
        expect(await found(expected)).toContain(expected);
        for (const name of ['om_media_list', 'om_media_import', 'om_media_crop', 'om_media_record_provenance',
            'om_contacts_resolve', 'om_forms_publish', 'om_web_events_touches', 'om_privacy_status', 'om_jobs_list', 'om_workspaces_list',
            'om_campaign_create_paused', 'om_creative_generate', 'om_audit_list', 'om_measure_report_cac', 'om_paid_sending_allowance_get',
            'om_forms_preview', 'om_forms_submissions', 'om_jobs_get', 'om_jobs_cancel',
            'om_campaign_propose_launch', 'om_campaign_reconcile', 'om_creative_status', 'om_creative_cancel',
            'om_measure_create_link', 'om_paid_sending_allowance_set', 'om_mail_provider_get', 'om_mail_provider_set']) {
            expect(await found(name)).toContain(name);
        }
    } finally { if (server?.ok) await server.value.stop({}); await removeStateRoot({ path: directory }); }
}, 30000);


/** Verified fixture requests exercise the existing safety service, never a forged approval.
 * Multiple operations share one allowance/account barrier and the dispatcher's real exchange.
 */
function financialFixture(required: { policy: 'spend' | 'generation'; amounts?: readonly number[]; unknown?: boolean; unbounded?: boolean }) {
    const f = fixture({});
    f.definition.policy = required.policy;
    f.definition.effects = required.policy === 'spend' ? ['ad_spend'] : ['generation'];
    const pluginDigest = 'b'.repeat(64); const schemaFingerprint = 'c'.repeat(64);
    const amounts = required.amounts ?? [300, 300, 800];
    const calls = amounts.map((amount, index) => ({ ...f.call, operationId: 'financial-' + index, input: { value: amount } }));
    const requests: EffectRequest[] = calls.map((call, index) => {
        const args = { tool: call.name, input: call.input };
        const argumentsDigest = value({ result: digestArguments({ arguments: args }) });
        const amount = { minorUnits: amounts[index], currency: 'USD' };
        const window = { start: 0, end: 100000 };
        const base: EffectRequest = { arguments: args, pluginDigest, schemaFingerprint, operationScope: f.definition.name,
            envelope: { operationId: call.operationId, connectionId: 'connection', accountId: required.policy === 'spend' ? 'account' : null,
                effects: [...f.definition.effects], argumentsDigest,
                moneyExposure: required.policy === 'spend' ? { amount, window } : null,
                requiredLimit: required.policy === 'spend' ? { amount: { minorUnits: 1000, currency: 'USD' }, timezone: 'UTC', evidenceId: 'cap', semantics: 'hard_limit' } : null } };
        if (required.policy === 'spend') return base;
        return { ...base, generation: { request: { operationId: call.operationId, connectionId: 'connection', argumentsDigest, configurationDigest: schemaFingerprint },
            quote: { quoteId: 'quote-' + index, pluginId: 'fixture-provider', pluginDigest, argumentsDigest, modelConfigurationDigest: schemaFingerprint,
                estimated: required.unbounded ? null : amount, upperBound: required.unbounded ? null : amount, pricingEvidenceId: 'pricing', expiresAt: 100000, status: required.unknown ? 'unknown' : 'known' } } };
    });
    const evidence: PlatformLimitEvidence = { evidenceId: 'cap', accountId: 'account', amount: { minorUnits: 1000, currency: 'USD' }, window: { start: 0, end: 100000 }, observedAt: 1000, semantics: 'hard_limit', pluginDigest };
    let enabled = true;
    const resolver = createMemoryVerifiedEffectResolver({ effects: requests.map(request => ({ scope: owner.scope, request, envelope: request.envelope })),
        quotes: requests.flatMap(request => request.generation ? [{ scope: owner.scope, ...request.generation, pluginDigest, schemaFingerprint }] : []) });
    const safety = createSafetyService({ repo: f.services.safety, confirmations: f.services.confirmations, clock: f.clock, ids: f.ids,
        policy: createMemorySpendPolicy({}), effects: { ...resolver, async resolve(input, options) {
            return enabled ? resolver.resolve(input, options) : { ok: false, error: { code: 'forbidden', message: 'Fixture backend removed', retryable: false } };
        } }, accountLocks: createMemoryAccountDispatchLock({ ids: f.ids }), audit: createMemorySafetyAudit({}),
        platformLimits: createMemoryPlatformLimitEvidence({ evidence: [{ scope: owner.scope, evidence }] }) });
    f.definition.safety = safety;
    f.definition.prepareEffect = async ({ call }) => {
        const request = requests.find(request => request.envelope.operationId === call.operationId);
        return request ? { ok: true, value: request } : { ok: false, error: { code: 'forbidden', message: 'Fixture operation unverified', retryable: false } };
    };
    const original = f.definition.invoke;
    f.definition.invoke = async input => { expect(input.permit?.operationId).toBe(input.authorization?.envelope.operationId); expect(input.permit).toBeDefined(); return original(input); };
    async function answer(input: { call: ToolCall; choice?: ApprovalResponse['choice'] }) {
        const card = value({ result: await f.tools.card({ context: owner, operationId: input.call.operationId }) })!;
        expect(card).not.toBeNull();
        return f.tools.answer({ context: owner, approver: { kind: 'local_token', ownerId: owner.scope.ownerId, deviceId: 'fixture-device', tokenId: 'fixture-token-reference' }, response: { cardId: card.cardId, operationId: card.operationId, argumentsDigest: card.argumentsDigest, choice: input.choice ?? 'allow' } });
    }
    return { ...f, calls, requests, answer, disconnect() { enabled = false; } };
}

it('requires a new exact spend card for every operation and returns the actual bounded dispatch result', async () => {
    const f = financialFixture({ policy: 'spend', amounts: [300, 300] });
    try {
        for (const call of f.calls) {
            expect(value({ result: await f.tools.dispatch({ context: agent, call }) }).status).toBe('pending');
            const card = value({ result: await f.tools.card({ context: agent, operationId: call.operationId }) })!;
            expect(card.classification).toBe('spend'); expect(card.allowedChoices).toEqual(['allow', 'cancel']);
            expect(await f.answer({ call, choice: 'always_allow' })).toMatchObject({ ok: false });
            value({ result: await f.answer({ call }) });
            expect(value({ result: await f.tools.dispatch({ context: agent, call }) })).toEqual({ status: 'completed', output: { saved: 300 } });
        }
        expect(f.effects).toEqual([{ value: 300 }, { value: 300 }]);
        expect(value({ result: await f.services.safety.snapshot({ context: owner, accountId: 'account' }) }).reserved.minorUnits).toBe(600);
    } finally { await f.tools.dispose({}); }
});

it('uses a normal generation grant only within the aggregate remaining allowance, then asks for exact spend', async () => {
    const f = financialFixture({ policy: 'generation' });
    try {
        value({ result: await f.tools.dispatch({ context: agent, call: f.calls[0] }) });
        const first = value({ result: await f.tools.card({ context: agent, operationId: f.calls[0].operationId }) })!;
        expect(first.classification).toBe('generation'); expect(first.allowedChoices).toContain('always_allow');
        value({ result: await f.answer({ call: f.calls[0], choice: 'always_allow' }) });
        expect(value({ result: await f.tools.operation({ context: agent, operationId: f.calls[0].operationId }) })).toMatchObject({ status: 'completed', output: { saved: 300 } });
        expect(value({ result: await f.tools.dispatch({ context: agent, call: f.calls[1] }) })).toEqual({ status: 'completed', output: { saved: 300 } });
        expect(value({ result: await f.tools.card({ context: agent, operationId: f.calls[1].operationId }) })).toBeNull();
        value({ result: await f.tools.dispatch({ context: agent, call: f.calls[2] }) });
        const above = value({ result: await f.tools.card({ context: agent, operationId: f.calls[2].operationId }) })!;
        expect(above.classification).toBe('spend'); expect(above.allowedChoices).toEqual(['allow', 'cancel']);
        expect(f.effects).toEqual([{ value: 300 }, { value: 300 }]);
        value({ result: await f.answer({ call: f.calls[2] }) });
        expect(value({ result: await f.tools.operation({ context: agent, operationId: f.calls[2].operationId }) }).status).toBe('completed');
        expect(f.effects).toHaveLength(3);
        expect(value({ result: await f.services.safety.getGenerationAllowanceView({ context: owner }) }).remaining.minorUnits).toBe(0);
    } finally { await f.tools.dispose({}); }
});

it('unknown generation cost has an exact spend card and an unbounded quote cannot dispatch', async () => {
    for (const unbounded of [false, true]) {
        const f = financialFixture({ policy: 'generation', amounts: [300], unknown: true, unbounded });
        try {
            value({ result: await f.tools.dispatch({ context: agent, call: f.calls[0] }) });
            const card = value({ result: await f.tools.card({ context: agent, operationId: f.calls[0].operationId }) })!;
            expect(card.classification).toBe('spend'); expect(card.allowedChoices).toEqual(['allow', 'cancel']);
            value({ result: await f.answer({ call: f.calls[0] }) });
            expect(value({ result: await f.tools.operation({ context: agent, operationId: f.calls[0].operationId }) }).status).toBe(unbounded ? 'unknown' : 'completed');
            expect(f.effects).toHaveLength(unbounded ? 0 : 1);
        } finally { await f.tools.dispose({}); }
    }
});

it('rechecks the current financial backend after approval and refuses a halted account', async () => {
    for (const deny of ['disconnect', 'halt'] as const) {
        const f = financialFixture({ policy: 'spend', amounts: [300] });
        try {
            value({ result: await f.tools.dispatch({ context: agent, call: f.calls[0] }) });
            if (deny === 'disconnect') f.disconnect();
            else value({ result: await f.services.safety.halt({ context: owner, adAccountId: 'account' }) });
            value({ result: await f.answer({ call: f.calls[0] }) });
            expect(value({ result: await f.tools.operation({ context: agent, operationId: f.calls[0].operationId }) })).toMatchObject({ status: 'unknown', error: { retryable: false } });
            expect(f.effects).toEqual([]);
        } finally { await f.tools.dispose({}); }
    }
});

it('one exact owner continuation sets the allowance and records local halt without claiming a remote stop', async () => {
    const f = fixture({});
    const definitions = value({ result: await buildOmToolDefinitions({ context: owner, services: f.services }) });
    const tools = createOmTools({ clock: f.clock, observer: f.observer, confirmations: f.services.confirmations as ReturnType<typeof createMemoryConfirmationExchange>,
        authorize: () => ({ ok: true, value: undefined }), async definitions() { return { ok: true, value: definitions }; } });
    try {
        const calls: ToolCall[] = [
            { name: 'om_allowance_set', operationId: 'setting', input: { amount: { currency: 'USD', minorUnits: 1500 }, dayTimezone: 'UTC', revision: 0 } },
            { name: 'om_halt_account', operationId: 'halt', input: { accountId: 'account' } },
        ];
        for (const call of calls) {
            value({ result: await tools.dispatch({ context: agent, call }) });
            const card = value({ result: await tools.card({ context: agent, operationId: call.operationId }) })!;
            expect(card.allowedChoices).toEqual(['allow', 'cancel']);
            value({ result: await tools.answer({ context: owner, approver: { kind: 'local_token', ownerId: owner.scope.ownerId, deviceId: 'fixture-device', tokenId: 'fixture-token-reference' }, response: { cardId: card.cardId, operationId: card.operationId, argumentsDigest: card.argumentsDigest, choice: 'allow' } }) });
            expect(value({ result: await tools.operation({ context: agent, operationId: call.operationId }) }).status).toBe('completed');
        }
        expect(value({ result: await f.services.safety.getGenerationAllowance({ context: owner }) }).amount.minorUnits).toBe(1500);
        expect(value({ result: await f.services.safety.getHalt({ context: owner, accountId: 'account' }) })).toMatchObject({ remoteStatus: 'pending' });
    } finally { await tools.dispose({}); await f.tools.dispose({}); }
});

/** Minimal D2 seam fixture; source descriptions remain distinct from backend execution. */
function addonFixture(required: { failure?: boolean } = {}): AddonToolDependencies {
    const rejected: Outcome<never> = { ok: false, error: { code: 'unavailable', message: 'remote sk-fixture-secret-never-display', retryable: true } };
    const addon = { id: 'fixture-addon', kind: 'plugin' as const, name: 'Fixture', description: 'Fixture instructions', version: '1.0.0', revision: 'revision', enabled: true };
    return { observer: { observe() {} }, addons: {
        async list() { return required.failure ? rejected : { ok: true, value: { items: [addon], cursor: null } }; },
        async describe() { return { ok: true, value: { effects: ['future-effect'], instructions: 'Fixture contribution' } }; },
        async install() { return rejected; }, async setEnabled() { return rejected; }, async uninstall() { return rejected; },
    }, integrations: { async list() { return { ok: true, value: { items: [], cursor: null } }; }, async disconnect() { return rejected; } } };
}

it('keeps the catalog and healthy add-on usable when another package description fails', async () => {
    const f = fixture({}); const addons = addonFixture();
    const broken = { id: 'fixture-addon', kind: 'agent-plugin' as const, name: 'Broken', description: 'Broken plugin', version: '1', revision: 'broken-revision', enabled: true };
    const dependencies: AddonToolDependencies = { ...addons, addons: { ...addons.addons,
        async list(input, options) {
            const listed = await addons.addons.list(input, options);
            return listed.ok ? { ok: true, value: { ...listed.value, items: [...listed.value.items, broken] } } : listed;
        },
        async describe(input, options) {
            if (input.kind === broken.kind && input.id === broken.id) return { ok: false, error: { code: 'unavailable', message: 'Fixture missing capabilities.json', retryable: false } };
            return addons.addons.describe(input, options);
        },
    } };
    try {
        const definitions = value({ result: await buildOmToolDefinitions({ context: owner, services: f.services, addons: dependencies }) });
        expect(definitions.some(tool => tool.name === 'om_status')).toBe(true);
        const healthy = definitions.find(tool => tool.name.startsWith('addon_plugin_'))!;
        expect(healthy.policy).toBe('read');
        expect(value({ result: await healthy.invoke({ context: owner, input: {} }) })).toMatchObject({ instructions: 'Fixture contribution' });
        const unavailable = definitions.find(tool => tool.name.startsWith('addon_agent_plugin_'))!;
        expect(unavailable.unavailableReason).toContain('unavailable');
        const tools = createOmTools({ definitions: async () => ({ ok: true, value: definitions }), confirmations: createMemoryConfirmationExchange({ ...answerAudit(), clock: f.clock, ids: f.ids }),
            clock: f.clock, observer: f.observer, authorize: () => ({ ok: true, value: undefined }) });
        try {
            expect(await tools.dispatch({ context: owner, call: { name: unavailable.name, operationId: 'broken-plugin', input: {} } })).toMatchObject({ ok: false });
        } finally { await tools.dispose({}); }
    } finally { await f.tools.dispose({}); }
});

it('consumes D2 management/source schemas and redacts structured third-party failures before the dispatcher boundary', async () => {
    const f = fixture({});
    try {
        const addons = addonFixture();
        const definitions = value({ result: await buildOmToolDefinitions({ context: owner, services: f.services, addons }) });
        expect(definitions.filter(tool => tool.name.startsWith('addons_') || tool.name.startsWith('integrations_'))).toHaveLength(9);
        expect(definitions.some(tool => tool.name === 'integrations_developer_token_status')).toBe(false);
        const statusContexts: CallContext[] = [];
        addons.integrations.pluginSecretStatus = async input => { statusContexts.push(input.context); return { ok: true, value: { configured: true } }; };
        const tools = createOmTools({ ...f, confirmations: f.services.confirmations, definitions: async () => ({ ok: true, value: definitions }), authorize: () => ({ ok: true, value: undefined }) });
        try {
            expect(await tools.dispatch({ context: agent, call: { name: 'integrations_plugin_secret_status', input: { pluginId: 'fixture-plugin' }, operationId: 'plugin-secret-status' } })).toMatchObject({ value: { status: 'completed', output: { configured: true } } });
            expect(statusContexts).toEqual([{ ...agent, principal: owner.principal }]);
        } finally { await tools.dispose({}); }
        const source = definitions.find(tool => tool.name.startsWith('addon_plugin_'))!;
        expect(source.policy).toBe('read'); expect(value({ result: await source.invoke({ context: owner, input: {} }) })).toMatchObject({ instructions: 'Fixture contribution' });
        const failing = await definitions.find(tool => tool.name === 'integrations_disconnect')!.invoke({ context: owner, input: { connectionId: 'connection' } });
        expect(failing).toMatchObject({ ok: false, error: { code: 'unavailable', retryable: true } });
        expect(JSON.stringify(failing)).not.toContain('sk-fixture');
        const badDiscovery = await buildOmToolDefinitions({ context: owner, services: f.services, addons: addonFixture({ failure: true }) });
        expect(JSON.stringify(badDiscovery)).not.toContain('sk-fixture'); expect(badDiscovery.ok).toBe(false);
        const rows = generateOmToolCoverage({ definitions });
        expect(rows.find(row => row.tool === source.name)).toMatchObject({ status: 'connected', policy: 'read', cli: 'om tools list/show/call' });
        expect(rows.filter(row => row.status === 'NEEDS').every(row => !!row.reason && !!row.needs)).toBe(true);
    } finally { await f.tools.dispose({}); }
});

it('binds contact writes to the public service and requests an exact destructive merge card', async () => {
    const f = fixture({});
    const contacts = createContactService({ repo: createMemoryContactRepo({}), suppression: { async assess() { return { ok: true, value: { allowed: true } }; } }, digest: { activeKeyVersion: 'v1', keys: { v1: new Uint8Array([1, 2, 3]) } }, clock: f.clock, ids: f.ids });
    const services: OwnerServices & OmFeatureServices = { ...f.services, contacts };
    const definitions = value({ result: await buildOmToolDefinitions({ context: owner, services }) });
    const tools = createOmTools({ clock: f.clock, observer: f.observer, confirmations: f.services.confirmations as ReturnType<typeof createMemoryConfirmationExchange>,
        authorize: () => ({ ok: true, value: undefined }), async definitions() { return { ok: true, value: definitions }; } });
    try {
        const subjects: string[] = [];
        for (const email of ['one@example.test', 'two@example.test']) {
            const call = { name: 'om_contacts_upsert', operationId: email, input: { identifiers: [{ kind: 'email', raw: email }] } };
            value({ result: await tools.dispatch({ context: agent, call }) });
            const card = value({ result: await tools.card({ context: agent, operationId: call.operationId }) })!;
            value({ result: await tools.answer({ context: owner, approver: { kind: 'local_token', ownerId: owner.scope.ownerId, deviceId: 'fixture-device', tokenId: 'fixture-token-reference' }, response: { cardId: card.cardId, operationId: card.operationId, argumentsDigest: card.argumentsDigest, choice: 'allow' } }) });
            const operation = value({ result: await tools.operation({ context: agent, operationId: call.operationId }) });
            expect(operation.status).toBe('completed');
            if (operation.status !== 'completed') throw new Error('Expected completed contact write');
            subjects.push((operation.output as { subjectId: string }).subjectId);
        }
        value({ result: await tools.dispatch({ context: agent, call: { name: 'om_contacts_merge', operationId: 'merge', input: { sourceSubjectId: subjects[1], targetSubjectId: subjects[0] } } }) });
        const card = value({ result: await tools.card({ context: agent, operationId: 'merge' }) })!;
        expect(card.classification).toBe('destructive'); expect(card.allowedChoices).toEqual(['allow', 'cancel']);
        value({ result: await tools.answer({ context: owner, approver: { kind: 'local_token', ownerId: owner.scope.ownerId, deviceId: 'fixture-device', tokenId: 'fixture-token-reference' }, response: { cardId: card.cardId, operationId: card.operationId, argumentsDigest: card.argumentsDigest, choice: 'allow' } }) });
        expect(value({ result: await contacts.resolve({ context: owner, identifier: { kind: 'email', raw: 'two@example.test' } }) }).subjectId).toBe(subjects[0]);
        expect(generateOmToolCoverage({ definitions }).some(row => row.capability === 'Contact upsert' && row.status === 'NEEDS')).toBe(false);
    } finally { await tools.dispose({}); await f.tools.dispose({}); }
});

/** Injected HTTP/file/terminal fixture drives the real generic CLI and dispatcher together. */
function toolCliFixture(required: { confirmed?: boolean; file?: string } = {}) {
    const f = fixture({}); let next = 0; let confirmations = 0;
    const requests: { path: string; method: string; body: unknown }[] = []; const stdout: string[] = []; const stderr: string[] = [];
    const runtime: CliRuntime = { env: { OM_SERVER_URL: 'http://fixture.test', OM_OWNER_TOKEN: 'fixture-token' }, clock: f.clock, ids: { next: () => 'cli-' + ++next },
        deadline: { create() { return { signal: new AbortController().signal, dispose() {} }; } },
        stdout: { write({ text }) { stdout.push(text); } }, stderr: { write({ text }) { stderr.push(text); } },
        async confirm() { confirmations++; return required.confirmed === true; },
        async *readPrompt() { yield new TextEncoder().encode(required.file ?? '{"value":7}'); },
        fetch: (async (url: URL, init?: RequestInit) => {
            const body = init?.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown;
            requests.push({ path: url.pathname, method: init?.method ?? 'GET', body });
            const response = await handleOwnerRequest({ context: owner, services: f.services, request: { method: init?.method === 'POST' ? 'POST' : 'GET', path: url.pathname, query: Object.fromEntries(url.searchParams), body } });
            return new Response(JSON.stringify(response.body), { status: response.status });
        }) as typeof fetch };
    return { ...f, runtime, requests, stdout, stderr, confirmationCount: () => confirmations };
}

it('generic CLI calls both tracking tools through the existing HTTP dispatcher', async () => {
    const f = toolCliFixture({ file: JSON.stringify({ destinationUrl: 'https://site.example' }) });
    const tracking: NonNullable<OmFeatureServices['tracking']> = {
        async snippet() { return { ok: true, value: { source: 'installer', campaignUrlTemplates: [], consentBanner: { head: '', body: '' } } }; },
        async readiness() { return { ok: true, value: { status: 'missing', heartbeatAt: null, fallbackUrl: null } }; },
    };
    const tools = createOmTools({ ...f, confirmations: f.services.confirmations, authorize: () => ({ ok: true, value: undefined }),
        definitions: input => buildOmToolDefinitions({ ...input, services: { ...f.services, tracking } }) });
    f.services.tools = tools;
    try {
        for (const name of ['om_web_events_snippet', 'om_tracking_readiness']) {
            value({ result: await runOmCli({ argv: ['tools', 'call', name, '--input-file', '-', '--json'], runtime: f.runtime }) });
            // The CLI reports through stdout (JSON envelope), not its return value.
            expect(JSON.parse(f.stdout.at(-1)!)).toMatchObject({ ok: true, value: { status: 'completed' } });
            expect(f.requests.at(-1)).toMatchObject({ path: '/api/tools/call', method: 'POST', body: { name, input: { destinationUrl: 'https://site.example' } } });
        }
        expect(f.confirmationCount()).toBe(0);
    } finally { await tools.dispose({}); await f.tools.dispose({}); }
});

it('generic CLI list/show/call reaches the same catalog and human approval returns the actual tool output', async () => {
    const f = toolCliFixture({ confirmed: true });
    try {
        value({ result: await runOmCli({ argv: ['tools', 'list', '--json'], runtime: f.runtime }) });
        expect(f.requests[0]).toMatchObject({ path: '/api/tools', method: 'GET' });
        value({ result: await runOmCli({ argv: ['tools', 'show', 'fixture_write', '--json'], runtime: f.runtime }) });
        expect(f.requests[1]).toMatchObject({ path: '/api/tools/describe/fixture_write' });
        value({ result: await runOmCli({ argv: ['tools', 'call', 'fixture_write', '--input-file', '-'], runtime: f.runtime }) });
        expect(f.effects).toEqual([{ value: 7 }]); expect(f.confirmationCount()).toBe(1);
        expect(f.stdout.at(-1)).toContain('"output":{"saved":7}');
        expect(f.requests.filter(request => request.path === '/api/tools/call')).toHaveLength(1);
        expect(f.stderr.join('')).toContain('Approval card:');
    } finally { await f.tools.dispose({}); }
});

it('JSON tool calls return pending and never approve, while malformed input and irrelevant flags send no HTTP', async () => {
    const f = toolCliFixture({ confirmed: true });
    try {
        value({ result: await runOmCli({ argv: ['tools', 'call', 'fixture_write', '--input-file', '-', '--json'], runtime: f.runtime }) });
        expect(f.confirmationCount()).toBe(0); expect(f.effects).toEqual([]); expect(f.stdout.join('')).toContain('"status":"pending"');
    } finally { await f.tools.dispose({}); }
    for (const argv of [
        ['tools', 'call', 'fixture_write'], ['tools', 'call', 'fixture_write', '--input-file', '-', '--choice', 'allow'],
        ['tools', 'show', '..'], ['tools', 'list', '--limit', '101'], ['tools', 'list', '--limit', '1', '--limit', '2'],
    ]) {
        const bad = toolCliFixture();
        try { expect(await runOmCli({ argv, runtime: bad.runtime })).toMatchObject({ ok: false }); expect(bad.requests).toEqual([]); }
        finally { await bad.tools.dispose({}); }
    }
    for (const file of ['{', JSON.stringify('x'.repeat(65537))]) {
        const bad = toolCliFixture({ file });
        try { expect(await runOmCli({ argv: ['tools', 'call', 'fixture_write', '--input-file', '-', '--json'], runtime: bad.runtime })).toMatchObject({ ok: false }); expect(bad.requests).toEqual([]); }
        finally { await bad.tools.dispose({}); }
    }
});

it('reserves financial identity before verification and cancellation cannot reopen the pending operation', async () => {
    const f = financialFixture({ policy: 'generation', amounts: [300] });
    const ready = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
    const prepare = f.definition.prepareEffect!;
    f.definition.prepareEffect = async input => { ready.resolve(); await release.promise; return prepare(input); };
    try {
        const first = f.tools.dispatch({ context: agent, call: f.calls[0] });
        await ready.promise;
        expect(value({ result: await f.tools.dispatch({ context: agent, call: f.calls[0] }) }).status).toBe('pending');
        await f.revoke(); release.resolve();
        expect(await first).toMatchObject({ ok: false, error: { code: 'cancelled' } });
        expect(value({ result: await f.tools.operation({ context: owner, operationId: f.calls[0].operationId }) }).status).toBe('cancelled');
        expect(f.effects).toEqual([]);
        expect(value({ result: await f.services.confirmations.list({ context: owner, query: { limit: 100 } }) }).items).toEqual([]);
    } finally { release.resolve(); await f.tools.dispose({}); }
});

it('reads instructions without a card and re-resolves removal before another invocation', async () => {
    const f = fixture({}); const addons = addonFixture();
    const tools = createOmTools({ clock: f.clock, observer: f.observer, confirmations: f.services.confirmations as ReturnType<typeof createMemoryConfirmationExchange>,
        authorize: () => ({ ok: true, value: undefined }), definitions: input => buildOmToolDefinitions({ ...input, services: f.services, addons }) });
    try {
        const catalog = value({ result: await tools.list({ context: owner, limit: 100 }) });
        const source = catalog.find(tool => tool.name.startsWith('addon_plugin_'))!;
        expect(await tools.dispatch({ context: agent, call: { name: source.name, operationId: 'addon-operation', input: {} } })).toMatchObject({ value: { status: 'completed', output: { instructions: 'Fixture contribution' } } });
        expect(value({ result: await f.services.confirmations.list({ context: owner, query: { limit: 100 } }) }).items).toEqual([]);
        addons.addons.list = async () => ({ ok: true, value: { items: [], cursor: null } });
        expect(await tools.dispatch({ context: agent, call: { name: source.name, operationId: 'after-removal', input: {} } })).toMatchObject({ ok: false });
        expect(value({ result: await tools.list({ context: owner, limit: 100 }) }).some(tool => tool.name === source.name)).toBe(false);
    } finally { await tools.dispose({}); await f.tools.dispose({}); }
});

it('typed backend effects cannot be disguised by combining them with read/write/generation/spend', async () => {
    for (const effect of ['conversion', 'halt_stop'] as const) {
        const f = fixture({}); f.definition.effects = ['write', 'generation', 'ad_spend', effect];
        try {
            expect(toolPolicy({ effects: f.definition.effects })).toBe('internal');
            expect(await f.tools.dispatch({ context: agent, call: f.call })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
            expect(f.effects).toEqual([]);
        } finally { await f.tools.dispose({}); }
    }
});

// A5: same dispatcher and real Jini wire/props validation, no browser/vendor I/O.
import { buildUiToolDefinitions, prepareUiSurface, checkedSurfaceAcknowledgement } from '../src/ui-tools.js';
import type { UiFrontendPort } from '../src/ui-tools.js';

/** Captured approval evidence; each fixture owns its audit records. */
function answerAudit() {
    const answers: unknown[] = [];
    return { answers, async recordAnswer(input: { answer: unknown }) {
        answers.push(structuredClone(input.answer));
        return { ok: true as const, value: undefined };
    } };
}

const uiComponents: ToolCall['input'][] = [{ id: 'root', component: 'Column', children: ['text'] }, { id: 'text', component: 'Text', text: 'Fixture' }];
async function uiFixture(required: { acknowledge?: 'rendered' | 'sent'; foreignRun?: boolean } = {}) {
    const base = fixture({}); const delivered: unknown[] = [];
    const frontend: UiFrontendPort = {
        async acknowledge() { return { ok: true, value: undefined }; },
        async page(input) { delivered.push(input); return { ok: true, value: { clicked: true } }; },
        async render(input) {
            delivered.push(input);
            return { ok: true, value: { status: required.acknowledge ?? 'rendered', surfaceId: input.surfaceId,
                invocationId: 'invocation', runId: required.foreignRun ? 'foreign' : input.context.runId!, frontendSessionId: 'frontend' } };
        },
    };
    await base.tools.dispose({});
    const definitions = buildUiToolDefinitions({ runtime: base, frontend });
    const tools = createOmTools({ ...base, confirmations: base.services.confirmations as ReturnType<typeof createMemoryConfirmationExchange>,
        authorize: () => ({ ok: true, value: undefined }), async definitions() { return { ok: true, value: definitions }; } });
    return { ...base, frontend, definitions, tools, delivered };
}
it('discovers charts and describes published Zod 3 props as plain JSON through the existing SDK', async () => {
    const f = await uiFixture();
    const search = await f.tools.dispatch({ context: agent, call: { name: 'search_components', input: { query: 'chart' }, operationId: 'search-chart' } });
    expect(search).toMatchObject({ ok: true, value: { status: 'completed', output: expect.arrayContaining([expect.objectContaining({ id: 'recharts.bar-chart' })]) } });
    const describe = await f.tools.dispatch({ context: agent, call: { name: 'describe_component', input: { id: 'recharts.bar-chart' }, operationId: 'describe-chart' } });
    expect(describe).toMatchObject({ ok: true, value: { output: { propsSchema: { type: 'object', required: expect.arrayContaining(['data', 'categoryKey', 'valueKey']) } } } });
    expect(f.delivered).toEqual([]); await f.tools.dispose({});
});
it('renders only after the one owner approval and returns the real browser acknowledgement', async () => {
    const f = await uiFixture(); const call = { name: 'render', input: { components: uiComponents }, operationId: 'surface-operation' };
    expect(await f.tools.dispatch({ context: agent, call })).toMatchObject({ ok: true, value: { status: 'pending' } });
    expect(f.delivered).toEqual([]);
    const card = value({ result: await f.tools.card({ context: owner, operationId: call.operationId }) })!;
    expect(await f.tools.answer({ context: owner, approver: { kind: 'local_token', ownerId: owner.scope.ownerId, deviceId: 'fixture-device', tokenId: 'fixture-token-reference' }, response: { cardId: card.cardId, operationId: card.operationId, argumentsDigest: card.argumentsDigest, choice: 'allow' } })).toEqual({ ok: true, value: undefined });
    expect(await f.tools.operation({ context: agent, operationId: call.operationId })).toMatchObject({ ok: true, value: { status: 'completed', output: { status: 'rendered', runId: 'run' } } });
    await f.tools.dispatch({ context: agent, call }); expect(f.delivered).toHaveLength(1); await f.tools.dispose({});
});
it('keeps missing browser transport explicit in coverage and never creates a page approval', async () => {
    const f = fixture({}); const definitions = buildUiToolDefinitions({ runtime: null });
    const tools = createOmTools({ ...f, confirmations: f.services.confirmations as ReturnType<typeof createMemoryConfirmationExchange>, authorize: () => ({ ok: true, value: undefined }),
        async definitions() { return { ok: true, value: definitions }; } });
    const result = await tools.dispatch({ context: agent, call: { name: 'page.click', input: { handle: 'save' }, operationId: 'page' } });
    expect(result).toMatchObject({ ok: false, error: { code: 'not_implemented' } });
    expect(generateOmToolCoverage({ definitions }).find(row => row.tool === 'page.click')).toMatchObject({ status: 'NEEDS', needs: 'A5_FRONTEND_COMPOSITION' });
    expect(value({ result: await f.services.confirmations.list({ context: owner, query: { limit: 100 } }) }).items).toEqual([]);
    await tools.dispose({}); await f.tools.dispose({});
});
for (const [name, components] of [
    ['unknown component', [{ id: 'root', component: 'Unregistered' }]],
    ['invalid Text props', [{ id: 'root', component: 'Text', text: 123 }]],
    ['missing root', [{ id: 'text', component: 'Text', text: 'fixture' }]],
    ['missing child', [{ id: 'root', component: 'Column', children: ['absent'] }]],
    ['cycle', [{ id: 'root', component: 'Column', children: ['root'] }]],
    ['duplicate ID', [{ id: 'root', component: 'Text', text: 'one' }, { id: 'root', component: 'Text', text: 'two' }]],
    ['aggregate expansion', [{ id: 'root', component: 'Column', children: Array(100).fill('text') }, { id: 'text', component: 'Text', text: 'fixture' }]],
] as const) it('rejects A2UI ' + name + ' before frontend delivery', async () => {
    const f = fixture({});
    expect(prepareUiSurface({ ...f, surfaceId: 'surface', input: { components } })).toMatchObject({ ok: false });
    await f.tools.dispose({});
});
it('accepts neutral chart wire IDs without a chart npm dependency', async () => {
    const f = fixture({});
    expect(prepareUiSurface({ ...f, surfaceId: 'surface', input: { components: [{ id: 'root', component: 'recharts.bar-chart', data: [{ name: 'A', count: 2 }], categoryKey: 'name', valueKey: 'count' }] } })).toMatchObject({ ok: true });
    await f.tools.dispose({});
});
it('never turns sent or foreign acknowledgements into rendered', async () => {
    const input = { status: 'sent', surfaceId: 'surface', invocationId: 'invocation', runId: 'run', frontendSessionId: 'frontend' };
    expect(checkedSurfaceAcknowledgement({ input, surfaceId: 'surface', runId: 'run' })).toEqual({ ok: true, value: input });
    expect(checkedSurfaceAcknowledgement({ input, surfaceId: 'surface', runId: 'foreign' })).toMatchObject({ ok: false });
    expect(checkedSurfaceAcknowledgement({ input: {}, surfaceId: 'surface', runId: 'run' })).toMatchObject({ ok: false });
});
it('authenticates acknowledgement identity before passing it to the frontend host', async () => {
    const f = await uiFixture(); f.services.ui = { runtime: f, frontend: f.frontend };
    const response = await handleOwnerRequest({ context: owner, services: f.services,
        request: { method: 'POST', path: '/api/runs/run/surfaces', body: { status: 'rendered', surfaceId: 'surface', invocationId: 'invocation', runId: 'foreign', frontendSessionId: 'frontend' } } });
    expect(response.status).toBe(400); expect(f.delivered).toEqual([]); await f.tools.dispose({});
});

/** Shared relay cases exercise its direct port and the actual owner HTTP translation. */
async function frontendFixture(required: { throughHttp: boolean; disconnected?(input: { context: CallContext; runId: string }): Promise<void> }) {
    const f = fixture({}); let live = true; let timerId = 0;
    const timers = new Map<number, { delayMs: number; callback(): void }>();
    const relay = createFrontendSessions({ clock: f.clock, ids: f.ids, randomToken: () => 'fixture-bind-' + f.ids.next(),
        schedule(input) { const id = ++timerId; timers.set(id, input); return () => { timers.delete(id); }; },
        authorize: input => live || input.context.principal.kind === 'owner' ? { ok: true, value: undefined }
            : { ok: false, error: { code: 'expired', message: 'Fixture run revoked', retryable: false } },
        disconnected: required.disconnected ?? (input => f.tools.cancel(input)) });
    f.services.ui = { runtime: { clock: f.clock, ids: f.ids }, frontend: relay.frontend, sessions: relay };
    const request = (input: { method: 'GET' | 'POST'; path: string; body?: unknown; query?: Record<string, string>; context?: CallContext; signal?: AbortSignal }) => {
        const args = { request: input, context: input.context ?? owner, services: f.services };
        return required.throughHttp ? handleOwnerRequest(args) : relay.handle(args);
    };
    const disconnect = new AbortController();
    const attached = await request({ method: 'GET', path: '/api/frontend-sessions/stream', query: { capabilities: 'page.find_elements,page.navigate,page.click' }, signal: disconnect.signal });
    const stream = attached.stream!.chunks[Symbol.asyncIterator]();
    const next = async () => {
        const chunk = await stream.next();
        if (chunk.done) throw new Error('Fixture stream closed');
        return JSON.parse(new TextDecoder().decode(chunk.value).slice(6).trim()) as { sessionId: string; bindToken: string; invocationId: string; runId: string; frontendSessionId: string; type: string };
    };
    const attachment = await next();
    const bind = (input: { token?: string; context?: CallContext; runId?: string } = {}) => relay.bindRun({ context: input.context ?? agent,
        runId: input.runId ?? 'run', expiresAt: 301000, frontendSessionId: attachment.sessionId, frontendBindToken: input.token ?? attachment.bindToken });
    const bound = bind(); if (!bound.ok) throw new Error(bound.error.message); await next();
    return { ...f, relay, request, next, attachment, bind, timers, disconnect, stream: attached.stream!,
        async revoke() { live = false; await f.revoke(); await relay.endRun({ context: owner, runId: 'run', status: 'cancelled' }); },
        async dispose() { await relay.dispose({}); await f.tools.dispose({}); },
    };
}
for (const throughHttp of [false, true]) describe('bound frontend relay / ' + (throughHttp ? 'owner-http' : 'direct-port'), () => {
    it('binds by current token and returns the observed browser output exactly once', async () => {
        const f = await frontendFixture({ throughHttp });
        try {
            const result = f.relay.frontend.page({ context: agent, name: 'page.find_elements', input: {} });
            const invocation = await f.next(); expect(invocation).toMatchObject({ type: 'invocation', runId: 'run', frontendSessionId: f.attachment.sessionId, capabilityId: 'page.find_elements' });
            const body = { invocationId: invocation.invocationId, ok: true, output: { elements: [{ handle: 'appearance-mode', label: 'Appearance' }] } };
            const path = '/api/frontend-sessions/' + f.attachment.sessionId + '/responses';
            expect((await f.request({ method: 'POST', path, body })).status).toBe(200);
            expect(await result).toEqual({ ok: true, value: body.output });
            expect((await f.request({ method: 'POST', path, body })).status).toBe(403);
        } finally { await f.dispose(); }
        expect(f.timers.size).toBe(0);
    });
    it('rejects cross-owner and cross-session responses without settling the right invocation', async () => {
        const f = await frontendFixture({ throughHttp });
        try {
            const result = f.relay.frontend.page({ context: agent, name: 'page.navigate', input: { page: 'settings' } });
            const invocation = await f.next();
            const body = { invocationId: invocation.invocationId, ok: true, output: { navigated: 'settings' } };
            const path = '/api/frontend-sessions/' + f.attachment.sessionId + '/responses';
            expect((await f.request({ method: 'POST', path, body, context: { ...owner, scope: { ...owner.scope, ownerId: 'foreign' } } })).status).toBe(403);
            expect((await f.request({ method: 'POST', path: '/api/frontend-sessions/foreign/responses', body })).status).toBe(403);
            expect((await f.request({ method: 'POST', path, body })).status).toBe(200);
            expect(await result).toEqual({ ok: true, value: body.output });
        } finally { await f.dispose(); }
    });
    it('requires matching rendered evidence and does not complete on sent alone', async () => {
        const f = await frontendFixture({ throughHttp });
        try {
            let settled = false;
            const result = f.relay.frontend.render({ context: agent, surfaceId: 'surface', messages: [{ version: 'v1.0', createSurface: { surfaceId: 'surface', catalogId: 'fixture', dataModel: {} } }] });
            void result.then(() => { settled = true; });
            const surface = await f.next(); expect(surface.type).toBe('a2ui');
            const identity = { surfaceId: 'surface', invocationId: surface.invocationId, runId: 'run', frontendSessionId: f.attachment.sessionId };
            expect(await f.relay.frontend.acknowledge({ context: owner, result: { ...identity, runId: 'foreign', status: 'rendered' } })).toMatchObject({ ok: false });
            expect(await f.relay.frontend.acknowledge({ context: owner, result: { ...identity, status: 'sent' } })).toMatchObject({ ok: true });
            await Promise.resolve(); expect(settled).toBe(false);
            expect(await f.relay.frontend.acknowledge({ context: owner, result: { ...identity, status: 'rendered' } })).toMatchObject({ ok: true });
            expect(await result).toEqual({ ok: true, value: { ...identity, status: 'rendered' } });
        } finally { await f.dispose(); }
    });
    it('cancellation voids page calls and cards and denies late browser acknowledgements', async () => {
        const f = await frontendFixture({ throughHttp });
        try {
            await f.tools.dispatch({ context: agent, call: f.call });
            const card = value({ result: await f.tools.card({ context: owner, operationId: f.call.operationId }) }); expect(card).not.toBeNull();
            const result = f.relay.frontend.page({ context: agent, name: 'page.click', input: { handle: 'appearance-mode' } });
            const invocation = await f.next(); await f.revoke();
            expect(await result).toMatchObject({ ok: false, error: { code: 'cancelled' } });
            expect((await f.request({ method: 'POST', path: '/api/frontend-sessions/' + f.attachment.sessionId + '/responses',
                body: { invocationId: invocation.invocationId, ok: true, output: {} } })).status).toBe(403);
            expect(await f.tools.card({ context: owner, operationId: f.call.operationId })).toEqual({ ok: true, value: null });
            expect(await f.tools.answer({ context: owner, approver: { kind: 'local_token', ownerId: owner.scope.ownerId, deviceId: 'fixture-device', tokenId: 'fixture-token-reference' }, response: { cardId: card!.cardId, operationId: card!.operationId, argumentsDigest: card!.argumentsDigest, choice: 'allow' } })).toMatchObject({ ok: false });
            expect(f.effects).toEqual([]);
        } finally { await f.dispose(); }
    });
    it('disconnect invalidates the attachment token and revokes its pending cards', async () => {
        const f = await frontendFixture({ throughHttp });
        try {
            await f.tools.dispatch({ context: agent, call: f.call });
            const result = f.relay.frontend.page({ context: agent, name: 'page.navigate', input: { page: 'settings' } }); await f.next();
            f.disconnect.abort(); expect(await result).toMatchObject({ ok: false, error: { code: 'cancelled' } });
            expect(f.bind()).toMatchObject({ ok: false });
            expect(await f.tools.card({ context: owner, operationId: f.call.operationId })).toEqual({ ok: true, value: null });
            expect(f.effects).toEqual([]); expect(f.timers.size).toBe(0);
        } finally { await f.dispose(); }
    });
    it('refuses stale tokens, foreign owners, unclaimed capabilities and oversized replies', async () => {
        const f = await frontendFixture({ throughHttp });
        try {
            expect(f.bind({ token: 'old-token', runId: 'other' })).toMatchObject({ ok: false });
            expect(f.bind({ runId: 'other', context: { ...agent, scope: { ...agent.scope, workspaceId: 'foreign' } } })).toMatchObject({ ok: false });
            expect(await f.relay.frontend.page({ context: agent, name: 'page.fill', input: { handle: 'appearance-mode', text: 'dark' } })).toMatchObject({ ok: false });
            const result = f.relay.frontend.page({ context: agent, name: 'page.navigate', input: { page: 'settings' } }); const invocation = await f.next();
            expect((await f.request({ method: 'POST', path: '/api/frontend-sessions/' + f.attachment.sessionId + '/responses',
                body: { invocationId: invocation.invocationId, ok: true, output: 'x'.repeat(65536) } })).status).toBe(400);
            const deadline = [...f.timers.values()].find(timer => timer.delayMs === 15000)!; deadline.callback();
            expect(await result).toMatchObject({ ok: false, error: { code: 'expired' } });
        } finally { await f.dispose(); }
    });
});

it('surface tool calls use the existing exact card, and cancellation prevents its effect', async () => {
    const f = await frontendFixture({ throughHttp: true });
    try {
        const request = { method: 'POST' as const, path: '/api/tools/call', body: { call: f.call, runId: 'run', frontendSessionId: f.attachment.sessionId } };
        const dispatched = await handleOwnerRequest({ services: f.services, context: owner, request });
        expect(dispatched.body).toMatchObject({ ok: true, value: { status: 'pending' } }); expect(f.effects).toEqual([]);
        const card = value({ result: await f.tools.card({ context: owner, operationId: f.call.operationId }) });
        await f.revoke();
        expect(await f.tools.answer({ context: owner, approver: { kind: 'local_token', ownerId: owner.scope.ownerId, deviceId: 'fixture-device', tokenId: 'fixture-token-reference' }, response: { cardId: card!.cardId, operationId: card!.operationId, argumentsDigest: card!.argumentsDigest, choice: 'allow' } })).toMatchObject({ ok: false });
        expect(f.effects).toEqual([]);
        const foreign = await handleOwnerRequest({ services: f.services, context: owner, request: { ...request,
            body: { call: { ...f.call, operationId: 'other' }, runId: 'run', frontendSessionId: 'foreign' } } });
        expect(foreign.status).toBe(403);
    } finally { await f.dispose(); }
});

it('authenticates the real frontend stream and carries its binding through a sandbox run', async () => {
    const directory = await fs.mkdtemp(join(tmpdir(), 'om-a5b-'));
    const studioRoot = join(directory, 'studio'); const stateRoot = join(directory, 'state');
    await fs.mkdir(studioRoot); await fs.writeFile(join(studioRoot, 'index.html'), '<!doctype html><title>Frontend fixture</title>');
    const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));
    const args = { env: { OM_STATE_ROOT: stateRoot }, io: createNodeBootIo({ projectRoot, studioRoot, ready() {} }),
        clock: { now: () => Date.now() }, ids: { next: () => randomUUID() }, observer: { observe() {} } };
    let server: Awaited<ReturnType<typeof bootServer>> | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
        server = await bootServer(args); const booted = value({ result: server }); const origin = new URL(booted.studioUrl).origin;
        const path = '/api/frontend-sessions/stream?capabilities=page.navigate';
        expect((await fetch(origin + path)).status).toBe(401);
        const bootstrap = await fetch(booted.studioUrl, { redirect: 'manual' }); const cookie = bootstrap.headers.get('set-cookie')!.split(';')[0];
        const headers = { cookie, origin, 'content-type': 'application/json' };
        const stream = await fetch(origin + path, { headers }); expect(stream.status).toBe(200); expect(stream.headers.get('content-type')).toContain('text/event-stream');
        reader = stream.body!.getReader(); const buffered = { text: '' };
        const attachment = await readFrontendSseFrame({ reader, buffered }) as { sessionId: string; bindToken: string };
        const body = { prompt: 'Sandbox fixture only', frontendSessionId: attachment.sessionId, frontendBindToken: attachment.bindToken };
        const run = await fetch(origin + '/api/runs', { method: 'POST', headers, body: JSON.stringify(body) });
        expect(run.status).toBe(200); const receipt = await run.json() as { value: { runId: string } };
        expect(receipt.value.runId).toBeTruthy();
        const binding = await readFrontendSseFrame({ reader, buffered }) as { runId: string; type: string };
        expect(binding).toMatchObject({ type: 'bound', runId: receipt.value.runId });
        expect(JSON.stringify(receipt)).not.toContain(attachment.bindToken);
        const events = await (await fetch(origin + '/api/runs/' + receipt.value.runId + '/events?after=0', { headers })).text();
        expect(events).not.toContain(attachment.bindToken);
        const foreign = await fetch(origin + '/api/runs', { method: 'POST', headers,
            body: JSON.stringify({ ...body, frontendBindToken: 'stale-fixture-token' }) });
        expect(foreign.status).toBe(403);
    } finally {
        await reader?.cancel(); if (server?.ok) await server.value.stop({}); await removeStateRoot({ path: stateRoot }); await fs.rm(directory, { recursive: true, force: true });
    }
});

it('removes queued page invocations when a run is cancelled before the browser pulls them', async () => {
    const f = await frontendFixture({ throughHttp: true });
    try {
        const first = f.relay.frontend.page({ context: agent, name: 'page.click', input: { handle: 'appearance-mode' } });
        const second = f.relay.frontend.page({ context: agent, name: 'page.navigate', input: { page: 'settings' } });
        await f.revoke();
        expect(await first).toMatchObject({ ok: false, error: { code: 'cancelled' } });
        expect(await second).toMatchObject({ ok: false, error: { code: 'cancelled' } });
        expect(await f.next()).toMatchObject({ type: 'voided', runId: 'run', frontendSessionId: f.attachment.sessionId });
    } finally { await f.dispose(); }
});

/** Fixture parser handles split/coalesced SSE packets and ignores heartbeat comments. */
async function readFrontendSseFrame(required: { reader: ReadableStreamDefaultReader<Uint8Array>; buffered: { text: string } }): Promise<unknown> {
    while (true) {
        const end = required.buffered.text.indexOf('\n\n');
        if (end >= 0) {
            const frame = required.buffered.text.slice(0, end); required.buffered.text = required.buffered.text.slice(end + 2);
            if (frame.startsWith('data: ')) return JSON.parse(frame.slice(6)) as unknown;
            continue;
        }
        const chunk = await required.reader.read();
        if (chunk.done) throw new Error('Frontend stream ended before the fixture frame');
        required.buffered.text += new TextDecoder().decode(chunk.value);
        if (required.buffered.text.length > 131072) throw new Error('Fixture SSE bound exceeded');
    }
}

/** Restart seam uses the production SQLite transaction bridge and the same definition/effect capture. */
function durableFixture(input: { backend: 'memory' | 'sql' }) {
    const base = fixture({});
    const native = new Database(':memory:');
    for (const path of ['../../../features/safety/migrations/0002_confirmations.sql', '../migrations/0003_tool_operations.sql'])
        native.exec(readFileSync(new URL(path, import.meta.url), 'utf8'));
    const { unit } = bindServerDatabase({ native, context: owner, observer: base.observer });
    const db: SafetySqlDatabase = unit;
    const memory = createMemoryToolOperationStore({});
    const memoryCards = createMemoryConfirmationExchange({ ...base, ...answerAudit() });
    let agentActive = true;
    function open(input: { store?: ToolOperationStore; confirmations?: ConfirmationExchangePort } = {}) {
        const store = input.store ?? (inputBackend === 'sql' ? createSqlToolOperationStore({ unit }) : memory);
        const confirmations: ConfirmationExchangePort = input.confirmations ?? (inputBackend === 'sql' ? createSqlConfirmationExchange({ ...base, db, ...answerAudit() }) : memoryCards);
        const tools = createOmTools({ ...base, store, confirmations, definitions: async () => ({ ok: true, value: [base.definition] }),
            authorize: ({ context }) => context.principal.kind === 'owner' || agentActive
                ? { ok: true, value: undefined } : { ok: false, error: { code: 'expired', message: 'Old agent run revoked', retryable: false } } });
        return { tools, confirmations, store };
    }
    const inputBackend = input.backend;
    return { ...base, open, revokeAgent() { agentActive = false; }, async close() { await base.tools.dispose({}); native.close(); } };
}
for (const backend of ['memory', 'sql'] as const) describe('durable tool operations / ' + backend, () => {
    it('restores the same card under fresh owner authority and executes exactly once', async () => {
        const f = durableFixture({ backend });
        try {
            const first = f.open();
            value({ result: await first.tools.dispatch({ context: agent, call: f.call }) });
            const card = value({ result: await first.tools.card({ context: owner, operationId: f.call.operationId }) })!;
            f.revokeAgent();
            const reopened = f.open();
            value({ result: await reopened.tools.restore({ context: owner }) });
            expect(f.effects).toEqual([]);
            expect(await reopened.tools.card({ context: owner, operationId: f.call.operationId })).toEqual({ ok: true, value: card });
            expect(value({ result: await reopened.confirmations.list({ context: owner, query: { limit: 100 } }) }).items).toEqual([card]);
            const response: ApprovalResponse = { cardId: card.cardId, operationId: card.operationId, argumentsDigest: card.argumentsDigest, choice: 'allow' };
            value({ result: await reopened.tools.answer({ context: owner, approver: { kind: 'local_token', ownerId: owner.scope.ownerId, deviceId: 'fixture-device', tokenId: 'fixture-token-reference' }, response }) });
            expect(f.effects).toEqual([{ value: 7 }]);
            expect(f.contexts[0]).toEqual({ ...agent, principal: owner.principal });
            expect(await reopened.tools.answer({ context: owner, approver: { kind: 'local_token', ownerId: owner.scope.ownerId, deviceId: 'fixture-device', tokenId: 'fixture-token-reference' }, response })).toMatchObject({ ok: false, error: { code: 'conflict' } });
            const terminal = f.open(); value({ result: await terminal.tools.restore({ context: owner }) });
            expect(await terminal.tools.dispatch({ context: owner, call: f.call })).toMatchObject({ ok: true, value: { status: 'completed' } });
            expect(f.effects).toHaveLength(1);
            await terminal.tools.dispose({});
        } finally { await f.close(); }
    });
    for (const crash of ['no-card', 'answered', 'expired', 'dispatching'] as const) it('does not resend after ' + crash + ' restart', async () => {
        const f = durableFixture({ backend });
        try {
            const first = f.open();
            value({ result: await first.tools.dispatch({ context: agent, call: f.call }) });
            const card = value({ result: await first.tools.card({ context: owner, operationId: f.call.operationId }) })!;
            const record = value({ result: await first.store.loadOpen({ scope: owner.scope }) })[0];
            const response: ApprovalResponse = { cardId: card.cardId, operationId: card.operationId, argumentsDigest: card.argumentsDigest, choice: 'allow' };
            if (crash === 'answered') value({ result: await first.confirmations.confirm({ context: owner, approver: { kind: 'local_token', ownerId: owner.scope.ownerId, deviceId: 'fixture-device', tokenId: 'fixture-token-reference' }, response }) });
            if (crash === 'expired') f.advance();
            if (crash === 'dispatching') record.executing = true;
            if (crash === 'no-card') { delete record.card; record.state = { status: 'pending', operationId: record.call.operationId }; }
            value({ result: await first.store.save({ context: agent, operation: record }) });
            f.revokeAgent(); const reopened = f.open();
            value({ result: await reopened.tools.restore({ context: owner }) });
            const status = crash === 'dispatching' ? 'unknown' : 'interrupted';
            expect(await reopened.tools.operation({ context: owner, operationId: f.call.operationId })).toMatchObject({ ok: true, value: { status } });
            if (crash === 'dispatching') {
                expect(await reopened.tools.dispatch({ context: owner, call: f.call })).toMatchObject({ ok: false, error: { retryable: false } });
                expect(await reopened.tools.operation({ context: owner, operationId: f.call.operationId })).toMatchObject({ value: { error: { retryable: false } } });
            }
            expect((await reopened.tools.answer({ context: owner, approver: { kind: 'local_token', ownerId: owner.scope.ownerId, deviceId: 'fixture-device', tokenId: 'fixture-token-reference' }, response })).ok).toBe(false);
            expect(f.effects).toEqual([]);
            await reopened.tools.dispose({});
        } finally { await f.close(); }
    });
    it('persists cancellation and preserves pending cards on clean shutdown', async () => {
        const f = durableFixture({ backend });
        try {
            const first = f.open(); value({ result: await first.tools.dispatch({ context: agent, call: f.call }) });
            await first.tools.cancel({ context: owner, runId: agent.runId! });
            const secondCall = { ...f.call, operationId: 'survives-shutdown' };
            value({ result: await first.tools.dispatch({ context: owner, call: secondCall }) });
            const card = value({ result: await first.tools.card({ context: owner, operationId: secondCall.operationId }) });
            await first.tools.dispose({});
            const reopened = f.open(); value({ result: await reopened.tools.restore({ context: owner }) });
            expect(await reopened.tools.operation({ context: owner, operationId: f.call.operationId })).toMatchObject({ ok: true, value: { status: 'cancelled' } });
            expect(await reopened.tools.card({ context: owner, operationId: secondCall.operationId })).toEqual({ ok: true, value: card });
            expect(f.effects).toEqual([]); await reopened.tools.dispose({});
        } finally { await f.close(); }
    });
    it('awaits the durable dispatch marker and refuses egress when saving it fails', async () => {
        const f = durableFixture({ backend });
        try {
            const { store } = f.open(); const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
            const guarded: ToolOperationStore = { ...store, loadOpen: input => store.loadOpen(input), async save(input) {
                if (input.operation.executing && input.operation.state.status === 'pending') {
                    entered.resolve(); await release.promise;
                    return { ok: false, error: { code: 'unavailable', message: 'Fixture disk failure', retryable: true } };
                }
                return store.save(input);
            } };
            const first = f.open({ store: guarded }); value({ result: await first.tools.dispatch({ context: agent, call: f.call }) });
            const card = value({ result: await first.tools.card({ context: owner, operationId: f.call.operationId }) })!;
            const answering = first.tools.answer({ context: owner, approver: { kind: 'local_token', ownerId: owner.scope.ownerId, deviceId: 'fixture-device', tokenId: 'fixture-token-reference' }, response: { cardId: card.cardId, operationId: card.operationId, argumentsDigest: card.argumentsDigest, choice: 'allow' } });
            await entered.promise; expect(f.effects).toEqual([]); release.resolve(); await answering;
            expect(await first.tools.dispatch({ context: owner, call: f.call })).toMatchObject({ ok: false, error: { retryable: false } });
            expect(f.effects).toEqual([]); await first.tools.dispose({});
        } finally { await f.close(); }
    });
});

for (const backend of ['memory', 'sql'] as const) describe('S1R1F regressions / ' + backend, () => {
    for (const failure of ['save', 'revoke'] as const) it('reports failed cancellation ' + failure + ' instead of acknowledging it', async () => {
        const f = durableFixture({ backend });
        try {
            const base = f.open();
            const failed: Outcome<void> = { ok: false, error: { code: 'unavailable', message: 'Fixture cancellation persistence failed', retryable: false } };
            const store: ToolOperationStore = { ...base.store, async save(input) {
                if (failure === 'save' && input.operation.state.status === 'cancelled') return failed;
                return base.store.save(input);
            } };
            const confirmations: ConfirmationExchangePort = { ...base.confirmations, async revoke(input) {
                return failure === 'revoke' ? failed : base.confirmations.revoke(input);
            } };
            const first = f.open({ store, confirmations });
            value({ result: await first.tools.dispatch({ context: agent, call: f.call }) });
            const card = value({ result: await first.tools.card({ context: owner, operationId: f.call.operationId }) })!;
            await expect(first.tools.cancel({ context: owner, runId: agent.runId! })).rejects.toMatchObject({ code: 'unavailable', retryable: false });
            expect((await first.tools.answer({ context: owner, approver: { kind: 'local_token', ownerId: owner.scope.ownerId, deviceId: 'fixture-device', tokenId: 'fixture-token-reference' }, response: { cardId: card.cardId, operationId: card.operationId,
                argumentsDigest: card.argumentsDigest, choice: 'allow' } })).ok).toBe(false);
            expect(f.effects).toEqual([]);
            await first.tools.dispose({});
            const reopened = f.open(); value({ result: await reopened.tools.restore({ context: owner }) });
            expect(await reopened.tools.operation({ context: owner, operationId: f.call.operationId })).toMatchObject({ ok: true,
                value: { status: failure === 'save' ? 'interrupted' : 'cancelled' } });
            expect(f.effects).toEqual([]); await reopened.tools.dispose({});
        } finally { await f.close(); }
    });
    it('reports persistence failure when the owner cancels through the approval card', async () => {
        const f = durableFixture({ backend });
        try {
            const base = f.open();
            const store: ToolOperationStore = { ...base.store, async save(input) {
                if (input.operation.state.status === 'cancelled') return { ok: false, error: { code: 'unavailable', message: 'Fixture save failure', retryable: false } };
                return base.store.save(input);
            } };
            const first = f.open({ store });
            value({ result: await first.tools.dispatch({ context: agent, call: f.call }) });
            const card = value({ result: await first.tools.card({ context: owner, operationId: f.call.operationId }) })!;
            expect(await first.tools.answer({ context: owner, approver: { kind: 'local_token', ownerId: owner.scope.ownerId, deviceId: 'fixture-device', tokenId: 'fixture-token-reference' }, response: { cardId: card.cardId, operationId: card.operationId,
                argumentsDigest: card.argumentsDigest, choice: 'cancel' } })).toMatchObject({ ok: false, error: { retryable: false } });
            expect(f.effects).toEqual([]); await first.tools.dispose({});
        } finally { await f.close(); }
    });
    it('completes 300 small operations and replays the oldest evicted body across restart', async () => {
        const f = durableFixture({ backend });
        f.definition.effects = ['read']; f.definition.policy = 'read';
        try {
            let current = f.open();
            for (let index = 0; index < 300; index++) {
                const call = { ...f.call, operationId: index === 0 ? 'oldest-z' : 'operation-' + index };
                expect(await current.tools.dispatch({ context: owner, call })).toEqual({ ok: true, value: { status: 'completed', output: { saved: 7 } } });
                if (index === 149) {
                    await current.tools.dispose({}); current = f.open();
                    value({ result: await current.tools.restore({ context: owner }) });
                }
            }
            const retained = value({ result: await current.store.loadOpen({ scope: owner.scope }) });
            expect(retained).toHaveLength(256);
            expect(retained.some(operation => operation.call.operationId === 'oldest-z')).toBe(false);
            const replay = value({ result: await current.store.replay({ context: owner, operationId: 'oldest-z' }) });
            expect(replay?.call.input).toEqual({}); expect(replay?.request.arguments).toEqual({});
            const call = { ...f.call, operationId: 'oldest-z' };
            expect(await current.tools.dispatch({ context: owner, call })).toEqual({ ok: true, value: { status: 'completed', output: { saved: 7 } } });
            expect(await current.tools.operation({ context: owner, operationId: call.operationId })).toEqual({ ok: true,
                value: { status: 'completed', operationId: call.operationId, output: { saved: 7 } } });
            await current.tools.dispose({}); current = f.open(); value({ result: await current.tools.restore({ context: owner }) });
            expect(await current.tools.dispatch({ context: owner, call })).toEqual({ ok: true, value: { status: 'completed', output: { saved: 7 } } });
            expect(await current.tools.dispatch({ context: owner, call: { ...call, input: { value: 8 } } })).toMatchObject({ ok: false, error: { code: 'conflict' } });
            expect(f.effects).toHaveLength(300);
            await current.tools.dispose({});
        } finally { await f.close(); }
    });
});

for (const lifecycle of ['endRun', 'dispose', 'stream'] as const) it('awaits frontend disconnect persistence during ' + lifecycle, async () => {
    const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
    const f = await frontendFixture({ throughHttp: false, async disconnected() { entered.resolve(); await release.promise; } });
    let settled = false;
    try {
        const stopping = lifecycle === 'endRun'
            ? f.relay.endRun({ context: owner, runId: 'run', status: 'cancelled' })
            : lifecycle === 'dispose' ? f.relay.dispose({}) : f.stream.cancel({});
        const observed = stopping.then(() => { settled = true; });
        await entered.promise; expect(settled).toBe(false);
        release.resolve(); await observed; expect(settled).toBe(true);
    } finally { release.resolve(); await f.dispose(); }
});

it('reports frontend disconnect persistence errors through endRun and disposal', async () => {
    const failure = { code: 'unavailable', message: 'Fixture revoke failed', retryable: false };
    const f = await frontendFixture({ throughHttp: false, async disconnected() { throw failure; } });
    try {
        await expect(f.relay.endRun({ context: owner, runId: 'run', status: 'cancelled' })).rejects.toEqual(failure);
        await expect(f.relay.dispose({})).rejects.toEqual(failure);
    } finally { await f.tools.dispose({}); }
});

it('routes OAuth HTTP and assistant starts through one write card and keeps callback secrets outside tools', async () => {
    const f = fixture({}); const addons = addonFixture(); const starts: CallContext[] = [];
    const challenge = { transactionId: 'sign-in', authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=fixture-state', expiresAt: 301000 };
    addons.integrations.startOAuth = async input => { starts.push(input.context); return { ok: true, value: challenge }; };
    addons.integrations.oauthStatus = async input => ({ ok: true, value: 'pluginId' in input ? { configured: true, clientId: 'fixture-client' } : { status: 'pending' } });
    const definitions = value({ result: await buildOmToolDefinitions({ context: agent, services: f.services, addons }) });
    const tools = createOmTools({ clock: f.clock, observer: f.observer, confirmations: f.services.confirmations,
        authorize: () => ({ ok: true, value: undefined }), definitions: async () => ({ ok: true, value: definitions }) });
    try {
        const start = definitions.find(tool => tool.name === 'integrations_oauth_start')!;
        expect(start).toMatchObject({ policy: 'write', ownerRoute: 'integrationOAuthStart' });
        expect(start.parse({ input: { pluginId: 'google-ads', code: 'never-chat' } })).toMatchObject({ ok: false });
        expect(definitions.some(tool => tool.name === 'integrations_oauth_callback')).toBe(false);
        expect(definitions.some(tool => tool.name === 'integrations_oauth_client_set' || tool.name === 'integrations_oauth_client_clear')).toBe(false);
        expect(definitions.find(tool => tool.name === 'integrations_oauth_status')!.parse({ input: { pluginId: 'google-ads', clientSecret: 'never-chat' } })).toMatchObject({ ok: false });
        expect(await tools.dispatch({ context: agent, call: { name: 'integrations_oauth_status', input: { pluginId: 'google-ads' }, operationId: 'client-status' } })).toMatchObject({ value: { status: 'completed', output: { configured: true, clientId: 'fixture-client' } } });
        const integrations = addons.integrations as Integrations;
        const response = await handleIntegrationRequest({ context: owner, integrations, services: { tools }, request: { method: 'POST', path: routes.integrationOAuthStart.path,
            headers: { 'idempotency-key': 'http-start' }, body: { pluginId: 'google-ads' } } });
        expect(response).toMatchObject({ status: 200, body: { value: { status: 'pending', operationId: 'http-start' } } });
        expect(starts).toEqual([]);
        for (const [context, operationId] of [[owner, 'http-start'], [agent, 'assistant-start']] as const) {
            value({ result: await tools.dispatch({ context, call: { name: start.name, input: { pluginId: 'google-ads' }, operationId } }) });
            const card = value({ result: await tools.card({ context, operationId }) })!;
            value({ result: await tools.answer({ context: owner, approver: { kind: 'local_token', ownerId: owner.scope.ownerId, deviceId: 'fixture-device', tokenId: 'fixture-token-reference' }, response: { cardId: card.cardId, operationId, argumentsDigest: card.argumentsDigest, choice: 'allow' } }) });
            expect(value({ result: await tools.operation({ context, operationId }) })).toMatchObject({ status: 'completed', output: challenge });
        }
        expect(starts).toHaveLength(2);
        expect(starts[1]).toMatchObject({ principal: owner.principal, runId: agent.runId, scope: agent.scope });
        expect(await tools.dispatch({ context: agent, call: { name: 'integrations_oauth_status', input: { transactionId: 'sign-in' }, operationId: 'status' } })).toMatchObject({ value: { status: 'completed', output: { status: 'pending' } } });
        expect(generateOmToolCoverage({ definitions }).find(row => row.tool === start.name)).toMatchObject({ http: routes.integrationOAuthStart.path, policy: 'write', status: 'connected' });
        expect(ownerRouteDisposition.integrationOAuthCallback).toContain('codes never enter assistant');
    } finally { await tools.dispose({}); await f.tools.dispose({}); }
});

it('direct conversations/settings bindings keep scope, pagination, output validation and mutation identity', async () => {
    const f = fixture({}); const seen: unknown[] = [];
    const conversations = { async list(input: Parameters<NonNullable<OwnerServices['conversations']>['list']>[0]) { seen.push(input); return { ok: true, value: { items: [], cursor: null } }; },
        async read(input: Parameters<NonNullable<OwnerServices['conversations']>['read']>[0]) { seen.push(input); return { ok: false, error: { code: 'forbidden', message: 'Conversation unavailable in owner scope', retryable: false } }; },
        async setSettings(input: Parameters<NonNullable<OwnerServices['conversations']>['setSettings']>[0]) { seen.push(input); return { ok: true, value: { invalid: true } }; } } as unknown as NonNullable<OwnerServices['conversations']>;
    const definitions = value({ result: await buildOmToolDefinitions({ context: agent, services: { ...f.services, conversations } }) });
    try {
        expect(await definitions.find(tool => tool.name === 'om_conversations_list')!.invoke({ context: agent, input: { limit: 3, cursor: 'next' } })).toEqual({ ok: true, value: { items: [], cursor: null } });
        expect(seen[0]).toEqual({ context: { ...agent, principal: owner.principal }, query: { limit: 3, cursor: 'next' } });
        expect(await definitions.find(tool => tool.name === 'om_conversations_get')!.invoke({ context: agent, input: { id: 'conversation', limit: 2, cursor: 'page' } })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
        expect(seen[1]).toEqual({ context: { ...agent, principal: owner.principal }, conversationId: 'conversation', query: { limit: 2, cursor: 'page' } });
        const settings = { mode: 'sandbox', model: 'fixture', connectionId: null };
        const write = definitions.find(tool => tool.name === 'om_assistant_settings_set')!;
        expect(write.ownerOnly).toBe(true);
        expect(await write.invoke({ context: owner, input: settings })).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
        expect(seen[2]).toEqual({ context: owner, settings });
        expect(await definitions.find(tool => tool.name === 'om_conversations_list')!.invoke({ context: agent, input: { limit: 11 } })).toMatchObject({ ok: false });
        expect(seen).toHaveLength(3);
        expect(await definitions.find(tool => tool.name === 'om_conversations_get')!.invoke({ context: agent, input: { id: 'x/y', limit: 2 } })).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    } finally { await f.tools.dispose({}); }
});

it('agent lead changes require an exact card every time and reject retained broad grants', async () => {
    const f = fixture({});
    const leads = createLeadsService({ repo: createMemoryLeadsRepo({}), clock: f.clock, ids: f.ids });
    const lead = value({ result: await leads.capture({ context: owner, subjectId: 'lead-subject', source: { kind: 'manual', ref: 'agent-stage' },
        occurredAt: 1000, attribution: { campaign: null, touchId: null, touchedAt: null, modelVersion: 'last_paid_touch_30d.v1' } }) });
    const tools = createOmTools({ ...f, confirmations: f.services.confirmations, authorize: () => ({ ok: true, value: undefined }),
        definitions: input => buildOmToolDefinitions({ ...input, services: { ...f.services, leads } }) });
    try {
        const call = { name: 'om_leads_set_stage', operationId: 'lead-change-1', input: { leadId: lead.leadId, to: 'qualified', expectedRevision: 1, changeId: 'lead-change-1' } };
        expect(await tools.dispatch({ context: agent, call })).toMatchObject({ ok: true, value: { status: 'pending' } });
        const card = value({ result: await tools.card({ context: owner, operationId: call.operationId }) });
        if (!card) throw new Error('Expected lead stage card');
        expect(card.allowedChoices).not.toContain('always_allow');
        expect(card.allowedChoices).not.toContain('allow_chat');
        const response = { cardId: card.cardId, operationId: call.operationId, argumentsDigest: card.argumentsDigest, choice: 'always_allow' as const };
        expect(await tools.answer({ context: owner, approver: f.services.approver!, response })).toMatchObject({ ok: false });
        value({ result: await tools.answer({ context: owner, approver: f.services.approver!, response: { ...response, choice: 'allow' } }) });
        expect(await leads.get({ context: owner, leadId: lead.leadId })).toMatchObject({ ok: true, value: { stage: 'qualified', revision: 2 } });
        expect(await tools.dispatch({ context: agent, call: { ...call, operationId: 'lead-change-2', input: { ...call.input, to: 'won', expectedRevision: 2, changeId: 'lead-change-2' } } }))
            .toMatchObject({ ok: true, value: { status: 'pending' } });
        expect(await leads.get({ context: owner, leadId: lead.leadId })).toMatchObject({ ok: true, value: { stage: 'qualified', revision: 2 } });
    } finally { await tools.dispose({}); await f.tools.dispose({}); }
});

it('shares owner-only measurement grant cards across the HTTP/CLI/assistant dispatcher and persists only Allow', async () => {
    const f = fixture({}); const native = new Database(':memory:');
    const presented = vi.spyOn(f.services.confirmations, 'present');
    for (const migration of ['0001_measure', '0005_measurement_grants'])
        native.exec(readFileSync(new URL('../../../features/measure/migrations/' + migration + '.sql', import.meta.url), 'utf8'));
    const database = bindServerDatabase({ native, context: owner, observer: f.observer }).workspace;
    f.services.measurementGrants = bindMeasurementGrants({ database, clock: f.clock, ids: f.ids, observer: f.observer });
    const definitions = value({ result: await buildOmToolDefinitions({ context: agent, services: f.services }) });
    const tools = createOmTools({ ...f, confirmations: f.services.confirmations, authorize: () => ({ ok: true, value: undefined }),
        definitions: async () => ({ ok: true, value: definitions }) });
    f.services.tools = tools;
    const input = { grantId: 'sharing', connectionId: 'connection', accountId: 'account', definitionIds: ['qualified'], destination: 'fixture-plugin', purpose: 'measurement', expiresAt: 10000 };
    try {
        const names = ['om_measure_grants_list', 'om_measure_grant', 'om_measure_revoke_grant'];
        expect(definitions.filter(tool => names.includes(tool.name)).map(tool => tool.name)).toEqual(names);
        for (const name of names.slice(1)) expect(definitions.find(tool => tool.name === name)!.ownerOnly).toBe(true);
        expect(generateOmToolCoverage({ definitions }).filter(row => row.tool && names.includes(row.tool)).map(row => row.studio))
            .toEqual(names.map(() => 'Integrations and chat via execute_tool'));
        for (const choice of ['cancel', 'allow'] as const) {
            const operationId = 'grant-' + choice;
            const response = await handleOwnerRequest({ context: owner, services: f.services, request: { method: 'POST', path: '/api/tools/call',
                body: { name: 'om_measure_grant', input, operationId } } });
            expect(response).toMatchObject({ status: 200, body: { ok: true, value: { status: 'pending', operationId, cardId: expect.any(String) } } });
            expect(native.prepare('SELECT * FROM measure_grant').all()).toHaveLength(0);
            const card = value({ result: await tools.card({ context: owner, operationId }) })!;
            expect(card.allowedChoices).toEqual(['allow', 'cancel']);
            expect(presented.mock.calls.at(-1)![0].request).not.toHaveProperty('operationScope');
            const answer = { cardId: card.cardId, operationId, argumentsDigest: card.argumentsDigest, choice };
            expect(await tools.answer({ context: owner, approver: f.services.approver!, response: { ...answer, choice: 'always_allow' } })).toMatchObject({ ok: false });
            value({ result: await tools.answer({ context: owner, approver: f.services.approver!, response: answer }) });
            expect(native.prepare('SELECT * FROM measure_grant').all()).toHaveLength(choice === 'allow' ? 1 : 0);
        }
        const audit = native.prepare('SELECT context_json FROM measure_egress_audit').all();
        expect(audit).toEqual([{ context_json: JSON.stringify(owner) }]);
    } finally { await tools.dispose({}); await f.tools.dispose({}); native.close(); }
});


it('exposes conversion settings reads and requires a fresh exact owner card for every assistant replacement', async () => {
    const f = fixture({}); const addons = addonFixture(); const writes: CallContext[] = [];
    const status = { pluginId: 'fixture-conversions', declaration: null, values: null };
    addons.integrations.conversionSettings = async () => ({ ok: true, value: status });
    addons.integrations.setConversionSettings = async input => { writes.push(input.context); return { ok: true, value: { ...status, values: {} } }; };
    const tools = createOmTools({ clock: f.clock, observer: f.observer, confirmations: f.services.confirmations,
        authorize: () => ({ ok: true, value: undefined }), definitions: input => buildOmToolDefinitions({ ...input, services: f.services, addons }) });
    try {
        const definitions = value({ result: await buildOmToolDefinitions({ context: agent, services: f.services, addons }) });
        expect(definitions.find(tool => tool.name === 'integrations_conversion_settings_set')).toMatchObject({ ownerOnly: true, policy: 'write', ownerRoute: 'setIntegrationConversionSettings' });
        expect(await tools.dispatch({ context: agent, call: { name: 'integrations_conversion_settings_get', operationId: 'conversion-read', input: { pluginId: status.pluginId } } })).toMatchObject({ ok: true, value: { status: 'completed', output: status } });
        for (const operationId of ['conversion-save-one', 'conversion-save-two']) {
            const call = { name: 'integrations_conversion_settings_set', operationId, input: { pluginId: status.pluginId, values: {} } };
            expect(await tools.dispatch({ context: agent, call })).toMatchObject({ value: { status: 'pending' } });
            const card = value({ result: await tools.card({ context: owner, operationId }) })!;
            expect(card.allowedChoices).toEqual(['allow', 'cancel']);
            expect(await tools.answer({ context: owner, approver: f.services.approver!, response: { cardId: card.cardId, operationId, argumentsDigest: card.argumentsDigest, choice: 'always_allow' } })).toMatchObject({ ok: false });
            expect(writes).toHaveLength(operationId.endsWith('one') ? 0 : 1);
            expect(await tools.answer({ context: owner, approver: f.services.approver!, response: { cardId: card.cardId, operationId, argumentsDigest: card.argumentsDigest, choice: 'allow' } })).toMatchObject({ ok: true });
        }
        expect(writes).toEqual([expect.objectContaining(owner), expect.objectContaining(owner)]);
        expect(generateOmToolCoverage({ definitions })).toEqual(expect.arrayContaining([
            expect.objectContaining({ tool: 'integrations_conversion_settings_get', http: routes.integrationConversionSettings.path }),
            expect.objectContaining({ tool: 'integrations_conversion_settings_set', http: routes.setIntegrationConversionSettings.path }),
        ]));
    } finally { await tools.dispose({}); await f.tools.dispose({}); }
});

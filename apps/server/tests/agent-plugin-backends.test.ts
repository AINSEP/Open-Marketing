/** R1 written-only fixtures. All transports below are injected; no vendor or native fetch is used. */
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import type { CallContext, Outcome, ToolCall } from '@open-marketing/contracts';
import { boundedJsonSchema } from '@open-marketing/contracts';
import { createMemoryConfirmationExchange, createMemorySafetyRepo, createMemoryAccountDispatchLock, createMemoryPlatformLimitEvidence,
    createMemorySpendPolicy, createMemorySafetyAudit, createSafetyService, digestArguments } from '@open-marketing/safety';
import type { SafetyService, EffectRequest, ConfirmationExchangePort } from '@open-marketing/safety';
import { bindAgentPluginBackends, bindAgentPluginJobs } from '../src/composition/agent-plugin-backends.js';
import type { AgentPluginState } from '../src/composition/agent-plugin-backends.js';
import { bindServerDatabase, provisionWorkspace } from '../src/composition/database.js';
import { migrationManifest } from '../src/composition/migrations.js';
import { createNodeBootIo } from '../src/composition/serve.js';
import { generateOmToolCoverage } from '../src/om-tool-coverage.js';
import { createOmTools, toolPolicy } from '../src/om-tools.js';
import { createMemoryCampaignRepo } from '@open-marketing/campaigns';
import type { NeutralCampaignLaunch } from '@open-marketing/campaigns';
import { bindPausedCampaignDeployment } from '../src/composition/campaigns.js';

const context: CallContext = { scope: { ownerId: 'owner', workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }, principal: { kind: 'owner', ownerId: 'owner' }, correlationId: 'correlation', traceId: 'trace', runId: 'fixture-run' };
const pluginIds = ['google-ads', 'linkedin-ads', 'tiktok-ads', 'meta-ads'] as const;
const clock = { now: () => 1000 };
const observer = { observe() {} };
function value<T>(required: { result: Outcome<T> }): T { if (!required.result.ok) throw new Error(required.result.error.message); return required.result.value; }

/** Load verifier-built entries with literal specifiers; only serve.ts owns computed imports.
 * Node 24 supports require(ESM). These inert bundles have no top-level await or vendor I/O.
 */
function loadFixtureModule(required: { moduleUrl: string }): object {
    const require = createRequire(import.meta.url);
    const pluginId = new URL(required.moduleUrl).pathname.split('/').at(-4);
    switch (pluginId) {
        case 'google-ads': return require('../../../content/agent-plugins/google-ads/io.github.ainsep.openmarketing/dist/index.mjs') as object;
        case 'linkedin-ads': return require('../../../content/agent-plugins/linkedin-ads/io.github.ainsep.openmarketing/dist/index.mjs') as object;
        case 'tiktok-ads': return require('../../../content/agent-plugins/tiktok-ads/io.github.ainsep.openmarketing/dist/index.mjs') as object;
        case 'higgsfield-media': return require('../../../content/agent-plugins/higgsfield-media/io.github.ainsep.openmarketing/dist/index.mjs') as object;
        case 'meta-ads': return require('../../../content/agent-plugins/meta-ads/io.github.ainsep.openmarketing/dist/index.mjs') as object;
        default: throw new Error('Unknown fixture plugin');
    }
}

async function fixture(required: { admitted?: boolean; only?: string; safety?: SafetyService; confirmations?: ConfirmationExchangePort; fetch?: typeof fetch } = {}) {
    const native = new Database(':memory:');
    native.pragma('foreign_keys = ON');
    for (const entry of migrationManifest) native.exec(readFileSync(new URL('../../../' + entry.path, import.meta.url), 'utf8'));
    const database = bindServerDatabase({ native, observer, context });
    await provisionWorkspace({ database: database.workspace, scope: context.scope });
    const ids = { next: () => randomUUID() };
    const jobs = bindAgentPluginJobs({ unit: database.unit, clock, ids, observer });
    const states = new Map<string, AgentPluginState>();
    for (const pluginId of pluginIds) {
        const manifest = JSON.parse(readFileSync(new URL('../../../content/agent-plugins/' + pluginId + '/plugin.json', import.meta.url), 'utf8'));
        states.set(pluginId, { enabled: !required.only || required.only === pluginId, bundled: true, admitted: required.admitted ?? manifest.extensions['io.github.ainsep.openmarketing'].admitted === true,
            revision: 'a'.repeat(64), metadata: manifest.extensions['io.github.ainsep.openmarketing'] });
    }
    const calls: { url: string; options?: RequestInit }[] = [];
    const accesses: { context: CallContext; pluginId: string; connectionId: string }[] = [];
    let beforeCredential: () => Promise<void> = async () => {};
    let failure: { stage: 'state' | 'module' | 'descriptors'; pluginId: string } | undefined;
    const loads: string[] = [];
    let bundleDigest = 'd'.repeat(64);
    let halted = false;
    const safetyRepo = createMemorySafetyRepo({ clock, ids, ownerTimezone: 'UTC' });
    const ports: Parameters<typeof bindAgentPluginBackends>[0] = { projectRoot: fileURLToPath(new URL('../../../', import.meta.url)), clock, observer,
        jobs, mode: 'sandbox', safety: required.safety, confirmations: required.confirmations, accountLocks: createMemoryAccountDispatchLock({ ids }),
        async state({ pluginId }) {
            if (failure?.stage === 'state' && failure.pluginId === pluginId) throw new Error('Fixture metadata missing');
            return states.get(pluginId) ?? null;
        },
        async moduleDigest() { return bundleDigest; },
        async loadModule({ moduleUrl }) {
            loads.push(moduleUrl);
            if (!moduleUrl.includes('/' + failure?.pluginId + '/')) return loadFixtureModule({ moduleUrl });
            if (failure?.stage === 'module') throw new Error('Fixture module missing');
            return {};
        },
        async wait() { return { ok: true, value: undefined }; },
        fetch: async (url, options) => {
            expect(native.inTransaction).toBe(false);
            calls.push({ url: String(url), options });
            const body = String(url).includes('linkedin') ? { elements: [] } : String(url).includes('facebook') ? { data: [] } : {};
            return required.fetch ? required.fetch(url, options) : new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
        },
        integrations: { async access(input) { accesses.push(input); await beforeCredential(); return { ok: true, value: { accessToken: 'fixture-token-for-' + input.pluginId } }; } },
        accounts: { async find({ externalAccountId }) { return { ok: true, value: { id: 'binding', scope: context.scope, connectionId: 'connection', externalAccountId } }; } },
        safetyRepo: { async snapshot(input) { const result = await safetyRepo.snapshot(input); return result.ok ? { ok: true, value: { ...result.value, halted } } : result; } },
    };
    const binding = bindAgentPluginBackends(ports);
    return { native, binding, ports, unit: database.unit, states, jobs, calls, accesses, ids, safetyRepo, loads,
        changeBundle() { bundleDigest = 'e'.repeat(64); },
        setFailure(input: NonNullable<typeof failure>) { failure = input; },
        setBeforeCredential(input: { callback(): Promise<void> }) { beforeCredential = input.callback; },
        halt() { halted = true; }, close() { native.close(); } };
}
const readArguments: Record<string, Record<string, ToolCall['input']>> = {
    'google-ads': { operationId: 'read', }, 'linkedin-ads': { kind: 'list_accounts' },
    'tiktok-ads': { kind: 'get-advertiser' }, 'meta-ads': {},
};
const readNames: Record<string, string> = { 'google-ads': 'vendor_google_ads_list_accounts', 'linkedin-ads': 'vendor_linkedin_ads_list_accounts', 'tiktok-ads': 'vendor_tiktok_ads_tiktok_ads_get_advertiser', 'meta-ads': 'vendor_meta_ads_instagram_accounts' };
it('fences LinkedIn admission before its adapter can resolve credentials or claim a mutation', async () => {
    const f = await fixture({ admitted: true, only: 'linkedin-ads' });
    try {
        const definition = value({ result: await f.binding.definitions({ context }) }).find(tool => tool.name === 'vendor_linkedin_ads_pause')!;
        f.states.get('linkedin-ads')!.admitted = false;
        expect(await definition.invoke({ context, input: { operationId: 'unadmitted-pause', connectionId: 'connection', accountId: '123', arguments: { kind: 'pause', campaignId: '456' } } })).toMatchObject({ ok: false });
        expect(f.accesses).toEqual([]); expect(f.calls).toEqual([]);
        expect(f.native.prepare("SELECT id FROM job WHERE operation='agent-plugin.invoke'").all()).toEqual([]);
    } finally { f.close(); }
});
it('rechecks the owning campaign card after LinkedIn credentials resolve and before transport', async () => {
    const confirmations = createMemoryConfirmationExchange({ clock, ids: { next: () => randomUUID() } });
    const f = await fixture({ admitted: true, only: 'linkedin-ads', confirmations });
    try {
        const definition = value({ result: await f.binding.definitions({ context }) }).find(tool => tool.name === 'vendor_linkedin_ads_pause')!;
        const input = { operationId: 'group-child', connectionId: 'connection', accountId: '123', arguments: { kind: 'pause', campaignId: '456' } };
        const args = { tool: definition.name, input };
        const child: EffectRequest = { arguments: args, pluginDigest: definition.revision, schemaFingerprint: 'c'.repeat(64), envelope: { operationId: input.operationId, connectionId: 'connection', accountId: '123', effects: ['write'], argumentsDigest: value({ result: digestArguments({ arguments: args }) }), moneyExposure: null, requiredLimit: null } };
        const reviewed = { calls: [child] };
        const root: EffectRequest = { ...child, arguments: reviewed, pausedCampaignCalls: [child], envelope: { ...child.envelope, operationId: 'group', accountId: null, effects: ['ad_spend'], argumentsDigest: value({ result: digestArguments({ arguments: reviewed }) }) } };
        const card = value({ result: await confirmations.present({ context, request: root }) });
        value({ result: await confirmations.confirm({ context, response: { cardId: card.cardId, operationId: card.operationId, argumentsDigest: card.argumentsDigest, choice: 'allow' } }) });
        f.setBeforeCredential({ async callback() { value({ result: await confirmations.revoke({ context, cardId: card.cardId }) }); } });
        expect(await definition.invoke({ context, input, authorization: { ...child, approvalId: card.cardId, policyRevision: 0, campaignApproval: { operationId: 'group', argumentsDigest: card.argumentsDigest, index: 0 } }, permit: { operationId: input.operationId, argumentsDigest: child.envelope.argumentsDigest, approvalId: card.cardId, expiresAt: 30000, reservationId: 'fixture-permit' } })).toMatchObject({ ok: false });
        expect(f.accesses).toHaveLength(1); expect(f.calls).toEqual([]);
    } finally { f.close(); }
});
function selection(required: { pluginId: string; operationId?: string }) {
    return { operationId: required.operationId ?? 'read', connectionId: 'connection', accountId: required.pluginId === 'meta-ads' ? null : required.pluginId === 'google-ads' ? '1234567890' : '123',
        currency: 'USD', timezone: 'UTC', arguments: readArguments[required.pluginId] };
}

it('exposes vendor-owned schemas/policies but unadmitted plugins make zero credential and fetch calls', async () => {
    const f = await fixture();
    try {
        const definitions = value({ result: await f.binding.definitions({ context }) });
        for (const name of Object.values(readNames)) expect(definitions.find(tool => tool.name === name)?.policy).toBe('read');
        for (const name of ['vendor_google_ads_activate', 'vendor_linkedin_ads_activate', 'vendor_tiktok_ads_tiktok_ads_activate_entity']) expect(definitions.find(tool => tool.name === name)?.policy).toBe('spend');
        expect(definitions.find(tool => tool.name === 'vendor_meta_ads_instagram_publish_post')?.policy).toBe('write');
        expect(toolPolicy({ effects: ['read', 'future-effect'] })).toBe('write');
        for (const pluginId of pluginIds) {
            const tool = definitions.find(tool => tool.name === readNames[pluginId])!;
            expect(tool.unavailableReason).toContain('unadmitted');
            expect(await tool.invoke({ context, input: selection({ pluginId }) })).toMatchObject({ ok: false });
        }
        expect(f.calls).toEqual([]); expect(f.accesses).toEqual([]);
    } finally { f.close(); }
});

it('resolves only the invoking plugin token freshly with a server-created service context', async () => {
    const f = await fixture({ admitted: true });
    try {
        const definitions = value({ result: await f.binding.definitions({ context }) });
        for (const pluginId of pluginIds) {
            const tool = definitions.find(tool => tool.name === readNames[pluginId])!;
            const result = await tool.invoke({ context, input: selection({ pluginId }) });
            expect(f.accesses.at(-1)).toMatchObject({ pluginId, connectionId: 'connection', context: { principal: { kind: 'service', serviceId: 'om-agent-plugin-backends' }, correlationId: 'correlation', traceId: 'trace' } });
            expect(f.calls.length).toBe(f.accesses.length);
            const headers = new Headers(f.calls.at(-1)?.options?.headers);
            expect(headers.get('authorization') ?? headers.get('Access-Token')).toContain('fixture-token-for-' + pluginId);
            expect(JSON.stringify(result)).not.toContain('fixture-token');
        }
        expect(f.accesses).toHaveLength(4);
    } finally { f.close(); }
});

it('denies disable/revision changes while credentials are pending, before fetch', async () => {
    for (const change of ['disable', 'revision', 'admission'] as const) {
        const f = await fixture({ admitted: true, only: 'linkedin-ads' });
        try {
            const tool = value({ result: await f.binding.definitions({ context }) }).find(tool => tool.name === readNames['linkedin-ads'])!;
            f.setBeforeCredential({ async callback() {
                const state = f.states.get('linkedin-ads')!;
                if (change === 'disable') state.enabled = false;
                if (change === 'revision') f.states.set('linkedin-ads', { ...state, revision: 'b'.repeat(64) });
                if (change === 'admission') state.admitted = false;
            } });
            expect(await tool.invoke({ context, input: selection({ pluginId: 'linkedin-ads' }) })).toMatchObject({ ok: false });
            expect(f.calls).toEqual([]);
        } finally { f.close(); }
    }
});

it('keeps disabled/uploaded backends absent and rejects malformed vendor commands before credentials', async () => {
    const f = await fixture({ admitted: true });
    try {
        f.states.get('google-ads')!.enabled = false;
        f.states.get('tiktok-ads')!.bundled = false;
        const definitions = value({ result: await f.binding.definitions({ context }) });
        expect(definitions.some(tool => tool.name.startsWith('vendor_google_ads_') || tool.name.startsWith('vendor_tiktok_ads_'))).toBe(false);
        expect(f.loads.some(url => url.includes('/google-ads/') || url.includes('/tiktok-ads/'))).toBe(false);
        const tool = definitions.find(tool => tool.name === readNames['linkedin-ads'])!;
        expect(tool.parse({ input: { ...selection({ pluginId: 'linkedin-ads' }), arguments: { kind: 'activate', entityIds: ['1', '2'] } } })).toMatchObject({ ok: false });
        expect(f.accesses).toEqual([]); expect(f.calls).toEqual([]);
    } finally { f.close(); }
});

it.each(['state', 'module', 'descriptors'] as const)('isolates one plugin %s failure while healthy tools remain discoverable', async stage => {
    const f = await fixture();
    try {
        f.setFailure({ stage, pluginId: 'google-ads' });
        const definitions = value({ result: await f.binding.definitions({ context }) });
        const unavailable = definitions.find(tool => tool.name === 'vendor_google_ads_unavailable')!;
        expect(unavailable.unavailableReason).toContain('om:build-plugins');
        expect(await unavailable.invoke({ context, input: {} })).toMatchObject({ ok: false, error: { code: 'unavailable' } });
        for (const pluginId of ['linkedin-ads', 'tiktok-ads', 'meta-ads']) expect(definitions.some(tool => tool.name === readNames[pluginId])).toBe(true);
        const confirmations = createMemoryConfirmationExchange({ clock, ids: f.ids });
        const tools = createOmTools({ definitions: input => f.binding.definitions(input), confirmations, clock, observer, authorize: () => ({ ok: true, value: undefined }) });
        try {
            const listed = value({ result: await tools.list({ context, limit: 100 }) });
            expect(listed.some(tool => tool.name === readNames['linkedin-ads'])).toBe(true);
        } finally { tools.dispose({}); }
        expect(f.calls).toEqual([]); expect(f.accesses).toEqual([]);
    } finally { f.close(); }
});

it('claims the one durable outbox once across binding recreation and leaves uncertain outcomes for reconciliation', async () => {
    const f = await fixture(); let sends = 0;
    try {
        const input = { context, pluginId: 'fixture', input: selection({ pluginId: 'linkedin-ads' }), async execute(): Promise<Outcome<unknown>> { sends++; return { ok: true, value: { status: 'unknown' } }; } };
        await Promise.all([f.jobs.dispatch(input), f.jobs.dispatch(input)]);
        const replacement = bindAgentPluginJobs({ unit: bindServerDatabase({ native: f.native, context, observer }).unit, clock, ids: f.ids, observer });
        expect(await replacement.dispatch(input)).toMatchObject({ ok: false, error: { code: 'conflict' } });
        expect(sends).toBe(1);
        expect(f.native.prepare("SELECT state FROM job WHERE operation='agent-plugin.invoke'").all()).toEqual([{ state: 'reconcile' }]);
        expect(f.native.prepare("SELECT event_type FROM job_attempt ORDER BY sequence").all().map(row => (row as { event_type: string }).event_type)).toEqual(expect.arrayContaining(['enqueue', 'claim', 'dispatch', 'complete']));
    } finally { f.close(); }
});

it('uses one exact spend card for each single-entity activation and never a gateway card', async () => {
    const ids = { next: () => randomUUID() };
    const confirmations = createMemoryConfirmationExchange({ clock, ids });
    const repo = createMemorySafetyRepo({ clock, ids, ownerTimezone: 'UTC' });
    const requests: EffectRequest[] = [];
    const safety = createSafetyService({ repo, confirmations, clock, ids, policy: createMemorySpendPolicy({}),
        effects: { async resolve({ request }) { const known = requests.find(item => item.envelope.operationId === request.envelope.operationId); return known ? { ok: true, value: known.envelope } : { ok: false, error: { code: 'forbidden', message: 'Unverified fixture', retryable: false } }; },
            async verifyGenerationQuote() { throw new Error('Not a generation fixture'); }, async verifyHaltStop() { throw new Error('Not a stop fixture'); } },
        accountLocks: createMemoryAccountDispatchLock({ ids }), audit: createMemorySafetyAudit({}),
        platformLimits: createMemoryPlatformLimitEvidence({ evidence: [{ scope: context.scope, evidence: { evidenceId: 'cap', accountId: '123', amount: { currency: 'USD', minorUnits: 1000 },
            window: { start: 0, end: 100000 }, observedAt: 1000, semantics: 'hard_limit', pluginDigest: createHash('sha256').update(JSON.stringify(['a'.repeat(64), 'd'.repeat(64)])).digest('hex') } }] }) });
    const f = await fixture({ admitted: true, only: 'linkedin-ads', safety });
    try {
        const definition = value({ result: await f.binding.definitions({ context }) }).find(tool => tool.name === 'vendor_linkedin_ads_activate')!;
        const tools = createOmTools({ definitions: input => f.binding.definitions(input), clock, observer, confirmations, authorize: () => ({ ok: true, value: undefined }) });
        for (const operationId of ['activate-one', 'activate-two']) {
            const input = { ...selection({ pluginId: 'linkedin-ads', operationId }), arguments: { kind: 'activate', entityType: 'campaign', entityId: '456' },
                moneyExposure: { amount: { currency: 'USD', minorUnits: 100 }, window: { start: 0, end: 100000 } },
                requiredLimit: { amount: { currency: 'USD', minorUnits: 1000 }, timezone: 'UTC', evidenceId: 'cap', semantics: 'hard_limit' } };
            const call = { name: definition.name, operationId, input } as ToolCall;
            requests.push(value({ result: await definition.prepareEffect!({ context, call }) }));
            expect(await tools.dispatch({ context, call })).toMatchObject({ ok: true, value: { status: 'pending' } });
            const card = value({ result: await tools.card({ context, operationId }) })!;
            expect(card.classification).toBe('spend'); expect(card.allowedChoices).toEqual(['allow', 'cancel']);
            expect(await tools.answer({ context, response: { cardId: card.cardId, operationId, argumentsDigest: card.argumentsDigest, choice: 'allow' } })).toMatchObject({ ok: true });
        }
        expect(f.calls).toHaveLength(2);
        expect(value({ result: await confirmations.list({ context, query: { limit: 100 } }) }).items).toHaveLength(0);
        const missing = { name: definition.name, operationId: 'missing-exposure', input: { ...selection({ pluginId: 'linkedin-ads', operationId: 'missing-exposure' }), arguments: { kind: 'activate', entityType: 'campaign', entityId: '456' } } } as ToolCall;
        expect(await tools.dispatch({ context, call: missing })).toMatchObject({ ok: false });
        expect(f.calls).toHaveLength(2);
        tools.dispose({});
    } finally { f.close(); }
});

it('rechecks halt after a write credential lookup and leaves the claimed outcome uncertain without fetching', async () => {
    const f = await fixture({ admitted: true, only: 'linkedin-ads' });
    try {
        const tool = value({ result: await f.binding.definitions({ context }) }).find(tool => tool.name === 'vendor_linkedin_ads_pause')!;
        f.setBeforeCredential({ async callback() { f.halt(); } });
        await tool.invoke({ context, input: { ...selection({ pluginId: 'linkedin-ads', operationId: 'halted-pause' }), arguments: { kind: 'pause', campaignId: '456' } } });
        expect(f.calls).toEqual([]);
        expect(f.native.prepare("SELECT state FROM job WHERE operation='agent-plugin.invoke'").all()).toEqual([{ state: 'reconcile' }]);
    } finally { f.close(); }
});

it('Instagram fetch encoding stays in the plugin and refuses redirected/oversized responses', async () => {
    const require = createRequire(import.meta.url);
    const module = require('../../../content/agent-plugins/meta-ads/io.github.ainsep.openmarketing/dist/index.mjs');
    const requests: { url: string; options?: RequestInit }[] = [];
    let oversized = false;
    const fetchFixture: typeof fetch = async (url, options) => { requests.push({ url: String(url), options }); return new Response(oversized ? 'x'.repeat(1048577) : JSON.stringify({ id: '456' })); };
    const dispatch = module.createMetaInstagramFetchDispatch({
        fetch: fetchFixture,
        credentials: { async access(input: { connectionId: string }) { expect(input.connectionId).toBe('connection'); return { ok: true, value: { accessToken: 'fixture-secret' } }; } },
    });
    const input = { context, connectionId: 'connection', operationId: 'post', effect: { operationId: 'post', connectionId: 'connection', accountId: '123',
        effects: ['write'], argumentsDigest: 'a'.repeat(64), moneyExposure: null, requiredLimit: null },
        request: { method: 'POST', endpoint: 'https://graph.facebook.com/v25.0/123/media', parameters: { image_url: 'https://fixture.invalid/image.png', caption: 'A & B' } }, timeoutMs: 15000 };
    expect(await dispatch(input)).toEqual({ ok: true, value: { id: '456' } });
    expect(requests[0].options?.redirect).toBe('error');
    expect(new URLSearchParams(String(requests[0].options?.body)).get('caption')).toBe('A & B');
    expect(requests[0].url).not.toContain('fixture-secret');
    oversized = true;
    expect(await dispatch(input)).toMatchObject({ ok: false, error: { code: 'limit_exceeded' } });
    expect(await dispatch({ ...input, request: { ...input.request, endpoint: 'https://evil.invalid/media' } })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    expect(requests).toHaveLength(2);
});


it('fences rebuilt bundle bytes during credential access and changes catalog revisions/import URLs', async () => {
    const f = await fixture({ admitted: true, only: 'linkedin-ads' });
    try {
        const old = value({ result: await f.binding.definitions({ context }) }).find(tool => tool.name === readNames['linkedin-ads'])!;
        f.setBeforeCredential({ async callback() { f.changeBundle(); } });
        expect(await old.invoke({ context, input: selection({ pluginId: 'linkedin-ads' }) })).toMatchObject({ ok: false });
        expect(f.calls).toEqual([]);
        const fresh = value({ result: await f.binding.definitions({ context }) }).find(tool => tool.name === old.name)!;
        expect(fresh.revision).not.toBe(old.revision);
        expect(f.loads[0]).not.toBe(f.loads.at(-1));
        expect(new URL(f.loads.at(-1)!).searchParams.get('revision')).toBe(fresh.revision);
    } finally { f.close(); }
});

it('recognizes Higgsfield as an agent plugin while leaving its hosted descriptors to federation', async () => {
    const f = await fixture();
    try {
        f.states.set('higgsfield-media', { enabled: true, bundled: true, admitted: false, revision: 'a'.repeat(64), metadata: {} });
        const definitions = value({ result: await f.binding.definitions({ context }) });
        expect(f.loads.some(url => url.includes('/higgsfield-media/'))).toBe(true);
        expect(definitions.some(tool => tool.name === 'vendor_higgsfield_media_unavailable')).toBe(false);
        expect(f.calls).toEqual([]); expect(f.accesses).toEqual([]);
    } finally { f.close(); }
});

it('coverage distinguishes unadmitted vendor tools and names the remaining owning workflow gaps', async () => {
    const f = await fixture();
    try {
        const rows = generateOmToolCoverage({ definitions: value({ result: await f.binding.definitions({ context }) }) });
        expect(rows.find(row => row.tool === readNames['linkedin-ads'])).toMatchObject({ status: 'unadmitted', reason: expect.stringContaining('unadmitted') });
        for (const capability of ['Campaign launch', 'Higgsfield creative lifecycle', 'Meta ads hosted binding', 'Uploaded executable agent plugins'])
            expect(rows.find(row => row.capability === capability)).toMatchObject({ status: 'NEEDS', reason: expect.any(String) });
        expect(rows.find(row => row.capability === 'Typed remote halt stop')?.reason).toContain('pending');
    } finally { f.close(); }
});

it('native bundle digests cover actual bytes, change on rebuild, and reject oversized files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'om-plugin-revision-'));
    const path = join(directory, 'index.mjs');
    const moduleUrl = pathToFileURL(path).href;
    const io = createNodeBootIo({ projectRoot: directory, studioRoot: directory, ready() {} });
    try {
        await writeFile(path, 'export const version = 1;');
        const first = await io.agentPlugins!.moduleDigest({ moduleUrl });
        expect(first).toBe(createHash('sha256').update('export const version = 1;').digest('hex'));
        await writeFile(path, 'export const version = 2;');
        expect(await io.agentPlugins!.moduleDigest({ moduleUrl })).not.toBe(first);
        await writeFile(path, 'x'.repeat(8388609));
        await expect(io.agentPlugins!.moduleDigest({ moduleUrl })).rejects.toThrow();
    } finally { await rm(directory, { recursive: true, force: true }); }
});

/** Actual plugin transports against a bounded synthetic social account, never native fetch. */
function socialVendor(required: { failLinkedIn?: boolean; failRead?: boolean } = {}) {
    const rows = new Map<string, Record<string, unknown>>(); let meta = 200, linkedin = 400;
    const fetchFixture: typeof fetch = async (url, init) => {
        const uri = new URL(String(url)); const isMeta = uri.hostname === 'graph.facebook.com';
        const key = decodeURIComponent(uri.pathname.split('/').at(-1)!);
        if (init?.method === 'GET') {
            if (required.failRead) throw new Error('Fixture read unavailable');
            return Response.json(rows.get(key) ?? {});
        }
        if (!isMeta) return linkedInCreate({ key, body: String(init?.body), rows, id: String(++linkedin), fail: required.failLinkedIn });
        const fields: Record<string, unknown> = Object.fromEntries(new URLSearchParams(String(init?.body)));
        const id = String(++meta);
        for (const field of ['targeting', 'special_ad_categories', 'creative']) if (typeof fields[field] === 'string') fields[field] = JSON.parse(String(fields[field]));
        if (fields.creative) fields.creative = { id: (fields.creative as { creative_id: string }).creative_id };
        rows.set(id, { ...fields, id, account_id: '123', configured_status: 'PAUSED' });
        return Response.json({ id });
    };
    return { fetch: fetchFixture, rows };
}
function linkedInCreate(required: { key: string; body: string; rows: Map<string, Record<string, unknown>>; id: string; fail?: boolean }): Response {
    if (required.fail && required.key === 'adCampaigns') throw new Error('Fixture ambiguous creation');
    const id = required.key === 'creatives' ? 'urn:li:sponsoredCreative:' + required.id : required.id;
    const body = JSON.parse(required.body);
    required.rows.set(id, { ...body, id, account: 'urn:li:sponsoredAccount:123', isServing: false });
    return new Response(null, { status: 201, headers: { 'x-restli-id': id } });
}
const socialCampaign: NeutralCampaignLaunch = { operationId: 'social-draft', name: 'Traffic', objective: 'traffic',
    schedule: { window: { start: 1791849600000, end: 1792022400000 }, timezone: 'UTC' }, audience: { countries: ['US'] }, creativeIds: ['creative'], creativeDigest: 'a'.repeat(64),
    targets: ['meta-ads', 'linkedin-ads'].map(pluginId => ({ pluginId, connectionId: 'connection', accountId: '123', dailyBudget: { currency: 'USD', minorUnits: 4321 }, expectedExposure: { currency: 'USD', minorUnits: 10000 } })) };
function socialMetadata(required: { pluginId: string }) {
    const common = { accountId: '123', currency: 'USD', currencyExponent: 2, timezone: 'UTC', creativeId: 'creative', creativeDigest: 'a'.repeat(64) };
    return { scope: context.scope, connectionId: 'connection', resolved: required.pluginId === 'meta-ads'
        ? { ...common, vendorCreativeId: '987', ageMin: 18, ageMax: 65, specialAdCategories: [] }
        : { ...common, reference: 'urn:li:share:987', organizationId: '789', locale: { country: 'US', language: 'en' }, politicalIntent: 'NOT_POLITICAL', unitCost: { currency: 'USD', minorUnits: 237 }, locations: [{ country: 'US', id: '103644278' }] } };
}
/** Real grouped safety, real SQL outbox and actual plugin modules; fixture network only. */
async function deploymentFixture(required: Parameters<typeof socialVendor>[0] = {}) {
    const vendor = socialVendor(required); const f = await fixture({ admitted: true, fetch: vendor.fetch });
    for (const [pluginId, state] of f.states) { state.enabled = ['meta-ads', 'linkedin-ads'].includes(pluginId); state.metadata = { ...state.metadata, campaignFixture: socialMetadata({ pluginId }) }; }
    const confirmations = createMemoryConfirmationExchange({ clock, ids: f.ids });
    const prepared = value({ result: await f.binding.prepareCampaign({ context, campaign: socialCampaign, operationId: 'social-launch' }) });
    const safety = createSafetyService({ repo: f.safetyRepo, confirmations, clock, ids: f.ids, accountLocks: f.ports.accountLocks, policy: createMemorySpendPolicy({}), platformLimits: createMemoryPlatformLimitEvidence({}), audit: createMemorySafetyAudit({}),
        effects: { async resolve({ request }) { const known = prepared.find(call => value({ result: digestArguments({ arguments: call }) }) === value({ result: digestArguments({ arguments: request }) })); return known ? { ok: true, value: known.envelope } : { ok: false, error: { code: 'forbidden', message: 'Unverified fixture', retryable: false } }; }, async verifyGenerationQuote() { throw new Error('Not generation'); }, async verifyHaltStop() { throw new Error('Not stop'); } } });
    const binding = bindAgentPluginBackends({ ...f.ports, confirmations, safety });
    const repo = createMemoryCampaignRepo({}); const draft = value({ result: await repo.saveNeutral({ context, campaign: socialCampaign }) });
    const definition = bindPausedCampaignDeployment({ unit: f.unit, repo, clock, ids: f.ids, observer, safety, confirmations,
        prepare: binding.prepareCampaign, definitions: binding.definitions, execute: binding.executeCampaign, read: binding.readCampaign });
    const tools = createOmTools({ clock, observer, confirmations, definitions: async () => ({ ok: true, value: [definition, ...value({ result: await binding.definitions({ context }) })] }), authorize: () => ({ ok: true, value: undefined }) });
    async function approve() {
        expect(value({ result: await tools.dispatch({ context, call: { name: definition.name, operationId: 'social-launch', input: { campaignId: draft.campaignId } } }) }).status).toBe('pending');
        const card = value({ result: await tools.card({ context, operationId: 'social-launch' }) })!;
        expect(card.allowedChoices).toEqual(['allow', 'cancel']); expect(f.calls).toEqual([]);
        value({ result: await tools.answer({ context, response: { cardId: card.cardId, operationId: card.operationId, argumentsDigest: card.argumentsDigest, choice: 'allow' } }) });
    }
    return { ...f, binding, tools, confirmations, approve, vendor, async closeAll() { await tools.dispose({}); f.close(); } };
}
it('executes both social hierarchies under one card/job and reconciles through the read-only catalog', async () => {
    const f = await deploymentFixture();
    try {
        await f.approve();
        expect(value({ result: await f.tools.operation({ context, operationId: 'social-launch' }) })).toMatchObject({ status: 'completed', output: { status: 'submitted' } });
        expect(f.native.prepare('SELECT state FROM job').all()).toEqual([{ state: 'succeeded' }]);
        expect(f.calls.filter(call => call.options?.method === 'POST')).toHaveLength(6);
        const before = f.calls.length;
        const read = await f.tools.dispatch({ context, call: { name: 'om_campaign_reconcile_deployment', operationId: 'read-deployment', input: { operationId: 'social-launch' } } });
        expect(read).toMatchObject({ ok: true, value: { status: 'completed', output: { complete: true, outcomes: [{ result: { references: { campaign: '201', adset: '202', ad: '203' } } }, { result: { references: { group: '401', campaign: '402', creative: 'urn:li:sponsoredCreative:403' } } }] } } });
        expect(f.calls.slice(before).map(call => call.options?.method)).toEqual(Array(6).fill('GET'));
        expect(f.native.prepare('SELECT id FROM job').all()).toHaveLength(1);
    } finally { await f.closeAll(); }
});
it('keeps Meta success and LinkedIn partial references after failure/restart without replay or rollback', async () => {
    const f = await deploymentFixture({ failLinkedIn: true });
    try {
        await f.approve(); expect(value({ result: await f.tools.operation({ context, operationId: 'social-launch' }) })).toMatchObject({ status: 'unknown' });
        expect(f.native.prepare('SELECT state FROM job').all()).toEqual([{ state: 'reconcile' }]);
        const evidence = JSON.stringify(f.native.prepare('SELECT evidence_id FROM job_attempt').all());
        expect(evidence).toContain('203'); expect(evidence).toContain('401');
        const before = f.calls.length;
        const restored = bindAgentPluginBackends(f.ports);
        const read = value({ result: await restored.definitions({ context }) }).find(tool => tool.name === 'om_campaign_reconcile_deployment')!;
        expect(await read.invoke({ context, input: { operationId: 'social-launch' } })).toMatchObject({ ok: true, value: { complete: false, outcomes: [{ result: { status: 'acknowledged' } }, { result: { status: 'unknown', references: { group: '401' } } }] } });
        expect(f.calls.slice(before).every(call => call.options?.method === 'GET')).toBe(true);
        expect(await read.invoke({ context: { ...context, scope: { ...context.scope, workspaceId: 'other' } }, input: { operationId: 'social-launch' } })).toMatchObject({ ok: false });
        expect(f.native.prepare('SELECT id FROM job').all()).toHaveLength(1);
    } finally { await f.closeAll(); }
});
it.each(['admission', 'binding', 'halt', 'approval', 'revision', 'cancel'] as const)('denies deployment egress when %s changes during credential resolution', async change => {
    const f = await deploymentFixture();
    try {
        f.setBeforeCredential({ async callback() {
            if (change === 'admission') f.states.get('meta-ads')!.admitted = false;
            if (change === 'binding') f.ports.accounts.find = async () => ({ ok: true, value: null });
            if (change === 'halt') f.halt();
            if (change === 'revision') f.changeBundle();
            if (change === 'cancel') await f.tools.cancel({ context, runId: context.runId! });
            if (change === 'approval') { const card = value({ result: await f.tools.card({ context, operationId: 'social-launch' }) })!; value({ result: await f.confirmations.revoke({ context, cardId: card.cardId }) }); }
        } });
        await f.approve(); expect(f.calls).toEqual([]);
        expect(f.native.prepare('SELECT id FROM job').all()).toHaveLength(1);
    } finally { await f.closeAll(); }
});

it('sends nothing when the owning run is cancelled during the final awaited approval verification', async () => {
    const f = await deploymentFixture();
    const verify = f.confirmations.verify;
    let finalChecks = 0;
    f.confirmations.verify = async input => {
        const result = await verify(input);
        if (f.accesses.length > 0) {
            finalChecks++;
            await f.tools.cancel({ context, runId: context.runId! });
        }
        return result;
    };
    try {
        await f.approve();
        expect(finalChecks).toBe(1); expect(f.accesses).toHaveLength(1);
        expect(f.calls).toEqual([]);
        expect(f.native.prepare('SELECT state FROM job').all()).toEqual([{ state: 'reconcile' }]);
    } finally { await f.closeAll(); }
});

it('propagates owning cancellation into an in-flight Google request alongside its transport timeout', async () => {
    const controller = new AbortController();
    let transportSignal: AbortSignal | null | undefined;
    const f = await fixture({ admitted: true, only: 'google-ads', fetch: async (_url, init) => {
        transportSignal = init?.signal;
        controller.abort();
        if (transportSignal?.aborted) throw new Error('Fixture request cancelled');
        return Response.json({ results: [] });
    } });
    try {
        const tool = value({ result: await f.binding.definitions({ context }) }).find(tool => tool.name === readNames['google-ads'])!;
        const result = await tool.invoke({ context, input: selection({ pluginId: 'google-ads' }), signal: controller.signal });
        expect(f.calls).toHaveLength(1); expect(f.accesses).toHaveLength(1);
        expect(transportSignal).toBeDefined(); expect(transportSignal).not.toBe(controller.signal);
        expect(transportSignal?.aborted).toBe(true); expect(result.ok).toBe(false);
    } finally { f.close(); }
});

it.each([false, true])('preserves the latest validated receipt across repeated failed reconciliation (malformed later receipt: %s)', async malformed => {
    const f = await deploymentFixture({ failLinkedIn: true });
    try {
        await f.approve();
        const history = value({ result: await f.jobs.history({ context, operationId: 'social-launch' }) });
        const call = value({ result: await f.binding.prepareCampaign({ context, campaign: socialCampaign, operationId: 'social-launch' }) })[1];
        if (malformed) value({ result: await f.jobs.checkpoint({ context, jobId: history.jobId, event: 'campaign_result', evidence: {
            operationId: call.envelope.operationId, result: { status: 'acknowledged', entityIds: ['forged'], references: { group: 42 } },
        } }) });
        f.states.get('linkedin-ads')!.admitted = false;
        const read = value({ result: await f.binding.definitions({ context }) }).find(tool => tool.name === 'om_campaign_reconcile_deployment')!;
        const before = f.calls.length;
        for (let attempt = 0; attempt < 2; attempt++) {
            expect(await read.invoke({ context, input: { operationId: 'social-launch' } })).toMatchObject({ ok: true, value: { complete: false, outcomes: [
                { result: { status: 'acknowledged' } }, { result: { status: 'unknown', entityIds: ['401'], references: { group: '401' } } },
            ] } });
        }
        expect(f.calls.slice(before).map(call => call.options?.method)).toEqual(Array(6).fill('GET'));
        expect(f.native.prepare('SELECT id FROM job').all()).toHaveLength(1);
        const observations = f.native.prepare("SELECT evidence_id FROM job_attempt WHERE event_type='campaign_result' ORDER BY sequence DESC LIMIT 2").all();
        expect(JSON.stringify(observations)).toContain('401'); expect(JSON.stringify(observations)).not.toContain('forged');
    } finally { await f.closeAll(); }
});

it.each(['ad', 'creative'])('recovers all receipt IDs after the %s acknowledgement checkpoint fails, without replay', async step => {
    const f = await deploymentFixture();
    try {
        f.native.exec(`CREATE TEMP TRIGGER fail_ack BEFORE INSERT ON job_attempt
            WHEN json_extract(NEW.evidence_id,'$.phase')='acknowledged' AND json_extract(NEW.evidence_id,'$.step')='${step}'
            BEGIN SELECT RAISE(FAIL,'Fixture acknowledgement checkpoint unavailable'); END`);
        await f.approve();
        expect(value({ result: await f.tools.operation({ context, operationId: 'social-launch' }) })).toMatchObject({ status: 'unknown' });
        const before = f.calls.length;
        const read = value({ result: await f.binding.definitions({ context }) }).find(tool => tool.name === 'om_campaign_reconcile_deployment')!;
        const result = await read.invoke({ context, input: { operationId: 'social-launch' } });
        const meta = { result: { status: 'acknowledged', entityIds: ['201', '202', '203'], references: { campaign: '201', adset: '202', ad: '203' } } };
        const linkedin = step === 'ad' ? { result: { status: 'not_attempted' } }
            : { result: { status: 'acknowledged', entityIds: ['401', '402', 'urn:li:sponsoredCreative:403'], references: { group: '401', campaign: '402', creative: 'urn:li:sponsoredCreative:403' } } };
        expect(result).toMatchObject({ ok: true, value: { complete: step === 'creative', outcomes: [meta, linkedin] } });
        expect(f.calls.slice(before).map(call => call.options?.method)).toEqual(Array(step === 'ad' ? 3 : 6).fill('GET'));
        expect(f.calls.filter(call => call.options?.method === 'POST')).toHaveLength(step === 'ad' ? 3 : 6);
        expect(f.native.prepare('SELECT id FROM job').all()).toHaveLength(1);
    } finally { await f.closeAll(); }
});

it('deduplicates checkpoint aliases by vendor ID and ignores malformed later references during social recovery', async () => {
    const f = await deploymentFixture();
    try {
        await f.approve();
        const history = value({ result: await f.jobs.history({ context, operationId: 'social-launch' }) });
        const call = value({ result: await f.binding.prepareCampaign({ context, campaign: socialCampaign, operationId: 'social-launch' }) })[0];
        const event = { context, jobId: history.jobId, event: 'campaign_observation' };
        value({ result: await f.jobs.checkpoint({ ...event, evidence: { operationId: call.envelope.operationId, references: { duplicate: '201', campaign: '201', adset: '202', ad: '203' } } }) });
        value({ result: await f.jobs.checkpoint({ ...event, evidence: { operationId: call.envelope.operationId, references: { campaign: 42 } } }) });
        const before = f.calls.length;
        const read = value({ result: await f.binding.definitions({ context }) }).find(tool => tool.name === 'om_campaign_reconcile_deployment')!;
        expect(await read.invoke({ context, input: { operationId: 'social-launch' } })).toMatchObject({ ok: true, value: { complete: true, outcomes: [
            { result: { status: 'acknowledged', entityIds: ['201', '202', '203'], references: { campaign: '201', adset: '202', ad: '203' } } },
            { result: { status: 'acknowledged' } },
        ] } });
        expect(f.calls.slice(before).map(call => call.options?.method)).toEqual(Array(6).fill('GET'));
        expect(f.native.prepare('SELECT id FROM job').all()).toHaveLength(1);
    } finally { await f.closeAll(); }
});

it.each([null, 'A'.repeat(22)])('Google journals mutation IDs in the owning job and sends its optional secret only as a plugin header (%s)', async token => {
    const f = await fixture({ admitted: true, only: 'google-ads', fetch: async (url, init) => {
        const body = JSON.parse(String(init?.body));
        if (String(url).endsWith('googleAds:mutate')) {
            expect(body.partialFailure).toBe(false); expect(body.validateOnly).toBe(false);
            const keys = ['campaignBudgetResult', 'campaignResult', 'adGroupResult', 'campaignCriterionResult', 'adGroupCriterionResult', 'adGroupAdResult'];
            const paths = ['campaignBudgets/101', 'campaigns/201', 'adGroups/301', 'campaignCriteria/201~2840', 'adGroupCriteria/301~501', 'adGroupAds/301~401'];
            return Response.json({ mutateOperationResponses: keys.map((key, index) => ({ [key]: { resourceName: 'customers/1234567890/' + paths[index] } })) });
        }
        return Response.json({ results: String(body.query).endsWith('FROM customer') ? [{ customer: { id: '1234567890', currencyCode: 'USD', timeZone: 'UTC', testAccount: true } }] : [] });
    } });
    const confirmations = createMemoryConfirmationExchange({ clock, ids: f.ids });
    const state = f.states.get('google-ads')!; state.metadata.loginCustomerId = '9999999999';
    const campaign = { ...socialCampaign, audience: { countries: ['US'], searchTerms: ['marketing tools'] }, targets: [{ ...socialCampaign.targets[0], pluginId: 'google-ads', accountId: '1234567890' }] };
    state.metadata.campaignFixture = { scope: context.scope, connectionId: 'connection', resolved: {
        binding: { scope: context.scope, connectionId: 'connection', customerId: '1234567890', currency: 'USD', timezone: 'UTC', mode: 'sandbox', pluginDigest: 'a'.repeat(64), schemaFingerprint: 'b'.repeat(64) },
        currencyExponent: 2, creativeId: 'creative', creativeDigest: campaign.creativeDigest, locations: [{ country: 'US', id: '2840' }], cpcBidMicros: '2370000',
        headlines: ['Open Marketing', 'Plan Search Campaigns', 'See Clear Reports'], descriptions: ['Plan paused Search campaigns.', 'Review each exact spend call.'], finalUrl: 'https://example.test/landing', euPoliticalAdvertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING' } };
    let tokenReads = 0;
    const binding = bindAgentPluginBackends({ ...f.ports, confirmations, integrations: { ...f.ports.integrations, async resolveDeveloperToken(input) { expect(input.pluginId).toBe('google-ads'); tokenReads++; return { ok: true, value: token }; } } });
    try {
        const calls = value({ result: await binding.prepareCampaign({ context, campaign, operationId: 'google-launch' }) });
        const rootArgs = { calls }; const root: EffectRequest = { arguments: rootArgs, pausedCampaignCalls: calls, pluginDigest: 'a'.repeat(64), schemaFingerprint: 'b'.repeat(64),
            envelope: { ...calls[0].envelope, operationId: 'google-launch', accountId: null, effects: ['ad_spend'], argumentsDigest: value({ result: digestArguments({ arguments: rootArgs }) }) } };
        const card = value({ result: await confirmations.present({ context, request: root }) });
        value({ result: await confirmations.confirm({ context, response: { cardId: card.cardId, operationId: card.operationId, argumentsDigest: card.argumentsDigest, choice: 'allow' } }) });
        const authorization = { ...calls[0], approvalId: card.cardId, policyRevision: 0, campaignApproval: { operationId: 'google-launch', argumentsDigest: card.argumentsDigest, index: 0 } };
        const result = await f.jobs.dispatch({ context, pluginId: 'om-campaigns', input: { operationId: 'google-launch', connectionId: 'om_campaign_deploy_paused', accountId: null, arguments: { intent: 'deploy-paused', request: boundedJsonSchema.parse(root) } },
            execute: async ({ jobId }) => binding.executeCampaign({ context, call: calls[0], authorization, permit: { operationId: calls[0].envelope.operationId, argumentsDigest: calls[0].envelope.argumentsDigest, approvalId: card.cardId, expiresAt: 300000, reservationId: 'fixture-permit' },
                checkpoint: item => f.jobs.checkpoint({ context, jobId, event: 'google-step.' + item.step, evidence: { ...item, operationId: calls[0].envelope.operationId } }) }) });
        expect(result).toMatchObject({ ok: true, value: { status: 'unknown', entityIds: expect.arrayContaining(['customers/1234567890/campaigns/201']) } });
        expect(f.native.prepare('SELECT state FROM job').all()).toEqual([{ state: 'reconcile' }]);
        expect(JSON.stringify(f.native.prepare('SELECT evidence_id FROM job_attempt').all())).toContain('customers/1234567890/campaigns/201');
        expect(tokenReads).toBe(f.calls.length);
        for (const call of f.calls) { const headers = new Headers(call.options?.headers); expect(headers.get('developer-token')).toBe(token); expect(headers.get('login-customer-id')).toBe('9999999999'); }
        const before = f.calls.length;
        const read = value({ result: await binding.definitions({ context }) }).find(tool => tool.name === 'om_campaign_reconcile_deployment')!;
        await read.invoke({ context, input: { operationId: 'google-launch' } });
        expect(f.calls.slice(before).every(call => call.url.endsWith('googleAds:search'))).toBe(true);
        expect(f.calls.filter(call => call.url.endsWith('googleAds:mutate'))).toHaveLength(1);
        if (token) expect(JSON.stringify([result, f.native.prepare('SELECT * FROM job_attempt').all()])).not.toContain(token);
    } finally { f.close(); }
});
it('unadmitted preparation/dispatch and unresolved or incompatible metadata perform no credential access', async () => {
    const f = await fixture({ only: 'meta-ads' });
    try {
        expect(await f.binding.prepareCampaign({ context, campaign: { ...socialCampaign, targets: [socialCampaign.targets[0]] }, operationId: 'unadmitted' })).toMatchObject({ ok: false });
        f.states.get('meta-ads')!.admitted = true;
        expect(await f.binding.prepareCampaign({ context, campaign: { ...socialCampaign, targets: [socialCampaign.targets[0]] }, operationId: 'missing' })).toMatchObject({ ok: false, error: { code: 'not_implemented' } });
        f.states.get('meta-ads')!.metadata.campaignFixture = socialMetadata({ pluginId: 'meta-ads' });
        const call = value({ result: await f.binding.prepareCampaign({ context, campaign: { ...socialCampaign, targets: [socialCampaign.targets[0]] }, operationId: 'ready' }) })[0];
        f.states.get('meta-ads')!.admitted = false;
        expect(await f.binding.executeCampaign({ context, call, evidence: [], checkpoint: async () => ({ ok: true, value: undefined }) })).toMatchObject({ ok: false });
        f.states.get('meta-ads')!.admitted = true;
        expect(await f.binding.prepareCampaign({ context, campaign: { ...socialCampaign, audience: { countries: ['US'], searchTerms: ['cannot discard'] }, targets: [socialCampaign.targets[0]] }, operationId: 'incompatible' })).toMatchObject({ ok: false, error: { code: 'not_implemented' } });
        expect(f.accesses).toEqual([]); expect(f.calls).toEqual([]); expect(f.native.prepare('SELECT id FROM job').all()).toEqual([]);
    } finally { f.close(); }
});
it('rejects duplicate step dispatch and foreign/oversized checkpoints in the owning journal', async () => {
    const f = await fixture(); let jobId = '';
    try {
        await f.jobs.dispatch({ context, pluginId: 'fixture', input: selection({ pluginId: 'linkedin-ads', operationId: 'checkpoint' }), async execute(input) {
            jobId = input.jobId;
            const event = { context, jobId, event: 'campaign-step', evidence: { phase: 'dispatch', operationId: 'child' } };
            expect(await f.jobs.checkpoint(event)).toEqual({ ok: true, value: undefined });
            expect(await f.jobs.checkpoint(event)).toMatchObject({ ok: false, error: { code: 'conflict' } });
            expect(await f.jobs.checkpoint({ ...event, context: { ...context, scope: { ...context.scope, workspaceId: 'other' } } })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
            return { ok: true, value: { status: 'unknown' } };
        } });
        expect(await f.jobs.checkpoint({ context, jobId, event: 'too-large', evidence: { data: 'x'.repeat(65537) } })).toMatchObject({ ok: false, error: { code: 'limit_exceeded' } });
        expect(await f.jobs.checkpoint({ context, jobId, event: 'later-step', evidence: { phase: 'dispatch' } })).toMatchObject({ ok: false, error: { code: 'conflict' } });
        expect(f.native.prepare("SELECT event_type FROM job_attempt WHERE event_type='campaign-step'").all()).toHaveLength(1);
    } finally { f.close(); }
});

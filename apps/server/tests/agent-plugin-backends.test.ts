/** R1 written-only fixtures. All transports below are injected; no vendor or native fetch is used. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import type { CallContext, Outcome, ToolCall } from '@open-marketing/contracts';
import { createMemoryConfirmationExchange, createMemorySafetyRepo, createMemoryAccountDispatchLock, createMemoryPlatformLimitEvidence,
    createMemorySpendPolicy, createMemorySafetyAudit, createSafetyService } from '@open-marketing/safety';
import type { SafetyService, EffectRequest } from '@open-marketing/safety';
import { bindAgentPluginBackends, bindAgentPluginJobs } from '../src/composition/agent-plugin-backends.js';
import type { AgentPluginState } from '../src/composition/agent-plugin-backends.js';
import { bindServerDatabase, provisionWorkspace } from '../src/composition/database.js';
import { migrationManifest } from '../src/composition/migrations.js';
import { createOmTools, toolPolicy } from '../src/om-tools.js';

const context: CallContext = { scope: { ownerId: 'owner', workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }, principal: { kind: 'owner', ownerId: 'owner' }, correlationId: 'correlation', traceId: 'trace' };
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
        case 'meta-ads': return require('../../../content/agent-plugins/meta-ads/io.github.ainsep.openmarketing/dist/index.mjs') as object;
        default: throw new Error('Unknown fixture plugin');
    }
}

async function fixture(required: { admitted?: boolean; only?: string; safety?: SafetyService } = {}) {
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
    let halted = false;
    const safetyRepo = createMemorySafetyRepo({ clock, ids, ownerTimezone: 'UTC' });
    const binding = bindAgentPluginBackends({ projectRoot: fileURLToPath(new URL('../../../', import.meta.url)), clock, observer,
        jobs, mode: 'sandbox', safety: required.safety,
        async state({ pluginId }) {
            if (failure?.stage === 'state' && failure.pluginId === pluginId) throw new Error('Fixture metadata missing');
            return states.get(pluginId) ?? null;
        },
        async loadModule({ moduleUrl }) {
            loads.push(moduleUrl);
            if (!moduleUrl.includes('/' + failure?.pluginId + '/')) return loadFixtureModule({ moduleUrl });
            if (failure?.stage === 'module') throw new Error('Fixture module missing');
            return {};
        },
        async wait() { return { ok: true, value: undefined }; },
        fetch: async (url, options) => {
            calls.push({ url: String(url), options });
            const body = String(url).includes('linkedin') ? { elements: [] } : String(url).includes('facebook') ? { data: [] } : {};
            return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
        },
        integrations: { async access(input) { accesses.push(input); await beforeCredential(); return { ok: true, value: { accessToken: 'fixture-token-for-' + input.pluginId } }; } },
        accounts: { async find({ externalAccountId }) { return { ok: true, value: { id: 'binding', scope: context.scope, connectionId: 'connection', externalAccountId } }; } },
        safetyRepo: { async snapshot(input) { const result = await safetyRepo.snapshot(input); return result.ok ? { ok: true, value: { ...result.value, halted } } : result; } },
    });
    return { native, binding, states, jobs, calls, accesses, ids, safetyRepo, loads,
        setFailure(input: NonNullable<typeof failure>) { failure = input; },
        setBeforeCredential(input: { callback(): Promise<void> }) { beforeCredential = input.callback; },
        halt() { halted = true; }, close() { native.close(); } };
}
const readArguments: Record<string, Record<string, ToolCall['input']>> = {
    'google-ads': { operationId: 'read', }, 'linkedin-ads': { kind: 'list_accounts' },
    'tiktok-ads': { kind: 'get-advertiser' }, 'meta-ads': {},
};
const readNames: Record<string, string> = { 'google-ads': 'vendor_google_ads_list_accounts', 'linkedin-ads': 'vendor_linkedin_ads_list_accounts', 'tiktok-ads': 'vendor_tiktok_ads_tiktok_ads_get_advertiser', 'meta-ads': 'vendor_meta_ads_instagram_accounts' };
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
            window: { start: 0, end: 100000 }, observedAt: 1000, semantics: 'hard_limit', pluginDigest: 'a'.repeat(64) } }] }) });
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

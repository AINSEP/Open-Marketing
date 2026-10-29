import { createSqlContactRepo } from '@open-marketing/contacts';
import { createSubjectLane } from '../src/composition/subject-lane.js';
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
import { z } from 'zod';
import type { MailProviderModule } from '@jini-ai/platform/mail';
import type { CallContext, CallOptions, Outcome, ToolCall, CampaignDeploymentRequired, PluginToolsFactory, PluginCapabilityDependencies, PluginConfiguration, PluginConnectionConfiguration, PluginCapabilitiesFactory, PluginCapability, HaltStopPermit } from '@open-marketing/contracts';
import { boundedJsonSchema, capabilityCatalog, definePluginTools, pluginConfigurationSchema, pluginConnectionConfigurationSchema, campaignDeploymentReceiptSchema } from '@open-marketing/contracts';
import * as tikTokSource from '../../../content/agent-plugins/tiktok-ads/io.github.ainsep.openmarketing/src/index.js';
import * as metaSource from '../../../content/agent-plugins/meta-ads/io.github.ainsep.openmarketing/src/index.js';
import * as whatsAppSource from '../../../content/agent-plugins/whatsapp-business/io.github.ainsep.openmarketing/src/index.js';
import * as twilioSource from '../../../content/agent-plugins/twilio-sms/io.github.ainsep.openmarketing/src/index.js';
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

/** Captured approval evidence; each fixture owns its audit records. */
function answerAudit() {
    const answers: unknown[] = [];
    return { answers, async recordAnswer(input: { answer: unknown }) {
        answers.push(structuredClone(input.answer));
        return { ok: true as const, value: undefined };
    } };
}

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
            entryUrl: pathToFileURL(join(fileURLToPath(new URL('../../../', import.meta.url)), 'content/agent-plugins', pluginId, 'io.github.ainsep.openmarketing/dist/index.mjs')).href,
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
    const ports: Parameters<typeof bindAgentPluginBackends>[0] = { addons: { async list() { return { ok: true, value: { items: [...states].map(([id, state]) => ({ kind: 'agent-plugin' as const, id, name: id, description: '', version: '1', enabled: state.enabled, revision: state.revision })), cursor: null } }; } }, projectRoot: fileURLToPath(new URL('../../../', import.meta.url)), clock, observer,
        jobs, subjectLane: createSubjectLane({ resolveSubject: createSqlContactRepo({ uow: database.unit }).get }), mode: 'sandbox', safety: required.safety, confirmations: required.confirmations, accountLocks: createMemoryAccountDispatchLock({ ids }),
        async state({ pluginId }) {
            if (failure?.stage === 'state' && failure.pluginId === pluginId) throw new Error('Fixture metadata missing');
            return states.get(pluginId) ?? null;
        },
        async moduleDigest() { return bundleDigest; },
        async loadModule({ moduleUrl }) {
            loads.push(moduleUrl);
            if (!moduleUrl.includes('/' + failure?.pluginId + '/')) return loadFixtureModule({ moduleUrl });
            if (failure?.stage === 'module') throw new Error('Fixture module missing');
            return { tools: [{ name: 'malformed' }], parseTool: () => ({ ok: true, value: {} }), createTools: () => ({}) };
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
/** Neutral installed provider over the existing backend fixture; HTTP must use the host guard.
 * Provider-side throws deliberately report unknown, just like real mail transports do. */
async function mailBackendFixture(required: { fetch?: typeof fetch } = {}) {
    const f = await fixture({ only: 'fixture-mail', fetch: required.fetch ?? (async () => Response.json({ id: 'fixture-message' })) });
    const pluginId = 'fixture-mail';
    // Jini rc.2's registry accepts underscores, while OM plugin IDs may contain hyphens.
    const descriptor = { id: 'fixture_mail', label: 'Fixture mail', module: 'io.github.ainsep.openmarketing/dist/index.mjs', credentialKeys: ['token'], feedback: false };
    const state: AgentPluginState = { enabled: true, bundled: false, admitted: true, revision: 'a'.repeat(64),
        entryUrl: 'file:///installed/fixture-mail/' + descriptor.module,
        metadata: { mailAdapters: [descriptor], enabled: true, admitted: true, capabilities: [], credentialCards: [], alertFrom: 'sender@example.com', installOption: 'kept' } };
    f.states.set(pluginId, state);
    const contexts: Parameters<MailProviderModule['create']>[0][] = [];
    const deliveries: Parameters<ReturnType<MailProviderModule['create']>['send']>[0][] = [];
    const provider: MailProviderModule = { id: descriptor.id, label: descriptor.label, credentialKeys: ['token'],
        capabilities: { hosted: true, feedback: false, domainVerification: false },
        create(ctx) {
            contexts.push(ctx);
            return { capabilities: () => ({ driver: 'fixture_mail', supportsIdempotencyKey: true, supportsWebhookFeedback: false, maxBatchSize: 1, supportsAttachments: false }),
                async send(input) {
                    deliveries.push(input);
                    try {
                        const response = await ctx.kit.httpClient.send({ request: { method: 'POST', url: 'https://fixture.invalid/mail', timeoutMs: 20000,
                            headers: { Authorization: 'Bearer ' + ctx.credential.token }, body: JSON.stringify(input) } });
                        const receipt = z.object({ id: z.string() }).parse(JSON.parse(response.bodyText));
                        return { ok: true, providerMessageId: receipt.id, acceptedAt: ctx.now!().toISOString() };
                    } catch { return { ok: false, retryable: false, unknown: true, errorCode: ctx.credential.token, message: ctx.credential.token }; }
                },
                sendBatch: async () => [{ ok: false, retryable: false, errorCode: 'batch_not_supported', message: 'Fixture single send only' }],
            };
        } };
    const module: { default?: MailProviderModule } = { default: provider };
    const ports = { ...f.ports, async loadModule(input: { moduleUrl: string }) { f.loads.push(input.moduleUrl); return module; } };
    const binding = bindAgentPluginBackends(ports);
    let reservations = 0;
    const request: Parameters<typeof binding.mail>[0] = { context, pluginId, request: { connectionId: 'mail-connection', idempotencyKey: 'notice-1',
        message: { workspaceId: context.scope.workspaceId, from: { email: 'sender@example.com' }, to: { email: 'owner@example.net' }, subject: 'Notice', text: 'Fixture notice' },
        async reserve() { reservations++; return { ok: true, value: 'reserved' }; } } };
    return { ...f, binding, ports, state, descriptor, module, provider, contexts, deliveries, request, reservations: () => reservations };
}

it('sends only through the selected declared mail provider with call-local settings, credentials and time', async () => {
    const f = await mailBackendFixture();
    try {
        expect(await f.binding.mail(f.request)).toEqual({ ok: true, providerMessageId: 'fixture-message', acceptedAt: '1970-01-01T00:00:01.000Z' });
        expect(f.calls).toHaveLength(1);
        expect(f.calls[0]).toMatchObject({ url: 'https://fixture.invalid/mail', options: { method: 'POST', redirect: 'error', headers: { Authorization: 'Bearer fixture-token-for-fixture-mail' } } });
        expect(f.calls[0].options?.signal).toBeInstanceOf(AbortSignal);
        expect(f.reservations()).toBe(1);
        expect(f.accesses).toEqual([{ context: { ...context, principal: { kind: 'service', serviceId: 'om-agent-plugin-backends' } }, pluginId: 'fixture-mail', connectionId: 'mail-connection' }]);
        expect(f.contexts[0].settings).toEqual({ alertFrom: 'sender@example.com', installOption: 'kept' });
        expect(f.deliveries).toEqual([{ workspaceId: context.scope.workspaceId, idempotencyKey: 'notice-1', message: f.request.request.message, sourceContext: { module: 'om.mail' } }]);
        expect(new URL(f.loads[0]).searchParams.get('revision')).toMatch(/^[a-f0-9]{64}$/);
        expect(f.native.prepare('SELECT id FROM job').all()).toEqual([]);
    } finally { f.close(); }
});

it('refuses provider success without a guarded send or quota reservation', async () => {
    const f = await mailBackendFixture();
    const create = f.provider.create;
    f.provider.create = ctx => ({ ...create(ctx), async send() {
        return { ok: true, providerMessageId: 'unsent-message', acceptedAt: ctx.now!().toISOString() };
    } });
    try {
        const result = await f.binding.mail(f.request);
        expect(result).toEqual({ ok: false, retryable: false, errorCode: 'unavailable', message: 'Mail refused before egress' });
        expect(result).not.toHaveProperty('unknown');
        expect(f.calls).toEqual([]);
        expect(f.reservations()).toBe(0);
    } finally { f.close(); }
});

it.each(['unadmitted', 'disabled', 'stale revision after credentials', 'stale bundle after credentials', 'withdrawn admission after credentials', 'stale revision after reserve', 'withdrawn consent', 'existing reservation'])(
    'refuses mail before native egress with no unknown flag: %s', async scenario => {
        const f = await mailBackendFixture();
        try {
            switch (scenario) {
                case 'unadmitted': f.state.admitted = false; break;
                case 'disabled': f.state.enabled = false; break;
                case 'stale revision after credentials': f.setBeforeCredential({ async callback() { f.state.revision = 'b'.repeat(64); } }); break;
                case 'stale bundle after credentials': f.setBeforeCredential({ async callback() { f.changeBundle(); } }); break;
                case 'withdrawn admission after credentials': f.setBeforeCredential({ async callback() { f.state.admitted = false; } }); break;
                case 'stale revision after reserve': f.request.request.reserve = async () => { f.state.revision = 'b'.repeat(64); return { ok: true, value: 'reserved' }; }; break;
                case 'withdrawn consent': f.request.request.reserve = async () => ({ ok: false, error: { code: 'forbidden', message: 'fixture-token-for-fixture-mail', retryable: false } }); break;
                case 'existing reservation': f.request.request.reserve = async () => ({ ok: true, value: 'existing' }); break;
            }
            const result = await f.binding.mail(f.request);
            expect(result).toMatchObject({ ok: false, errorCode: 'forbidden', retryable: false });
            expect(result).not.toHaveProperty('unknown');
            expect(JSON.stringify(result)).not.toContain('fixture-token-for-fixture-mail');
            expect(f.calls).toEqual([]);
        } finally { f.close(); }
    });

it.each(['unknown plugin', 'unknown descriptor', 'entry mismatch', 'missing default', 'invalid provider', 'registry ID refusal', 'feedback disagreement', 'credential keys disagreement', 'malformed descriptor'])(
    'reports sender not bound without credentials or HTTP: %s', async scenario => {
        const f = await mailBackendFixture();
        try {
            switch (scenario) {
                case 'unknown plugin': f.request.pluginId = 'missing-mail'; break;
                case 'unknown descriptor': f.descriptor.id = 'other_mail'; break;
                case 'entry mismatch': f.descriptor.module = 'other/mail.mjs'; break;
                case 'missing default': delete f.module.default; break;
                case 'invalid provider': f.module.default = { ...f.provider, capabilities: { ...f.provider.capabilities, feedback: true } }; break;
                case 'registry ID refusal': f.descriptor.id = 'fixture-mail'; f.module.default = { ...f.provider, id: 'fixture-mail' }; break;
                case 'feedback disagreement': f.descriptor.feedback = true; break;
                case 'credential keys disagreement': f.descriptor.credentialKeys = ['username']; break;
                case 'malformed descriptor': f.descriptor.module = '../mail.mjs'; break;
            }
            const result = await f.binding.mail(f.request);
            expect(result).toMatchObject({ ok: false, errorCode: 'not_implemented', retryable: false });
            expect(result).not.toHaveProperty('unknown');
            expect(f.calls).toEqual([]); expect(f.accesses).toEqual([]);
        } finally { f.close(); }
    });

it('refuses missing mail credentials and redacts credential-boundary failures', async () => {
    const f = await mailBackendFixture();
    f.ports.integrations = { async access() { return { ok: false, error: { code: 'unavailable', message: 'private-credential-json', retryable: true } }; } };
    try {
        const result = await f.binding.mail(f.request);
        expect(result).toMatchObject({ ok: false, errorCode: 'forbidden', retryable: false });
        expect(result).not.toHaveProperty('unknown');
        expect(JSON.stringify(result)).not.toContain('private-credential-json');
        expect(f.calls).toEqual([]); expect(f.reservations()).toBe(0);
    } finally { f.close(); }
});

it('converts provider configuration refusals into fixed pre-egress outcomes', async () => {
    const f = await mailBackendFixture();
    const create = f.provider.create;
    f.provider.create = ctx => ({ ...create(ctx), async send() {
        return { ok: false, retryable: false, unknown: true, errorCode: ctx.credential.token, message: ctx.credential.token };
    } });
    try {
        const result = await f.binding.mail(f.request);
        expect(result).toEqual({ ok: false, retryable: false, errorCode: 'unavailable', message: 'Mail refused before egress' });
        expect(JSON.stringify(result)).not.toContain('fixture-token-for-fixture-mail');
        expect(f.calls).toEqual([]); expect(f.reservations()).toBe(0);
    } finally { f.close(); }
});

it('allows only one mail HTTP attempt even if a provider sends concurrently', async () => {
    const f = await mailBackendFixture();
    const create = f.provider.create;
    f.provider.create = ctx => {
        const inner = create(ctx);
        return { ...inner, async send(input) { const attempts = await Promise.all([inner.send(input), inner.send(input)]); return attempts[1]; } };
    };
    try {
        const result = await f.binding.mail(f.request);
        expect(result).toMatchObject({ ok: false, unknown: true, retryable: false });
        expect(JSON.stringify(result)).not.toContain('fixture-token-for-fixture-mail');
        expect(f.calls).toHaveLength(1); expect(f.reservations()).toBe(1);
    } finally { f.close(); }
});

it.each(['native failure', 'oversized response', 'provider throw after send'])('keeps submitted mail uncertain and secret-free: %s', async scenario => {
    const f = await mailBackendFixture({ fetch: async () => {
        if (scenario === 'native failure') throw new Error('fixture-token-for-fixture-mail');
        if (scenario === 'oversized response') return new Response('x'.repeat(1048577));
        return Response.json({ id: 'fixture-message' });
    } });
    const create = f.provider.create;
    if (scenario === 'provider throw after send') f.provider.create = ctx => {
        const inner = create(ctx);
        return { ...inner, async send(input) { await inner.send(input); throw new Error(ctx.credential.token); } };
    };
    try {
        const result = await f.binding.mail(f.request);
        expect(result).toMatchObject({ ok: false, unknown: true, retryable: false });
        expect(JSON.stringify(result)).not.toContain('fixture-token-for-fixture-mail');
        expect(f.calls).toHaveLength(1); expect(f.reservations()).toBe(1);
    } finally { f.close(); }
});

it('preserves definitive provider back-pressure without echoing provider error text', async () => {
    const f = await mailBackendFixture();
    const create = f.provider.create;
    f.provider.create = ctx => {
        const inner = create(ctx);
        return { ...inner, async send(input) {
            await inner.send(input);
            return { ok: false, retryable: true, errorCode: ctx.credential.token, message: ctx.credential.token, retryAfterMs: 2000 };
        } };
    };
    try {
        const result = await f.binding.mail(f.request);
        expect(result).toMatchObject({ ok: false, retryable: true, retryAfterMs: 2000 });
        expect(result.ok ? undefined : result.unknown).not.toBe(true);
        expect(JSON.stringify(result)).not.toContain('fixture-token-for-fixture-mail');
        expect(f.calls).toHaveLength(1);
    } finally { f.close(); }
});

const readArguments: Record<string, Record<string, ToolCall['input']>> = {
    'google-ads': {}, 'linkedin-ads': { kind: 'list_accounts' },
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
    const confirmations = createMemoryConfirmationExchange({ ...answerAudit(), clock, ids: { next: () => randomUUID() } });
    const f = await fixture({ admitted: true, only: 'linkedin-ads', confirmations });
    try {
        const definition = value({ result: await f.binding.definitions({ context }) }).find(tool => tool.name === 'vendor_linkedin_ads_pause')!;
        const input = { operationId: 'group-child', connectionId: 'connection', accountId: '123', arguments: { kind: 'pause', campaignId: '456' } };
        const args = { tool: definition.name, input };
        const child: EffectRequest = { arguments: args, pluginDigest: definition.revision, schemaFingerprint: 'c'.repeat(64), envelope: { operationId: input.operationId, connectionId: 'connection', accountId: '123', effects: ['write'], argumentsDigest: value({ result: digestArguments({ arguments: args }) }), moneyExposure: null, requiredLimit: null } };
        const reviewed = { calls: [child] };
        const root: EffectRequest = { ...child, arguments: reviewed, pausedCampaignCalls: [child], envelope: { ...child.envelope, operationId: 'group', accountId: null, effects: ['ad_spend'], argumentsDigest: value({ result: digestArguments({ arguments: reviewed }) }) } };
        const card = value({ result: await confirmations.present({ context, request: root }) });
        value({ result: await confirmations.confirm({ context, approver: { kind: 'local_token', ownerId: context.scope.ownerId, deviceId: 'fixture-device', tokenId: 'fixture-token-reference' }, response: { cardId: card.cardId, operationId: card.operationId, argumentsDigest: card.argumentsDigest, choice: 'allow' } }) });
        f.setBeforeCredential({ async callback() { value({ result: await confirmations.revoke({ context, cardId: card.cardId }) }); } });
        expect(await definition.invoke({ context, input, authorization: { ...child, approvalId: card.cardId, policyRevision: 0, campaignApproval: { operationId: 'group', argumentsDigest: card.argumentsDigest, index: 0 } }, permit: { operationId: input.operationId, argumentsDigest: child.envelope.argumentsDigest, approvalId: card.cardId, expiresAt: 30000, reservationId: 'fixture-permit' } })).toMatchObject({ ok: false });
        expect(f.accesses).toHaveLength(1); expect(f.calls).toEqual([]);
    } finally { f.close(); }
});
function selection(required: { pluginId: string; operationId?: string }) {
    return { operationId: required.operationId ?? 'read', connectionId: 'connection', accountId: required.pluginId === 'meta-ads' ? null : required.pluginId === 'google-ads' ? '1234567890' : '123',
        arguments: readArguments[required.pluginId] };
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

it('skips disabled backends, admits uploaded entries and rejects malformed commands before credentials', async () => {
    const f = await fixture({ admitted: true });
    try {
        f.states.get('google-ads')!.enabled = false;
        f.states.get('tiktok-ads')!.bundled = false;
        const definitions = value({ result: await f.binding.definitions({ context }) });
        expect(definitions.some(tool => tool.name.startsWith('vendor_google_ads_'))).toBe(false);
        expect(definitions.some(tool => tool.name === readNames['tiktok-ads'])).toBe(true);
        expect(f.loads.some(url => url.includes('/google-ads/'))).toBe(false);
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
        expect(unavailable.unavailableReason).toContain('runtime bundle');
        expect(await unavailable.invoke({ context, input: {} })).toMatchObject({ ok: false, error: { code: 'unavailable' } });
        for (const pluginId of ['linkedin-ads', 'tiktok-ads', 'meta-ads']) expect(definitions.some(tool => tool.name === readNames[pluginId])).toBe(true);
        const confirmations = createMemoryConfirmationExchange({ ...answerAudit(), clock, ids: f.ids });
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

it('fences an exact-expiry checkpoint and completion without granting a duplicate attempt', async () => {
    const f = await fixture(); let now = 1000, sends = 0;
    const jobs = bindAgentPluginJobs({ unit: f.unit, clock: { now: () => now }, ids: f.ids, observer });
    try {
        const input = { context, pluginId: 'fixture', input: selection({ pluginId: 'linkedin-ads', operationId: 'expiry' }),
            async execute({ jobId }: { jobId: string }): Promise<Outcome<unknown>> {
                now += 300000;
                const checkpoint = await jobs.checkpoint({ context, jobId, event: 'step', evidence: { phase: 'dispatch' } });
                if (!checkpoint.ok) return checkpoint;
                sends++; return { ok: true, value: {} };
            } };
        expect(await jobs.dispatch(input)).toMatchObject({ ok: false, error: { code: 'conflict' } });
        expect(await jobs.dispatch(input)).toMatchObject({ ok: false, error: { code: 'conflict' } });
        expect(sends).toBe(0);
        expect(f.native.prepare('SELECT state,attempts FROM job').all()).toEqual([{ state: 'dispatching', attempts: 1 }]);
    } finally { f.close(); }
});

it('uses one exact spend card for each single-entity activation and never a gateway card', async () => {
    const ids = { next: () => randomUUID() };
    const confirmations = createMemoryConfirmationExchange({ ...answerAudit(), clock, ids });
    const repo = createMemorySafetyRepo({ clock, ids, ownerTimezone: 'UTC' });
    const requests: EffectRequest[] = [];
    const safety = createSafetyService({ repo, confirmations, clock, ids, policy: createMemorySpendPolicy({}),
        effects: { async resolve({ request }) { const known = requests.find(item => item.envelope.operationId === request.envelope.operationId); return known ? { ok: true, value: known.envelope } : { ok: false, error: { code: 'forbidden', message: 'Unverified fixture', retryable: false } }; },
            async verifyGenerationQuote() { throw new Error('Not a generation fixture'); }, async verifyHaltStop() { throw new Error('Not a stop fixture'); } },
        accountLocks: createMemoryAccountDispatchLock({ ids }), audit: createMemorySafetyAudit({}),
        platformLimits: createMemoryPlatformLimitEvidence({ evidence: [{ scope: context.scope, evidence: { evidenceId: 'cap', accountId: '123', amount: { currency: 'USD', minorUnits: 1000 },
            window: { start: 0, end: 100000 }, observedAt: 1000, semantics: 'hard_limit', pluginDigest: createHash('sha256').update(JSON.stringify(['a'.repeat(64), 'd'.repeat(64), pathToFileURL(join(fileURLToPath(new URL('../../../', import.meta.url)), 'content/agent-plugins/linkedin-ads/io.github.ainsep.openmarketing/dist/index.mjs')).href, null])).digest('hex') } }] }) });
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
            expect(await tools.answer({ context, approver: { kind: 'local_token', ownerId: context.scope.ownerId, deviceId: 'fixture-device', tokenId: 'fixture-token-reference' }, response: { cardId: card.cardId, operationId, argumentsDigest: card.argumentsDigest, choice: 'allow' } })).toMatchObject({ ok: true });
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
        f.states.set('higgsfield-media', { entryUrl: pathToFileURL(join(fileURLToPath(new URL('../../../', import.meta.url)), 'content/agent-plugins/higgsfield-media/io.github.ainsep.openmarketing/dist/index.mjs')).href, enabled: true, bundled: true, admitted: false, revision: 'a'.repeat(64), metadata: {} });
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
function socialVendor(required: { failLinkedIn?: boolean; failRead?: boolean; includeTikTok?: boolean; failTikTok?: boolean } = {}) {
    const rows = new Map<string, Record<string, unknown>>(); let meta = 200, linkedin = 400;
    // Existing single-link Meta creative that verifies the reviewed destination before any POST.
    rows.set('987', { id: '987', account_id: '123', object_story_spec: { link_data: { link: 'https://example.test/landing' } } });
    const fetchFixture: typeof fetch = async (url, init) => {
        const uri = new URL(String(url));
        if (uri.hostname === 'business-api.tiktok.com') return tikTokDeploymentResponse({ uri, init, rows, fail: required.failTikTok });
        const isMeta = uri.hostname === 'graph.facebook.com';
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
/** Exact scoped TikTok fixture; ad creative fields are flat on GET. No live fetch. */
function tikTokDeploymentResponse(required: { uri: URL; init?: RequestInit; rows: Map<string, Record<string, unknown>>; fail?: boolean }): Response {
    const entity = required.uri.pathname.split('/').at(-3)!;
    const ids: Record<string, string> = { campaign: '701', adgroup: '702', ad: '703' };
    const id = ids[entity];
    if (required.init?.method === 'GET') {
        const filtering = JSON.parse(required.uri.searchParams.get('filtering') ?? '{}');
        expect(filtering[entity + '_ids']).toEqual([id]);
        return Response.json({ code: 0, data: { list: [required.rows.get(id)], page_info: { page: 1, page_size: 100, total_page: 1, total_number: 1 } } });
    }
    if (required.fail && entity === 'adgroup') throw new Error('Fixture uncertain TikTok create');
    const body = JSON.parse(String(required.init?.body));
    const fields = entity === 'ad' ? body.creatives[0] : body;
    expect(fields.operation_status).toBe('DISABLE');
    required.rows.set(id, { ...fields, advertiser_id: '123', campaign_id: ids.campaign, ...(entity !== 'campaign' ? { adgroup_id: ids.adgroup } : {}), ...(entity === 'ad' ? { ad_id: id } : {}) });
    return Response.json({ code: 0, data: entity === 'ad' ? { ad_ids: [id] } : { [entity + '_id']: id } });
}
const socialCampaign: NeutralCampaignLaunch = { schemaVersion: 2, operationId: 'social-draft', name: 'Traffic', objective: 'traffic',
    schedule: { window: { start: 1791849600000, end: 1792022400000 }, timezone: 'UTC' }, audience: { countries: ['US'] }, ads: [{ creativeId: 'creative', destinationUrl: 'https://example.test/landing' }], creativeDigest: 'a'.repeat(64),
    targets: ['meta-ads', 'linkedin-ads'].map(pluginId => ({ pluginId, connectionId: 'connection', accountId: '123', dailyBudget: { minorUnits: 4321, currency: 'USD' }, expectedExposure: { minorUnits: 10000, currency: 'USD' } })) }; // stored (parsed) key order
function socialMetadata(required: { pluginId: string }) {
    const common = { accountId: '123', currency: 'USD', currencyExponent: 2, timezone: 'UTC', creativeId: 'creative', creativeDigest: 'a'.repeat(64) };
    return { scope: context.scope, connectionId: 'connection', resolved: required.pluginId === 'meta-ads'
        ? { ...common, vendorCreativeId: '987', ageMin: 18, ageMax: 65, specialAdCategories: [] }
        : required.pluginId === 'tiktok-ads'
        ? { ...common, locations: [{ country: 'US', id: '6252001' }], creative: { adFormat: 'SINGLE_VIDEO', videoId: 'video', imageIds: ['cover'], identityId: 'identity', text: 'Visit us', landingPageUrl: 'https://example.test/landing' } }
        : { ...common, reference: 'urn:li:share:987', organizationId: '789', locale: { country: 'US', language: 'en' }, politicalIntent: 'NOT_POLITICAL', unitCost: { currency: 'USD', minorUnits: 237 }, locations: [{ country: 'US', id: '103644278' }] } };
}
/** Prepared vendor plans isolate approval/outbox regressions from unsupported v2 translation.
 * Only these two translators are doubled; deployment codecs/adapters and readback remain real.
 */
function usePreparedSocialPlans(required: { ports: Parameters<typeof bindAgentPluginBackends>[0] }): void {
    const plans = {
        'meta-ads': {
            campaign: { kind: 'create-campaign', name: 'Traffic', objective: 'OUTCOME_TRAFFIC', specialAdCategories: [] },
            adset: { kind: 'create-adset', name: 'Traffic', campaignId: { from: 'campaign' }, targeting: { countries: ['US'], age_min: 18, age_max: 65 }, billingEvent: 'IMPRESSIONS', optimizationGoal: 'LINK_CLICKS', dailyBudgetMinor: 4321, schedule: socialCampaign.schedule.window },
            ad: { kind: 'create-ad', name: 'Traffic', creativeId: '987', adsetId: { from: 'adset' }, destinationUrl: socialCampaign.ads[0]!.destinationUrl },
        },
        'linkedin-ads': {
            group: { kind: 'create_campaign_group_draft', name: 'Traffic', runSchedule: socialCampaign.schedule.window },
            campaign: { kind: 'create_campaign_draft', name: 'Traffic', campaignGroupId: { from: 'group' }, organizationId: '789', locale: { country: 'US', language: 'en' }, geoIds: ['103644278'], dailyBudget: { amount: '43.21', currencyCode: 'USD' }, unitCost: { amount: '2.37', currencyCode: 'USD' }, costType: 'CPC', runSchedule: socialCampaign.schedule.window, politicalIntent: 'NOT_POLITICAL' },
            creative: { kind: 'create_creative_draft', campaignId: { from: 'campaign' }, reference: 'urn:li:share:987' },
        },
    };
    const load = required.ports.loadModule;
    required.ports.loadModule = async input => {
        const module = await load(input);
        const pluginId = new URL(input.moduleUrl).pathname.split('/').at(-4);
        if (pluginId !== 'meta-ads' && pluginId !== 'linkedin-ads') return module;
        return { ...module, translateCampaign: () => ({ ok: true, value: plans[pluginId] }) };
    };
}
/** Real grouped safety/SQL outbox and plugin deployment adapters; prepared social plans above. */
async function deploymentFixture(required: Parameters<typeof socialVendor>[0] = {}) {
    const campaign = required.includeTikTok ? { ...socialCampaign, targets: [...socialCampaign.targets, { ...socialCampaign.targets[0], pluginId: 'tiktok-ads' }] } : socialCampaign;
    const vendor = socialVendor(required); const f = await fixture({ admitted: true, fetch: vendor.fetch });
    usePreparedSocialPlans({ ports: f.ports });
    for (const [pluginId, state] of f.states) { state.enabled = ['meta-ads', 'linkedin-ads'].includes(pluginId) || (pluginId === 'tiktok-ads' && required.includeTikTok === true); state.metadata = { ...state.metadata, campaignFixture: socialMetadata({ pluginId }) }; }
    const confirmations = createMemoryConfirmationExchange({ ...answerAudit(), clock, ids: f.ids });
    const prepared = value({ result: await f.binding.prepareCampaign({ context, campaign, operationId: 'social-launch' }) });
    expect(prepared.validation.map(item => item.status)).toEqual(campaign.targets.map(() => 'unsupported'));
    const safety = createSafetyService({ repo: f.safetyRepo, confirmations, clock, ids: f.ids, accountLocks: f.ports.accountLocks, policy: createMemorySpendPolicy({}), platformLimits: createMemoryPlatformLimitEvidence({}), audit: createMemorySafetyAudit({}),
        effects: { async resolve({ request }) { const known = prepared.calls.find(call => value({ result: digestArguments({ arguments: call }) }) === value({ result: digestArguments({ arguments: request }) })); return known ? { ok: true, value: known.envelope } : { ok: false, error: { code: 'forbidden', message: 'Unverified fixture', retryable: false } }; }, async verifyGenerationQuote() { throw new Error('Not generation'); }, async verifyHaltStop() { throw new Error('Not stop'); } } });
    const binding = bindAgentPluginBackends({ ...f.ports, confirmations, safety });
    const repo = createMemoryCampaignRepo({}); const draft = value({ result: await repo.saveNeutral({ context, campaign }) });
    const definition = bindPausedCampaignDeployment({ unit: f.unit, repo, clock, ids: f.ids, observer, safety, confirmations,
        prepare: binding.prepareCampaign, definitions: binding.definitions, execute: binding.executeCampaign, read: binding.readCampaign });
    const tools = createOmTools({ clock, observer, confirmations, definitions: async () => ({ ok: true, value: [definition, ...value({ result: await binding.definitions({ context }) })] }), authorize: () => ({ ok: true, value: undefined }) });
    async function approve() {
        expect(value({ result: await tools.dispatch({ context, call: { name: definition.name, operationId: 'social-launch', input: { campaignId: draft.campaignId } } }) }).status).toBe('pending');
        const card = value({ result: await tools.card({ context, operationId: 'social-launch' }) })!;
        expect(card.allowedChoices).toEqual(['allow', 'cancel']); expect(f.calls).toEqual([]);
        value({ result: await tools.answer({ context, approver: { kind: 'local_token', ownerId: context.scope.ownerId, deviceId: 'fixture-device', tokenId: 'fixture-token-reference' }, response: { cardId: card.cardId, operationId: card.operationId, argumentsDigest: card.argumentsDigest, choice: 'allow' } }) });
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
it('resolves only the frozen deployment plugin without paging or importing unrelated plugins', async () => {
    const f = await deploymentFixture();
    try {
        const { calls } = value({ result: await f.binding.prepareCampaign({ context, campaign: socialCampaign, operationId: 'targeted-lookup' }) });
        const selected = calls.find(call => (call.arguments as { tool: string }).tool === 'vendor_meta_ads_campaign_deploy_paused')!;
        const loads: string[] = [];
        const hashes: string[] = [];
        const binding = bindAgentPluginBackends({ ...f.ports,
            addons: { async list() { throw new Error('Frozen deployment must not scan the installed catalog'); } },
            async moduleDigest(input) { hashes.push(input.moduleUrl); return f.ports.moduleDigest(input); },
            async loadModule(input) { loads.push(input.moduleUrl); return f.ports.loadModule(input); },
        });
        const result = await binding.executeCampaign({ context, call: selected, evidence: [], checkpoint: async () => ({ ok: true, value: undefined }) });
        expect(result.ok).toBe(true);
        expect(loads.length).toBeGreaterThan(0); expect(hashes.length).toBeGreaterThan(0);
        expect([...loads, ...hashes].every(url => url.includes('/meta-ads/'))).toBe(true);
        expect(await binding.executeCampaign({ context, call: { ...selected, arguments: { ...(selected.arguments as Record<string, unknown>), tool: 'untrusted_tool' } }, evidence: [], checkpoint: async () => ({ ok: true, value: undefined }) })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
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
        const call = value({ result: await f.binding.prepareCampaign({ context, campaign: socialCampaign, operationId: 'social-launch' }) }).calls[1];
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
        const call = value({ result: await f.binding.prepareCampaign({ context, campaign: socialCampaign, operationId: 'social-launch' }) }).calls[0];
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

it.each([[null, true, ['read']], ['A'.repeat(22), true, ['read']], [null, false, ['read']], [null, true, ['read', 'write']]] as const)('Google validates before creation and refuses an unsafe validator (secret %s, validator admitted %s, effects %j)', async (token, validatorAdmitted, effects) => {
    const f = await fixture({ admitted: true, only: 'google-ads', fetch: async (url, init) => {
        const body = JSON.parse(String(init?.body));
        if (String(url).endsWith('googleAds:mutate')) {
            expect(body.partialFailure).toBe(false);
            if (body.validateOnly === true) return Response.json({});
            expect(body.validateOnly).toBe(false);
            const keys = ['campaignBudgetResult', 'campaignResult', 'adGroupResult', 'campaignCriterionResult', 'adGroupCriterionResult', 'adGroupAdResult'];
            const paths = ['campaignBudgets/101', 'campaigns/201', 'adGroups/301', 'campaignCriteria/201~2840', 'adGroupCriteria/301~501', 'adGroupAds/301~401'];
            return Response.json({ mutateOperationResponses: keys.map((key, index) => ({ [key]: { resourceName: 'customers/1234567890/' + paths[index] } })) });
        }
        return Response.json({ results: /FROM customer(?: LIMIT 2)?$/.test(String(body.query)) ? [{ customer: { id: '1234567890', currencyCode: 'USD', timeZone: 'UTC', testAccount: true } }] : [] });
    } });
    const confirmations = createMemoryConfirmationExchange({ ...answerAudit(), clock, ids: f.ids });
    const state = f.states.get('google-ads')!; state.metadata.loginCustomerId = '9999999999';
    state.capabilities = [{ capabilityId: 'campaign.validate.v1', version: 1, pluginId: 'google-ads', schemaFingerprint: 'b'.repeat(64), effects: [...effects], admitted: validatorAdmitted }];
    // Reuse the capability fixture's cancellable pending deadline rather than an immediate expiry.
    f.ports.wait = (_input, options) => new Promise(resolve => { options?.signal?.addEventListener('abort', () => resolve({ ok: false, error: { code: 'cancelled', message: 'Fixture timer cleared', retryable: false } }), { once: true }); });
    const campaign = { ...socialCampaign, audience: { countries: ['US'], searchTerms: ['marketing tools'] }, targets: [{ ...socialCampaign.targets[0], pluginId: 'google-ads', accountId: '1234567890' }] };
    state.metadata.campaignFixture = { scope: context.scope, connectionId: 'connection', resolved: {
        binding: { scope: context.scope, connectionId: 'connection', customerId: '1234567890', currency: 'USD', timezone: 'UTC', mode: 'sandbox', pluginDigest: 'a'.repeat(64), schemaFingerprint: 'b'.repeat(64) },
        currencyExponent: 2, creativeId: 'creative', creativeDigest: campaign.creativeDigest, locations: [{ country: 'US', id: '2840' }], cpcBidMicros: '2370000',
        headlines: ['Open Marketing', 'Plan Search Campaigns', 'See Clear Reports'], descriptions: ['Plan paused Search campaigns.', 'Review each exact spend call.'], finalUrl: 'https://example.test/landing', euPoliticalAdvertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING' } };
    const binding = bindAgentPluginBackends({ ...f.ports, confirmations, integrations: { async access(input, optional) {
        const accessed = await f.ports.integrations.access(input, optional);
        return accessed.ok && token ? { ok: true, value: { ...accessed.value, secrets: { developerToken: token } } } : accessed;
    } } });
    try {
        const prepared = await binding.prepareCampaign({ context, campaign, operationId: 'google-launch' });
        if (!validatorAdmitted || effects.some(effect => effect === 'write')) {
            expect(prepared).toMatchObject({ ok: false, error: { code: 'forbidden', message: 'Campaign validation unavailable' } });
            expect(f.calls).toEqual([]); expect(f.accesses).toEqual([]);
            return;
        }
        const { calls, validation } = value({ result: prepared });
        expect(validation[0]).toMatchObject({ status: 'validated', argumentsDigest: calls[0].envelope.argumentsDigest, pluginDigest: calls[0].pluginDigest, schemaFingerprint: calls[0].schemaFingerprint });
        const { evidenceDigest, ...evidence } = validation[0];
        expect(evidenceDigest).toBe(value({ result: digestArguments({ arguments: evidence }) }));
        const rootArgs = { calls, validation }; const root: EffectRequest = { arguments: rootArgs, pausedCampaignCalls: calls, pluginDigest: 'a'.repeat(64), schemaFingerprint: 'b'.repeat(64),
            envelope: { ...calls[0].envelope, operationId: 'google-launch', accountId: null, effects: ['ad_spend'], argumentsDigest: value({ result: digestArguments({ arguments: rootArgs }) }) } };
        const card = value({ result: await confirmations.present({ context, request: root }) });
        value({ result: await confirmations.confirm({ context, approver: { kind: 'local_token', ownerId: context.scope.ownerId, deviceId: 'fixture-device', tokenId: 'fixture-token-reference' }, response: { cardId: card.cardId, operationId: card.operationId, argumentsDigest: card.argumentsDigest, choice: 'allow' } }) });
        const authorization = { ...calls[0], approvalId: card.cardId, policyRevision: 0, campaignApproval: { operationId: 'google-launch', argumentsDigest: card.argumentsDigest, index: 0 } };
        const result = await f.jobs.dispatch({ context, pluginId: 'om-campaigns', input: { operationId: 'google-launch', connectionId: 'om_campaign_deploy_paused', accountId: null, arguments: { intent: 'deploy-paused', request: boundedJsonSchema.parse(root) } },
            execute: async ({ jobId }) => binding.executeCampaign({ context, call: calls[0], authorization, permit: { operationId: calls[0].envelope.operationId, argumentsDigest: calls[0].envelope.argumentsDigest, approvalId: card.cardId, expiresAt: 300000, reservationId: 'fixture-permit' },
                checkpoint: item => f.jobs.checkpoint({ context, jobId, event: 'google-step.' + item.step, evidence: { ...item, operationId: calls[0].envelope.operationId } }) }) });
        expect(result).toMatchObject({ ok: true, value: { status: 'unknown', entityIds: expect.arrayContaining(['customers/1234567890/campaigns/201']) } });
        expect(f.native.prepare('SELECT state FROM job').all()).toEqual([{ state: 'reconcile' }]);
        expect(JSON.stringify(f.native.prepare('SELECT evidence_id FROM job_attempt').all())).toContain('customers/1234567890/campaigns/201');
        expect(f.accesses).toHaveLength(f.calls.length);
        for (const call of f.calls) { const headers = new Headers(call.options?.headers); expect(headers.get('developer-token')).toBe(token); expect(headers.get('login-customer-id')).toBe('9999999999'); }
        const before = f.calls.length;
        const read = value({ result: await binding.definitions({ context }) }).find(tool => tool.name === 'om_campaign_reconcile_deployment')!;
        await read.invoke({ context, input: { operationId: 'google-launch' } });
        expect(f.calls.slice(before).every(call => call.url.endsWith('googleAds:search'))).toBe(true);
        const mutates = f.calls.filter(call => call.url.endsWith('googleAds:mutate')).map(call => JSON.parse(String(call.options?.body)));
        expect(mutates).toHaveLength(2); expect(mutates[0].validateOnly).toBe(true); expect(mutates[1].validateOnly).toBe(false);
        expect(mutates[0]).toEqual({ ...mutates[1], validateOnly: true });
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
        const loadModule = f.ports.loadModule;
        usePreparedSocialPlans({ ports: f.ports });
        const call = value({ result: await f.binding.prepareCampaign({ context, campaign: { ...socialCampaign, targets: [socialCampaign.targets[0]] }, operationId: 'ready' }) }).calls[0];
        f.ports.loadModule = loadModule;
        f.states.get('meta-ads')!.admitted = false;
        expect(await f.binding.executeCampaign({ context, call, evidence: [], checkpoint: async () => ({ ok: true, value: undefined }) })).toMatchObject({ ok: false });
        f.states.get('meta-ads')!.admitted = true;
        expect(await f.binding.prepareCampaign({ context, campaign: { ...socialCampaign, audience: { countries: ['US'], searchTerms: ['cannot discard'] }, targets: [socialCampaign.targets[0]] }, operationId: 'incompatible' })).toMatchObject({ ok: false, error: { code: 'not_implemented' } });
        expect(f.accesses).toEqual([]); expect(f.calls).toEqual([]); expect(f.native.prepare('SELECT id FROM job').all()).toEqual([]);
    } finally { f.close(); }
});
// Meta now carries ad.destinationUrl in its plan and verifies it against the creative (GET) before any POST.
it.each(['linkedin-ads'])('rejects unverified %s destinations without credentials, egress or enqueue', async pluginId => {
    const f = await fixture({ admitted: true, only: pluginId });
    f.states.get(pluginId)!.metadata.campaignFixture = socialMetadata({ pluginId });
    const campaign = { ...socialCampaign, targets: socialCampaign.targets.filter(target => target.pluginId === pluginId) };
    try {
        expect(await f.binding.prepareCampaign({ context, campaign, operationId: 'unverified-destination' })).toMatchObject({ ok: false, error: { code: 'not_implemented', message: expect.stringContaining('destination URL') } });
        expect(f.accesses).toEqual([]); expect(f.calls).toEqual([]);
        expect(f.native.prepare('SELECT id FROM job').all()).toEqual([]);
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
        expect(await f.jobs.checkpoint({ context, jobId, event: 'observation', evidence: { phase: 'observation' } })).toEqual({ ok: true, value: undefined });
        expect(f.native.prepare("SELECT event_type FROM job_attempt WHERE event_type='campaign-step'").all()).toHaveLength(1);
    } finally { f.close(); }
});

it.each([false, true])('includes TikTok in the one grouped card/job and preserves partial outcomes (failure: %s)', async failTikTok => {
    const f = await deploymentFixture({ includeTikTok: true, failTikTok });
    try {
        await f.approve();
        expect(value({ result: await f.tools.operation({ context, operationId: 'social-launch' }) })).toMatchObject({ status: failTikTok ? 'unknown' : 'completed' });
        const before = f.calls.length;
        const read = value({ result: await f.binding.definitions({ context }) }).find(tool => tool.name === 'om_campaign_reconcile_deployment')!;
        expect(await read.invoke({ context, input: { operationId: 'social-launch' } })).toMatchObject({ ok: true, value: { complete: !failTikTok, outcomes: [
            { result: { status: 'acknowledged' } }, { result: { status: 'acknowledged' } },
            { result: { status: failTikTok ? 'unknown' : 'acknowledged', references: failTikTok ? { campaign: '701' } : { campaign: '701', adgroup: '702', ad: '703' } } },
        ] } });
        expect(f.calls.slice(before).every(call => call.options?.method === 'GET')).toBe(true);
        expect(f.calls.filter(call => call.options?.method === 'POST')).toHaveLength(failTikTok ? 8 : 9);
        expect(f.native.prepare('SELECT id FROM job').all()).toHaveLength(1);
        expect(f.calls.filter(call => call.url.includes('tiktok.com')).every(call => call.url.includes('/open_api/v1.3/'))).toBe(true);
    } finally { await f.closeAll(); }
});
it('rechecks TikTok admission during credential lookup after the other vendors finish', async () => {
    const f = await deploymentFixture({ includeTikTok: true });
    f.setBeforeCredential({ async callback() { if (f.accesses.at(-1)?.pluginId === 'tiktok-ads') f.states.get('tiktok-ads')!.admitted = false; } });
    try {
        await f.approve();
        expect(value({ result: await f.tools.operation({ context, operationId: 'social-launch' }) })).toMatchObject({ status: 'unknown' });
        expect(f.calls.filter(call => call.url.includes('tiktok.com'))).toEqual([]);
        expect(f.calls.filter(call => call.options?.method === 'POST')).toHaveLength(6);
    } finally { await f.closeAll(); }
});

function capabilityRow(required: Record<string, unknown>) {
    return { capabilityId: 'campaign.status.v1', version: 1, pluginId: 'fixture-sixth', schemaFingerprint: 'b'.repeat(64), effects: ['read'], admitted: true, ...required };
}

/** Replacement plugin exercises the installed ABI through real host guards; all egress is fake. */
async function capabilityFixture(required: { capabilities?: unknown; output?: unknown; module?: object } = {}) {
    const f = await fixture({ admitted: true, only: 'fixture-sixth' });
    const pluginId = 'fixture-sixth';
    const capabilities = required.capabilities ?? [capabilityRow({ effects: [] })];
    f.states.set(pluginId, { enabled: true, bundled: false, admitted: true, revision: 'a'.repeat(64), metadata: {},
        entryUrl: 'file:///installed/fixture-sixth/io.github.ainsep.openmarketing/dist/index.mjs', capabilities });
    let factories = 0;
    const publications: Parameters<PluginCapability<'organic.publish.v1'>>[0][] = [];
    let received!: Parameters<PluginCapabilitiesFactory>[0];
    const output = required.output ?? { observedAt: 1000, complete: true, campaigns: [{ vendorCampaignId: 'campaign', status: 'paused', disapprovalDescriptions: [] }] };
    const createCapabilities: PluginCapabilitiesFactory = ports => {
        received = ports;
        factories++;
        async function read(call: Parameters<PluginCapability>[0], optional?: CallOptions): Promise<Outcome<unknown>> {
            const access = await ports.credentials.access(call.connection, optional);
            if (!access.ok) return access;
            await ports.fetch('https://fixture.invalid/read', { signal: optional?.signal });
            return { ok: true, value: output };
        }
        // Tainted output is intentional: malformed-response cases exercise the host parser.
        return { 'campaign.status.v1': read as PluginCapability<'campaign.status.v1'>,
            'report.metrics.v1': read as PluginCapability<'report.metrics.v1'>, 'tracking.tag.v1': read as PluginCapability<'tracking.tag.v1'>,
            'organic.publish.v1': async (call, optional) => {
                publications.push(call);
                const access = await ports.credentials.access(call.connection, optional);
                if (!access.ok) return access;
                await ports.fetch('https://fixture.invalid/publish', { method: 'POST', signal: optional?.signal });
                return { ok: true, value: capabilityCatalog['organic.publish.v1'].output.parse(output) };
            } };
    };
    const module = required.module ?? { createCapabilities };
    const waits: { milliseconds: number; signal?: AbortSignal }[] = [];
    let finishWait: (result: Outcome<void>) => void = () => {};
    const ports = { ...f.ports, async loadModule(input: { moduleUrl: string }) {
        return input.moduleUrl.includes('/fixture-sixth/') ? module : f.ports.loadModule(input);
    }, wait(input: { milliseconds: number }, optional?: CallOptions): Promise<Outcome<void>> {
        waits.push({ ...input, signal: optional?.signal });
        return new Promise(resolve => {
            finishWait = resolve;
            optional?.signal?.addEventListener('abort', () => resolve({ ok: false, error: { code: 'cancelled', message: 'Fixture timer cleared', retryable: false } }), { once: true });
        });
    } };
    const binding = bindAgentPluginBackends(ports);
    const request = { context, pluginId, capabilityId: 'campaign.status.v1' as const, connection: { connectionId: 'connection', accountId: '123' }, input: { vendorCampaignIds: ['campaign'] } };
    return { ...f, binding, ports, request, output, waits, publications, expire: () => finishWait({ ok: true, value: undefined }), factories: () => factories, dependencies: () => received };
}

it('exposes only the approved write capability with a fresh owner card and dispatches through the outbox', async () => {
    const f = await capabilityFixture({ capabilities: [capabilityRow({ capabilityId: 'organic.publish.v1', effects: ['write'] }),
        capabilityRow({ capabilityId: 'audience.member.add.v1', effects: ['write'] })], output: { status: 'published', postId: 'fixture-post' } });
    const input = { operationId: 'organic-update', connectionId: 'connection', accountId: '123', arguments: { text: 'Exact update', languageCode: 'en' } };
    const dispatches: Parameters<typeof f.jobs.dispatch>[0][] = [];
    const dispatch = f.jobs.dispatch;
    f.jobs.dispatch = async call => { dispatches.push(call); return dispatch(call); };
    try {
        const definitions = value({ result: await f.binding.definitions({ context }) });
        const tool = definitions.find(tool => tool.name === 'vendor_fixture_sixth_organic_publish_v1')!;
        expect(tool).toMatchObject({ policy: 'write', effects: ['write'], ownerOnly: true });
        expect(definitions.some(tool => tool.name === 'vendor_fixture_sixth_audience_member_add_v1')).toBe(false);
        expect(f.factories()).toBe(0);
        // Deliberately cross the typed read-only API to verify its runtime refusal.
        expect(await f.binding.invokeCapability({ ...f.request, capabilityId: 'organic.publish.v1', input: input.arguments } as unknown as typeof f.request))
            .toMatchObject({ ok: false, error: { code: 'forbidden' } });
        expect(dispatches).toEqual([]); expect(f.factories()).toBe(0);
        expect(await tool.invoke({ context, input })).toEqual({ ok: true, value: f.output });
        expect(dispatches).toHaveLength(1); expect(dispatches[0].input).toEqual(input);
        expect(f.factories()).toBe(1); expect(f.publications).toEqual([{ context, connection: { connectionId: 'connection', accountId: '123' }, input: input.arguments }]);
        expect(f.calls).toHaveLength(1); expect(f.native.prepare('SELECT id FROM job').all()).toHaveLength(1);
        expect(await tool.invoke({ context, input })).toMatchObject({ ok: false, error: { code: 'conflict' } });
        expect(f.factories()).toBe(1); expect(f.calls).toHaveLength(1);
    } finally { f.close(); }
});

it('keeps organic publishing unavailable in read_only mode before constructing a handler', async () => {
    const f = await capabilityFixture({ capabilities: [capabilityRow({ capabilityId: 'organic.publish.v1', effects: ['write'] })] });
    const backends = bindAgentPluginBackends({ ...f.ports, mode: 'read_only' });
    try {
        const tool = value({ result: await backends.definitions({ context }) }).find(tool => tool.name === 'vendor_fixture_sixth_organic_publish_v1')!;
        expect(tool.unavailableReason).toBe('Local vendor account mode is read-only');
        expect(await tool.invoke({ context, input: { operationId: 'blocked-update', connectionId: 'connection', accountId: '123', arguments: { text: 'Update' } } }))
            .toMatchObject({ ok: false, error: { code: 'unavailable' } });
        expect(f.factories()).toBe(0); expect(f.calls).toEqual([]); expect(f.accesses).toEqual([]);
        expect(f.native.prepare('SELECT id FROM job').all()).toEqual([]);
    } finally { f.close(); }
});

it.each([
    { name: 'no halt manifest row', factories: 1, accesses: 1, fetches: 1, outcome: { ok: true, value: { status: 'acknowledged', entityIds: ['456'] } } },
    { name: 'missing handler', factories: 1, accesses: 0, fetches: 0, outcome: { ok: false, error: { code: 'not_implemented', message: 'Plugin has no campaign.halt-stop.v1 capability' } } },
    { name: 'revision mismatch', factories: 0, accesses: 0, fetches: 0, outcome: { ok: false, error: { code: 'conflict' } } },
    { name: 'binding changed', factories: 0, accesses: 0, fetches: 0, outcome: { ok: false, error: { message: 'Stop account binding unavailable' } } },
    { name: 'expired at fetch', factories: 1, accesses: 1, fetches: 0, outcome: { ok: false, error: { message: 'Stop result unknown; reconcile before retrying' } } },
    { name: 'handler throws', factories: 1, accesses: 0, fetches: 0, outcome: { ok: false, error: { message: 'Stop result unknown; reconcile before retrying' } } },
])('dispatches halt with the permit and guarded capability: $name', async row => {
    let factories = 0; let now = 1000;
    const createCapabilities: PluginCapabilitiesFactory = ports => {
        factories++;
        if (row.name === 'missing handler') return {};
        return { 'campaign.halt-stop.v1': async (call, optional) => {
            if (row.name === 'handler throws') throw new Error('fixture-token-must-stay-private');
            expect(call.input).toEqual(permit.request);
            const access = await ports.credentials.access(call.connection, optional);
            if (!access.ok) return access;
            if (row.name === 'expired at fetch') now = permit.expiresAt;
            await ports.fetch('https://fixture.invalid/stop', { method: 'PATCH', signal: optional?.signal });
            return { ok: true, value: { status: 'acknowledged', entityIds: call.input.entityIds } };
        } };
    };
    const f = await capabilityFixture({ module: { createCapabilities } });
    f.ports.clock = { now: () => now };
    const revision = value({ result: await f.binding.definitions({ context }) }).find(tool => tool.name === 'vendor_fixture_sixth_campaign_status_v1')!.revision!;
    const args = { adAccountId: '123', entityIds: ['456'], action: 'pause' as const };
    const permit: HaltStopPermit = { kind: 'halt-stop', expiresAt: 2000, request: { ...args, operationId: 'stop', scope: context.scope,
        connectionId: 'connection', haltId: 'halt', haltEpoch: 1, bindingId: 'fixture.stop.v1',
        pluginDigest: row.name === 'revision mismatch' ? 'f'.repeat(64) : revision,
        argumentsDigest: value({ result: digestArguments({ arguments: args }) }) } };
    try {
        f.halt();
        if (row.name === 'binding changed') f.ports.accounts = { async find({ externalAccountId }) {
            return { ok: true, value: { id: 'binding', scope: context.scope, connectionId: 'different', externalAccountId } };
        } };
        const result = await f.binding.haltStop({ context, pluginId: 'fixture-sixth', permit });
        expect(result).toMatchObject(row.outcome);
        expect(JSON.stringify(result)).not.toContain('fixture-token-must-stay-private');
        expect(factories).toBe(row.factories);
        expect(f.accesses).toHaveLength(row.accesses);
        expect(f.calls).toHaveLength(row.fetches);
    } finally { f.close(); }
});

it('discovers a sixth uploaded plugin and invokes it with the catalog read floor without a new vendor branch', async () => {
    const f = await capabilityFixture();
    f.states.get('fixture-sixth')!.metadata = { admitted: false, installOption: 'kept', mailAdapters: [{ id: 'fixture', module: 'mail.mjs', credentialKeys: ['token'], feedback: false }] };
    try {
        const definitions = value({ result: await f.binding.definitions({ context }) });
        expect(definitions.find(tool => tool.name === 'vendor_fixture_sixth_campaign_status_v1')).toMatchObject({ effects: ['read'], policy: 'read' });
        expect(f.factories()).toBe(0); expect(f.accesses).toEqual([]);
        expect(await f.binding.invokeCapability(f.request)).toEqual({ ok: true, value: f.output });
        expect(Object.keys(f.dependencies()).sort()).toEqual(['clock', 'configuration', 'credentials', 'fetch', 'observer', 'wait']);
        expect(f.dependencies().configuration.settings).toEqual({ installOption: 'kept' });
        expect(f.factories()).toBe(1); expect(f.calls).toHaveLength(1);
        expect(f.waits).toHaveLength(1);
        expect(f.waits[0].milliseconds).toBe(30000);
        expect(f.waits[0].signal?.aborted).toBe(true);
        expect(f.calls[0].options?.signal?.aborted).toBe(true);
        expect(f.accesses).toMatchObject([{ pluginId: 'fixture-sixth', connectionId: 'connection' }]);
        expect(f.native.prepare('SELECT * FROM job').all()).toEqual([]);
    } finally { f.close(); }
});

it('skips enabled skill-only and unbuilt plugins before hashing or importing', async () => {
    const f = await capabilityFixture();
    for (const state of f.states.values()) state.enabled = false;
    f.states.set('om-playbook', { enabled: true, admitted: true, bundled: true, revision: 'a'.repeat(64), metadata: {} });
    f.states.set('unbuilt-ads', { enabled: true, admitted: true, bundled: true, revision: 'a'.repeat(64), metadata: {}, capabilities: [capabilityRow({ pluginId: 'unbuilt-ads' })] });
    let hashes = 0;
    f.ports.moduleDigest = async () => { hashes++; return 'd'.repeat(64); };
    try {
        const definitions = value({ result: await f.binding.definitions({ context }) });
        expect(definitions.map(tool => tool.name)).toEqual(['om_campaign_reconcile_deployment']);
        expect(hashes).toBe(0); expect(f.loads).toEqual([]); expect(f.factories()).toBe(0);
    } finally { f.close(); }
});

it('does not turn legacy string declarations into executable capabilities', async () => {
    const f = await capabilityFixture({ capabilities: ['campaign.status.v1', { capabilityId: 'legacy.read', effects: ['read'] }] });
    try {
        expect(value({ result: await f.binding.definitions({ context }) }).map(tool => tool.name)).toEqual(['om_campaign_reconcile_deployment']);
        expect(await f.binding.invokeCapability(f.request)).toMatchObject({ ok: false });
        expect(f.factories()).toBe(0);
    } finally { f.close(); }
});

it('accepts server-built configuration through the real TikTok source factory and guarded invoker', async () => {
    const f = await capabilityFixture();
    const manifest = JSON.parse(readFileSync(new URL('../../../content/agent-plugins/tiktok-ads/io.github.ainsep.openmarketing/capabilities.json', import.meta.url), 'utf8'));
    f.states.delete('fixture-sixth');
    const state = f.states.get('tiktok-ads')!;
    state.enabled = true;
    state.capabilities = manifest.capabilities;
    const calls: { url: URL; options?: RequestInit }[] = [];
    const binding = bindAgentPluginBackends({ ...f.ports, async loadModule() { return tikTokSource; },
        async fetch(url, options) {
            expect(f.native.inTransaction).toBe(false);
            calls.push({ url: new URL(String(url)), options });
            return new Response(JSON.stringify({ code: 0, data: {
                list: [{ advertiser_id: '123', campaign_id: '456', campaign_name: 'Fixture paused campaign', operation_status: 'DISABLE' }],
                page_info: { page: 1, page_size: 100, total_page: 1, total_number: 1 },
            } }), { headers: { 'content-type': 'application/json' } });
        } });
    try {
        expect(value({ result: await binding.definitions({ context }) }).find(tool => tool.name === 'vendor_tiktok_ads_campaign_status_v1')).toMatchObject({ policy: 'read', unavailableReason: 'Capability unadmitted' });
        expect(await binding.invokeCapability({ ...f.request, pluginId: 'tiktok-ads', input: { vendorCampaignIds: ['456'] } })).toMatchObject({ ok: false });
        expect(f.accesses).toEqual([]);
        expect(calls).toEqual([]);
        state.capabilities = manifest.capabilities.map((row: { capabilityId: string }) => ({ ...row, admitted: true }));
        const result = value({ result: await binding.invokeCapability({ ...f.request, pluginId: 'tiktok-ads', input: { vendorCampaignIds: ['456'] } }) });
        expect(capabilityCatalog['campaign.status.v1'].output.parse(result)).toEqual({ observedAt: 1000, complete: true,
            campaigns: [{ vendorCampaignId: '456', status: 'paused', disapprovalDescriptions: [] }] });
        expect(f.accesses).toEqual([{ context: { ...context, principal: { kind: 'service', serviceId: 'om-agent-plugin-backends' } }, pluginId: 'tiktok-ads', connectionId: 'connection' }]);
        expect(calls).toHaveLength(1);
        const call = calls[0]!;
        expect(call.url.origin + call.url.pathname).toBe('https://business-api.tiktok.com/open_api/v1.3/campaign/get/');
        expect(call.url.searchParams.get('advertiser_id')).toBe('123');
        expect(JSON.parse(call.url.searchParams.get('filtering')!)).toEqual({ campaign_ids: ['456'], primary_status: 'STATUS_ALL' });
        expect(call.options?.method).toBe('GET');
        expect(new Headers(call.options?.headers).get('Access-Token')).toBe('fixture-token-for-tiktok-ads');
        expect(f.native.prepare('SELECT * FROM job').all()).toEqual([]);
    } finally { f.close(); }
});

it.each(['deadline', 'caller'] as const)('settles %s cancellation even when a handler ignores its signal', async cause => {
    let entered: () => void = () => {};
    const started = new Promise<void>(resolve => { entered = resolve; });
    let handlerSignal: AbortSignal | undefined;
    let lateFetch: typeof fetch | undefined;
    const createCapabilities: PluginCapabilitiesFactory = required => {
        lateFetch = required.fetch;
        return { 'campaign.status.v1': (_call, optional) => {
            handlerSignal = optional?.signal; entered();
            return new Promise(() => {});
        } };
    };
    const f = await capabilityFixture({ module: { createCapabilities } });
    const caller = new AbortController();
    try {
        const pending = f.binding.invokeCapability(f.request, { signal: caller.signal });
        await started;
        if (cause === 'deadline') f.expire(); else caller.abort();
        expect(await pending).toMatchObject({ ok: false, error: { code: cause === 'deadline' ? 'expired' : 'cancelled' } });
        expect(handlerSignal?.aborted).toBe(true); expect(f.waits[0].signal?.aborted).toBe(true);
        await expect(lateFetch!('https://fixture.invalid/late')).rejects.toThrow();
        expect(f.calls).toEqual([]); expect(f.accesses).toEqual([]);
    } finally { f.close(); }
});

it('pages installed discovery and isolates malformed declarations from a healthy plugin', async () => {
    const f = await capabilityFixture({ capabilities: [capabilityRow({ version: 2 })] });
    const cursors: (string | undefined)[] = [];
    f.states.get('linkedin-ads')!.enabled = true;
    const binding = bindAgentPluginBackends({ ...f.ports, addons: { async list({ query }) {
        cursors.push(query.cursor);
        const id = query.cursor ? 'fixture-sixth' : 'linkedin-ads';
        return { ok: true, value: { items: [{ kind: 'agent-plugin', id, name: id, description: '', version: '1', enabled: true, revision: 'a'.repeat(64) }], cursor: query.cursor ? null : 'page-2' } };
    } } });
    try {
        const definitions = value({ result: await binding.definitions({ context }) });
        expect(cursors).toEqual([undefined, 'page-2']);
        expect(definitions.some(tool => tool.name === readNames['linkedin-ads'])).toBe(true);
        expect(definitions.find(tool => tool.name === 'vendor_fixture_sixth_unavailable')?.unavailableReason).toBeTruthy();
        expect(f.factories()).toBe(0); expect(f.calls).toEqual([]);
    } finally { f.close(); }
});

it('keeps a callable capability when the same plugin also declares a reserved ID', async () => {
    const f = await capabilityFixture({ capabilities: [capabilityRow({ effects: [] }), capabilityRow({ capabilityId: 'brand.extract.v1', effects: [] })] });
    try {
        expect(await f.binding.invokeCapability(f.request)).toEqual({ ok: true, value: f.output });
    } finally { f.close(); }
});

it('keeps generic tools when createCapabilities is missing', async () => {
    const f = await capabilityFixture({ module: { ...fixtureToolDeclarations, createTools: () => ({}) } });
    try {
        const definitions = value({ result: await f.binding.definitions({ context }) });
        expect(definitions.find(tool => tool.name === 'vendor_fixture_sixth_read')).toMatchObject({ policy: 'read', unavailableReason: undefined });
        expect(definitions.some(tool => tool.name === 'vendor_fixture_sixth_campaign_status_v1')).toBe(false);
    } finally { f.close(); }
});

it('keeps capabilities when tools have no createTools factory', async () => {
    const f = await capabilityFixture();
    const binding = bindAgentPluginBackends({ ...f.ports, async loadModule(input) {
        return { ...await f.ports.loadModule(input), ...fixtureToolDeclarations };
    } });
    try {
        const definitions = value({ result: await binding.definitions({ context }) });
        expect(definitions.some(tool => tool.name === 'vendor_fixture_sixth_read')).toBe(false);
        expect(await binding.invokeCapability(f.request)).toEqual({ ok: true, value: f.output });
    } finally { f.close(); }
});

it.each([
    [capabilityRow({}), capabilityRow({})],
    [capabilityRow({ capabilityId: 'campaign.deploy' })],
    [capabilityRow({ effects: ['future_effect'] })],
    [capabilityRow({ pluginId: 'foreign' })], [capabilityRow({ pluginDigest: 'f'.repeat(64) })],
    [capabilityRow({ schemaFingerprint: 'invalid' })], [capabilityRow({ approved: true })],
    Array(101).fill(capabilityRow({})),
].map(capabilities => ({ capabilities })))('refuses duplicate, reserved and malformed canonical declarations %#', async ({ capabilities }) => {
    const f = await capabilityFixture({ capabilities });
    try {
        expect(await f.binding.invokeCapability(f.request)).toMatchObject({ ok: false });
        expect(f.factories()).toBe(0); expect(f.accesses).toEqual([]); expect(f.calls).toEqual([]);
    } finally { f.close(); }
});

it.each(['write', 'ad_spend', 'conversion', 'halt_stop'] as const)('retains raised %s effects and refuses a direct typed read', async effect => {
    const f = await capabilityFixture({ capabilities: [capabilityRow({ effects: [effect] })] });
    try {
        const tool = value({ result: await f.binding.definitions({ context }) }).find(tool => tool.name === 'vendor_fixture_sixth_campaign_status_v1')!;
        expect(tool.effects).toEqual(['read', effect]);
        expect(tool.policy).not.toBe('read');
        expect(await f.binding.invokeCapability(f.request)).toMatchObject({ ok: false, error: { code: 'forbidden' } });
        expect(f.factories()).toBe(0); expect(f.calls).toEqual([]);
    } finally { f.close(); }
});

it('does not infer execution authority from discovery or an absent ABI/entry', async () => {
    const cases = [
        { capabilities: [capabilityRow({ admitted: false })] },
        { module: {} }, { module: { createCapabilities: () => ({}) } },
    ];
    for (const options of cases) {
        const f = await capabilityFixture(options);
        try {
            expect(await f.binding.invokeCapability(f.request)).toMatchObject({ ok: false });
            delete f.states.get('fixture-sixth')!.entryUrl;
            expect(await f.binding.invokeCapability(f.request)).toMatchObject({ ok: false });
            expect(f.accesses).toEqual([]); expect(f.calls).toEqual([]); expect(f.factories()).toBe(0);
        } finally { f.close(); }
    }
});

it('parses canonical input/output and refuses status identities outside the request', async () => {
    for (const output of [{ invalid: true }, { observedAt: 1000, complete: true, campaigns: [{ vendorCampaignId: 'foreign', status: 'paused', disapprovalDescriptions: [] }] }]) {
        const f = await capabilityFixture({ output });
        try {
            expect(await f.binding.invokeCapability({ ...f.request, input: { vendorCampaignIds: [] } })).toMatchObject({ ok: false });
            expect(f.factories()).toBe(0);
            expect(await f.binding.invokeCapability(f.request)).toMatchObject({ ok: false });
            expect(f.calls).toHaveLength(1);
        } finally { f.close(); }
    }
});

it.each(['declaration', 'entry', 'account', 'scope'] as const)('rechecks %s changes during credential resolution before egress', async change => {
    const f = await capabilityFixture();
    f.setBeforeCredential({ callback: async () => {
        if (change === 'declaration') f.states.get('fixture-sixth')!.capabilities = [capabilityRow({ effects: ['write'] })];
        if (change === 'entry') f.states.get('fixture-sixth')!.entryUrl = 'file:///replacement/index.mjs';
        if (change === 'account') f.ports.accounts.find = async () => ({ ok: true, value: null });
        if (change === 'scope') f.ports.accounts.find = async () => ({ ok: true, value: { id: 'binding', connectionId: 'connection', externalAccountId: '123', scope: { ...context.scope, workspaceId: 'foreign' } } });
    } });
    try {
        expect(await f.binding.invokeCapability(f.request)).toMatchObject({ ok: false });
        expect(f.accesses).toHaveLength(1); expect(f.calls).toEqual([]);
    } finally { f.close(); }
});

it('refuses reporting batches with a schema-valid foreign account or window', async () => {
    for (const mismatch of ['account', 'window'] as const) {
        const output = { schema: 'report.metrics.v1', pluginId: 'fixture-sixth', connectionId: 'connection', accountId: mismatch === 'account' ? 'foreign' : '123',
            currency: 'USD', timezone: 'UTC', grain: 'campaign', days: { start: '2026-10-01', end: mismatch === 'window' ? '2026-10-03' : '2026-10-02' },
            mapping: { pluginId: 'fixture-sixth', version: '1', grains: { campaign: { spend: { vendorField: 'cost', meaning: 'Spend' } } } },
            retrievedAt: 1000, dataThrough: 1000, complete: true, freshness: 'fresh', finality: 'final', restated: false, rows: [] };
        const f = await capabilityFixture({ capabilities: [capabilityRow({ capabilityId: 'report.metrics.v1', effects: [] })], output });
        try {
            expect(await f.binding.invokeCapability({ ...f.request, capabilityId: 'report.metrics.v1', input: { grain: 'campaign', days: { start: '2026-10-01', end: '2026-10-02' } } })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
            expect(f.calls).toHaveLength(1);
        } finally { f.close(); }
    }
});


it('routes an effectful canonical capability through the existing generic approval card', async () => {
    const f = await capabilityFixture({ capabilities: [capabilityRow({ effects: ['write'] })] });
    const confirmations = createMemoryConfirmationExchange({ ...answerAudit(), clock, ids: f.ids });
    const tools = createOmTools({ definitions: input => f.binding.definitions(input), confirmations, clock, observer, authorize: () => ({ ok: true, value: undefined }) });
    try {
        const operationId = 'canonical-write';
        expect(await tools.dispatch({ context, call: { operationId, name: 'vendor_fixture_sixth_campaign_status_v1',
            input: { operationId, ...f.request.connection, arguments: f.request.input } } })).toMatchObject({ ok: true, value: { status: 'pending' } });
        expect(f.factories()).toBe(0); expect(f.calls).toEqual([]);
        const card = value({ result: await tools.card({ context, operationId }) })!;
        expect(card.classification).toBe('write');
        expect(await tools.answer({ context, approver: { kind: 'local_token', ownerId: context.scope.ownerId, deviceId: 'fixture-device', tokenId: 'fixture-token-reference' },
            response: { cardId: card.cardId, operationId, argumentsDigest: card.argumentsDigest, choice: 'allow' } })).toMatchObject({ ok: true });
        expect(f.calls).toHaveLength(1);
        expect(f.native.prepare('SELECT state FROM job').all()).toEqual([{ state: 'succeeded' }]);
    } finally { tools.dispose({}); f.close(); }
});

it('rejects cyclic discovery cursors without loading any plugin', async () => {
    const f = await capabilityFixture(); let pages = 0;
    const binding = bindAgentPluginBackends({ ...f.ports, addons: { async list() {
        pages++; return { ok: true, value: { items: [], cursor: 'same-cursor' } };
    } } });
    try {
        expect(await binding.definitions({ context })).toMatchObject({ ok: false, error: { code: 'limit_exceeded' } });
        expect(pages).toBe(2); expect(f.factories()).toBe(0); expect(f.calls).toEqual([]);
    } finally { f.close(); }
});

it('validates tracking campaign scope before constructing the plugin and accepts inert text output', async () => {
    const output = { snippet: '<script>fixture</script>', campaignUrlTemplate: 'https://fixture.invalid/?campaign={id}' };
    const f = await capabilityFixture({ capabilities: [capabilityRow({ capabilityId: 'tracking.tag.v1', effects: [] })], output });
    try {
        const input = { campaignKey: { pluginId: 'foreign', accountId: '123', vendorCampaignId: 'campaign' }, destinationUrl: 'https://fixture.invalid/' };
        expect(await f.binding.invokeCapability({ ...f.request, capabilityId: 'tracking.tag.v1', input })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
        expect(f.factories()).toBe(0); expect(f.accesses).toEqual([]);
        input.campaignKey.pluginId = 'fixture-sixth';
        expect(await f.binding.invokeCapability({ ...f.request, capabilityId: 'tracking.tag.v1', input })).toEqual({ ok: true, value: output });
        expect(f.calls).toHaveLength(1);
    } finally { f.close(); }
});

/** Real source factories receive server-built configuration and the broker's JSON-card envelope. */
it.each([
    { pluginId: 'twilio-sms', source: twilioSource, accountId: 'AC' + 'a'.repeat(32), command: { kind: 'account_status' },
        tool: 'vendor_twilio_sms_om_twilio_account_status',
        url: 'https://api.twilio.com/2010-04-01/Accounts/AC' + 'a'.repeat(32) + '.json',
        card: { accountSid: 'AC' + 'a'.repeat(32), apiKeySid: 'SK' + 'a'.repeat(32), apiKeySecret: 'fixture-twilio-secret' },
        authorization: 'Basic ' + Buffer.from('SK' + 'a'.repeat(32) + ':fixture-twilio-secret').toString('base64'),
        body: { sid: 'AC' + 'a'.repeat(32), status: 'active', type: 'Trial', auth_token: 'tainted-secret' },
        projected: { operationId: 'messaging-read', status: 'succeeded', sendReadiness: 'unknown', data: { sid: 'AC' + 'a'.repeat(32), status: 'active', type: 'Trial' } } },
    { pluginId: 'whatsapp-business', source: whatsAppSource, accountId: '123', command: { kind: 'get_account_status' },
        tool: 'vendor_whatsapp_business_get_account_status',
        url: 'https://graph.facebook.com/v26.0/123?fields=id,name,business_verification_status,account_review_status',
        card: { accessToken: 'fixture-whatsapp-token', wabaId: '123', phoneNumberId: '456', appSecret: 'fixture-app-secret' },
        authorization: 'Bearer fixture-whatsapp-token',
        body: { id: '123', name: 'Fixture', business_verification_status: 'VERIFIED', account_review_status: 'APPROVED', access_token: 'tainted-secret' },
        projected: { operationId: 'messaging-read', data: { id: '123', name: 'Fixture', business_verification_status: 'VERIFIED', account_review_status: 'APPROVED' } } },
])('invokes the real $pluginId read factory through the guarded server catalog', async row => {
    const f = await fixture({ admitted: true, only: row.pluginId });
    const manifest = JSON.parse(readFileSync(new URL('../../../content/agent-plugins/' + row.pluginId + '/plugin.json', import.meta.url), 'utf8'));
    f.states.set(row.pluginId, { enabled: true, admitted: true, bundled: true, revision: 'a'.repeat(64),
        metadata: manifest.extensions['io.github.ainsep.openmarketing'],
        entryUrl: pathToFileURL(join(f.ports.projectRoot, 'content/agent-plugins', row.pluginId, 'io.github.ainsep.openmarketing/dist/index.mjs')).href });
    const binding = bindAgentPluginBackends({ ...f.ports, async loadModule() { return row.source; },
        integrations: { async access(input) {
            f.accesses.push(input);
            return { ok: true, value: { accessToken: JSON.stringify(row.card) } };
        } },
        async fetch(url, options) {
            expect(f.native.inTransaction).toBe(false);
            f.calls.push({ url: String(url), options });
            return Response.json(row.body);
        } });
    try {
        const tool = value({ result: await binding.definitions({ context }) }).find(tool => tool.name === row.tool)!;
        const result = await tool.invoke({ context, input: { operationId: 'messaging-read', connectionId: 'connection', accountId: row.accountId, arguments: row.command } });
        expect(result).toEqual({ ok: true, value: row.projected });
        expect(f.calls).toHaveLength(1);
        expect(f.calls[0]!.url).toBe(row.url);
        expect(f.calls[0]!.options?.method).toBe('GET');
        expect(new Headers(f.calls[0]!.options?.headers).get('Authorization')).toBe(row.authorization);
        expect(f.accesses).toEqual([{ context: { ...context, principal: { kind: 'service', serviceId: 'om-agent-plugin-backends' } }, pluginId: row.pluginId, connectionId: 'connection' }]);
        expect(f.native.prepare('SELECT * FROM job').all()).toEqual([]);
    } finally { f.close(); }
});

/** One generic declaration set covers fixed tools, metadata and missing-export discovery. */
const fixtureToolDeclarations = definePluginTools({ tools: [
    { name: 'read', description: 'Read fixture', inputSchema: z.strictObject({}), effects: ['read'] },
    { name: 'connections', description: 'List fixture connections', inputSchema: z.strictObject({}), effects: ['read'], connectionOnly: true },
    { name: 'pending', description: 'Unavailable fixture', inputSchema: z.strictObject({}), effects: ['read'], unavailableReason: 'Fixture needs setup' },
] });

it('invokes connection-only tools without an account and refuses other unbound calls before effects', async () => {
    const received: unknown[] = [];
    let factories = 0;
    const createTools = (dependencies: PluginCapabilityDependencies<PluginConfiguration | PluginConnectionConfiguration>): ReturnType<PluginToolsFactory> => {
        factories++;
        expect(dependencies).not.toHaveProperty('admitted');
        return { async invoke(input, optional) {
            const schema = input.name === 'connections' ? pluginConnectionConfigurationSchema : pluginConfigurationSchema;
            expect(schema.parse(dependencies.configuration)).toEqual({ scope: context.scope, connectionId: 'connection', accountId: input.name === 'connections' ? null : '123', pluginDigest: expect.any(String), settings: {} });
            received.push(input);
            const access = await dependencies.credentials.access(input.connection, optional);
            if (!access.ok) return access;
            await dependencies.fetch('https://fixture.invalid/tool', { signal: optional?.signal });
            return { ok: true, value: { rows: ['fixture'] } };
        } };
    };
    const f = await capabilityFixture({ module: { ...fixtureToolDeclarations, createTools } });
    const input = { operationId: 'generic-read', connectionId: 'connection', accountId: '123', arguments: {} };
    try {
        const definitions = value({ result: await f.binding.definitions({ context }) });
        const read = definitions.find(tool => tool.name === 'vendor_fixture_sixth_read')!;
        const pending = definitions.find(tool => tool.name === 'vendor_fixture_sixth_pending')!;
        const connections = definitions.find(tool => tool.name === 'vendor_fixture_sixth_connections')!;
        expect(pending.unavailableReason).toBe('Fixture needs setup');
        expect(await pending.invoke({ context, input })).toMatchObject({ ok: false, error: { message: 'Fixture needs setup' } });
        expect(await read.invoke({ context, input: { ...input, connectionId: 'foreign' } })).toMatchObject({ ok: false });
        expect(factories).toBe(0); expect(f.accesses).toEqual([]); expect(f.calls).toEqual([]);
        expect(await connections.invoke({ context, input: { ...input, accountId: null } })).toEqual({ ok: true, value: { rows: ['fixture'] } });
        expect(factories).toBe(1); expect(f.accesses).toHaveLength(1); expect(f.calls).toHaveLength(1);
        expect(await read.invoke({ context, input: { ...input, accountId: null } })).toMatchObject({ ok: false });
        expect(factories).toBe(1); expect(f.accesses).toHaveLength(1); expect(f.calls).toHaveLength(1);
        expect(await read.invoke({ context, input })).toEqual({ ok: true, value: { rows: ['fixture'] } });
        expect(received).toEqual([
            { context, connection: { connectionId: 'connection', accountId: null }, name: 'connections', operationId: input.operationId, input: {}, moneyExposure: null, requiredLimit: null },
            { context, connection: { connectionId: 'connection', accountId: '123' }, name: 'read', operationId: input.operationId, input: {}, moneyExposure: null, requiredLimit: null },
        ]);
        expect(factories).toBe(2); expect(f.accesses).toHaveLength(2); expect(f.calls).toHaveLength(2);
    } finally { f.close(); }
});

it('discovers Meta Instagram accounts through only the generic source exports without an account', async () => {
    const f = await fixture({ admitted: true, only: 'meta-ads', fetch: async url => {
        expect(new URL(String(url)).pathname).toBe('/v25.0/me/accounts');
        return Response.json({ data: [{ id: '111', name: 'Fixture Page', instagram_business_account: { id: '222', username: 'fixture' } }] });
    } });
    const binding = bindAgentPluginBackends({ ...f.ports, async loadModule() {
        return { tools: metaSource.tools, parseTool: metaSource.parseTool, createTools: metaSource.createTools };
    } });
    try {
        const tool = value({ result: await binding.definitions({ context }) }).find(tool => tool.name === 'vendor_meta_ads_instagram_accounts')!;
        const result = await tool.invoke({ context, input: { operationId: 'instagram-discovery', connectionId: 'connection', accountId: null, arguments: {} } });
        expect(result).toEqual({ ok: true, value: { accounts: [{ pageId: '111', pageName: 'Fixture Page', igUserId: '222', username: 'fixture' }], hasMore: false } });
        expect(f.accesses).toHaveLength(1); expect(f.calls).toHaveLength(1);
        expect(JSON.stringify(result)).not.toContain('fixture-token-for-meta-ads');
    } finally { f.close(); }
});

it('makes malformed generic declarations unavailable without constructing their factory', async () => {
    let factories = 0;
    const f = await capabilityFixture({ module: { ...fixtureToolDeclarations,
        tools: [{ ...fixtureToolDeclarations.tools[1], effects: ['write'] }],
        createTools() { factories++; return {}; },
    } });
    try {
        const definitions = value({ result: await f.binding.definitions({ context }) });
        expect(definitions.find(tool => tool.name === 'vendor_fixture_sixth_unavailable')?.unavailableReason).toBeTruthy();
        expect(factories).toBe(0); expect(f.accesses).toEqual([]); expect(f.calls).toEqual([]);
    } finally { f.close(); }
});

it('skips backend halt capabilities while keeping a declared read capability', async () => {
    const f = await capabilityFixture({ capabilities: [capabilityRow({}), capabilityRow({ capabilityId: 'campaign.halt-stop.v1', effects: ['halt_stop'] })] });
    try {
        const definitions = value({ result: await f.binding.definitions({ context }) });
        expect(definitions.some(tool => tool.name === 'vendor_fixture_sixth_campaign_halt_stop_v1')).toBe(false);
        expect(definitions.some(tool => tool.name === 'vendor_fixture_sixth_unavailable')).toBe(false);
        expect(f.factories()).toBe(0);
        expect(await f.binding.invokeCapability(f.request)).toEqual({ ok: true, value: f.output });
    } finally { f.close(); }
});

it('forwards fresh plugin-bound secrets without enriching another plugin or echoing a failing handler', async () => {
    const sentinel = 'fixture-api-secret-SENTINEL';
    const f = await capabilityFixture();
    const received: unknown[] = [];
    const accesses: string[] = [];
    const events: unknown[] = [];
    let fail = false;
    const createCapabilities: PluginCapabilitiesFactory = dependencies => ({ 'campaign.status.v1': async (call, optional) => {
        const access = await dependencies.credentials.access(call.connection, optional);
        if (!access.ok) return access;
        received.push(access.value);
        if (fail) throw new Error(access.value.secrets?.apiSecret);
        return { ok: true, value: capabilityCatalog['campaign.status.v1'].output.parse(f.output) };
    } });
    f.states.set('fixture-seventh', { ...f.states.get('fixture-sixth')!,
        entryUrl: 'file:///installed/fixture-seventh/io.github.ainsep.openmarketing/dist/index.mjs',
        capabilities: [capabilityRow({ pluginId: 'fixture-seventh' })] });
    const binding = bindAgentPluginBackends({ ...f.ports, observer: { observe(event) { events.push(event); } },
        async loadModule() { return { createCapabilities }; },
        integrations: { async access(input) {
            accesses.push(input.pluginId);
            return { ok: true, value: { accessToken: 'fixture-token', ...(input.pluginId === 'fixture-sixth' ? { secrets: { apiSecret: sentinel } } : {}) } };
        } },
    });
    try {
        expect(await binding.invokeCapability(f.request)).toEqual({ ok: true, value: f.output });
        expect(received[0]).toEqual({ accessToken: 'fixture-token', secrets: { apiSecret: sentinel } });
        expect(await binding.invokeCapability({ ...f.request, pluginId: 'fixture-seventh' })).toEqual({ ok: true, value: f.output });
        expect(received[1]).toEqual({ accessToken: 'fixture-token' });
        fail = true;
        const result = await binding.invokeCapability(f.request);
        expect(result).toMatchObject({ ok: false });
        expect(accesses).toEqual(['fixture-sixth', 'fixture-seventh', 'fixture-sixth']);
        expect(received[2]).toEqual(received[0]);
        expect(events.length).toBeGreaterThan(0);
        expect(JSON.stringify([result, events])).not.toContain(sentinel);
    } finally { f.close(); }
});

it('uses only the real TikTok fixed exports and projects strict egress fields for advertiser reads', async () => {
    const f = await capabilityFixture();
    f.states.delete('fixture-sixth');
    f.states.get('tiktok-ads')!.enabled = true;
    const calls: { url: URL; options?: RequestInit }[] = [];
    const binding = bindAgentPluginBackends({ ...f.ports, async loadModule() { return tikTokSource; },
        async fetch(url, options) {
            calls.push({ url: new URL(String(url)), options });
            return Response.json({ code: 0, data: { list: [{ advertiser_id: '123', advertiser_name: 'Fixture', currency: 'USD', timezone: 'UTC' }] } });
        } });
    try {
        const tool = value({ result: await binding.definitions({ context }) }).find(tool => tool.name === 'vendor_tiktok_ads_tiktok_ads_get_advertiser')!;
        expect(await tool.invoke({ context, input: selection({ pluginId: 'tiktok-ads' }) })).toMatchObject({ ok: true });
        expect(calls).toHaveLength(1); expect(f.accesses).toHaveLength(1);
        expect(calls[0].url.origin + calls[0].url.pathname).toBe('https://business-api.tiktok.com/open_api/v1.3/advertiser/info/');
        expect(calls[0].url.searchParams.get('advertiser_ids')).toBe('["123"]');
        expect(calls[0].options?.method).toBe('GET');
        expect(new Headers(calls[0].options?.headers).get('Access-Token')).toBe('fixture-token-for-tiktok-ads');
    } finally { f.close(); }
});

it.each(['draft', 'paused'] as const)('uses generic deployment exports, saved evidence and the receipt %s state', async state => {
    const received: { method: string; saved: CampaignDeploymentRequired['saved'] }[] = [];
    const controller = new AbortController();
    const receipt = campaignDeploymentReceiptSchema.parse({ status: 'acknowledged', state, entityIds: ['entity'], references: { campaign: 'entity' } });
    const module = {
        campaignDeploymentPlanSchema: z.strictObject({ label: z.literal('fixture-plan') }),
        async translateCampaign(input: { campaign: NeutralCampaignLaunch; target: NeutralCampaignLaunch['targets'][number]; resolved: unknown; context: CallContext; dependencies: PluginCapabilityDependencies }, options?: CallOptions) {
            await Promise.resolve();
            expect(input.context).toEqual(context);
            expect(input.target).toEqual(input.campaign.targets[0]);
            expect(input.resolved).toEqual({});
            expect(pluginConfigurationSchema.parse(input.dependencies.configuration)).toEqual({ scope: context.scope,
                connectionId: 'connection', accountId: '123', pluginDigest: expect.any(String), settings: { installOption: 'kept' } });
            expect(Object.keys(input.dependencies).sort()).toEqual(['clock', 'configuration', 'credentials', 'fetch', 'observer', 'wait']);
            expect(options?.signal).toBe(controller.signal);
            return { ok: true, value: { label: 'fixture-plan' } };
        },
        async deployCampaignPaused(input: CampaignDeploymentRequired) {
            expect(pluginConfigurationSchema.parse(input.dependencies.configuration)).toEqual({ scope: context.scope,
                connectionId: 'connection', accountId: '123', pluginDigest: expect.any(String), settings: { installOption: 'kept' } });
            expect(Object.keys(input.dependencies).sort()).toEqual(['clock', 'configuration', 'credentials', 'fetch', 'observer', 'wait']);
            received.push({ method: 'deploy', saved: input.saved });
            const first = await input.checkpoint({ step: 'first', phase: 'observation', references: { checkpoint: 'old-entity' }, record: { version: 1 } });
            if (!first.ok) return first;
            const latest = await input.checkpoint({ step: 'latest', phase: 'observation', references: { checkpoint: 'entity' }, record: { version: 2 } });
            return latest.ok ? { ok: true as const, value: receipt } : latest;
        },
        async readCampaignDeployment(input: CampaignDeploymentRequired) {
            pluginConfigurationSchema.parse(input.dependencies.configuration);
            expect(input.dependencies).not.toHaveProperty('admitted');
            received.push({ method: 'read', saved: input.saved });
            return { ok: true as const, value: receipt };
        },
    };
    const f = await capabilityFixture({ module });
    f.states.get('fixture-sixth')!.metadata = { installOption: 'kept', campaignFixture: { scope: context.scope, connectionId: 'connection', resolved: {} } };
    const confirmations = createMemoryConfirmationExchange({ ...answerAudit(), clock, ids: f.ids });
    const binding = bindAgentPluginBackends({ ...f.ports, confirmations });
    const campaign = { ...socialCampaign, targets: [{ ...socialCampaign.targets[0], pluginId: 'fixture-sixth' }] };
    try {
        const { calls } = value({ result: await binding.prepareCampaign({ context, campaign, operationId: 'generic-launch' }, { signal: controller.signal }) });
        expect(calls).toHaveLength(1); expect(received).toEqual([]);
        expect(calls[0].arguments).toMatchObject({ input: { arguments: { plan: { label: 'fixture-plan' } } } });
        const rootArgs = { calls };
        const root: EffectRequest = { arguments: rootArgs, pausedCampaignCalls: calls, pluginDigest: 'a'.repeat(64), schemaFingerprint: 'b'.repeat(64),
            envelope: { ...calls[0].envelope, operationId: 'generic-launch', accountId: null, effects: ['ad_spend'], argumentsDigest: value({ result: digestArguments({ arguments: rootArgs }) }) } };
        const card = value({ result: await confirmations.present({ context, request: root }) });
        value({ result: await confirmations.confirm({ context, approver: { kind: 'local_token', ownerId: context.scope.ownerId, deviceId: 'fixture-device', tokenId: 'fixture-token-reference' },
            response: { cardId: card.cardId, operationId: card.operationId, argumentsDigest: card.argumentsDigest, choice: 'allow' } }) });
        const authorization = { ...calls[0], approvalId: card.cardId, policyRevision: 0,
            campaignApproval: { operationId: 'generic-launch', argumentsDigest: card.argumentsDigest, index: 0 } };
        const result = await f.jobs.dispatch({ context, pluginId: 'om-campaigns', input: { operationId: 'generic-launch', connectionId: 'om_campaign_deploy_paused', accountId: null,
            arguments: { intent: 'deploy-paused', request: boundedJsonSchema.parse(root) } },
            async execute({ jobId }) {
                const deployed = await binding.executeCampaign({ context, call: calls[0], authorization,
                    permit: { operationId: calls[0].envelope.operationId, argumentsDigest: calls[0].envelope.argumentsDigest, approvalId: card.cardId, expiresAt: 300000, reservationId: 'fixture-permit' },
                    checkpoint: item => f.jobs.checkpoint({ context, jobId, event: 'campaign_observation', evidence: { ...item, operationId: calls[0].envelope.operationId } }) });
                if (!deployed.ok) return deployed;
                const saved = await f.jobs.checkpoint({ context, jobId, event: 'campaign_result', evidence: { operationId: calls[0].envelope.operationId, result: boundedJsonSchema.parse(deployed.value) } });
                return saved.ok ? deployed : saved;
            } });
        expect(result).toEqual({ ok: true, value: receipt });
        expect(received).toEqual([{ method: 'deploy', saved: { references: {}, record: null } }]);
        const read = value({ result: await binding.definitions({ context }) }).find(tool => tool.name === 'om_campaign_reconcile_deployment')!;
        expect(await read.invoke({ context, input: { operationId: 'generic-launch' } })).toMatchObject({ ok: true, value: { complete: true,
            entities: [{ entityId: 'entity', state }], outcomes: [{ result: receipt }] } });
        expect(received).toEqual([{ method: 'deploy', saved: { references: {}, record: null } },
            { method: 'read', saved: { references: { campaign: 'entity' }, record: { version: 2 } } }]);
        expect(f.native.prepare('SELECT id FROM job').all()).toHaveLength(1);
        expect(f.accesses).toEqual([]); expect(f.calls).toEqual([]);
    } finally { f.close(); }
});

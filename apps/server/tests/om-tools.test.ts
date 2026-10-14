/** Written-only A3 contract/security/boot regressions. No vendor requests or credentials. */
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { parseBoundary, toolDescriptorSchema, toolOperationSchema, toolResultSchema } from '@open-marketing/contracts';
import type { ApprovalResponse, CallContext, Outcome, ToolCall, ToolResult } from '@open-marketing/contracts';
import { createMemoryConfirmationExchange, createMemorySafetyRepo, createMemoryAccountDispatchLock, createMemoryPlatformLimitEvidence, createMemorySpendPolicy, createMemoryVerifiedEffectResolver, createMemorySafetyAudit, createSafetyService, digestArguments } from '@open-marketing/safety';
import { createMemoryCampaignRepo } from '@open-marketing/campaigns';
import { buildOmToolDefinitions, createOmTools, discoveryTools, toolInputSchema, toolPolicy } from '../src/om-tools.js';
import type { EffectRequest, PlatformLimitEvidence } from '@open-marketing/safety';
import type { OmFeatureServices, OmToolDefinition } from '../src/om-tools.js';
import { generateOmToolCoverage, ownerRouteDisposition } from '../src/om-tool-coverage.js';
import { routes } from '../src/cli/http.js';
import { handleOwnerRequest } from '../src/inbound/owner.js';
import type { OwnerServices } from '../src/inbound/owner.js';
import { handleOmRequest } from '../src/inbound/om.js';
import { bootServer } from '../src/composition/index.js';
import { createNodeBootIo } from '../src/composition/serve.js';
import { runOmCli, type CliRuntime } from '../src/cli/index.js';
import { createContactService, createMemoryContactRepo } from '@open-marketing/contacts';
import type { AddonToolDependencies } from '../src/addon-tools.js';
import { removeStateRoot } from './state-root.js';

const owner: CallContext = { scope: { ownerId: 'owner', workspaceId: 'workspace' }, principal: { kind: 'owner', ownerId: 'owner' }, correlationId: 'correlation', traceId: 'trace' };
const agent: CallContext = { ...owner, runId: 'run', principal: { kind: 'agent', runId: 'run', agentInstanceId: 'instance' } };
function value<T>(required: { result: Outcome<T> }): T {
    if (!required.result.ok) throw new Error(required.result.error.message);
    return required.result.value;
}
function fixture(_required: Record<string, never>) {
    let now = 1000; let sequence = 0; let active = true; let revision = '1'; let enabled = true;
    const clock = { now: () => now }; const ids = { next: () => 'id-' + ++sequence }; const observer = { observe() {} };
    const confirmations = createMemoryConfirmationExchange({ clock, ids });
    const effects: unknown[] = []; const contexts: CallContext[] = [];
    const schema = z.strictObject({ value: z.number() });
    const definition: { -readonly [Key in keyof OmToolDefinition]: OmToolDefinition[Key] } = { name: 'fixture_write', capability: 'Fixture write', description: 'Save the exact fixture value.',
        effects: ['write'], policy: 'write', revision: '1', inputSchema: toolInputSchema({ schema }),
        parse: input => parseBoundary({ schema, input: input.input }),
        async invoke(input) { effects.push(input.input); contexts.push(input.context); return { ok: true, value: { saved: (input.input as { value: number }).value } }; } };
    const services: OwnerServices = { confirmations, safety: createMemorySafetyRepo({ clock, ids, ownerTimezone: 'UTC' }), campaigns: createMemoryCampaignRepo({}) };
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
    return { tools, call, services, grants, grant, effects, contexts, clock, ids, observer, answer,
        advance() { now = 301001; }, revoke() { active = false; tools.cancel({ context: owner, runId: 'run' }); }, endRun() { active = false; },
        replace() { revision = '2'; }, remove() { enabled = false; }, definition };
}

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
        f.tools.dispose({});
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
    expect(f.effects).toEqual([]); f.tools.dispose({});
});

it('cancellation and expiry void cards before a late owner answer can execute', async () => {
    for (const interruption of ['cancel', 'expiry'] as const) {
        const f = fixture({}); value({ result: await f.tools.dispatch({ context: agent, call: f.call }) });
        const card = value({ result: await f.tools.card({ context: agent, operationId: f.call.operationId }) })!;
        if (interruption === 'cancel') f.revoke(); else f.advance();
        const result = await f.tools.answer({ context: owner, response: { cardId: card.cardId, operationId: card.operationId, argumentsDigest: card.argumentsDigest, choice: 'allow' } });
        expect(result.ok).toBe(false); expect(f.effects).toEqual([]);
        expect(value({ result: await f.services.confirmations.list({ context: owner, query: { limit: 100 } }) }).items).toEqual([]);
        f.tools.dispose({});
    }
});

it('requires fresh approval after a source revision changes or disappears', async () => {
    for (const change of ['replace', 'remove'] as const) {
        const f = fixture({}); value({ result: await f.tools.dispatch({ context: agent, call: f.call }) });
        f[change](); expect((await f.answer()).status).toBe(409); expect(f.effects).toEqual([]);
        expect(value({ result: await f.tools.operation({ context: agent, operationId: f.call.operationId }) }).status).toBe('interrupted');
        f.tools.dispose({});
    }
});

it('denied cards and thrown outcomes cannot become completed or be blindly retried', async () => {
    const denied = fixture({}); value({ result: await denied.tools.dispatch({ context: agent, call: denied.call }) });
    expect((await denied.answer({ choice: 'cancel' })).status).toBe(200);
    expect(value({ result: await denied.tools.operation({ context: agent, operationId: denied.call.operationId }) }).status).toBe('cancelled');
    expect(denied.effects).toEqual([]); denied.tools.dispose({});
    const f = fixture({}); f.definition.invoke = async () => { f.effects.push('entered'); throw new Error('Opaque fixture failure'); };
    value({ result: await f.tools.dispatch({ context: agent, call: f.call }) }); await f.answer();
    expect(value({ result: await f.tools.operation({ context: agent, operationId: f.call.operationId }) }).status).toBe('unknown');
    expect((await f.tools.dispatch({ context: agent, call: f.call })).ok).toBe(false); expect(f.effects).toEqual(['entered']); f.tools.dispose({});
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
        if (interruption === 'cancel') f.tools.cancel({ context: owner, runId: agent.runId! });
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
    } finally { finish({ ok: false, error: { code: 'cancelled', message: 'Fixture cleanup', retryable: false } }); f.tools.dispose({}); }
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
        } finally { f.tools.dispose({}); }
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
        expect(f.effects).toEqual([]); f.tools.dispose({});
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
    f.tools.dispose({});
});

it('bounds pending operation retention and revokes every retained card on disposal', async () => {
    const f = fixture({}); const results: Outcome<ToolResult>[] = [];
    for (let index = 0; index < 20; index++) results.push(await f.tools.dispatch({ context: agent, call: { ...f.call, operationId: 'bounded-' + index } }));
    expect(results.some(result => !result.ok && result.error.code === 'limit_exceeded')).toBe(true);
    expect(f.effects).toEqual([]);
    expect(value({ result: await f.services.confirmations.list({ context: owner, query: { limit: 100 } }) }).items.length).toBeLessThanOrEqual(16);
    f.tools.dispose({});
    expect(value({ result: await f.services.confirmations.list({ context: owner, query: { limit: 100 } }) }).items).toEqual([]);
    expect((await f.tools.dispatch({ context: agent, call: f.call })).ok).toBe(false);
});

it('generates checked route/capability coverage from declarations, with explicit future gaps', async () => {
    const f = fixture({}); const definitions = value({ result: await buildOmToolDefinitions({ context: owner, services: f.services }) });
    const rows = generateOmToolCoverage({ definitions });
    expect(Object.keys(ownerRouteDisposition).sort()).toEqual(Object.keys(routes).sort());
    for (const route of Object.values(routes)) expect(rows.some(row => row.http === route.path)).toBe(true);
    expect(rows.filter(row => row.tool).map(row => row.tool)).toEqual([...definitions, ...discoveryTools].map(tool => tool.name));
    expect(definitions.every(tool => toolDescriptorSchema.safeParse({ name: tool.name, description: tool.description, effects: tool.effects, inputSchema: tool.inputSchema }).success)).toBe(true);
    expect(definitions.some(tool => /om_(runs|conversations)_/.test(tool.name))).toBe(false);
    expect(rows.some(row => row.status === 'NEEDS' && row.capability.includes('not connected'))).toBe(true);
    expect(rows.find(row => row.capability === 'Paused/draft campaign creation')?.policy).toBe('write');
    expect(rows.find(row => row.capability === 'Vendor activation/live budget/cap changes (not connected)')?.policy).toBe('spend');
    expect(rows.filter(row => row.tool).every(row => row.cli === 'om tools list/show/call')).toBe(true);
    expect(rows.filter(row => row.status === 'NEEDS').every(row => !!row.needs && !!row.reason)).toBe(true); f.tools.dispose({});
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
    } finally { tools.dispose({}); f.tools.dispose({}); }
});

it('lists a seeded bundled agent-plugin source in the catalog after real boot restores its enabled state', async () => {
    const directory = await fs.mkdtemp(join(tmpdir(), 'om-a3-'));
    const studioRoot = join(directory, 'studio'); const stateRoot = join(directory, 'state');
    await fs.mkdir(studioRoot); await fs.writeFile(join(studioRoot, 'index.html'), '<!doctype html><title>A3 fixture</title>');
    const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));
    const io = createNodeBootIo({ projectRoot, studioRoot, ready() {} });
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
        const enabled = await fetch(origin + '/api/addons/v1/set-enabled', { method: 'POST', headers, body: JSON.stringify({ kind: seeded.kind, id: seeded.id, enabled: true }) });
        expect(enabled.status).toBe(200); await first.stop({});
        server = await bootServer(args); const restarted = value({ result: server });
        const secondBootstrap = await fetch(restarted.studioUrl, { redirect: 'manual' });
        const secondCookie = secondBootstrap.headers.get('set-cookie')!.split(';')[0];
        const response = await fetch(new URL('/api/tools?limit=100', restarted.studioUrl), { headers: { cookie: secondCookie } });
        expect(response.status).toBe(200);
        const tools = await response.json() as { value: { name: string }[] };
        const expected = 'addon_agent_plugin_' + createHash('sha256').update(seeded.id).digest('hex').slice(0, 32);
        expect(tools.value.some(tool => tool.name === expected)).toBe(true);
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
        return f.tools.answer({ context: owner, response: { cardId: card.cardId, operationId: card.operationId, argumentsDigest: card.argumentsDigest, choice: input.choice ?? 'allow' } });
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
    } finally { f.tools.dispose({}); }
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
    } finally { f.tools.dispose({}); }
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
        } finally { f.tools.dispose({}); }
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
        } finally { f.tools.dispose({}); }
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
            value({ result: await tools.answer({ context: owner, response: { cardId: card.cardId, operationId: card.operationId, argumentsDigest: card.argumentsDigest, choice: 'allow' } }) });
            expect(value({ result: await tools.operation({ context: agent, operationId: call.operationId }) }).status).toBe('completed');
        }
        expect(value({ result: await f.services.safety.getGenerationAllowance({ context: owner }) }).amount.minorUnits).toBe(1500);
        expect(value({ result: await f.services.safety.getHalt({ context: owner, accountId: 'account' }) })).toMatchObject({ remoteStatus: 'pending' });
    } finally { tools.dispose({}); f.tools.dispose({}); }
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

it('consumes D2 management/source schemas and redacts structured third-party failures before the dispatcher boundary', async () => {
    const f = fixture({});
    try {
        const addons = addonFixture();
        const definitions = value({ result: await buildOmToolDefinitions({ context: owner, services: f.services, addons }) });
        expect(definitions.filter(tool => tool.name.startsWith('addons_') || tool.name.startsWith('integrations_'))).toHaveLength(6);
        const source = definitions.find(tool => tool.name.startsWith('addon_plugin_'))!;
        expect(source.policy).toBe('write'); expect(value({ result: await source.invoke({ context: owner, input: {} }) })).toMatchObject({ instructions: 'Fixture contribution' });
        const failing = await definitions.find(tool => tool.name === 'integrations_disconnect')!.invoke({ context: owner, input: { connectionId: 'connection' } });
        expect(failing).toMatchObject({ ok: false, error: { code: 'unavailable', retryable: true } });
        expect(JSON.stringify(failing)).not.toContain('sk-fixture');
        const badDiscovery = await buildOmToolDefinitions({ context: owner, services: f.services, addons: addonFixture({ failure: true }) });
        expect(JSON.stringify(badDiscovery)).not.toContain('sk-fixture'); expect(badDiscovery.ok).toBe(false);
        const rows = generateOmToolCoverage({ definitions });
        expect(rows.find(row => row.tool === source.name)).toMatchObject({ status: 'connected', policy: 'write', cli: 'om tools list/show/call' });
        expect(rows.filter(row => row.status === 'NEEDS').every(row => !!row.reason && !!row.needs)).toBe(true);
    } finally { f.tools.dispose({}); }
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
            value({ result: await tools.answer({ context: owner, response: { cardId: card.cardId, operationId: card.operationId, argumentsDigest: card.argumentsDigest, choice: 'allow' } }) });
            const operation = value({ result: await tools.operation({ context: agent, operationId: call.operationId }) });
            expect(operation.status).toBe('completed');
            if (operation.status !== 'completed') throw new Error('Expected completed contact write');
            subjects.push((operation.output as { subjectId: string }).subjectId);
        }
        value({ result: await tools.dispatch({ context: agent, call: { name: 'om_contacts_merge', operationId: 'merge', input: { sourceSubjectId: subjects[1], targetSubjectId: subjects[0] } } }) });
        const card = value({ result: await tools.card({ context: agent, operationId: 'merge' }) })!;
        expect(card.classification).toBe('destructive'); expect(card.allowedChoices).toEqual(['allow', 'cancel']);
        value({ result: await tools.answer({ context: owner, response: { cardId: card.cardId, operationId: card.operationId, argumentsDigest: card.argumentsDigest, choice: 'allow' } }) });
        expect(value({ result: await contacts.resolve({ context: owner, identifier: { kind: 'email', raw: 'two@example.test' } }) }).subjectId).toBe(subjects[0]);
        expect(generateOmToolCoverage({ definitions }).some(row => row.capability === 'Contact upsert' && row.status === 'NEEDS')).toBe(false);
    } finally { tools.dispose({}); f.tools.dispose({}); }
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
    } finally { f.tools.dispose({}); }
});

it('JSON tool calls return pending and never approve, while malformed input and irrelevant flags send no HTTP', async () => {
    const f = toolCliFixture({ confirmed: true });
    try {
        value({ result: await runOmCli({ argv: ['tools', 'call', 'fixture_write', '--input-file', '-', '--json'], runtime: f.runtime }) });
        expect(f.confirmationCount()).toBe(0); expect(f.effects).toEqual([]); expect(f.stdout.join('')).toContain('"status":"pending"');
    } finally { f.tools.dispose({}); }
    for (const argv of [
        ['tools', 'call', 'fixture_write'], ['tools', 'call', 'fixture_write', '--input-file', '-', '--choice', 'allow'],
        ['tools', 'show', '..'], ['tools', 'list', '--limit', '101'], ['tools', 'list', '--limit', '1', '--limit', '2'],
    ]) {
        const bad = toolCliFixture();
        try { expect(await runOmCli({ argv, runtime: bad.runtime })).toMatchObject({ ok: false }); expect(bad.requests).toEqual([]); }
        finally { bad.tools.dispose({}); }
    }
    for (const file of ['{', JSON.stringify('x'.repeat(65537))]) {
        const bad = toolCliFixture({ file });
        try { expect(await runOmCli({ argv: ['tools', 'call', 'fixture_write', '--input-file', '-', '--json'], runtime: bad.runtime })).toMatchObject({ ok: false }); expect(bad.requests).toEqual([]); }
        finally { bad.tools.dispose({}); }
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
        f.revoke(); release.resolve();
        expect(await first).toMatchObject({ ok: false, error: { code: 'cancelled' } });
        expect(value({ result: await f.tools.operation({ context: owner, operationId: f.calls[0].operationId }) }).status).toBe('cancelled');
        expect(f.effects).toEqual([]);
        expect(value({ result: await f.services.confirmations.list({ context: owner, query: { limit: 100 } }) }).items).toEqual([]);
    } finally { release.resolve(); f.tools.dispose({}); }
});

it('re-resolves installed D2 sources and invalidates a pending card when its package is removed', async () => {
    const f = fixture({}); const addons = addonFixture();
    const tools = createOmTools({ clock: f.clock, observer: f.observer, confirmations: f.services.confirmations as ReturnType<typeof createMemoryConfirmationExchange>,
        authorize: () => ({ ok: true, value: undefined }), definitions: input => buildOmToolDefinitions({ ...input, services: f.services, addons }) });
    try {
        const catalog = value({ result: await tools.list({ context: owner, limit: 100 }) });
        const source = catalog.find(tool => tool.name.startsWith('addon_plugin_'))!;
        value({ result: await tools.dispatch({ context: agent, call: { name: source.name, operationId: 'addon-operation', input: {} } }) });
        const card = value({ result: await tools.card({ context: agent, operationId: 'addon-operation' }) })!;
        addons.addons.list = async () => ({ ok: true, value: { items: [], cursor: null } });
        expect(await tools.answer({ context: owner, response: { cardId: card.cardId, operationId: card.operationId, argumentsDigest: card.argumentsDigest, choice: 'allow' } })).toMatchObject({ ok: false, error: { code: 'conflict' } });
        expect(value({ result: await tools.operation({ context: agent, operationId: 'addon-operation' }) }).status).toBe('interrupted');
        expect(value({ result: await tools.list({ context: owner, limit: 100 }) }).some(tool => tool.name === source.name)).toBe(false);
    } finally { tools.dispose({}); f.tools.dispose({}); }
});

it('typed backend effects cannot be disguised by combining them with read/write/generation/spend', async () => {
    for (const effect of ['conversion', 'halt_stop'] as const) {
        const f = fixture({}); f.definition.effects = ['write', 'generation', 'ad_spend', effect];
        try {
            expect(toolPolicy({ effects: f.definition.effects })).toBe('internal');
            expect(await f.tools.dispatch({ context: agent, call: f.call })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
            expect(f.effects).toEqual([]);
        } finally { f.tools.dispose({}); }
    }
});

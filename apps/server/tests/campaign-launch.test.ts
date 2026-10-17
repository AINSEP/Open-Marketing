/** C1R2 fixture-only regressions. Written, not executed; no vendor or file database is opened. */
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import type { CallContext, Outcome, ToolCall } from '@open-marketing/contracts';
import { createMemoryCampaignRepo } from '@open-marketing/campaigns';
import type { NeutralCampaignLaunch } from '@open-marketing/campaigns';
import { createMemorySafetyRepo, createMemoryConfirmationExchange, createMemorySpendPolicy, createMemoryAccountDispatchLock,
    createMemoryPlatformLimitEvidence, createMemorySafetyAudit, createSafetyService, digestArguments } from '@open-marketing/safety';
import type { CampaignConstituent, FrozenDispatchRequest } from '@open-marketing/safety';
import { createOmTools } from '../src/om-tools.js';
import type { OmToolDefinition } from '../src/om-tools.js';
import { bindPausedCampaignDeployment } from '../src/composition/campaigns.js';
import { bindServerDatabase, provisionWorkspace } from '../src/composition/database.js';
import { migrationManifest } from '../src/composition/migrations.js';
import { createSqlToolOperationStore } from '../src/tool-operations.js';

const context: CallContext = { scope: { ownerId: 'owner', workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }, principal: { kind: 'owner', ownerId: 'owner' }, correlationId: 'correlation', traceId: 'trace', runId: 'run' };
function value<T>(input: { result: Outcome<T> }): T { if (!input.result.ok) throw new Error(input.result.error.message); return input.result.value; }
function digest(input: { value: unknown }): string { return value({ result: digestArguments({ arguments: input.value }) }); }

async function fixture() {
    const native = new Database(':memory:'); native.pragma('foreign_keys = ON');
    for (const entry of migrationManifest) native.exec(readFileSync(new URL('../../../' + entry.path, import.meta.url), 'utf8'));
    let now = 1000;
    const clock = { now: () => now }, ids = { next: () => randomUUID() }, observer = { observe() {} };
    const database = bindServerDatabase({ native, context, observer });
    await provisionWorkspace({ database: database.workspace, scope: context.scope });
    const repo = createMemoryCampaignRepo({});
    const campaign: NeutralCampaignLaunch = { operationId: 'local', name: 'Traffic', objective: 'traffic', schedule: { window: { start: 2000, end: 1000000 }, timezone: 'UTC' }, audience: { countries: ['US'] }, creativeIds: ['creative'], creativeDigest: 'a'.repeat(64),
        targets: [1, 2, 3].map(accountId => ({ pluginId: 'fixture', connectionId: 'connection', accountId: String(accountId), dailyBudget: { minorUnits: 500, currency: accountId === 2 ? 'EUR' : 'USD' }, expectedExposure: { minorUnits: 2500, currency: accountId === 2 ? 'EUR' : 'USD' } })) };
    const saved = value({ result: await repo.saveNeutral({ context, campaign }) });
    const confirmations = createMemoryConfirmationExchange({ clock, ids });
    const safetyRepo = createMemorySafetyRepo({ clock, ids, ownerTimezone: 'UTC' });
    const sends: string[] = [];
    let afterFirst = async () => {};
    let uncertain = false, badEvidence = false, unavailable = false, changedRevision = false;
    const schema = { type: 'object', properties: { operationId: { type: 'string' } } };
    const children: OmToolDefinition[] = campaign.targets.map((target, index) => ({ name: 'vendor_fixture_create_' + index, description: 'Fixture paused creation', capability: 'fixture: create', effects: ['write'], policy: 'write', revision: 'b'.repeat(64), inputSchema: schema,
        parse: input => ({ ok: true, value: input.input }),
        async invoke(input) {
            expect(input.permit).toBeDefined(); expect(input.authorization?.campaignApproval?.index).toBe(index);
            sends.push(target.accountId);
            if (sends.length === 1) await afterFirst();
            return { ok: true, value: uncertain && index === 1 ? { status: 'unknown' } : { entityIds: ['entity-' + index] } };
        } }));
    const calls: CampaignConstituent[] = campaign.targets.map((target, index) => {
        const args = { tool: children[index].name, input: { operationId: 'launch-child-' + index, connectionId: target.connectionId, accountId: target.accountId, arguments: { kind: 'create-draft', name: campaign.name } } };
        return { arguments: args, pluginDigest: children[index].revision, schemaFingerprint: digest({ value: schema }), envelope: { operationId: 'launch-child-' + index, connectionId: target.connectionId, accountId: target.accountId, effects: ['write'], argumentsDigest: digest({ value: args }), moneyExposure: null, requiredLimit: null } };
    });
    const safety = createSafetyService({ repo: safetyRepo, confirmations, clock, ids, policy: createMemorySpendPolicy({}), accountLocks: createMemoryAccountDispatchLock({ ids }), platformLimits: createMemoryPlatformLimitEvidence({}), audit: createMemorySafetyAudit({}),
        effects: { async resolve({ request }) { const matched = calls.find(call => digest({ value: call }) === digest({ value: request })); return matched ? { ok: true, value: matched.envelope } : { ok: false, error: { code: 'forbidden', message: 'Not a verified fixture', retryable: false } }; }, async verifyGenerationQuote() { throw new Error('No generation'); }, async verifyHaltStop() { throw new Error('No halt stop'); } } });
    const ports = { unit: database.unit, repo, safety, confirmations, clock, ids, observer,
        async prepare(): Promise<Outcome<readonly CampaignConstituent[]>> { return unavailable ? { ok: false, error: { code: 'unavailable', message: 'Plugin unadmitted: fixture', retryable: false } } : { ok: true, value: structuredClone(calls) }; },
        async definitions(): Promise<Outcome<readonly OmToolDefinition[]>> { return { ok: true, value: children.map(child => changedRevision ? { ...child, revision: 'c'.repeat(64) } : child) }; },
        async read(): Promise<Outcome<unknown>> { return { ok: true, value: { complete: true, entities: calls.map((call, index) => ({ operationId: call.envelope.operationId, entityId: badEvidence ? 'unrelated' : 'entity-' + index, state: index === 1 ? 'draft' : 'paused' })) } }; } };
    const definition = bindPausedCampaignDeployment(ports);
    const store = createSqlToolOperationStore({ unit: database.unit });
    const toolPorts = { definitions: async () => ({ ok: true as const, value: [definition] }), confirmations, clock, observer, store, authorize: () => ({ ok: true as const, value: undefined }) };
    const tools = createOmTools(toolPorts);
    const call: ToolCall = { name: definition.name, operationId: 'launch', input: { campaignId: saved.campaignId } };
    async function approve() {
        expect(value({ result: await tools.dispatch({ context, call }) }).status).toBe('pending');
        const card = value({ result: await tools.card({ context, operationId: 'launch' }) });
        if (!card) throw new Error('Expected owning card');
        value({ result: await tools.answer({ context, response: { cardId: card.cardId, operationId: card.operationId, argumentsDigest: card.argumentsDigest, choice: 'allow' } }) });
        return card;
    }
    return { native, tools, toolPorts, definition, ports, safety, confirmations, calls, sends, campaign, call, approve,
        setAfterFirst(input: { callback: () => Promise<void> }) { afterFirst = input.callback; },
        setUncertain() { uncertain = true; }, setBadEvidence() { badEvidence = true; }, setUnavailable() { unavailable = true; }, changeRevision() { changedRevision = true; }, expire() { now += 300001; },
        async close() { await tools.dispose({}); native.close(); } };
}

it('one exact card reviews every destination and executes only non-serving constituents in the single outbox', async () => {
    const f = await fixture();
    try {
        expect(value({ result: await f.tools.dispatch({ context, call: f.call }) }).status).toBe('pending');
        const card = value({ result: await f.tools.card({ context, operationId: 'launch' }) })!;
        expect(card.classification).toBe('spend'); expect(card.allowedChoices).toEqual(['allow', 'cancel']);
        expect(card.expiresAt).toBe(301000);
        expect(card.arguments.campaign).toEqual(f.campaign); expect(card.arguments.calls).toEqual(f.calls);
        expect(card.arguments.budgetSemantics).toContain('not hard spending caps');
        expect(f.sends).toEqual([]); expect(f.native.prepare('SELECT id FROM job').all()).toEqual([]);
        value({ result: await f.tools.answer({ context, response: { cardId: card.cardId, operationId: card.operationId, argumentsDigest: card.argumentsDigest, choice: 'allow' } }) });
        expect(value({ result: await f.tools.operation({ context, operationId: 'launch' }) })).toMatchObject({ status: 'completed', output: { status: 'submitted' } });
        expect(f.sends).toEqual(['1', '2', '3']);
        expect(f.native.prepare('SELECT state FROM job').all()).toEqual([{ state: 'succeeded' }]);
        expect(f.native.prepare("SELECT event_type FROM job_attempt WHERE event_type LIKE 'campaign_%' ORDER BY sequence").all()).toEqual(Array.from({ length: 3 }, () => [{ event_type: 'campaign_dispatch' }, { event_type: 'campaign_ack' }]).flat());
        const payload = String((f.native.prepare('SELECT payload FROM job').get() as { payload: string }).payload);
        expect(payload).toContain('deploy-paused'); expect(payload).toContain(card.cardId);
        expect(value({ result: await f.tools.dispatch({ context, call: f.call }) })).toMatchObject({ status: 'completed' });
        expect(f.sends).toHaveLength(3);
    } finally { await f.close(); }
});

it.each(['unknown', 'halt', 'revoke', 'expire', 'revision'] as const)('stops after %s and never replays an uncertain campaign after binding replacement', async mode => {
    const f = await fixture();
    try {
        const snapshot = value({ result: await f.definition.prepareEffect!({ context, call: f.call }) });
        if (mode === 'unknown') f.setUncertain();
        f.setAfterFirst({ callback: async () => {
            if (mode === 'halt') value({ result: await f.safety.haltAccount({ context, adAccountId: '2' }) });
            if (mode === 'revoke') { const card = value({ result: await f.tools.card({ context, operationId: 'launch' }) })!; value({ result: await f.confirmations.revoke({ context, cardId: card.cardId }) }); }
            if (mode === 'expire') f.expire();
            if (mode === 'revision') f.changeRevision();
        } });
        const card = await f.approve();
        expect(value({ result: await f.tools.operation({ context, operationId: 'launch' }) })).toMatchObject({ status: 'unknown', error: { retryable: false } });
        expect(f.sends).toEqual(mode === 'unknown' ? ['1', '2'] : ['1']);
        const acknowledgements = f.native.prepare("SELECT evidence_id FROM job_attempt WHERE event_type='campaign_ack'").all();
        expect(acknowledgements).toHaveLength(1); expect(JSON.stringify(acknowledgements)).toContain('entity-0');
        // A completion past the five-minute lease is fenced; ordinary outbox recovery owns it.
        expect(f.native.prepare('SELECT state FROM job').all()).toEqual([{ state: mode === 'expire' ? 'dispatching' : 'reconcile' }]);
        const authorization: FrozenDispatchRequest = { ...snapshot, approvalId: card.cardId, policyRevision: 0 };
        expect(await bindPausedCampaignDeployment(f.ports).invoke({ context, input: f.call.input, authorization })).toMatchObject({ ok: false });
        expect(f.sends).toHaveLength(mode === 'unknown' ? 2 : 1);
        if (mode === 'unknown') {
            const restored = createOmTools(f.toolPorts);
            try { value({ result: await restored.restore({ context }) }); expect(await restored.dispatch({ context, call: f.call })).toMatchObject({ ok: false, error: { retryable: false } }); }
            finally { await restored.dispose({}); }
            expect(f.sends).toHaveLength(2);
        }
    } finally { await f.close(); }
});

it('rejects changed plans, extra calls and cross-scope authority before enqueue', async () => {
    const f = await fixture();
    try {
        const prepared = value({ result: await f.definition.prepareEffect!({ context, call: f.call }) });
        const card = value({ result: await f.ports.safety.prepareApproval({ context, request: prepared }) });
        value({ result: await f.confirmations.confirm({ context, response: { cardId: card.cardId, operationId: card.operationId, argumentsDigest: card.argumentsDigest, choice: 'allow' } }) });
        const authorization = { ...prepared, approvalId: card.cardId, policyRevision: 0 };
        const changed = { ...authorization, pausedCampaignCalls: [...authorization.pausedCampaignCalls!, f.calls[0]] };
        expect(await f.definition.invoke({ context, input: f.call.input, authorization: changed })).toMatchObject({ ok: false });
        expect(await f.definition.invoke({ context: { ...context, scope: { ...context.scope, workspaceId: 'other' } }, input: f.call.input, authorization })).toMatchObject({ ok: false });
        expect(f.native.prepare('SELECT id FROM job').all()).toEqual([]); expect(f.sends).toEqual([]);
    } finally { await f.close(); }
});

it('requires complete exact hierarchy evidence and does not turn acknowledgements into verified paused state', async () => {
    const f = await fixture();
    try {
        f.setBadEvidence(); await f.approve();
        expect(value({ result: await f.tools.operation({ context, operationId: 'launch' }) })).toMatchObject({ status: 'unknown', error: { retryable: false } });
        expect(f.sends).toHaveLength(3);
        expect(f.native.prepare("SELECT evidence_id FROM job_attempt WHERE event_type='campaign_ack'").all()).toHaveLength(3);
    } finally { await f.close(); }
});

it('preparation failure prevents the entire card and enqueue', async () => {
    const f = await fixture();
    try {
        f.setUnavailable();
        expect(await f.tools.dispatch({ context, call: f.call })).toMatchObject({ ok: false, error: { retryable: false } });
        expect(value({ result: await f.confirmations.list({ context, query: { limit: 100 } }) }).items).toEqual([]);
        expect(f.native.prepare('SELECT id FROM job').all()).toEqual([]); expect(f.sends).toEqual([]);
    } finally { await f.close(); }
});

it('denies invalid grouped authority and direct root dispatch without creating a second card', async () => {
    const f = await fixture();
    try {
        const request = value({ result: await f.definition.prepareEffect!({ context, call: f.call }) });
        const inflated = { ...f.calls[0], envelope: { ...f.calls[0].envelope, effects: ['ad_spend' as const] } };
        const calls = [inflated, ...f.calls.slice(1)];
        const args = { ...request.arguments, calls };
        expect(await f.safety.prepareApproval({ context, request: { ...request, arguments: args, pausedCampaignCalls: calls, envelope: { ...request.envelope, argumentsDigest: digest({ value: args }) } } })).toMatchObject({ ok: false });
        expect(value({ result: await f.confirmations.list({ context, query: { limit: 100 } }) }).items).toEqual([]);
        const card = value({ result: await f.safety.prepareApproval({ context, request }) });
        value({ result: await f.confirmations.confirm({ context, response: { cardId: card.cardId, operationId: card.operationId, argumentsDigest: card.argumentsDigest, choice: 'allow' } }) });
        let dispatches = 0;
        expect(await f.safety.withDispatch({ context, request: { ...request, approvalId: card.cardId, policyRevision: 0 }, dispatch: async () => { dispatches++; return { ok: true, value: null }; } })).toMatchObject({ ok: false });
        expect(dispatches).toBe(0); expect(f.sends).toEqual([]);
    } finally { await f.close(); }
});

it('restart recovery preserves a pending owning card without running callbacks', async () => {
    const f = await fixture();
    try {
        value({ result: await f.tools.dispatch({ context, call: f.call }) });
        const restored = createOmTools(f.toolPorts);
        try {
            value({ result: await restored.restore({ context }) });
            expect(value({ result: await restored.operation({ context, operationId: 'launch' }) })).toMatchObject({ status: 'pending' });
            expect(value({ result: await restored.card({ context, operationId: 'launch' }) })?.classification).toBe('spend');
            expect(f.sends).toEqual([]); expect(f.native.prepare('SELECT id FROM job').all()).toEqual([]);
        } finally { await restored.dispose({}); }
    } finally { await f.close(); }
});

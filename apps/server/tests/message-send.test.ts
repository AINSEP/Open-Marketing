/** Written-only regressions: actual SQLite identity, policy, allowances and jobs; fixture plugin I/O. */
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { expect, it, vi } from 'vitest';
import type { CallContext, Outcome } from '@open-marketing/contracts';
import { createSqlContactRepo } from '@open-marketing/contacts';
import { createMemoryAccountDispatchLock, createMemoryConfirmationExchange, createMemorySafetyRepo, createSqlPaidSendingAllowances } from '@open-marketing/safety';
import type { PaidSendingAllowances } from '@open-marketing/safety';
import { bindAgentPluginBackends, bindAgentPluginJobs } from '../src/composition/agent-plugin-backends.js';
import { bindServerDatabase, provisionWorkspace } from '../src/composition/database.js';
import { bindIdentity, createVisitTokens } from '../src/composition/identity.js';
import { migrationManifest } from '../src/composition/migrations.js';
import { createSubjectLane } from '../src/composition/subject-lane.js';
import { createOmTools } from '../src/om-tools.js';

const context: CallContext = { scope: { ownerId: 'owner', workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
    principal: { kind: 'owner', ownerId: 'owner' }, correlationId: 'correlation', traceId: 'trace', runId: 'send-run' };
const agent: CallContext = { ...context, principal: { kind: 'agent', runId: 'send-run', agentInstanceId: 'fixture-agent' } };
const approver = { kind: 'local_token' as const, ownerId: 'owner', deviceId: 'fixture-device', tokenId: 'fixture-token-reference' };
const recipient = '+15555550100';
const request = { operationId: 'send-one', pluginId: 'fixture-messaging', connectionId: 'connection', accountId: 'account',
    recipient, purpose: 'notice', intent: 'marketing' as const, message: { content: 'Fixture message. Reply STOP.' }, maxCost: { currency: 'USD', minorUnits: 500 } };
type AuthorityInput = Pick<Parameters<PaidSendingAllowances['reserve']>[0], 'quote' | 'argumentsDigest'> & { execute(): Promise<Outcome<unknown>> };
type PluginSend = { deliveryId: string; dependencies: { authority(input: AuthorityInput): Promise<Outcome<unknown>> } };

function value<T>(required: { result: Outcome<T> }): T {
    expect(required.result.ok).toBe(true);
    if (!required.result.ok) throw new Error(required.result.error.code);
    return required.result.value;
}

/** The fake module exercises authority without vendor codecs; storage/policy are the real adapters. */
async function fixture(required: { consent?: boolean; mode?: 'production' | 'read_only'; amount?: number; outcome?: 'accepted' | 'refused' | 'unknown' } = {}) {
    const native = new Database(':memory:');
    native.pragma('foreign_keys = ON');
    for (const entry of migrationManifest) native.exec(readFileSync(new URL('../../../' + entry.path, import.meta.url), 'utf8'));
    let instant = 1000, sequence = 0;
    const clock = { now: () => instant }, ids = { next: () => 'send-fixture-' + ++sequence }, observer = { observe() {} };
    const database = bindServerDatabase({ native, observer, context });
    await provisionWorkspace({ database: database.workspace, scope: context.scope });
    const subjectLane = createSubjectLane({ resolveSubject: createSqlContactRepo({ uow: database.unit }).get });
    const identity = bindIdentity({ unit: database.unit, clock, ids, observer, digestKey: new Uint8Array([1, 2, 3]), subjectLane,
        tokens: createVisitTokens({ key: new Uint8Array([1, 2, 3]), clock, ids }).tokens });
    const subject = value({ result: await identity.contacts.upsert({ context, identifiers: [{ kind: 'phone', raw: recipient }] }) });
    if (required.consent !== false) value({ result: await identity.policy.appendEvidence({ context, evidence: { kind: 'consent', scope: context.scope,
        id: 'consent', subjectId: subject.subjectId, sourceId: 'fixture', recordedAt: instant,
        consent: { scope: 'channel', target: 'sms', purpose: request.purpose, status: 'granted', start: 0, end: 253402300799999 } } }) });
    const allowances = createSqlPaidSendingAllowances({ db: database.unit, clock, observer, timezone: 'UTC' });
    const reserve = vi.spyOn(allowances, 'reserve'), settle = vi.spyOn(allowances, 'settle');
    let amount = required.amount ?? 2;
    const execute = vi.fn(async ({ deliveryId }: { deliveryId: string }): Promise<Outcome<unknown>> => {
        expect(native.inTransaction).toBe(false);
        if (required.outcome === 'refused') return { ok: false, error: { code: 'forbidden', message: 'fixture-secret ' + recipient, retryable: false } };
        if (required.outcome === 'unknown') return { ok: true, value: { status: 'unknown', deliveryId } };
        return { ok: true, value: { status: 'accepted', deliveryId, providerMessageId: 'provider-message' } };
    });
    const sendMessage = vi.fn(async (input: PluginSend) => {
        const money = { currency: 'USD', minorUnits: amount }, argumentsDigest = 'a'.repeat(64);
        return input.dependencies.authority({ argumentsDigest, quote: { quoteId: input.deliveryId, argumentsDigest,
            estimated: money, upperBound: money, status: 'known', pricingEvidenceId: 'fixture-price', expiresAt: instant + 300000 },
            execute: () => execute({ deliveryId: input.deliveryId }) });
    });
    const backends = bindAgentPluginBackends({ projectRoot: '/fixtures', clock, observer, mode: required.mode ?? 'production',
        unit: database.unit, policyForTransaction: ({ unit }) => identity.forTransaction({ unit }).policy,
        addons: { async list() { return { ok: true, value: { items: [], cursor: null } }; } },
        state: async () => ({ enabled: true, admitted: true, bundled: false, revision: 'a'.repeat(64), entryUrl: 'file:///fixture-message/index.mjs', metadata: {} }),
        moduleDigest: async () => 'b'.repeat(64), loadModule: async () => ({ messageChannel: 'sms', sendMessage }),
        integrations: { async access() { return { ok: true, value: { accessToken: 'fixture-secret' } }; } },
        accounts: { async find({ externalAccountId }) { return { ok: true, value: { id: 'binding', scope: context.scope, connectionId: request.connectionId, externalAccountId } }; } },
        fetch: async () => { throw new Error('Unexpected native egress'); }, wait: async () => ({ ok: true, value: undefined }),
        safetyRepo: createMemorySafetyRepo({ clock, ids, ownerTimezone: 'UTC' }), accountLocks: createMemoryAccountDispatchLock({ ids }), subjectLane,
        jobs: bindAgentPluginJobs({ unit: database.unit, clock, ids, observer }), messaging: { contacts: identity.contacts, policy: identity.policy, paidSending: allowances } });
    const confirmations = createMemoryConfirmationExchange({ clock, ids, async recordAnswer() { return { ok: true, value: undefined }; } });
    const present = vi.spyOn(confirmations, 'present');
    const tools = createOmTools({ clock, observer, confirmations, definitions: backends.definitions, authorize: () => ({ ok: true, value: undefined }) });
    const definition = value({ result: await backends.definitions({ context }) }).find(tool => tool.name === 'om_message_send')!;
    expect(definition).toBeDefined();
    async function card() {
        expect(await tools.dispatch({ context: agent, call: { name: definition.name, operationId: request.operationId, input: request } })).toMatchObject({ value: { status: 'pending' } });
        const card = value({ result: await tools.card({ context, operationId: request.operationId }) });
        expect(card).not.toBeNull();
        return card!;
    }
    return { native, tools, definition, identity, subject, allowances, reserve, settle, execute, sendMessage, card, present,
        invoke: (input: typeof request = request) => definition.invoke({ context, input }),
        job: () => native.prepare('SELECT state FROM job ORDER BY created_at, id LIMIT 1').get(),
        setAmount(input: { amount: number }) { amount = input.amount; },
        nextDay() { instant += 86400000; },
        async close() { await tools.dispose({}); native.close(); } };
}

it('shows recipient, exact message and USD maximum on an owner-only Allow/Cancel card', async () => {
    const f = await fixture();
    try {
        expect(f.definition).toMatchObject({ ownerOnly: true, policy: 'write', effects: ['write'], revision: '1' });
        const card = await f.card();
        expect(card.allowedChoices).toEqual(['allow', 'cancel']);
        expect(card.arguments).toEqual({ tool: 'om_message_send', input: request });
        expect(f.sendMessage).not.toHaveBeenCalled(); expect(f.reserve).not.toHaveBeenCalled();
    } finally { await f.close(); }
});
it('rechecks STOP suppression appended after the card and refuses without calling the plugin or reserving', async () => {
    const f = await fixture();
    try {
        const card = await f.card();
        value({ result: await f.identity.policy.appendEvidence({ context, evidence: { kind: 'suppression', scope: context.scope,
            id: 'STOP', subjectId: f.subject.subjectId, sourceId: 'fixture', recordedAt: 1000,
            suppression: { channel: 'sms', start: 1000, end: 253402300799999 } } }) });
        value({ result: await f.tools.answer({ context, approver, response: { cardId: card.cardId, operationId: card.operationId, argumentsDigest: card.argumentsDigest, choice: 'allow' } }) });
        expect(await f.tools.operation({ context, operationId: request.operationId })).toMatchObject({ value: { output: { status: 'failed', reason: 'suppressed' } } });
        expect(f.job()).toMatchObject({ state: 'failed' });
        expect(f.sendMessage).not.toHaveBeenCalled(); expect(f.reserve).not.toHaveBeenCalled();
    } finally { await f.close(); }
});
it('refuses missing consent before plugin invocation', async () => {
    const f = await fixture({ consent: false });
    try {
        expect(await f.invoke()).toMatchObject({ value: { status: 'failed', reason: 'consent_missing' } });
        expect(f.job()).toMatchObject({ state: 'failed' });
        expect(f.sendMessage).not.toHaveBeenCalled(); expect(f.reserve).not.toHaveBeenCalled();
    } finally { await f.close(); }
});
it('refuses recipients outside OM contacts', async () => {
    const f = await fixture();
    try {
        expect(await f.invoke({ ...request, recipient: '+15555550199' })).toMatchObject({ value: { status: 'failed', reason: 'unknown_recipient' } });
        expect(f.job()).toMatchObject({ state: 'failed' });
        expect(f.sendMessage).not.toHaveBeenCalled(); expect(f.reserve).not.toHaveBeenCalled();
    } finally { await f.close(); }
});
it('refuses quotes above the exact approved ceiling before reserving', async () => {
    const f = await fixture({ amount: 501 });
    try {
        expect(await f.invoke()).toMatchObject({ value: { status: 'failed', reason: 'quote_exceeds_approved_maximum: 501 USD cents' } });
        expect(f.job()).toMatchObject({ state: 'failed' });
        expect(f.reserve).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled();
    } finally { await f.close(); }
});
it('refuses an exhausted paid-sending allowance without execute', async () => {
    const f = await fixture({ amount: 501 });
    try {
        expect(await f.invoke({ ...request, maxCost: { currency: 'USD', minorUnits: 600 } })).toMatchObject({ value: { status: 'failed' } });
        expect(f.reserve).toHaveBeenCalledOnce(); expect(f.execute).not.toHaveBeenCalled();
        expect(f.job()).toMatchObject({ state: 'failed' });
    } finally { await f.close(); }
});
it('succeeds once, settles at the quoted upper bound and conflicts on operation replay', async () => {
    const f = await fixture();
    try {
        expect(await f.invoke()).toMatchObject({ value: { status: 'accepted' } });
        expect(f.job()).toMatchObject({ state: 'succeeded' });
        expect(f.settle).toHaveBeenCalledWith({ context, settlement: { reservationId: request.operationId,
            observationId: 'provider-message', actual: { currency: 'USD', minorUnits: 2 } } });
        expect(await f.invoke()).toMatchObject({ ok: false, error: { code: 'conflict' } });
        expect(f.execute).toHaveBeenCalledOnce(); expect(f.sendMessage).toHaveBeenCalledOnce();
    } finally { await f.close(); }
});
it('settles a definitive refusal to zero and records failed without leaking provider errors', async () => {
    const f = await fixture({ outcome: 'refused', amount: 500 });
    try {
        const result = await f.invoke();
        expect(result).toMatchObject({ value: { status: 'failed', reason: 'forbidden' } });
        expect(JSON.stringify(result)).not.toContain('fixture-secret'); expect(JSON.stringify(result)).not.toContain(recipient);
        expect(f.job()).toMatchObject({ state: 'failed' });
        expect(f.settle).toHaveBeenCalledWith({ context, settlement: { reservationId: request.operationId,
            observationId: request.operationId + ':refused', actual: { currency: 'USD', minorUnits: 0 } } });
        f.setAmount({ amount: 500 });
        expect(await f.invoke({ ...request, operationId: 'after-refusal' })).toMatchObject({ value: { status: 'failed', reason: 'forbidden' } });
        expect(f.execute).toHaveBeenCalledTimes(2);
    } finally { await f.close(); }
});
it('records unknown as reconcile, retains its hold and blocks next-day one-cent exposure', async () => {
    const f = await fixture({ outcome: 'unknown', amount: 500 });
    try {
        expect(await f.invoke()).toMatchObject({ value: { status: 'unknown' } });
        expect(f.job()).toMatchObject({ state: 'reconcile' });
        expect(f.settle).not.toHaveBeenCalled();
        f.nextDay(); f.setAmount({ amount: 1 });
        expect(await f.invoke({ ...request, operationId: 'after-unknown' })).toMatchObject({ value: { status: 'failed' } });
        expect(f.execute).toHaveBeenCalledOnce();
    } finally { await f.close(); }
});
it('makes read_only sending unavailable before creating any card', async () => {
    const f = await fixture({ mode: 'read_only' });
    try {
        expect(f.definition.unavailableReason).toBe('Local vendor account mode is read-only');
        expect(await f.tools.dispatch({ context: agent, call: { name: f.definition.name, operationId: request.operationId, input: request } })).toMatchObject({ ok: false, error: { code: 'not_implemented' } });
        expect(f.present).not.toHaveBeenCalled(); expect(f.sendMessage).not.toHaveBeenCalled();
    } finally { await f.close(); }
});

/** B1 regressions, written only: real local persistence, fixture evidence, no vendor I/O. */
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { CallContext, CampaignStatusOutput, ObserverEvent, Outcome, UnitOfWork } from '@open-marketing/contracts';
import { bindServerDatabase } from '../src/composition/database.js';
import { appendAlerts, listAlerts, type AlertCandidate } from '../src/alerts/index.js';
import { ALERT_EVALUATION_INTERVAL_MS, evaluateAlerts } from '../src/alerts/index.js';
import { bindAlerts } from '../src/composition/alerts.js';
import { bindReporting } from '../src/composition/reporting.js';
import type { AccountBindingListPort, AccountBinding } from '@open-marketing/workspaces';
import type { MetricDay } from '@open-marketing/measure';
import { createHash } from 'node:crypto';
import { createMemoryConfirmationExchange, createMemorySafetyRepo } from '@open-marketing/safety';
import { createMemoryCampaignRepo } from '@open-marketing/campaigns';
import { buildOmToolDefinitions, createOmTools } from '../src/om-tools.js';
import { handleOwnerRequest } from '../src/inbound/owner.js';

const context: CallContext = { scope: { ownerId: 'owner', workspaceId: 'workspace' },
    principal: { kind: 'owner', ownerId: 'owner' }, correlationId: 'alerts-correlation', traceId: 'alerts-trace' };
const agent: CallContext = { ...context, principal: { kind: 'agent', runId: 'run', agentInstanceId: 'instance' }, runId: 'run' };
const approver = { kind: 'local_token' as const, ownerId: 'owner', deviceId: 'device', tokenId: 'server-token-reference' };
const now = Date.parse('2026-10-28T12:00:00Z');

function value<T>({ result }: { result: Outcome<T> }): T {
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.code);
    return result.value;
}
/** Existing server SQLite adapter, clock/IDs, alert outbox and credential summaries; no secrets. */
function fixture(_required: Record<string, never>) {
    const native = new Database(':memory:');
    native.pragma('foreign_keys = ON');
    native.exec(readFileSync(new URL('../../../features/jobs/migrations/0001_jobs.sql', import.meta.url), 'utf8'));
    native.exec(readFileSync(new URL('../migrations/0006_alerts.sql', import.meta.url), 'utf8'));
    let sequence = 0;
    const clock = { now: () => now };
    const ids = { next: () => 'p1-alert-' + String(++sequence).padStart(4, '0') };
    const events: ObserverEvent[] = [];
    const observer = { observe(event: ObserverEvent) { events.push(event); } };
    const { unit, workspace: db } = bindServerDatabase({ native, observer, context });
    native.exec(readFileSync(new URL('../../../features/credentials/migrations/0001_credentials.sql', import.meta.url), 'utf8'));
    const accountBindings: AccountBindingListPort = { async listAccountBindings() { return { ok: true, value: { items: [], cursor: null } }; } };
    const timers: { delayMs: number; callback: () => void; cancel: ReturnType<typeof vi.fn> }[] = [];
    const schedule: Parameters<typeof bindAlerts>[0]['schedule'] = input => {
        const timer = { ...input, cancel: vi.fn() }; timers.push(timer); return timer.cancel;
    };
    const reporting = bindReporting({ database: db, unit, clock, ids, observer, schedule, host: undefined });
    const confirmations = createMemoryConfirmationExchange({ clock, ids, async recordAnswer() { return { ok: true, value: undefined }; } });
    return { native, unit, db, clock, ids, observer, events, context, confirmations, approver, accountBindings,
        reporting, host: undefined, schedule, timers, close() { native.close(); } };
}

describe('B1 alert feed byte budget', () => {
    it('pages three roughly 25KB notices as two then one without omissions or duplicates', async () => {
        const f = fixture({});
        try {
            const candidates: AlertCandidate[] = ['first', 'second', 'third'].map(id => ({ kind: 'ad_disapproved',
                dedupKey: id, campaign: { pluginId: 'fixture-ads', accountId: 'account', vendorCampaignId: id },
                reasons: Array.from({ length: 13 }, (_, index) => 'é'.repeat(950) + index) }));
            expect(await appendAlerts({ ...f, candidates })).toEqual({ ok: true, value: 3 });
            const first = value({ result: await listAlerts({ ...f, query: { limit: 100 } }) });
            expect(first.items).toHaveLength(2);
            expect(first.cursor).not.toBeNull();
            expect(Buffer.byteLength(JSON.stringify(first), 'utf8')).toBeLessThanOrEqual(60000);
            const second = value({ result: await listAlerts({ ...f, query: { limit: 100, cursor: first.cursor! } }) });
            expect(second.items).toHaveLength(1);
            expect(second.cursor).toBeNull();
            expect(Buffer.byteLength(JSON.stringify(second), 'utf8')).toBeLessThanOrEqual(60000);
            expect([...first.items, ...second.items].map(item => item.candidate.dedupKey)).toEqual(['first', 'second', 'third']);
            expect(new Set([...first.items, ...second.items].map(item => item.noticeId)).size).toBe(3);
        } finally { f.close(); }
    });
});

describe('B1 alert composition', () => {
    it('creates an approval notice through evaluation with mail unbound', async () => {
        const f = fixture({});
        try {
            const alerts = bindAlerts({ ...f, confirmations: { async list(input) {
                expect(input).toEqual({ context, query: { limit: 100 } });
                return { ok: true, value: { items: [{ cardId: 'waiting-card', expiresAt: now + 1000,
                    operationId: 'waiting-operation', argumentsDigest: 'a'.repeat(64), arguments: {},
                    allowedChoices: ['allow', 'cancel'], classification: 'write' }], cursor: null } };
            } } });
            expect(await evaluateAlerts({ ...f, slot: Math.floor(now / ALERT_EVALUATION_INTERVAL_MS), sources: alerts.sources }))
                .toEqual({ ok: true, value: undefined });
            const feed = value({ result: await alerts.list({ context, query: { limit: 100 } }) });
            expect(feed.items).toHaveLength(1);
            expect(feed.items[0]).toMatchObject({ candidate: { kind: 'approval_waiting', cardId: 'waiting-card' }, acknowledgement: null });
            expect(f.native.prepare('SELECT COUNT(*) AS total FROM server_alert_email_reservation').get()).toEqual({ total: 0 });
        } finally { f.close(); }
    });
    it('returns a failed confirmations read after durably scheduling the successor', async () => {
        const f = fixture({});
        try {
            const failure = { ok: false as const, error: { code: 'unavailable' as const, message: 'Fixture read unavailable', retryable: true } };
            const alerts = bindAlerts({ ...f, confirmations: { async list() { return failure; } } });
            expect(await alerts.sources({ context })).toEqual(failure);
            expect(await evaluateAlerts({ ...f, slot: Math.floor(now / ALERT_EVALUATION_INTERVAL_MS), sources: alerts.sources })).toEqual(failure);
            const rows = f.native.prepare('SELECT payload FROM job').all() as { payload: string }[];
            expect(rows).toHaveLength(1);
            expect(JSON.parse(rows[0]!.payload)).toMatchObject({ handler: 'alerts.evaluate', payload: { slot: Math.floor(now / ALERT_EVALUATION_INTERVAL_MS) + 1 } });
            expect(value({ result: await alerts.list({ context, query: { limit: 100 } }) }).items).toEqual([]);
        } finally { f.close(); }
    });
    it('seeds the current slot once and throws when durable enqueue fails', async () => {
        const f = fixture({});
        try {
            const alerts = bindAlerts(f);
            await alerts.seed({ context });
            await alerts.seed({ context });
            expect(f.native.prepare('SELECT COUNT(*) AS total FROM job').get()).toEqual({ total: 1 });
            const unit: UnitOfWork = { async transaction() {
                throw new Error('Fixture outbox unavailable');
            } };
            await expect(bindAlerts({ ...f, unit }).seed({ context })).rejects.toThrow('Alert evaluation seed failed: unavailable');
        } finally { f.close(); }
    });
});

/** The production definitions and dispatcher, with existing public memory services for unrelated tools. */
function toolFixture(required: { fixture: ReturnType<typeof fixture> }) {
    const f = required.fixture;
    const alerts = bindAlerts(f);
    const services = { alerts, approver, confirmations: f.confirmations,
        campaigns: createMemoryCampaignRepo({}), safety: createMemorySafetyRepo({ clock: f.clock, ids: f.ids, ownerTimezone: 'UTC' }) };
    const tools = createOmTools({ ...f, authorize() { return { ok: true, value: undefined }; },
        definitions: input => buildOmToolDefinitions({ ...input, services }) });
    return { alerts, tools };
}

describe('B1 alert tools', () => {
    it('lists a scoped page through the real tool definitions and dispatcher', async () => {
        const f = fixture({});
        const { tools } = toolFixture({ fixture: f });
        try {
            value({ result: await appendAlerts({ ...f, candidates: [{ kind: 'approval_waiting', cardId: 'waiting-card', dedupKey: 'waiting' }] }) });
            const result = value({ result: await tools.dispatch({ context: agent,
                call: { name: 'om_alerts_list', input: { limit: 25 }, operationId: 'feed-read' } }) });
            expect(result).toMatchObject({ status: 'completed', output: { items: [{ candidate: { cardId: 'waiting-card' }, acknowledgement: null }], cursor: null } });
            const other = { ...context, scope: { ...context.scope, workspaceId: 'another-workspace' } };
            expect(value({ result: await tools.dispatch({ context: other,
                call: { name: 'om_alerts_list', input: { limit: 25 }, operationId: 'other-feed' } }) }))
                .toMatchObject({ status: 'completed', output: { items: [], cursor: null } });
        } finally { await tools.dispose({}); f.close(); }
    });
    it('acknowledges through the owner route without a card and rejects a spoofed approver', async () => {
        const f = fixture({});
        const alerts = bindAlerts(f);
        const services = { alerts, confirmations: f.confirmations, campaigns: createMemoryCampaignRepo({}),
            safety: createMemorySafetyRepo({ clock: f.clock, ids: f.ids, ownerTimezone: 'UTC' }) };
        try {
            value({ result: await appendAlerts({ ...f, candidates: [{ kind: 'approval_waiting', cardId: 'waiting-card', dedupKey: 'waiting' }] }) });
            const noticeId = value({ result: await alerts.list({ context, query: { limit: 1 } }) }).items[0]!.noticeId;
            const request = { method: 'POST' as const, path: '/api/alerts/acknowledge', body: { noticeId } };
            const invalid = await handleOwnerRequest({ request: { ...request, body: { noticeId, approver: { ...approver, deviceId: 'spoofed' } } }, context, services });
            expect(invalid.status).toBe(400);
            expect(value({ result: await alerts.list({ context, query: { limit: 1 } }) }).items[0]?.acknowledgement).toBeNull();
            expect(await handleOwnerRequest({ request, context, services }))
                .toEqual({ status: 200, body: { ok: true, value: { status: 'acknowledged' } } });
            expect(value({ result: await alerts.list({ context, query: { limit: 1 } }) }).items[0]?.acknowledgement)
                .toEqual({ at: now, approver });
            expect(value({ result: await f.confirmations.list({ context, query: { limit: 100 } }) }).items).toEqual([]);
        } finally { f.close(); }
    });
    it('requires the owner card and records the server approver only after the owner answers', async () => {
        const f = fixture({});
        const { alerts, tools } = toolFixture({ fixture: f });
        try {
            value({ result: await appendAlerts({ ...f, candidates: [{ kind: 'approval_waiting', cardId: 'waiting-card', dedupKey: 'waiting' }] }) });
            const before = value({ result: await alerts.list({ context, query: { limit: 1 } }) }).items[0]!;
            expect(await alerts.acknowledge({ context: agent, noticeId: before.noticeId }))
                .toMatchObject({ ok: false, error: { code: 'forbidden' } });
            const call = { name: 'om_alerts_acknowledge', input: { noticeId: before.noticeId }, operationId: 'acknowledge' };
            const pending = value({ result: await tools.dispatch({ context: agent, call }) });
            expect(pending.status).toBe('pending');
            expect(value({ result: await alerts.list({ context, query: { limit: 1 } }) }).items[0]?.acknowledgement).toBeNull();
            const card = value({ result: await tools.card({ context, operationId: call.operationId }) });
            expect(card).not.toBeNull();
            expect(card!.allowedChoices).toEqual(['allow', 'cancel']);
            expect(card!.arguments).toEqual({ tool: call.name, input: call.input });
            expect(await tools.answer({ context, response: { cardId: card!.cardId, operationId: card!.operationId,
                argumentsDigest: card!.argumentsDigest, choice: 'allow' }, approver: { ...approver, deviceId: 'answering-device' } }))
                .toEqual({ ok: true, value: undefined });
            expect(value({ result: await tools.operation({ context, operationId: call.operationId }) }))
                .toMatchObject({ status: 'completed', output: { status: 'acknowledged' } });
            const after = value({ result: await alerts.list({ context, query: { limit: 1 } }) }).items[0]!;
            expect(after.acknowledgement).toEqual({ at: now, approver });
            expect(value({ result: await tools.dispatch({ context: agent, call: { ...call, operationId: 'acknowledge-again' } }) }).status).toBe('pending');
        } finally { await tools.dispose({}); f.close(); }
    });
});

/** Two stored days expose sorted/deduplicated campaign discovery and the shared UTC window. */
function storedPartitions(required: { accountId: string; ids?: readonly string[] }): MetricDay[] {
    return ['2026-10-27', '2026-10-28'].map(day => ({ day, syncId: 'stored-' + day, previousSyncId: null,
        batch: { schema: 'report.metrics.v1', pluginId: 'fixture-ads', connectionId: 'connection-' + required.accountId,
            accountId: required.accountId, currency: 'USD', timezone: 'UTC', grain: 'campaign',
            days: { start: '2026-10-27', end: '2026-10-29' }, retrievedAt: now - 16 * 60000, dataThrough: now - 16 * 60000,
            complete: true, freshness: 'fresh', finality: 'provisional', restated: false,
            mapping: { pluginId: 'fixture-ads', version: '1', grains: { campaign: { spend: { vendorField: 'cost', meaning: 'Account currency micros' } } } },
            rows: (required.ids ?? ['campaign-z', 'campaign-a']).map(vendorCampaignId => ({ day,
                entity: { grain: 'campaign', vendorCampaignId }, metrics: { spend: '20000001' } })),
        } }));
}
/** Valid catalog output; tests alter the host result rather than bypassing the evidence reader. */
function statusFixture(required: { ids?: readonly string[] } = {}): CampaignStatusOutput {
    return { observedAt: now, complete: true, campaigns: (required.ids ?? ['campaign-a', 'campaign-z']).map(vendorCampaignId => ({
        vendorCampaignId, status: 'disapproved', disapprovalDescriptions: ['Fixture policy rejection'],
        currentBudget: { kind: 'daily', currency: 'USD', amountMicros: '10000000' },
    })) };
}

/** Reuse the real credential SQL list and typed spies for existing reporting/catalog ports. */
function evidenceFixture(required: { accounts: readonly string[]; revoked?: readonly string[] }) {
    const f = fixture({});
    const bindings: AccountBinding[] = required.accounts.map(externalAccountId => ({ id: 'binding-' + externalAccountId,
        scope: context.scope, connectionId: 'connection-' + externalAccountId, externalAccountId }));
    for (const binding of bindings) {
        f.native.prepare(`INSERT INTO om_credential_connection
            (owner_id,workspace_id,connection_id,plugin_id,status,version,ciphertext,aad_digest) VALUES (?,?,?,?,?,1,?,?)`)
            .run(context.scope.ownerId, context.scope.workspaceId, binding.connectionId, 'fixture-ads',
                required.revoked?.includes(binding.externalAccountId) ? 'revoked' : 'connected', 'fixture-sealed', 'a'.repeat(64));
    }
    bindings.push({ id: 'binding-foreign', scope: context.scope, connectionId: 'connection-foreign', externalAccountId: 'account-foreign' });
    f.native.prepare(`INSERT INTO om_credential_connection
        (owner_id,workspace_id,connection_id,plugin_id,status,version,ciphertext,aad_digest) VALUES (?,?,?,?,?,1,?,?)`)
        .run('foreign-owner', context.scope.workspaceId, 'connection-foreign', 'foreign-plugin', 'connected', 'fixture-sealed', 'b'.repeat(64));
    const listAccountBindings = vi.spyOn(f.accountBindings, 'listAccountBindings').mockResolvedValue({ ok: true, value: { items: bindings, cursor: null } });
    const readDays = vi.spyOn(f.reporting.repo, 'readDays').mockImplementation(async input => ({ ok: true, value: storedPartitions({ accountId: input.query.accountId }) }));
    const enqueue = vi.spyOn(f.reporting, 'enqueue').mockResolvedValue({ ok: true, value: { jobId: 'refresh-job', operationId: 'refresh-operation', status: 'enqueued' } });
    // Preserve the generic host contract, following p1-reporting-runtime.test.ts's fixture.
    const host: NonNullable<Parameters<typeof bindAlerts>[0]['host']> = { async invokeCapability() { throw new Error('Unconfigured fixture capability'); } };
    const invokeCapability = vi.spyOn(host, 'invokeCapability').mockResolvedValue({ ok: true, value: statusFixture() });
    return { ...f, host, bindings, listAccountBindings, readDays, enqueue, invokeCapability };
}

/** Reuse B1's pending-card list fixture; the approval evaluator/store remain real. */
function addPendingApproval(required: { fixture: Pick<ReturnType<typeof fixture>, 'confirmations'> }): void {
    vi.spyOn(required.fixture.confirmations, 'list').mockResolvedValue({ ok: true, value: { items: [{
        cardId: 'b2-waiting-card', operationId: 'b2-waiting-operation', argumentsDigest: 'c'.repeat(64), arguments: {},
        classification: 'write', allowedChoices: ['allow', 'cancel'], expiresAt: now + 1000,
    }], cursor: null } });
}

describe('B2 status and pacing sources', () => {
    it('joins only connected accounts, pages bindings, and uses exact catalog/refresh arguments with stable replay identity', async () => {
        const f = evidenceFixture({ accounts: ['account-a', 'account-revoked'], revoked: ['account-revoked'] });
        try {
            f.listAccountBindings.mockImplementation(async input => ({ ok: true, value: input.query.cursor
                ? { items: [f.bindings[1]!, f.bindings[2]!], cursor: null } : { items: [f.bindings[0]!], cursor: 'binding-account-a' } }));
            const alerts = bindAlerts(f);
            const first = value({ result: await alerts.sources({ context }) });
            expect(first.statuses).toHaveLength(1);
            expect(first.pacing).toHaveLength(2);
            expect(f.listAccountBindings.mock.calls.map(([input]) => input.query)).toEqual([
                { limit: 100, cursor: undefined }, { limit: 100, cursor: 'binding-account-a' }]);
            expect(f.invokeCapability).toHaveBeenCalledTimes(1);
            expect(f.invokeCapability).toHaveBeenCalledWith({ context, pluginId: 'fixture-ads', capabilityId: 'campaign.status.v1',
                connection: { connectionId: 'connection-account-a', accountId: 'account-a' },
                input: { vendorCampaignIds: ['campaign-a', 'campaign-z'] } }, { signal: expect.any(AbortSignal) });
            const days = { start: '2026-10-27', end: '2026-10-29' };
            const syncId = createHash('sha256').update(JSON.stringify(['fixture-ads', 'connection-account-a', 'account-a',
                days.start, days.end, Math.floor(now / ALERT_EVALUATION_INTERVAL_MS)])).digest('hex');
            expect(f.enqueue).toHaveBeenCalledTimes(1);
            expect(f.enqueue).toHaveBeenCalledWith({ context, request: { syncId, pluginId: 'fixture-ads', connectionId: 'connection-account-a', accountId: 'account-a',
                input: { grain: 'campaign', days } } }, { signal: expect.any(AbortSignal) });
            expect(f.readDays).toHaveBeenCalledWith({ context, query: { pluginId: 'fixture-ads', connectionId: 'connection-account-a', accountId: 'account-a',
                grain: 'campaign', days } }, { signal: expect.any(AbortSignal) });
            await alerts.sources({ context });
            expect(f.enqueue.mock.calls[1]?.[0].request.syncId).toBe(syncId);
            expect(f.events.filter(event => event.operation === 'server.alerts.evidence')).toEqual([]);
        } finally { f.close(); }
    });
    it('creates disapproval and daily pacing notices through evaluation and the existing feed', async () => {
        const f = evidenceFixture({ accounts: ['account-a'] });
        try {
            const alerts = bindAlerts(f);
            expect(await evaluateAlerts({ ...f, slot: Math.floor(now / ALERT_EVALUATION_INTERVAL_MS), sources: alerts.sources })).toEqual({ ok: true, value: undefined });
            const feed = value({ result: await alerts.list({ context, query: { limit: 100 } }) });
            expect(feed.items.filter(item => item.candidate.kind === 'ad_disapproved')).toHaveLength(2);
            expect(feed.items.filter(item => item.candidate.kind === 'pacing')).toHaveLength(2);
            expect(feed.items[0]?.candidate).toMatchObject({ campaign: { pluginId: 'fixture-ads', accountId: 'account-a' } });
        } finally { f.close(); }
    });
    it.each(['unavailable', 'protocol_mismatch'] as const)('retains account B and pending approvals when account A has %s', async code => {
        const f = evidenceFixture({ accounts: ['account-a', 'account-b'] });
        try {
            addPendingApproval({ fixture: f });
            if (code === 'unavailable') f.invokeCapability.mockResolvedValueOnce({ ok: false, error: { code, message: 'Fixture unavailable', retryable: true } });
            else f.invokeCapability.mockResolvedValueOnce({ ok: true, value: statusFixture({ ids: ['unrequested-campaign'] }) });
            const alerts = bindAlerts(f);
            expect(await evaluateAlerts({ ...f, slot: Math.floor(now / ALERT_EVALUATION_INTERVAL_MS), sources: alerts.sources })).toEqual({ ok: true, value: undefined });
            const feed = value({ result: await alerts.list({ context, query: { limit: 100 } }) });
            expect(feed.items.filter(item => item.candidate.kind === 'approval_waiting')).toHaveLength(1);
            expect(feed.items.filter(item => item.candidate.kind === 'ad_disapproved').map(item => item.candidate))
                .toMatchObject([{ campaign: { accountId: 'account-b' } }, { campaign: { accountId: 'account-b' } }]);
            expect(f.events.filter(event => event.operation === 'server.alerts.evidence')).toEqual([
                { operation: 'server.alerts.evidence', outcome: code, correlationId: context.correlationId, traceId: context.traceId, runId: undefined }]);
        } finally { f.close(); }
    });
    it('discards the late account, stops the loop, keeps earlier evidence and cancels the one timer', async () => {
        const f = evidenceFixture({ accounts: ['account-a', 'account-b', 'account-c'] });
        try {
            addPendingApproval({ fixture: f });
            f.invokeCapability.mockResolvedValueOnce({ ok: true, value: statusFixture() });
            f.invokeCapability.mockImplementationOnce(async () => {
                f.timers[0]!.callback();
                return { ok: true, value: statusFixture() };
            });
            const evidence = value({ result: await bindAlerts(f).sources({ context }) });
            expect(evidence.pendingCards).toHaveLength(1);
            expect(evidence.statuses.map(batch => batch.accountId)).toEqual(['account-a']);
            expect(evidence.pacing.map(item => item.campaign.accountId)).toEqual(['account-a', 'account-a']);
            expect(f.invokeCapability).toHaveBeenCalledTimes(2);
            expect(f.enqueue).toHaveBeenCalledTimes(2);
            expect(f.timers).toHaveLength(1);
            expect(f.timers[0]?.delayMs).toBe(25000);
            expect(f.timers[0]?.cancel).toHaveBeenCalledTimes(1);
            expect(f.events.filter(event => event.operation === 'server.alerts.evidence').map(event => event.outcome)).toEqual(['cancelled']);
        } finally { f.close(); }
    });
});

const flightStart = Date.parse('2026-10-20T00:00:00Z'), flightEnd = Date.parse('2026-11-05T00:00:00Z');
const historyDays = ['2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26'];
/** Covered stored flight history (complete, cutoff at the next local midnight) for both fixture campaigns. */
function historyPartitions(required: { accountId: string; days?: readonly string[] }): MetricDay[] {
    return (required.days ?? historyDays).map(day => {
        const next = new Date(Date.parse(day) + 86400000).toISOString().slice(0, 10);
        const base = storedPartitions({ accountId: required.accountId })[0]!;
        return { ...base, day, syncId: 'history-' + day, batch: { ...base.batch, days: { start: day, end: next },
            retrievedAt: Date.parse(next), dataThrough: Date.parse(next),
            rows: ['campaign-a', 'campaign-z'].map(vendorCampaignId => ({ day, entity: { grain: 'campaign' as const, vendorCampaignId }, metrics: { spend: '1300000000' } })) } };
    });
}
/** campaign-a has a 16,000-unit lifetime flight (elapsed share 8,500 units at now); campaign-z stays daily. */
function lifetimeStatus(): CampaignStatusOutput {
    const status = statusFixture();
    return { ...status, campaigns: status.campaigns.map(item => item.vendorCampaignId !== 'campaign-a' ? item
        : { ...item, status: 'active', disapprovalDescriptions: [], currentBudget: { kind: 'lifetime', currency: 'USD', amountMicros: '16000000000', flight: { start: flightStart, end: flightEnd } } }) };
}
/** Current-window reads keep the B2 fixture; history-window reads return the given partitions or failure. */
function lifetimeFixture(required: { history: (input: { days: { start: string; end: string } }) => Outcome<MetricDay[]> }) {
    const f = evidenceFixture({ accounts: ['account-a'] });
    f.invokeCapability.mockResolvedValue({ ok: true, value: lifetimeStatus() });
    f.readDays.mockImplementation(async input => input.query.days.start === '2026-10-27'
        ? { ok: true, value: storedPartitions({ accountId: input.query.accountId }) } : required.history({ days: input.query.days }));
    return f;
}

describe('W22 lifetime pacing sources', () => {
    it('reads flight history once per account and persists a lifetime notice beside daily notices', async () => {
        const f = lifetimeFixture({ history: () => ({ ok: true, value: historyPartitions({ accountId: 'account-a' }) }) });
        try {
            const alerts = bindAlerts(f);
            expect(await evaluateAlerts({ ...f, slot: Math.floor(now / ALERT_EVALUATION_INTERVAL_MS), sources: alerts.sources })).toEqual({ ok: true, value: undefined });
            expect(f.readDays.mock.calls.map(([input]) => input.query.days)).toEqual([
                { start: '2026-10-27', end: '2026-10-29' }, { start: '2026-10-20', end: '2026-10-27' }]);
            expect(f.enqueue).toHaveBeenCalledTimes(1);
            const pacing = value({ result: await alerts.list({ context, query: { limit: 100 } }) }).items
                .map(item => item.candidate).filter(candidate => candidate.kind === 'pacing');
            expect(pacing).toHaveLength(2);
            expect(pacing).toContainEqual(expect.objectContaining({ campaign: { pluginId: 'fixture-ads', accountId: 'account-a', vendorCampaignId: 'campaign-a' }, rules: ['lifetime'], localDay: '2026-10-28' }));
            expect(pacing).toContainEqual(expect.objectContaining({ campaign: expect.objectContaining({ vendorCampaignId: 'campaign-z' }), rules: ['today'] }));
        } finally { f.close(); }
    });
    it('keeps daily, disapproval and approval notices when the history read fails', async () => {
        const f = lifetimeFixture({ history: () => ({ ok: false, error: { code: 'unavailable', message: 'Fixture history unavailable', retryable: true } }) });
        try {
            addPendingApproval({ fixture: f });
            const alerts = bindAlerts(f);
            expect(await evaluateAlerts({ ...f, slot: Math.floor(now / ALERT_EVALUATION_INTERVAL_MS), sources: alerts.sources })).toEqual({ ok: true, value: undefined });
            const candidates = value({ result: await alerts.list({ context, query: { limit: 100 } }) }).items.map(item => item.candidate);
            expect(candidates.filter(candidate => candidate.kind === 'approval_waiting')).toHaveLength(1);
            expect(candidates.filter(candidate => candidate.kind === 'ad_disapproved')).toHaveLength(1);
            expect(candidates.filter(candidate => candidate.kind === 'pacing')).toMatchObject([{ rules: ['today'], campaign: { vendorCampaignId: 'campaign-z' } }]);
            expect(f.events.filter(event => event.operation === 'server.alerts.evidence').map(event => event.outcome)).toEqual(['unavailable']);
        } finally { f.close(); }
    });
    it('refreshes only history windows with an uncovered day, with one syncId per UTC day', async () => {
        const f = lifetimeFixture({ history: () => ({ ok: true, value: historyPartitions({ accountId: 'account-a', days: historyDays.filter(day => day !== '2026-10-22') }) }) });
        try {
            const alerts = bindAlerts(f);
            const first = value({ result: await alerts.sources({ context }) });
            expect(first.pacing.map(item => item.campaign.vendorCampaignId)).toEqual(['campaign-z']);
            const days = { start: '2026-10-20', end: '2026-10-27' };
            const daySlot = Math.floor(Date.parse('2026-10-28T00:00:00Z') / ALERT_EVALUATION_INTERVAL_MS);
            const syncId = createHash('sha256').update(JSON.stringify(['fixture-ads', 'connection-account-a', 'account-a', days.start, days.end, daySlot])).digest('hex');
            expect(f.enqueue).toHaveBeenCalledTimes(2);
            expect(f.enqueue.mock.calls[1]?.[0]).toEqual({ context, request: { syncId, pluginId: 'fixture-ads', connectionId: 'connection-account-a', accountId: 'account-a',
                input: { grain: 'campaign', days } } });
            vi.spyOn(f.clock, 'now').mockReturnValue(now + ALERT_EVALUATION_INTERVAL_MS);
            value({ result: await alerts.sources({ context }) });
            expect(f.enqueue).toHaveBeenCalledTimes(4);
            expect(f.enqueue.mock.calls[3]?.[0].request.syncId).toBe(syncId);
            expect(f.enqueue.mock.calls[2]?.[0].request.syncId).not.toBe(f.enqueue.mock.calls[0]?.[0].request.syncId);
        } finally { f.close(); }
    });
});

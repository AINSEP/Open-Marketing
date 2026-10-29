/** Written-only integration evidence against the real SQLite unit and single jobs outbox. */
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { CallContext, ObserverEvent, Outcome, UnitOfWork } from '@open-marketing/contracts';
import { bindServerDatabase } from '../src/composition/database.js';
import { alertCandidates, acknowledgeAlert, appendAlerts, listAlerts, ALERT_EVALUATION_INTERVAL_MS,
    alertEvaluationJob, enqueueAlertEvaluation, evaluateAlerts, alertEmailJob, dispatchAlertEmail, enqueueAlertEmail, reserveAlertEmail, ALERT_EMAIL_DEFINITION_DIGEST, type AlertEmailDependencies, type AlertMailPort, type AlertEvidence } from '../src/alerts/index.js';
import { createSqlJobRepo } from '@open-marketing/jobs';
import { digestArguments } from '@open-marketing/safety';
import { createFormWorkers } from '../src/composition/workers.js';
import { formRetryPolicy } from '../src/composition/forms.js';
import { countAddonJobs } from '../src/composition/agent-plugin-backends.js';
import { bootOwnerSettings } from '../src/composition/index.js';

type MailBackends = NonNullable<Parameters<typeof bootOwnerSettings>[0]['pluginBackends']>;

const context: CallContext = { scope: { ownerId: 'owner', workspaceId: 'workspace' }, principal: { kind: 'owner', ownerId: 'owner' },
    correlationId: 'alerts-correlation', traceId: 'alerts-trace', runId: 'alerts-run' };
const approver = { kind: 'local_token' as const, ownerId: 'owner', deviceId: 'device', tokenId: 'token-reference' };
const now = Date.parse('2026-10-03T12:00:00Z');
const empty: AlertEvidence = { pendingCards: [], statuses: [], pacing: [] };
/** Extract a typed success without permitting a failed setup to skip assertions. */
function value<T>({ result }: { result: Outcome<T> }): T {
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.code);
    return result.value;
}
/** Fresh real database per case, reopenable for durable-notice verification; no timers/vendor I/O. */
function fixture(_input: Record<string, never>) {
    const directory = mkdtempSync(join(tmpdir(), 'om-alerts-'));
    const path = join(directory, 'fixture.sqlite');
    let native = new Database(path);
    native.pragma('journal_mode = WAL');
    native.pragma('foreign_keys = ON');
    native.exec(readFileSync(new URL('../../../features/jobs/migrations/0001_jobs.sql', import.meta.url), 'utf8'));
    native.exec(readFileSync(new URL('../migrations/0006_alerts.sql', import.meta.url), 'utf8'));
    native.exec(readFileSync(new URL('../../../features/credentials/migrations/0001_credentials.sql', import.meta.url), 'utf8'));
    let instant = now;
    let sequence = 0;
    const clock = { now: () => instant };
    const ids = { next: () => 'alert-fixture-' + String(++sequence).padStart(4, '0') };
    const events: ObserverEvent[] = [];
    const observer = { observe(event: ObserverEvent) { events.push(event); } };
    let database = bindServerDatabase({ native, observer, context });
    return {
        context, clock, ids, observer, events, timezone: 'UTC', senderConnectionId: 'sender-a',
        get unit() { return database.unit; },
        get native() { return native; },
        peer() {
            const peer = new Database(path);
            peer.pragma('foreign_keys = ON');
            peer.pragma('busy_timeout = 0');
            return { unit: bindServerDatabase({ native: peer, observer, context }).unit, close() { peer.close(); } };
        },
        advance({ ms }: { ms: number }) { instant += ms; },
        restart() {
            native.close();
            native = new Database(path);
            native.pragma('foreign_keys = ON');
            database = bindServerDatabase({ native, observer, context });
        },
        close() { native.close(); rmSync(directory, { force: true, recursive: true }); },
    };
}
/** Real rule-generated approval candidate, independently identified by card ID in assertions. */
function candidates({ cardIds }: { cardIds: string[] }) {
    return value({ result: alertCandidates({ ...empty, now, pendingCards: cardIds.map(cardId => ({ cardId, status: 'pending', expiresAt: now + 300000 })) }) });
}
/** Explicit processOne only; construction must never schedule or call another handler. */
function workers(required: { fixture: ReturnType<typeof fixture>; sources?: Parameters<typeof evaluateAlerts>[0]['sources'] }) {
    return createFormWorkers({ ...required.fixture, forms: { async accept() { throw new Error('Unexpected forms job'); } },
        schedule() { throw new Error('Unexpected worker scheduling'); },
        ...(required.sources ? { alerts: { sources: required.sources } } : {}) });
}

/** Guarded fixture port: records egress only after a NEW notice reservation, never on replay. */
function mailFixture(required: { fixture: ReturnType<typeof fixture> }) {
    const f = required.fixture;
    const state = { enabled: true, admitted: true, bundled: false, revision: 'fixture-revision',
        metadata: { mailAdapters: [{ id: 'fixture-mail', label: 'Fixture mail', module: 'mail/index.mjs', credentialKeys: ['token'], feedback: false }],
            alertFrom: 'alerts@example.test' as unknown } };
    const calls: Parameters<AlertMailPort['send']>[0][] = [];
    const sent: Parameters<AlertMailPort['send']>[0][] = [];
    const alertEmail: AlertEmailDependencies = { timezone: 'UTC', ownerEmail: 'owner@example.test',
        async agentPluginState({ pluginId }) { return pluginId === 'example-mail' ? state : null; },
        mail: { async send(input) {
            calls.push(input);
            const reserved = await input.reserve();
            if (!reserved.ok || reserved.value !== 'reserved') return { ok: false, retryable: false, errorCode: 'reservation_refused', message: 'Alert email not reserved' };
            sent.push(input);
            return { ok: true, providerMessageId: 'fixture-delivery', acceptedAt: '2026-10-03T12:00:00Z' };
        } },
    };
    function select(input: { selected: string | null; alertFrom?: string | null }): void {
        f.native.prepare(`INSERT INTO om_owner_settings(owner_id,workspace_id,key,value_json) VALUES (?,?,'mail.provider',?)
            ON CONFLICT(owner_id,workspace_id,key) DO UPDATE SET value_json=excluded.value_json`)
            .run(context.scope.ownerId, context.scope.workspaceId, JSON.stringify(input.selected));
        if (input.alertFrom !== undefined) f.native.prepare(`INSERT INTO om_owner_settings(owner_id,workspace_id,key,value_json) VALUES (?,?,'mail.alertFrom',?)
            ON CONFLICT(owner_id,workspace_id,key) DO UPDATE SET value_json=excluded.value_json`)
            .run(context.scope.ownerId, context.scope.workspaceId, JSON.stringify(input.alertFrom));
    }
    function connect(input: { connectionId: string }): void {
        f.native.prepare(`INSERT INTO om_credential_connection(owner_id,workspace_id,connection_id,plugin_id,status,version,ciphertext,aad_digest)
            VALUES (?,?,?,'example-mail','connected',1,'sealed-fixture','digest')`).run(context.scope.ownerId, context.scope.workspaceId, input.connectionId);
    }
    select({ selected: 'example-mail' });
    connect({ connectionId: f.senderConnectionId });
    return { state, calls, sent, alertEmail, select, connect };
}

it('retains notices and original acknowledgement across restart and evaluation replay', async () => {
    const f = fixture({});
    try {
        expect(await appendAlerts({ ...f, candidates: candidates({ cardIds: ['card-a'] }) })).toEqual({ ok: true, value: 1 });
        const first = value({ result: await listAlerts({ ...f, query: { limit: 10 } }) });
        expect(first.items).toHaveLength(1);
        expect(first.items[0]).toMatchObject({ acknowledgement: null, candidate: { kind: 'approval_waiting', cardId: 'card-a' } });
        const noticeId = first.items[0]!.noticeId;
        expect(await acknowledgeAlert({ ...f, noticeId, approver })).toEqual({ ok: true, value: undefined });
        f.advance({ ms: 1000 });
        expect(await acknowledgeAlert({ ...f, noticeId, approver: { ...approver, tokenId: 'second-token' } })).toEqual({ ok: true, value: undefined });
        f.restart();
        expect(await appendAlerts({ ...f, candidates: candidates({ cardIds: ['card-a'] }) })).toEqual({ ok: true, value: 0 });
        const page = value({ result: await listAlerts({ ...f, query: { limit: 10 } }) });
        expect(page.items).toHaveLength(1);
        expect(page.items[0]).toMatchObject({ noticeId, acknowledgement: { at: now, approver } });
        expect(() => f.native.prepare('DELETE FROM server_alert_notice').run()).toThrow('append-only');
        expect(() => f.native.prepare('UPDATE server_alert_ack SET acknowledged_at=1').run()).toThrow('append-only');
    } finally { f.close(); }
});

it('scopes list/ack, rejects agent acknowledgement and pages without duplicates', async () => {
    const f = fixture({});
    try {
        value({ result: await appendAlerts({ ...f, candidates: candidates({ cardIds: ['a', 'b', 'c'] }) }) });
        const first = value({ result: await listAlerts({ ...f, query: { limit: 2 } }) });
        expect(first.items).toHaveLength(2);
        expect(first.cursor).toEqual(expect.any(String));
        const second = value({ result: await listAlerts({ ...f, query: { limit: 2, cursor: first.cursor! } }) });
        expect(second.items).toHaveLength(1);
        expect(second.cursor).toBeNull();
        expect(new Set([...first.items, ...second.items].map(item => item.noticeId)).size).toBe(3);
        const otherWorkspace = { ...context, scope: { ...context.scope, workspaceId: 'other-workspace' } };
        const otherOwner: CallContext = { ...context, scope: { ...context.scope, ownerId: 'other-owner' }, principal: { kind: 'owner', ownerId: 'other-owner' } };
        expect(value({ result: await listAlerts({ ...f, context: otherWorkspace, query: { limit: 10 } }) }).items).toEqual([]);
        expect(value({ result: await listAlerts({ ...f, context: otherOwner, query: { limit: 10 } }) }).items).toEqual([]);
        const noticeId = first.items[0]!.noticeId;
        expect(await acknowledgeAlert({ ...f, context: otherWorkspace, noticeId, approver })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
        expect(await acknowledgeAlert({ ...f, context: { ...context, principal: { kind: 'agent', agentInstanceId: 'agent', runId: 'run' } }, noticeId, approver })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
        expect(await acknowledgeAlert({ ...f, noticeId, approver: { ...approver, ownerId: 'wrong-owner' } })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
        expect(value({ result: await listAlerts({ ...f, query: { limit: 10 } }) }).items.every(item => item.acknowledgement === null)).toBe(true);
        expect(await listAlerts({ ...f, query: { limit: 101 } })).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    } finally { f.close(); }
});

it('rolls back all notice inserts when a later row fails', async () => {
    const f = fixture({});
    try {
        f.native.exec("CREATE TRIGGER fixture_alert_failure BEFORE INSERT ON server_alert_notice WHEN json_extract(NEW.candidate,'$.cardId')='b' BEGIN SELECT RAISE(ABORT,'fixture failure'); END;");
        expect(await appendAlerts({ ...f, candidates: candidates({ cardIds: ['a', 'b'] }) })).toMatchObject({ ok: false, error: { code: 'unavailable' } });
        expect(value({ result: await listAlerts({ ...f, query: { limit: 10 } }) }).items).toEqual([]);
        f.native.exec('DROP TRIGGER fixture_alert_failure');
        expect(await appendAlerts({ ...f, candidates: candidates({ cardIds: ['a', 'b'] }) })).toEqual({ ok: true, value: 2 });
    } finally { f.close(); }
});

it('seeds idempotently and persists the next future slot before a failed source read', async () => {
    const f = fixture({});
    try {
        const slot = Math.floor(now / ALERT_EVALUATION_INTERVAL_MS);
        expect(await enqueueAlertEvaluation({ ...f, slot })).toEqual({ ok: true, value: undefined });
        f.restart();
        expect(await enqueueAlertEvaluation({ ...f, slot })).toEqual({ ok: true, value: undefined });
        expect(f.native.prepare('SELECT COUNT(*) AS count FROM job').get()).toEqual({ count: 1 });
        f.advance({ ms: 3 * ALERT_EVALUATION_INTERVAL_MS });
        const nextDue = (slot + 4) * ALERT_EVALUATION_INTERVAL_MS;
        let reads = 0;
        const captured: { input: { context: CallContext; limit: 100 }; due: unknown[] }[] = [];
        const sources = async (input: { context: CallContext; limit: 100 }): Promise<Outcome<AlertEvidence>> => {
            reads++;
            captured.push({ input, due: f.native.prepare('SELECT available_at FROM job WHERE available_at>?').all(now) });
            throw new Error('Source unavailable');
        };
        expect(await evaluateAlerts({ ...f, slot, sources })).toMatchObject({ ok: false, error: { code: 'unavailable' } });
        expect(await evaluateAlerts({ ...f, slot, sources })).toMatchObject({ ok: false, error: { code: 'unavailable' } });
        expect(reads).toBe(2);
        expect(captured).toEqual(Array.from({ length: 2 }, () => ({ input: { context, limit: 100 }, due: [{ available_at: nextDue }] })));
        expect(f.native.prepare('SELECT COUNT(*) AS count FROM job').get()).toEqual({ count: 2 });
        expect(f.native.prepare('SELECT context_json FROM job WHERE available_at=?').get(nextDue)).toMatchObject({ context_json: JSON.stringify(context) });
        expect(f.events).toContainEqual({ operation: 'server.alerts.evaluate', outcome: 'unavailable', correlationId: context.correlationId, traceId: context.traceId, runId: context.runId });
    } finally { f.close(); }
});

it('does not read sources when successor enqueue fails, and retries coherently after repair', async () => {
    const f = fixture({});
    try {
        const slot = Math.floor(now / ALERT_EVALUATION_INTERVAL_MS);
        f.native.exec("CREATE TRIGGER fixture_job_failure BEFORE INSERT ON job BEGIN SELECT RAISE(ABORT,'fixture failure'); END;");
        let reads = 0;
        const sources = async (): Promise<Outcome<AlertEvidence>> => { reads++; return { ok: true, value: { ...empty, pendingCards: [{ cardId: 'a', status: 'pending', expiresAt: now + 1 }] } }; };
        expect(await evaluateAlerts({ ...f, slot, sources })).toMatchObject({ ok: false, error: { code: 'unavailable' } });
        expect(reads).toBe(0);
        expect(value({ result: await listAlerts({ ...f, query: { limit: 10 } }) }).items).toEqual([]);
        f.native.exec('DROP TRIGGER fixture_job_failure');
        expect(await evaluateAlerts({ ...f, slot, sources })).toEqual({ ok: true, value: undefined });
        expect(await evaluateAlerts({ ...f, slot, sources })).toEqual({ ok: true, value: undefined });
        expect(reads).toBe(2);
        expect(value({ result: await listAlerts({ ...f, query: { limit: 10 } }) }).items).toHaveLength(1);
    } finally { f.close(); }
});

it('rejects early/malformed evaluation and persists no notices for invalid evidence', async () => {
    const f = fixture({});
    try {
        const slot = Math.floor(now / ALERT_EVALUATION_INTERVAL_MS);
        let reads = 0;
        const sources = async (): Promise<Outcome<AlertEvidence>> => { reads++; return { ok: true, value: empty }; };
        expect(await evaluateAlerts({ ...f, slot: slot + 1, sources })).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
        expect(await evaluateAlerts({ ...f, slot: -1, sources })).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
        expect(reads).toBe(0);
        const oversized: AlertEvidence = { ...empty, pendingCards: Array.from({ length: 101 }, () => ({ cardId: 'a', status: 'pending', expiresAt: now + 1 })) };
        expect(await evaluateAlerts({ ...f, slot, sources: async () => ({ ok: true, value: oversized }) })).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
        expect(value({ result: await listAlerts({ ...f, query: { limit: 10 } }) }).items).toEqual([]);
        const denied = { ok: false as const, error: { code: 'unavailable' as const, message: 'No reporting evidence', retryable: true } };
        expect(await evaluateAlerts({ ...f, slot, sources: async () => denied })).toEqual(denied);
        const brokenUnit: UnitOfWork = { async transaction() { throw new Error('Fixture database unavailable'); } };
        expect(await listAlerts({ ...f, unit: brokenUnit, query: { limit: 10 } })).toMatchObject({ ok: false, error: { code: 'unavailable' } });
    } finally { f.close(); }
});

it('rechecks approval expiry after source I/O rather than using the scheduling instant', async () => {
    const f = fixture({});
    try {
        const slot = Math.floor(now / ALERT_EVALUATION_INTERVAL_MS);
        const sources = async (): Promise<Outcome<AlertEvidence>> => {
            f.advance({ ms: 1000 });
            return { ok: true, value: { ...empty, pendingCards: [{ cardId: 'expires-during-read', status: 'pending', expiresAt: now + 500 }] } };
        };
        expect(await evaluateAlerts({ ...f, slot, sources })).toEqual({ ok: true, value: undefined });
        expect(value({ result: await listAlerts({ ...f, query: { limit: 10 } }) }).items).toEqual([]);
    } finally { f.close(); }
});

it('pages chronologically with reversed UUIDs, equal-time ties and later low-ID inserts', async () => {
    const f = fixture({});
    try {
        const high = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
        const mid = '88888888-8888-4888-8888-888888888888';
        const low = '44444444-4444-4444-8444-444444444444';
        value({ result: await appendAlerts({ ...f, ids: { next: () => high }, candidates: candidates({ cardIds: ['oldest'] }) }) });
        f.advance({ ms: 1 });
        value({ result: await appendAlerts({ ...f, ids: { next: () => mid }, candidates: candidates({ cardIds: ['tie-high'] }) }) });
        value({ result: await appendAlerts({ ...f, ids: { next: () => low }, candidates: candidates({ cardIds: ['tie-low'] }) }) });
        const first = value({ result: await listAlerts({ ...f, query: { limit: 2 } }) });
        expect(first.items.map(item => item.noticeId)).toEqual([high, low]);
        expect(first.items.map(item => item.createdAt)).toEqual([now, now + 1]);
        const second = value({ result: await listAlerts({ ...f, query: { limit: 1, cursor: first.cursor! } }) });
        expect(second.items.map(item => item.noticeId)).toEqual([mid]);
        f.advance({ ms: 1 });
        const later = '00000000-0000-4000-8000-000000000001';
        value({ result: await appendAlerts({ ...f, ids: { next: () => later }, candidates: candidates({ cardIds: ['latest'] }) }) });
        const next = value({ result: await listAlerts({ ...f, query: { limit: 2, cursor: first.cursor! } }) });
        expect(next.items.map(item => item.noticeId)).toEqual([mid, later]);
        const other = { ...context, scope: { ...context.scope, workspaceId: 'other' } };
        expect(value({ result: await listAlerts({ ...f, context: other, query: { limit: 2, cursor: first.cursor! } }) }).items).toEqual([]);
    } finally { f.close(); }
});

it('round-trips composite cursors for maximum-length Unicode notice IDs', async () => {
    const f = fixture({});
    try {
        const noticeId = '😀'.repeat(128);
        value({ result: await appendAlerts({ ...f, ids: { next: () => noticeId }, candidates: candidates({ cardIds: ['unicode'] }) }) });
        f.advance({ ms: 1 });
        value({ result: await appendAlerts({ ...f, candidates: candidates({ cardIds: ['later'] }) }) });
        const first = value({ result: await listAlerts({ ...f, query: { limit: 1 } }) });
        expect(first.items[0]!.noticeId).toBe(noticeId);
        expect(first.cursor!.length).toBeGreaterThan(256);
        const next = value({ result: await listAlerts({ ...f, query: { limit: 1, cursor: first.cursor! } }) });
        expect(next.items[0]!.candidate).toMatchObject({ cardId: 'later' });
        expect(next.cursor).toBeNull();
    } finally { f.close(); }
});

it.each(['not-json', 'e30', '!!!!', 'A', 'x'.repeat(4097),
    Buffer.from(JSON.stringify({ createdAt: -1, noticeId: 'a' })).toString('base64url'),
    Buffer.from(JSON.stringify({ createdAt: now, noticeId: 'a', ownerId: 'other' })).toString('base64url'),
])('rejects malformed composite cursor before SQL: %s', async cursor => {
    let transactions = 0;
    const unit: UnitOfWork = { async transaction() { transactions++; throw new Error('Must not query'); } };
    expect(await listAlerts({ context, unit, query: { limit: 1, cursor } })).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    expect(transactions).toBe(0);
});

it('evaluates through the real worker and retries source failure on the shared worker schedule', async () => {
    const f = fixture({});
    let reads = 0;
    const worker = workers({ fixture: f, sources: async input => {
        expect(input).toEqual({ context, limit: 100 });
        reads++;
        if (reads === 1) return { ok: false, error: { code: 'unavailable', message: 'Fixture gap', retryable: true } };
        return { ok: true, value: { ...empty, pendingCards: [{ cardId: 'worker-card', status: 'pending', expiresAt: now + 10000 }] } };
    } });
    try {
        const slot = Math.floor(now / ALERT_EVALUATION_INTERVAL_MS);
        value({ result: await enqueueAlertEvaluation({ ...f, slot }) });
        expect(await worker.processOne()).toMatchObject({ kind: 'completed', state: 'retry' });
        expect(f.native.prepare("SELECT available_at,attempts FROM job WHERE operation='alerts.evaluate' AND state='retry'").get()).toEqual({ available_at: now + 1000, attempts: 1 });
        f.advance({ ms: 999 });
        expect(await worker.processOne()).toEqual({ kind: 'idle' });
        expect(reads).toBe(1);
        f.advance({ ms: 1 });
        expect(await worker.processOne()).toMatchObject({ kind: 'completed', state: 'succeeded' });
        expect(reads).toBe(2);
        const notices = value({ result: await listAlerts({ ...f, query: { limit: 10 } }) });
        expect(notices.items).toHaveLength(1);
        expect(notices.items[0]!.candidate).toMatchObject({ cardId: 'worker-card' });
        expect(f.native.prepare("SELECT available_at FROM job WHERE state='pending'").all()).toEqual([{ available_at: now + 900000 }]);
    } finally { await worker.stop({}); f.close(); }
});

it.each(['operationId', 'idempotencyKey', 'argumentsDigest', 'slot', 'scope', 'disabled'] as const)(
    'denies forged or disabled evaluation before source I/O: %s', async field => {
        const f = fixture({});
        let reads = 0;
        const sources = async (): Promise<Outcome<AlertEvidence>> => { reads++; return { ok: true, value: empty }; };
        const worker = workers({ fixture: f, ...(field === 'disabled' ? {} : { sources }) });
        try {
            const slot = Math.floor(now / ALERT_EVALUATION_INTERVAL_MS);
            const jobContext = field === 'scope' ? { ...context, scope: { ...context.scope, workspaceId: 'elsewhere' } } : context;
            const job = { ...alertEvaluationJob({ context: jobContext, slot }) };
            if (field === 'slot') job.payload = { slot: slot - 1 };
            if (field === 'operationId' || field === 'idempotencyKey') job[field] = 'forged';
            if (field === 'argumentsDigest') job.argumentsDigest = 'f'.repeat(64);
            const repo = createSqlJobRepo({ database: f.unit, clock: f.clock, ids: f.ids, retryPolicy: formRetryPolicy });
            value({ result: await repo.enqueue({ context: jobContext, job }) });
            expect(await worker.processOne()).toMatchObject({ kind: 'completed', state: 'denied' });
            expect(reads).toBe(0);
            expect(value({ result: await listAlerts({ ...f, query: { limit: 10 } }) }).items).toEqual([]);
            expect(f.native.prepare('SELECT COUNT(*) AS count FROM job').get()).toEqual({ count: 1 });
        } finally { await worker.stop({}); f.close(); }
    });

it('maps invalid source evidence to permanent worker failure without retrying', async () => {
    const f = fixture({});
    const worker = workers({ fixture: f, sources: async () => ({ ok: true, value: { ...empty,
        pendingCards: Array.from({ length: 101 }, () => ({ cardId: 'a', status: 'pending', expiresAt: now + 1 })) } }) });
    try {
        value({ result: await enqueueAlertEvaluation({ ...f, slot: Math.floor(now / ALERT_EVALUATION_INTERVAL_MS) }) });
        expect(await worker.processOne()).toMatchObject({ kind: 'completed', state: 'failed' });
        expect(value({ result: await listAlerts({ ...f, query: { limit: 10 } }) }).items).toEqual([]);
    } finally { await worker.stop({}); f.close(); }
});

it('queues one typed email per scoped notice, binding its definition across replay and restart', async () => {
    const f = fixture({});
    const definitionDigest = ALERT_EMAIL_DEFINITION_DIGEST;
    try {
        value({ result: await appendAlerts({ ...f, candidates: candidates({ cardIds: ['email'] }) }) });
        const noticeId = value({ result: await listAlerts({ ...f, query: { limit: 1 } }) }).items[0]!.noticeId;
        value({ result: await enqueueAlertEmail({ ...f, noticeId, definitionDigest }) });
        expect(await countAddonJobs({ unit: f.unit, observer: f.observer, context, kind: 'agent-plugin', id: 'example-ads' }))
            .toEqual({ ok: true, value: 0 });
        const row = f.native.prepare("SELECT payload FROM job WHERE operation='alerts.email'").get() as { payload: string };
        expect(JSON.parse(row.payload)).toMatchObject({ handler: 'alerts.email', payload: { noticeId, definitionDigest, senderConnectionId: 'sender-a' } });
        f.advance({ ms: 86400000 });
        f.restart();
        value({ result: await enqueueAlertEmail({ ...f, context: { ...context, traceId: 'replay-trace' }, noticeId, definitionDigest }) });
        expect(await enqueueAlertEmail({ ...f, noticeId, definitionDigest: 'b'.repeat(64) })).toMatchObject({ ok: false, error: { code: 'conflict' } });
        expect(f.native.prepare('SELECT COUNT(*) AS count FROM job').get()).toEqual({ count: 1 });
        const other = { ...context, scope: { ...context.scope, workspaceId: 'other' } };
        expect(await enqueueAlertEmail({ ...f, context: other, noticeId, definitionDigest })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
        expect(await enqueueAlertEmail({ ...f, noticeId: 'missing', definitionDigest })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
        expect(await enqueueAlertEmail({ ...f, noticeId, definitionDigest: 'invalid' })).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
        // Email preparation must not prevent the in-app notice from being visible.
        expect(value({ result: await listAlerts({ ...f, query: { limit: 1 } }) }).items[0]!.noticeId).toBe(noticeId);
        const worker = workers({ fixture: f });
        try {
            expect(await dispatchAlertEmail({ ...f, payload: { noticeId, definitionDigest, senderConnectionId: 'sender-a' } })).toEqual({ ok: false,
                errorCode: 'not_implemented', message: 'Alert email sender not bound', retryable: false });
            expect(await worker.processOne()).toMatchObject({ kind: 'completed', state: 'failed' });
            expect(await worker.processOne()).toEqual({ kind: 'idle' });
            expect(f.events).toContainEqual({ operation: 'server.forms.worker', outcome: 'sender_not_bound',
                correlationId: context.correlationId, traceId: context.traceId, runId: context.runId });
            expect(f.native.prepare('SELECT COUNT(*) AS count FROM server_alert_email_reservation').get()).toEqual({ count: 0 });
        }
        finally { await worker.stop({}); }
    } finally { f.close(); }
});

it('validates email dispatch payloads before any SQL or sender use', async () => {
    const unit: UnitOfWork = { async transaction() { throw new Error('Unexpected SQL'); } };
    expect(await dispatchAlertEmail({ context, unit, clock: { now: () => now },
        payload: { noticeId: '', definitionDigest: ALERT_EMAIL_DEFINITION_DIGEST, senderConnectionId: 'sender-a' } }))
        .toMatchObject({ ok: false, errorCode: 'invalid_input' });
});

it.each(['operationId', 'idempotencyKey', 'argumentsDigest', 'noticeId', 'definitionDigest', 'senderConnectionId', 'scope', 'payload'] as const)(
    'denies forged email envelopes before the unbound handler: %s', async field => {
        const f = fixture({});
        const worker = workers({ fixture: f });
        try {
            const jobContext = field === 'scope' ? { ...context, scope: { ...context.scope, workspaceId: 'foreign' } } : context;
            const job = { ...alertEmailJob({ context: jobContext, payload: { noticeId: 'notice', definitionDigest: ALERT_EMAIL_DEFINITION_DIGEST, senderConnectionId: 'sender-a' } }) };
            if (field === 'operationId' || field === 'idempotencyKey') job[field] = 'forged';
            if (field === 'argumentsDigest') job.argumentsDigest = 'f'.repeat(64);
            if (field === 'noticeId') job.payload = { noticeId: 'forged', definitionDigest: ALERT_EMAIL_DEFINITION_DIGEST, senderConnectionId: 'sender-a' };
            if (field === 'definitionDigest') job.payload = { noticeId: 'notice', definitionDigest: 'b'.repeat(64), senderConnectionId: 'sender-a' };
            if (field === 'senderConnectionId') job.payload = { noticeId: 'notice', definitionDigest: ALERT_EMAIL_DEFINITION_DIGEST, senderConnectionId: 'forged' };
            if (field === 'payload') job.payload = { noticeId: 'notice', definitionDigest: 'invalid', senderConnectionId: 'sender-a' };
            const repo = createSqlJobRepo({ database: f.unit, clock: f.clock, ids: f.ids, retryPolicy: formRetryPolicy });
            value({ result: await repo.enqueue({ context: jobContext, job }) });
            expect(await worker.processOne()).toMatchObject({ kind: 'completed', state: 'denied' });
            expect(f.events.some(event => event.outcome === 'sender_not_bound')).toBe(false);
            expect(f.native.prepare('SELECT COUNT(*) AS count FROM server_alert_email_reservation').get()).toEqual({ count: 0 });
        } finally { await worker.stop({}); f.close(); }
    });

it('registers email with forms, evaluation, halt and creative handlers all enabled', async () => {
    const f = fixture({});
    async function unexpectedCreative(): Promise<never> { throw new Error('Unexpected creative call'); }
    const worker = createFormWorkers({ ...f,
        forms: { async accept() { throw new Error('Unexpected forms job'); } },
        alerts: { async sources() { throw new Error('Unexpected evaluation'); } },
        halt: { async dispatch() { throw new Error('Unexpected halt job'); } },
        creative: { async dispatchQueued() { throw new Error('Unexpected creative job'); },
            service: { pollDue: unexpectedCreative, ingestVerifiedCompletion: unexpectedCreative, requestGeneration: unexpectedCreative,
                dispatchGeneration: unexpectedCreative, refreshJob: unexpectedCreative, recover: unexpectedCreative, cancelGeneration: unexpectedCreative } },
        schedule() { throw new Error('Unexpected worker scheduling'); },
    });
    try {
        const repo = createSqlJobRepo({ database: f.unit, clock: f.clock, ids: f.ids, retryPolicy: formRetryPolicy });
        value({ result: await repo.enqueue({ context, job: alertEmailJob({ context, payload: { noticeId: 'notice', definitionDigest: ALERT_EMAIL_DEFINITION_DIGEST, senderConnectionId: 'sender-a' } }) }) });
        expect(await worker.processOne()).toMatchObject({ kind: 'completed', state: 'failed' });
        expect(f.events.some(event => event.outcome === 'sender_not_bound')).toBe(true);
        expect(f.native.prepare('SELECT COUNT(*) AS count FROM server_alert_email_reservation').get()).toEqual({ count: 0 });
    } finally { await worker.stop({}); f.close(); }
});

it('sends the selected plugin/connection with validated addresses and the durable job idempotency key', async () => {
    const f = fixture({});
    const mail = mailFixture({ fixture: f });
    try {
        value({ result: await appendAlerts({ ...f, candidates: candidates({ cardIds: ['selected-mail'] }) }) });
        const noticeId = value({ result: await listAlerts({ ...f, query: { limit: 1 } }) }).items[0]!.noticeId;
        const payload = { noticeId, definitionDigest: ALERT_EMAIL_DEFINITION_DIGEST, senderConnectionId: f.senderConnectionId };
        expect(await dispatchAlertEmail({ ...f, payload, alertEmail: mail.alertEmail })).toMatchObject({ ok: true });
        expect(mail.sent).toHaveLength(1);
        expect(mail.sent[0]).toMatchObject({ context, pluginId: 'example-mail', connectionId: 'sender-a',
            idempotencyKey: alertEmailJob({ context, payload }).idempotencyKey,
            message: { workspaceId: context.scope.workspaceId, from: { email: 'alerts@example.test' }, to: { email: 'owner@example.test' },
                subject: 'Open Marketing alert: approval_waiting', text: 'An approval is waiting. Open Open Marketing to review.' } });
        expect(f.native.prepare('SELECT COUNT(*) AS count FROM server_alert_email_reservation').get()).toEqual({ count: 1 });
    } finally { f.close(); }
});

it('binds boot alert mail to the backend with the resolved sender, owner From and durable key', async () => {
    const f = fixture({});
    const mail = mailFixture({ fixture: f });
    const calls: Parameters<MailBackends['mail']>[0][] = [];
    const pluginBackends = { async mail(input: Parameters<MailBackends['mail']>[0]) {
        calls.push(input);
        expect(await input.request.reserve()).toEqual({ ok: true, value: 'reserved' });
        return { ok: true, providerMessageId: 'boot-delivery', acceptedAt: new Date(now).toISOString() };
    } } as MailBackends;
    const addons = { addons: {}, agentPluginState: mail.alertEmail.agentPluginState } as Parameters<typeof bootOwnerSettings>[0]['addons'];
    const { alertEmail } = bootOwnerSettings({ addons, unit: f.unit, timezone: 'UTC', ownerEmail: 'owner@example.test', pluginBackends });
    try {
        mail.select({ selected: 'example-mail', alertFrom: 'owner-from@example.test' });
        value({ result: await appendAlerts({ ...f, candidates: candidates({ cardIds: ['boot-mail'] }) }) });
        const noticeId = value({ result: await listAlerts({ ...f, query: { limit: 1 } }) }).items[0]!.noticeId;
        const payload = { noticeId, definitionDigest: ALERT_EMAIL_DEFINITION_DIGEST, senderConnectionId: f.senderConnectionId };
        expect(await dispatchAlertEmail({ ...f, payload, alertEmail })).toMatchObject({ ok: true, providerMessageId: 'boot-delivery' });
        expect(calls).toEqual([{ context, pluginId: 'example-mail', request: { connectionId: 'sender-a',
            idempotencyKey: alertEmailJob({ context, payload }).idempotencyKey, reserve: expect.any(Function),
            message: { workspaceId: context.scope.workspaceId, from: { email: 'owner-from@example.test' }, to: { email: 'owner@example.test' },
                subject: 'Open Marketing alert: approval_waiting', text: 'An approval is waiting. Open Open Marketing to review.' } } }]);
        expect(f.native.prepare('SELECT COUNT(*) AS count FROM server_alert_email_reservation').get()).toEqual({ count: 1 });
    } finally { f.close(); }
});

it.each(['selection removed', 'connection ambiguous'] as const)('refuses boot mail when %s before reserve without consuming quota', async scenario => {
    const f = fixture({});
    const mail = mailFixture({ fixture: f });
    const reservations: Awaited<ReturnType<Parameters<AlertMailPort['send']>[0]['reserve']>>[] = [];
    let changeSender = true;
    const pluginBackends = { async mail(input: Parameters<MailBackends['mail']>[0]) {
        if (changeSender) {
            if (scenario === 'selection removed') mail.select({ selected: null });
            else mail.connect({ connectionId: 'sender-b' });
        }
        const reserved = await input.request.reserve();
        reservations.push(reserved);
        if (!reserved.ok) return { ok: false, retryable: false, errorCode: reserved.error.code, message: reserved.error.message };
        return { ok: true, providerMessageId: 'boot-delivery', acceptedAt: new Date(now).toISOString() };
    } } as MailBackends;
    const addons = { addons: {}, agentPluginState: mail.alertEmail.agentPluginState } as Parameters<typeof bootOwnerSettings>[0]['addons'];
    const { alertEmail } = bootOwnerSettings({ addons, unit: f.unit, timezone: 'UTC', ownerEmail: 'owner@example.test', pluginBackends });
    try {
        value({ result: await appendAlerts({ ...f, candidates: candidates({ cardIds: ['changed-sender'] }) }) });
        const noticeId = value({ result: await listAlerts({ ...f, query: { limit: 1 } }) }).items[0]!.noticeId;
        const payload = { noticeId, definitionDigest: ALERT_EMAIL_DEFINITION_DIGEST, senderConnectionId: f.senderConnectionId };
        expect(await dispatchAlertEmail({ ...f, payload, alertEmail })).toEqual({ ok: false, retryable: false, errorCode: 'forbidden', message: 'Alert sender changed' });
        expect(reservations).toEqual([{ ok: false, error: { code: 'forbidden', message: 'Alert sender changed', retryable: false } }]);
        expect(f.native.prepare('SELECT COUNT(*) AS count FROM server_alert_email_reservation').get()).toEqual({ count: 0 });
        changeSender = false;
        mail.select({ selected: 'example-mail' });
        f.native.prepare("UPDATE om_credential_connection SET status='revoked' WHERE connection_id='sender-b'").run();
        expect(await dispatchAlertEmail({ ...f, payload, alertEmail })).toMatchObject({ ok: true });
        expect(reservations[1]).toEqual({ ok: true, value: 'reserved' });
    } finally { f.close(); }
});

it('preserves sender_not_bound and leaves the notice reservable when boot has no backends', async () => {
    const f = fixture({});
    const mail = mailFixture({ fixture: f });
    const addons = { addons: {}, agentPluginState: mail.alertEmail.agentPluginState } as Parameters<typeof bootOwnerSettings>[0]['addons'];
    const { alertEmail } = bootOwnerSettings({ addons, unit: f.unit, timezone: 'UTC', ownerEmail: 'owner@example.test' });
    try {
        value({ result: await appendAlerts({ ...f, candidates: candidates({ cardIds: ['no-backends'] }) }) });
        const noticeId = value({ result: await listAlerts({ ...f, query: { limit: 1 } }) }).items[0]!.noticeId;
        const payload = { noticeId, definitionDigest: ALERT_EMAIL_DEFINITION_DIGEST, senderConnectionId: f.senderConnectionId };
        expect(await dispatchAlertEmail({ ...f, payload, alertEmail })).toEqual({ ok: false, retryable: false, errorCode: 'not_implemented', message: 'Alert email sender not bound' });
        expect(await reserveAlertEmail({ ...f, noticeId })).toEqual({ ok: true, value: 'reserved' });
    } finally { f.close(); }
});

it.each(['unselected', 'unconnected', 'two-connections', 'disabled', 'unadmitted', 'mismatched-connection'] as const)(
    'refuses %s without calling mail or reserving quota', async mode => {
        const f = fixture({});
        const mail = mailFixture({ fixture: f });
        try {
            if (mode === 'unselected') mail.select({ selected: null });
            if (mode === 'unconnected') f.native.prepare("UPDATE om_credential_connection SET status='reconnect_required'").run();
            if (mode === 'two-connections') mail.connect({ connectionId: 'sender-b' });
            if (mode === 'disabled') mail.state.enabled = false;
            if (mode === 'unadmitted') mail.state.admitted = false;
            const payload = { noticeId: 'notice', definitionDigest: ALERT_EMAIL_DEFINITION_DIGEST,
                senderConnectionId: mode === 'mismatched-connection' ? 'old-sender' : f.senderConnectionId };
            const worker = createFormWorkers({ ...f, alertEmail: mail.alertEmail, forms: { async accept() { throw new Error('Unexpected forms'); } },
                schedule() { throw new Error('Unexpected scheduling'); } });
            try {
                const repo = createSqlJobRepo({ database: f.unit, clock: f.clock, ids: f.ids, retryPolicy: formRetryPolicy });
                value({ result: await repo.enqueue({ context, job: alertEmailJob({ context, payload }) }) });
                expect(await worker.processOne()).toMatchObject({ kind: 'completed', state: 'failed' });
                expect(f.events).toContainEqual(expect.objectContaining({ operation: 'server.forms.worker', outcome: 'sender_not_bound' }));
            } finally { await worker.stop({}); }
            expect(mail.calls).toHaveLength(0);
            expect(f.native.prepare('SELECT COUNT(*) AS count FROM server_alert_email_reservation').get()).toEqual({ count: 0 });
        } finally { f.close(); }
    });

it.each(['missing-from', 'invalid-from', 'missing-owner', 'invalid-owner'] as const)(
    'rejects %s before notice lookup or mail send', async mode => {
        const f = fixture({});
        const mail = mailFixture({ fixture: f });
        try {
            if (mode === 'missing-from') mail.state.metadata.alertFrom = undefined;
            if (mode === 'invalid-from') mail.state.metadata.alertFrom = 'synthetic-secret\r\nBcc: someone@example.test';
            if (mode === 'missing-owner') delete mail.alertEmail.ownerEmail;
            if (mode === 'invalid-owner') mail.alertEmail.ownerEmail = 'invalid-owner';
            // There is deliberately no notice: an address failure must win over the missing notice.
            const result = await dispatchAlertEmail({ ...f, alertEmail: mail.alertEmail,
                payload: { noticeId: 'absent', definitionDigest: ALERT_EMAIL_DEFINITION_DIGEST, senderConnectionId: f.senderConnectionId } });
            expect(result).toMatchObject({ ok: false, errorCode: 'invalid_input' });
            expect(JSON.stringify(result)).not.toContain('synthetic-secret');
            expect(mail.calls).toHaveLength(0);
            expect(f.native.prepare('SELECT COUNT(*) AS count FROM server_alert_email_reservation').get()).toEqual({ count: 0 });
        } finally { f.close(); }
    });

it('re-queues under a new connection, dedupes the same connection, and never sends a reserved notice twice', async () => {
    const f = fixture({});
    const mail = mailFixture({ fixture: f });
    try {
        value({ result: await appendAlerts({ ...f, candidates: candidates({ cardIds: ['rebind'] }) }) });
        const noticeId = value({ result: await listAlerts({ ...f, query: { limit: 1 } }) }).items[0]!.noticeId;
        const definitionDigest = ALERT_EMAIL_DEFINITION_DIGEST;
        value({ result: await enqueueAlertEmail({ ...f, noticeId, definitionDigest }) });
        value({ result: await reserveAlertEmail({ ...f, noticeId }) });
        f.native.prepare("UPDATE om_credential_connection SET status='revoked'").run();
        mail.connect({ connectionId: 'sender-b' });
        value({ result: await enqueueAlertEmail({ ...f, noticeId, definitionDigest, senderConnectionId: 'sender-b' }) });
        value({ result: await enqueueAlertEmail({ ...f, noticeId, definitionDigest, senderConnectionId: 'sender-b' }) });
        expect(f.native.prepare("SELECT COUNT(*) AS count FROM job WHERE operation='alerts.email'").get()).toEqual({ count: 2 });
        const a = alertEmailJob({ context, payload: { noticeId, definitionDigest, senderConnectionId: 'sender-a' } });
        const b = alertEmailJob({ context, payload: { noticeId, definitionDigest, senderConnectionId: 'sender-b' } });
        expect(a.idempotencyKey).not.toBe(b.idempotencyKey);
        expect(a.argumentsDigest).not.toBe(b.argumentsDigest);
        expect(await dispatchAlertEmail({ ...f, payload: { noticeId, definitionDigest, senderConnectionId: 'sender-b' }, alertEmail: mail.alertEmail }))
            .toMatchObject({ ok: false, errorCode: 'reservation_refused' });
        expect(mail.calls).toHaveLength(1);
        expect(mail.sent).toHaveLength(0);
        expect(await reserveAlertEmail({ ...f, noticeId })).toEqual({ ok: true, value: 'existing' });
    } finally { f.close(); }
});

it('re-queues an unbound failed delivery after binding without duplicating the same connection', async () => {
    const f = fixture({});
    const mail = mailFixture({ fixture: f });
    try {
        value({ result: await appendAlerts({ ...f, candidates: candidates({ cardIds: ['bind-later'] }) }) });
        const noticeId = value({ result: await listAlerts({ ...f, query: { limit: 1 } }) }).items[0]!.noticeId;
        const definitionDigest = ALERT_EMAIL_DEFINITION_DIGEST;
        const worker = createFormWorkers({ ...f, alertEmail: mail.alertEmail, forms: { async accept() { throw new Error('Unexpected forms'); } },
            schedule() { throw new Error('Unexpected schedule'); } });
        try {
            mail.select({ selected: null });
            value({ result: await enqueueAlertEmail({ ...f, noticeId, definitionDigest, senderConnectionId: 'unbound-connection' }) });
            expect(await worker.processOne()).toMatchObject({ kind: 'completed', state: 'failed' });
            mail.select({ selected: 'example-mail' });
            value({ result: await enqueueAlertEmail({ ...f, noticeId, definitionDigest }) });
            value({ result: await enqueueAlertEmail({ ...f, noticeId, definitionDigest }) });
            expect(await worker.processOne()).toMatchObject({ kind: 'completed', state: 'succeeded' });
            expect(await worker.processOne()).toEqual({ kind: 'idle' });
            expect(mail.sent).toHaveLength(1);
            expect(f.events.some(event => event.outcome === 'sender_not_bound')).toBe(true);
        } finally { await worker.stop({}); }
    } finally { f.close(); }
});

it('sends only fixed per-kind content and validates the definition and scoped notice before mail', async () => {
    const f = fixture({});
    const mail = mailFixture({ fixture: f });
    const campaign = { pluginId: 'example-ads', accountId: 'account', vendorCampaignId: 'synthetic-secret' };
    try {
        value({ result: await appendAlerts({ ...f, candidates: [
            { kind: 'ad_disapproved', dedupKey: 'disapproved', campaign, reasons: ['synthetic-secret'] },
            { kind: 'pacing', dedupKey: 'pacing', campaign, localDay: '2026-10-03', rules: ['today'] },
        ] }) });
        const notices = value({ result: await listAlerts({ ...f, query: { limit: 10 } }) }).items;
        for (const notice of notices) {
            const payload = { noticeId: notice.noticeId, definitionDigest: ALERT_EMAIL_DEFINITION_DIGEST, senderConnectionId: f.senderConnectionId };
            expect(await dispatchAlertEmail({ ...f, payload, alertEmail: mail.alertEmail })).toMatchObject({ ok: true });
        }
        expect(mail.sent.map(call => call.message)).toMatchObject([
            { subject: 'Open Marketing alert: ad_disapproved', text: 'An ad was disapproved. Open Open Marketing to review.' },
            { subject: 'Open Marketing alert: pacing', text: 'Campaign spending needs review. Open Open Marketing to review.' },
        ]);
        expect(JSON.stringify(mail.sent.map(call => call.message))).not.toContain('synthetic-secret');
        const payload = { noticeId: notices[0]!.noticeId, definitionDigest: ALERT_EMAIL_DEFINITION_DIGEST, senderConnectionId: f.senderConnectionId };
        expect(await dispatchAlertEmail({ ...f, payload: { ...payload, definitionDigest: 'f'.repeat(64) }, alertEmail: mail.alertEmail })).toMatchObject({ ok: false, errorCode: 'invalid_input' });
        expect(await dispatchAlertEmail({ ...f, payload: { ...payload, noticeId: 'missing' }, alertEmail: mail.alertEmail })).toMatchObject({ ok: false, errorCode: 'forbidden' });
        const foreign = { ...context, scope: { ...context.scope, workspaceId: 'elsewhere' } };
        f.native.prepare("INSERT INTO om_owner_settings VALUES ('owner','elsewhere','mail.provider','\"example-mail\"')").run();
        f.native.prepare(`INSERT INTO om_credential_connection(owner_id,workspace_id,connection_id,plugin_id,status,version,ciphertext,aad_digest)
            VALUES ('owner','elsewhere','sender-a','example-mail','connected',1,'sealed-fixture','digest')`).run();
        expect(await dispatchAlertEmail({ ...f, context: foreign, payload, alertEmail: mail.alertEmail })).toMatchObject({ ok: false, errorCode: 'forbidden' });
        expect(mail.calls).toHaveLength(2);
    } finally { f.close(); }
});

it('atomically enqueues only newly inserted notices when a sender is supplied, with no backfill', async () => {
    const f = fixture({});
    try {
        const a = candidates({ cardIds: ['in-app-only'] });
        value({ result: await appendAlerts({ ...f, candidates: a }) });
        expect(f.native.prepare('SELECT COUNT(*) AS count FROM job').get()).toEqual({ count: 0 });
        expect(await appendAlerts({ ...f, candidates: a }, { email: { senderConnectionId: f.senderConnectionId } })).toEqual({ ok: true, value: 0 });
        expect(f.native.prepare('SELECT COUNT(*) AS count FROM job').get()).toEqual({ count: 0 });
        const batch = [...a, ...candidates({ cardIds: ['bound-one', 'bound-two'] })];
        expect(await appendAlerts({ ...f, candidates: batch }, { email: { senderConnectionId: f.senderConnectionId } })).toEqual({ ok: true, value: 2 });
        expect(await appendAlerts({ ...f, candidates: batch }, { email: { senderConnectionId: f.senderConnectionId } })).toEqual({ ok: true, value: 0 });
        const jobs = f.native.prepare("SELECT payload FROM job WHERE operation='alerts.email' ORDER BY id").all() as { payload: string }[];
        expect(jobs).toHaveLength(2);
        for (const row of jobs) expect(JSON.parse(row.payload)).toMatchObject({ payload: { senderConnectionId: 'sender-a', definitionDigest: ALERT_EMAIL_DEFINITION_DIGEST } });
        expect(f.native.prepare('SELECT COUNT(*) AS count FROM server_alert_notice').get()).toEqual({ count: 3 });
    } finally { f.close(); }
});

it('rolls back notices AND earlier email intents when a later enqueue returns a failed Outcome', async () => {
    const f = fixture({});
    try {
        f.native.exec(`CREATE TRIGGER fixture_second_email_failure BEFORE INSERT ON job
            WHEN (SELECT COUNT(*) FROM job WHERE operation='alerts.email')=1 BEGIN SELECT RAISE(ABORT,'fixture failure'); END;`);
        const batch = candidates({ cardIds: ['first', 'second'] });
        expect(await appendAlerts({ ...f, candidates: batch }, { email: { senderConnectionId: f.senderConnectionId } }))
            .toMatchObject({ ok: false, error: { code: 'unavailable' } });
        expect(f.native.prepare('SELECT COUNT(*) AS count FROM server_alert_notice').get()).toEqual({ count: 0 });
        expect(f.native.prepare('SELECT COUNT(*) AS count FROM job').get()).toEqual({ count: 0 });
        f.native.exec('DROP TRIGGER fixture_second_email_failure');
        expect(await appendAlerts({ ...f, candidates: batch }, { email: { senderConnectionId: f.senderConnectionId } })).toEqual({ ok: true, value: 2 });
        expect(f.native.prepare('SELECT COUNT(*) AS count FROM job').get()).toEqual({ count: 2 });
    } finally { f.close(); }
});

it.each(['bound', 'unselected', 'unconnected'] as const)('evaluation queues email only while %s', async mode => {
    const f = fixture({});
    const mail = mailFixture({ fixture: f });
    mail.select({ selected: 'example-mail', alertFrom: 'owner-from@example.test' });
    if (mode === 'unselected') mail.select({ selected: null });
    if (mode === 'unconnected') f.native.prepare("UPDATE om_credential_connection SET status='reconnect_required'").run();
    const worker = createFormWorkers({ ...f, alertEmail: mail.alertEmail, forms: { async accept() { throw new Error('Unexpected forms'); } },
        alerts: { async sources() { return { ok: true, value: { ...empty, pendingCards: [{ cardId: 'evaluated', status: 'pending', expiresAt: now + 1000 }] } }; } },
        schedule() { throw new Error('Unexpected scheduling'); } });
    try {
        value({ result: await enqueueAlertEvaluation({ ...f, slot: Math.floor(now / ALERT_EVALUATION_INTERVAL_MS) }) });
        expect(await worker.processOne()).toMatchObject({ kind: 'completed', state: 'succeeded' });
        expect(f.native.prepare('SELECT COUNT(*) AS count FROM server_alert_notice').get()).toEqual({ count: 1 });
        expect(f.native.prepare("SELECT COUNT(*) AS count FROM job WHERE operation='alerts.email'").get()).toEqual({ count: mode === 'bound' ? 1 : 0 });
        if (mode === 'bound') {
            expect(await worker.processOne()).toMatchObject({ kind: 'completed', state: 'succeeded' });
            expect(mail.sent).toHaveLength(1);
            expect(mail.sent[0]!.message.from.email).toBe('owner-from@example.test');
        } else {
            expect(await worker.processOne()).toEqual({ kind: 'idle' });
            expect(mail.calls).toHaveLength(0);
        }
    } finally { await worker.stop({}); f.close(); }
});

it.each(['failure', 'unknown', 'thrown'] as const)('classifies %s mail outcomes without persisting provider error secrets', async mode => {
    const f = fixture({});
    const mail = mailFixture({ fixture: f });
    const guarded = mail.alertEmail.mail;
    mail.alertEmail.mail = { async send(input) {
        const result = await guarded.send(input);
        if (!result.ok) return result;
        if (mode === 'thrown') throw new Error('synthetic-secret');
        return { ok: false, retryable: true, errorCode: 'synthetic-secret', message: 'synthetic-secret', ...(mode === 'unknown' ? { unknown: true } : {}) };
    } };
    const worker = createFormWorkers({ ...f, alertEmail: mail.alertEmail, forms: { async accept() { throw new Error('Unexpected forms'); } },
        schedule() { throw new Error('Unexpected schedule'); } });
    try {
        value({ result: await appendAlerts({ ...f, candidates: candidates({ cardIds: ['failure-mode'] }) }, { email: { senderConnectionId: f.senderConnectionId } }) });
        expect(await worker.processOne()).toMatchObject({ kind: 'completed', state: mode === 'failure' ? 'failed' : 'reconcile' });
        expect(await worker.processOne()).toEqual({ kind: 'idle' });
        expect(mail.sent).toHaveLength(1);
        expect(f.native.prepare('SELECT COUNT(*) AS count FROM server_alert_email_reservation').get()).toEqual({ count: 1 });
        expect(JSON.stringify(f.events)).not.toContain('synthetic-secret');
        expect(JSON.stringify(f.native.prepare('SELECT * FROM job').all())).not.toContain('synthetic-secret');
        expect(JSON.stringify(f.native.prepare('SELECT * FROM job_attempt').all())).not.toContain('synthetic-secret');
        expect(f.events).toContainEqual(expect.objectContaining({ operation: 'server.forms.worker', outcome: mode === 'thrown' ? 'email_unknown' : 'email_failed' }));
    } finally { await worker.stop({}); f.close(); }
});

it('admits an arbitrary valid stop plugin ID through worker decode and reaches halt.dispatch', async () => {
    const f = fixture({});
    const payload = { pluginId: 'example-ads', request: { operationId: 'stop-operation', scope: context.scope, connectionId: 'connection',
        adAccountId: 'account', entityIds: ['campaign'], action: 'pause' as const, haltId: 'halt', haltEpoch: 1,
        pluginDigest: 'a'.repeat(64), bindingId: 'example.stop.v1', argumentsDigest: 'b'.repeat(64) } };
    const calls: unknown[] = [];
    const worker = createFormWorkers({ ...f, forms: { async accept() { throw new Error('Unexpected forms'); } },
        halt: { async dispatch(input) { calls.push(input); return { ok: true, value: { status: 'stopped' } }; } },
        schedule() { throw new Error('Unexpected schedule'); } });
    try {
        const repo = createSqlJobRepo({ database: f.unit, clock: f.clock, ids: f.ids, retryPolicy: formRetryPolicy });
        value({ result: await repo.enqueue({ context, job: { handler: 'agent-plugin.halt-stop', operationId: 'stop-operation',
            idempotencyKey: 'halt-stop:stop-operation', argumentsDigest: value({ result: digestArguments({ arguments: payload }) }), payload } }) });
        expect(await worker.processOne()).toMatchObject({ kind: 'completed', state: 'succeeded' });
        expect(calls).toEqual([{ context, payload }]);
    } finally { await worker.stop({}); f.close(); }
});

it.each([
    { timezone: 'America/Los_Angeles', start: '2026-10-03T23:59:59Z', sameDay: ['2026-10-04T00:00:00Z'], midnight: '2026-10-04T07:00:00Z' },
    { timezone: 'Asia/Taipei', start: '2026-10-03T15:00:00Z', sameDay: ['2026-10-03T15:59:59Z'], midnight: '2026-10-03T16:00:00Z' },
    { timezone: 'America/Los_Angeles', start: '2026-03-08T08:00:00Z', sameDay: ['2026-03-08T10:00:00Z', '2026-03-09T00:00:00Z'], midnight: '2026-03-09T07:00:00Z' },
    { timezone: 'America/Los_Angeles', start: '2026-11-01T07:00:00Z', sameDay: ['2026-11-01T09:00:00Z', '2026-11-02T00:00:00Z'], midnight: '2026-11-02T08:00:00Z' },
])('resets the owner cap only at local midnight: $timezone / $start', async ({ timezone, start, sameDay, midnight }) => {
    const f = fixture({});
    try {
        value({ result: await appendAlerts({ ...f, candidates: candidates({ cardIds: Array.from({ length: 21 }, (_, i) => 'calendar' + i) }) }) });
        const notices = value({ result: await listAlerts({ ...f, query: { limit: 100 } }) }).items;
        f.advance({ ms: Date.parse(start) - f.clock.now() });
        for (const notice of notices.slice(0, 20)) value({ result: await reserveAlertEmail({ ...f, timezone, noticeId: notice.noticeId }) });
        const blocked = notices[20]!.noticeId;
        for (const instant of sameDay) {
            f.advance({ ms: Date.parse(instant) - f.clock.now() });
            expect(await reserveAlertEmail({ ...f, timezone, noticeId: blocked })).toMatchObject({ ok: false, error: { code: 'limit_exceeded' } });
        }
        f.advance({ ms: Date.parse(midnight) - 1 - f.clock.now() });
        expect(await reserveAlertEmail({ ...f, timezone, noticeId: blocked })).toMatchObject({ ok: false, error: { code: 'limit_exceeded' } });
        f.advance({ ms: 1 });
        expect(await reserveAlertEmail({ ...f, timezone, noticeId: blocked })).toEqual({ ok: true, value: 'reserved' });
        expect(await reserveAlertEmail({ ...f, timezone, noticeId: notices[0]!.noticeId })).toEqual({ ok: true, value: 'existing' });
        expect(f.native.prepare('SELECT COUNT(*) AS count,COUNT(DISTINCT local_day) AS days FROM server_alert_email_reservation').get()).toEqual({ count: 21, days: 2 });
    } finally { f.close(); }
});

it.each(['', 'Invalid/Timezone', 'x'.repeat(101)])('rejects an invalid reservation timezone before SQL: %s', async timezone => {
    let transactions = 0;
    const unit: UnitOfWork = { async transaction() { transactions++; throw new Error('Must not query'); } };
    expect(await reserveAlertEmail({ context, noticeId: 'notice', unit, timezone, clock: { now: () => now } }))
        .toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    expect(transactions).toBe(0);
});

it('caps new email attempts at 20 per owner across workspaces and retains reservations on replay/restart', async () => {
    const f = fixture({});
    const other = { ...context, scope: { ...context.scope, workspaceId: 'other' } };
    try {
        value({ result: await appendAlerts({ ...f, candidates: candidates({ cardIds: Array.from({ length: 11 }, (_, i) => 'a' + i) }) }) });
        value({ result: await appendAlerts({ ...f, context: other, candidates: candidates({ cardIds: Array.from({ length: 10 }, (_, i) => 'b' + i) }) }) });
        const a = value({ result: await listAlerts({ ...f, query: { limit: 100 } }) }).items;
        const b = value({ result: await listAlerts({ ...f, context: other, query: { limit: 100 } }) }).items;
        for (const notice of a) expect(await reserveAlertEmail({ ...f, noticeId: notice.noticeId })).toEqual({ ok: true, value: 'reserved' });
        for (const notice of b.slice(0, 9)) expect(await reserveAlertEmail({ ...f, context: other, noticeId: notice.noticeId })).toEqual({ ok: true, value: 'reserved' });
        const blocked = b[9]!.noticeId;
        expect(await reserveAlertEmail({ ...f, context: other, noticeId: blocked })).toMatchObject({ ok: false, error: { code: 'limit_exceeded' } });
        f.restart();
        expect(await reserveAlertEmail({ ...f, noticeId: a[0]!.noticeId })).toEqual({ ok: true, value: 'existing' });
        expect(await reserveAlertEmail({ ...f, context: other, noticeId: blocked })).toMatchObject({ ok: false, error: { code: 'limit_exceeded' } });
        const anotherOwner: CallContext = { ...context, scope: { ownerId: 'second-owner', workspaceId: 'workspace' }, principal: { kind: 'owner', ownerId: 'second-owner' } };
        value({ result: await appendAlerts({ ...f, context: anotherOwner, candidates: candidates({ cardIds: ['independent'] }) }) });
        const separate = value({ result: await listAlerts({ ...f, context: anotherOwner, query: { limit: 1 } }) }).items[0]!.noticeId;
        expect(await reserveAlertEmail({ ...f, context: anotherOwner, noticeId: separate })).toEqual({ ok: true, value: 'reserved' });
        f.advance({ ms: 86400000 });
        expect(await reserveAlertEmail({ ...f, noticeId: a[0]!.noticeId })).toEqual({ ok: true, value: 'existing' });
        expect(await reserveAlertEmail({ ...f, context: other, noticeId: blocked })).toEqual({ ok: true, value: 'reserved' });
        expect(f.native.prepare('SELECT COUNT(*) AS count FROM server_alert_email_reservation').get()).toEqual({ count: 22 });
        expect(() => f.native.prepare('DELETE FROM server_alert_email_reservation').run()).toThrow('append-only');
        expect(() => f.native.prepare('UPDATE server_alert_email_reservation SET daily_slot=1').run()).toThrow('append-only');
    } finally { f.close(); }
});

it('allows only one competing reservation for the last daily slot across database connections', async () => {
    const f = fixture({});
    const peer = f.peer();
    try {
        value({ result: await appendAlerts({ ...f, candidates: candidates({ cardIds: Array.from({ length: 21 }, (_, i) => 'race' + i) }) }) });
        const notices = value({ result: await listAlerts({ ...f, query: { limit: 100 } }) }).items;
        for (const notice of notices.slice(0, 19)) value({ result: await reserveAlertEmail({ ...f, noticeId: notice.noticeId }) });
        const results = await Promise.all([
            reserveAlertEmail({ ...f, noticeId: notices[19]!.noticeId }),
            reserveAlertEmail({ ...f, unit: peer.unit, noticeId: notices[20]!.noticeId }),
        ]);
        expect(results.filter(result => result.ok && result.value === 'reserved')).toHaveLength(1);
        expect(results.filter(result => !result.ok)).toHaveLength(1);
        expect(f.native.prepare('SELECT COUNT(*) AS count,MAX(daily_slot) AS last FROM server_alert_email_reservation').get()).toEqual({ count: 20, last: 20 });
        for (const notice of notices.slice(19)) {
            const retry = await reserveAlertEmail({ ...f, noticeId: notice.noticeId });
            expect(retry).not.toEqual({ ok: true, value: 'reserved' });
        }
    } finally { peer.close(); f.close(); }
});

it('denies email preparation on storage failure, malformed input or a notice outside scope', async () => {
    const f = fixture({});
    try {
        value({ result: await appendAlerts({ ...f, candidates: candidates({ cardIds: ['failure'] }) }) });
        const noticeId = value({ result: await listAlerts({ ...f, query: { limit: 1 } }) }).items[0]!.noticeId;
        const definitionDigest = ALERT_EMAIL_DEFINITION_DIGEST;
        const other = { ...context, scope: { ...context.scope, workspaceId: 'other' } };
        expect(await reserveAlertEmail({ ...f, context: other, noticeId })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
        expect(await reserveAlertEmail({ ...f, noticeId: '' })).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
        f.native.exec("CREATE TRIGGER fixture_reservation_failure BEFORE INSERT ON server_alert_email_reservation BEGIN SELECT RAISE(ABORT,'fixture failure'); END;");
        expect(await reserveAlertEmail({ ...f, noticeId })).toMatchObject({ ok: false, error: { code: 'unavailable' } });
        expect(f.native.prepare('SELECT COUNT(*) AS count FROM server_alert_email_reservation').get()).toEqual({ count: 0 });
        f.native.exec('DROP TRIGGER fixture_reservation_failure');
        expect(await reserveAlertEmail({ ...f, noticeId })).toEqual({ ok: true, value: 'reserved' });
        f.native.exec("CREATE TRIGGER fixture_email_failure BEFORE INSERT ON job BEGIN SELECT RAISE(ABORT,'fixture failure'); END;");
        expect(await enqueueAlertEmail({ ...f, noticeId, definitionDigest })).toMatchObject({ ok: false, error: { code: 'unavailable' } });
        expect(f.native.prepare('SELECT COUNT(*) AS count FROM job').get()).toEqual({ count: 0 });
        f.native.exec('DROP TRIGGER fixture_email_failure');
        expect(await enqueueAlertEmail({ ...f, noticeId, definitionDigest })).toEqual({ ok: true, value: undefined });
    } finally { f.close(); }
});

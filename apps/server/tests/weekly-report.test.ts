/** Written-only weekly report regressions; no vendor calls or product databases. */
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { deriveMetricRatios, metricBatchSchema } from '@open-marketing/contracts';
import type { CallContext, Outcome } from '@open-marketing/contracts';
import { campaignResults, campaignResultsSchema, createSqlMetricsRepo, syncMetrics, type CampaignResults } from '@open-marketing/measure';
import { weeklyReportCandidate, weeklyReportSchema, alertCandidateSchema } from '../src/alerts/rules.js';
import { weeklyReportSlot, weeklyReportDays, weeklyReportJob, enqueueWeeklyReport, generateWeeklyReport,
    listAlerts, dispatchAlertEmail, ALERT_EMAIL_DEFINITION_DIGEST, type AlertEmailDependencies } from '../src/alerts/index.js';
import { bindServerDatabase } from '../src/composition/database.js';
import { countAddonJobs } from '../src/composition/agent-plugin-backends.js';
import { createFormWorkers } from '../src/composition/workers.js';
import { bindReporting } from '../src/composition/reporting.js';

const context: CallContext = { scope: { ownerId: 'owner', workspaceId: 'workspace' }, principal: { kind: 'owner', ownerId: 'owner' },
    correlationId: 'weekly-correlation', traceId: 'weekly-trace', runId: 'weekly-run' };
const now = Date.parse('2026-10-27T00:00:00Z');
const target = { pluginId: 'fixture-ads', connectionId: 'connection', accountId: 'account' };
const days = { start: '2026-10-19', end: '2026-10-26' };
const clock = { now: () => now };
function value<T>({ result }: { result: Outcome<T> }): T {
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.code);
    return result.value;
}
function row(required: { id: string; spend?: string | null }): CampaignResults['campaigns'][number] {
    const metrics = { ...(required.spend === undefined ? {} : { spend: required.spend }), impressions: '100', clicks: '10', vendorConversions: '2000000' };
    return { campaign: { pluginId: target.pluginId, accountId: target.accountId, vendorCampaignId: required.id }, metrics,
        ratios: value({ result: deriveMetricRatios({ metrics }) }), vendorSource: 'report.metrics.v1', leadSource: 'om_verified_creation_cohort',
        verifiedLeads: { status: 'unavailable', reason: 'not_implemented' } };
}
function results(required: { campaigns?: CampaignResults['campaigns'] } = {}): CampaignResults {
    return campaignResultsSchema.parse({ query: { ...target, days }, currency: 'USD', timezone: 'UTC', mapping: null,
        attributionModel: 'last_paid_touch_30d.v1', workspaceUnattributed: { status: 'unavailable', reason: 'not_implemented' },
        campaigns: required.campaigns ?? [row({ id: 'campaign', spend: '9007199254740993' })], complete: false,
        missingDays: ['2026-10-20'], observations: [], periodReach: [] });
}
function report(required: { results: CampaignResults }) {
    const candidate = value({ result: weeklyReportCandidate({ target, days, ...required }) });
    if (candidate.kind !== 'weekly_report') throw new Error('Expected weekly report');
    return candidate;
}

it('keeps platform conversions, unavailable OM leads, null metrics and unsupported metrics distinct', () => {
    const candidate = report({ results: results({ campaigns: [row({ id: 'null', spend: null }), row({ id: 'unsupported' }), row({ id: 'zero', spend: '0' })] }) });
    expect(candidate.report.campaigns.map(item => item.campaign.vendorCampaignId)).toEqual(['zero', 'null', 'unsupported']);
    expect(candidate.report.campaigns[0]).toMatchObject({ metrics: { spend: '0', vendorConversions: '2000000' },
        vendorSource: 'report.metrics.v1', leadSource: 'om_verified_creation_cohort', verifiedLeads: { status: 'unavailable', reason: 'not_implemented' } });
    expect(candidate.report.campaigns[1]!.metrics.spend).toBeNull();
    expect(candidate.report.campaigns[2]!.metrics).not.toHaveProperty('spend');
});

it('sorts large integer spend exactly, breaks ties by ID and records every omitted campaign', () => {
    const source = results({ campaigns: Array.from({ length: 12 }, (_, index) => row({ id: String(index).padStart(2, '0'), spend: String(9007199254740992n + BigInt(index)) })) });
    const candidate = report({ results: source });
    expect(candidate.report.campaigns.map(item => item.campaign.vendorCampaignId)).toEqual(['11', '10', '09']);
    expect(candidate.report.omittedCampaigns).toBe(9);
    expect(source.campaigns[0]!.campaign.vendorCampaignId).toBe('00');
    const tied = report({ results: results({ campaigns: [row({ id: 'b', spend: '1' }), row({ id: 'a', spend: '1' })] }) });
    expect(tied.report.campaigns.map(item => item.campaign.vendorCampaignId)).toEqual(['a', 'b']);
    const mixedCase = report({ results: results({ campaigns: [row({ id: 'a', spend: '1' }), row({ id: 'Z', spend: '1' })] }) });
    expect(mixedCase.report.campaigns.map(item => item.campaign.vendorCampaignId)).toEqual(['Z', 'a']);
});

it('fits maximum escaped IDs, full metric/ratio cells and seven maximum observation records within the notice byte limit', () => {
    const id = '\u0000'.repeat(256), integer = '9'.repeat(38);
    const fullRow = { ...row({ id, spend: integer }), campaign: { pluginId: id, accountId: id, vendorCampaignId: id },
        metrics: { spend: integer, impressions: integer, clicks: integer, vendorConversions: integer, vendorConversionValue: integer },
        ratios: Object.fromEntries(['ctr', 'cpcMicros', 'cpmMicros', 'vendorCpaMicros', 'vendorRoas'].map(name =>
            [name, { status: 'exact', numerator: '9'.repeat(44), denominator: '9'.repeat(44) }])),
        verifiedLeads: { status: 'available', count: Number.MAX_SAFE_INTEGER } };
    const source = campaignResultsSchema.parse({ ...results(), timezone: 'x'.repeat(100), campaigns: Array(10).fill(fullRow),
        observations: Array.from({ length: 7 }, (_, index) => ({ day: `2026-10-${19 + index}`, syncId: '"'.repeat(256),
            previousSyncId: '"'.repeat(256), retrievedAt: Number.MAX_SAFE_INTEGER, dataThrough: Number.MAX_SAFE_INTEGER,
            ageMs: Number.MAX_SAFE_INTEGER, complete: false, freshness: 'stale', finality: 'provisional', restated: true })) });
    const candidate = value({ result: weeklyReportCandidate({ target: { pluginId: id, accountId: id, connectionId: id }, days, results: source }) });
    expect(Buffer.byteLength(JSON.stringify(candidate), 'utf8')).toBeLessThanOrEqual(32768);
    expect(alertCandidateSchema.safeParse(candidate).success).toBe(true);
    if (candidate.kind !== 'weekly_report') throw new Error('Expected weekly report');
    expect(candidate.report.campaigns).toHaveLength(3);
    expect(candidate.report.omittedCampaigns).toBe(7);
    expect(Buffer.byteLength(JSON.stringify({ ...candidate, report: { ...candidate.report, campaigns: source.campaigns } }), 'utf8')).toBeGreaterThan(32768);
    expect(weeklyReportSchema.safeParse({ ...candidate.report, campaigns: source.campaigns }).success).toBe(false);
});

/** Real SQLite/outbox seam; explicit processing only, no timers or external I/O. */
function fixture() {
    const directory = mkdtempSync(join(tmpdir(), 'om-weekly-report-')), path = join(directory, 'fixture.sqlite');
    let native = new Database(path), sequence = 0;
    for (const url of ['../../../features/jobs/migrations/0001_jobs.sql', '../../../features/measure/migrations/0003_metrics.sql',
        '../../../features/credentials/migrations/0001_credentials.sql', '../migrations/0006_alerts.sql'])
        native.exec(readFileSync(new URL(url, import.meta.url), 'utf8'));
    const observer = { observe: vi.fn() }, ids = { next: () => 'weekly-fixture-' + String(++sequence).padStart(4, '0') };
    let database = bindServerDatabase({ native, observer, context });
    return { context, clock, ids, observer,
        get unit() { return database.unit; }, get database() { return database.workspace; }, get native() { return native; },
        restart() { native.close(); native = new Database(path); database = bindServerDatabase({ native, observer, context }); },
        close() { native.close(); rmSync(directory, { force: true, recursive: true }); } };
}
function observedResults(): CampaignResults {
    return resultsWithObservation({ source: results() });
}
function resultsWithObservation(required: { source: CampaignResults }): CampaignResults {
    return { ...required.source, observations: [{ day: days.start, syncId: 'sync-1', previousSyncId: null, retrievedAt: now,
        dataThrough: now - 1000, ageMs: 0, complete: false, freshness: 'fresh', finality: 'provisional', restated: false }] };
}

it('uses Tuesday slots for preceding Monday through Sunday dates, end-exclusive, with stable scoped identity', async () => {
    const slot = weeklyReportSlot({ now });
    expect(weeklyReportDays({ slot })).toEqual(days);
    expect(weeklyReportSlot({ now: now - 1 })).toBe(slot - 1);
    expect(weeklyReportJob({ context, target, slot })).toEqual(weeklyReportJob({ context: { ...context, traceId: 'different', correlationId: 'different' }, target, slot }));
    expect(weeklyReportJob({ context: { ...context, scope: { ...context.scope, workspaceId: 'other' } }, target, slot }))
        .not.toEqual(weeklyReportJob({ context, target, slot }));
    const f = fixture();
    try {
        value({ result: await enqueueWeeklyReport({ ...f, target, slot }) });
        value({ result: await enqueueWeeklyReport({ ...f, target, slot }) });
        expect(f.native.prepare('SELECT operation,available_at FROM job').all()).toEqual([{ operation: 'alerts.weekly_report', available_at: now }]);
    } finally { f.close(); }
});

it('refuses a slot not yet due without reading or appending', async () => {
    const f = fixture();
    try {
        const read = vi.fn<Parameters<typeof generateWeeklyReport>[0]['results']>(async () => ({ ok: true, value: observedResults() }));
        expect(await generateWeeklyReport({ ...f, target, slot: weeklyReportSlot({ now }) + 1, results: read }))
            .toMatchObject({ ok: false, error: { code: 'invalid_input' } });
        expect(read).not.toHaveBeenCalled();
        expect(f.native.prepare('SELECT COUNT(*) AS count FROM server_alert_notice').get()).toEqual({ count: 0 });
    } finally { f.close(); }
});

it('retains the first snapshot across restart/replay and schedules one future successor without email', async () => {
    const f = fixture(), slot = weeklyReportSlot({ now });
    try {
        const read = vi.fn<Parameters<typeof generateWeeklyReport>[0]['results']>(async () => ({ ok: true, value: observedResults() }));
        value({ result: await generateWeeklyReport({ ...f, target, slot, results: read }) });
        const first = value({ result: await listAlerts({ ...f, query: { limit: 10 } }) });
        expect(first.items[0]?.candidate).toMatchObject({ kind: 'weekly_report', report: { campaigns: [{ metrics: { spend: '9007199254740993' } }] } });
        f.restart();
        read.mockResolvedValue({ ok: true, value: resultsWithObservation({ source: results({ campaigns: [row({ id: 'campaign', spend: '1' })] }) }) });
        value({ result: await generateWeeklyReport({ ...f, target, slot, results: read }) });
        expect(value({ result: await listAlerts({ ...f, query: { limit: 10 } }) })).toEqual(first);
        expect(read).toHaveBeenCalledWith({ context, query: { ...target, days } });
        expect(f.native.prepare('SELECT operation,available_at FROM job').all()).toEqual([{ operation: 'alerts.weekly_report', available_at: now + 7 * 86400000 }]);
        expect(f.native.prepare('SELECT COUNT(*) AS count FROM server_alert_email_reservation').get()).toEqual({ count: 0 });
        expect(value({ result: await listAlerts({ ...f, context: { ...context, scope: { ...context.scope, workspaceId: 'other' } }, query: { limit: 10 } }) }).items).toEqual([]);
    } finally { f.close(); }
});

it('records exactly one empty-week gap report and stops recurrence', async () => {
    const f = fixture(), slot = weeklyReportSlot({ now });
    try {
        const source = results({ campaigns: [] });
        source.currency = null; source.timezone = null;
        source.missingDays = ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25'];
        const read = async (): Promise<Outcome<CampaignResults>> => ({ ok: true, value: source });
        value({ result: await generateWeeklyReport({ ...f, target, slot, results: read }) });
        value({ result: await generateWeeklyReport({ ...f, target, slot, results: read }) });
        const notices = value({ result: await listAlerts({ ...f, query: { limit: 10 } }) });
        expect(notices.items).toHaveLength(1);
        expect(notices.items[0]?.candidate).toMatchObject({ report: { complete: false, campaigns: [], observations: [], missingDays: source.missingDays, currency: null } });
        expect(f.native.prepare('SELECT COUNT(*) AS count FROM job').get()).toEqual({ count: 0 });
    } finally { f.close(); }
});

it('does not treat a pending stored-only weekly report as active addon work', async () => {
    const f = fixture();
    try {
        value({ result: await enqueueWeeklyReport({ ...f, target, slot: weeklyReportSlot({ now }) + 1 }) });
        expect(await countAddonJobs({ ...f, kind: 'agent-plugin', id: 'fixture-addon' })).toEqual({ ok: true, value: 0 });
    } finally { f.close(); }
});

it('preserves source failure and classifies only unavailable as transient in the real worker', async () => {
    const f = fixture();
    try {
        const reporting = bindReporting({ ...f, host: undefined, schedule: () => () => {} });
        const read = vi.spyOn(reporting, 'results').mockResolvedValue({ ok: false, error: { code: 'unavailable', message: 'Fixture unavailable', retryable: true } });
        const worker = createFormWorkers({ ...f, reporting, forms: { async accept() { throw new Error('Unexpected forms job'); } }, schedule: () => () => {} });
        value({ result: await enqueueWeeklyReport({ ...f, target, slot: weeklyReportSlot({ now }) }) });
        expect(await worker.processOne()).toMatchObject({ kind: 'completed', state: 'retry' });
        expect(read).toHaveBeenCalledOnce();
        expect(f.native.prepare('SELECT COUNT(*) AS count FROM server_alert_notice').get()).toEqual({ count: 0 });
        await worker.stop({});
        expect(await generateWeeklyReport({ ...f, target, slot: weeklyReportSlot({ now }), results: async () => ({ ok: false,
            error: { code: 'forbidden', message: 'Fixture refusal', retryable: false } }) }))
            .toEqual({ ok: false, error: { code: 'forbidden', message: 'Fixture refusal', retryable: false } });
    } finally { f.close(); }
});

it('maps an unbound leads port to unavailable while keeping an explicit zero available', async () => {
    const f = fixture();
    try {
        const repo = createSqlMetricsRepo({ database: f.database });
        const batch = metricBatchSchema.parse({ schema: 'report.metrics.v1', ...target, days, currency: 'USD', timezone: 'UTC', grain: 'campaign',
            retrievedAt: now, dataThrough: now, complete: true, freshness: 'fresh', finality: 'final', restated: false,
            mapping: { pluginId: target.pluginId, version: 'v1', grains: { campaign: { spend: { vendorField: 'cost', meaning: 'Currency micros' } } } },
            rows: [{ day: days.start, entity: { grain: 'campaign', vendorCampaignId: 'campaign' }, metrics: { spend: '1000000' } }] });
        value({ result: await syncMetrics({ context, repo, clock, request: { syncId: 'sync-1', ...target, input: { days, grain: 'campaign' } },
            report: async () => ({ ok: true, value: batch }) }, { signal: new AbortController().signal }) });
        const unavailable = value({ result: await campaignResults({ context, query: { ...target, days }, repo, clock,
            leads: { async cohort() { return { ok: false, error: { code: 'not_implemented', message: 'Verified lead counts not bound', retryable: false } }; } } }) });
        expect(report({ results: unavailable }).report.campaigns[0]!.verifiedLeads).toEqual({ status: 'unavailable', reason: 'not_implemented' });
        const zero = value({ result: await campaignResults({ context, query: { ...target, days }, repo, clock,
            leads: { async cohort() { return { ok: true, value: { counts: [{ campaign: { pluginId: target.pluginId, accountId: target.accountId, vendorCampaignId: 'campaign' }, count: 0 }], unattributed: 0 } }; } } }) });
        expect(report({ results: zero }).report.campaigns[0]!.verifiedLeads).toEqual({ status: 'available', count: 0 });
    } finally { f.close(); }
});

it('refuses weekly email under the v1 definition before invoking mail or reserving quota', async () => {
    const f = fixture();
    try {
        value({ result: await generateWeeklyReport({ ...f, target, slot: weeklyReportSlot({ now }), results: async () => ({ ok: true, value: observedResults() }) }) });
        const noticeId = value({ result: await listAlerts({ ...f, query: { limit: 10 } }) }).items[0]!.noticeId;
        f.native.prepare("INSERT INTO om_owner_settings VALUES (?,?,'mail.provider',?)").run('owner', 'workspace', JSON.stringify('fixture-mail'));
        f.native.prepare("INSERT INTO om_credential_connection(owner_id,workspace_id,connection_id,plugin_id,status,version,ciphertext,aad_digest) VALUES ('owner','workspace','sender','fixture-mail','connected',1,'sealed-fixture','digest')").run();
        const send = vi.fn<AlertEmailDependencies['mail']['send']>();
        const alertEmail: AlertEmailDependencies = { timezone: 'UTC', ownerEmail: 'owner@example.test', mail: { send },
            async agentPluginState() { return { enabled: true, admitted: true, bundled: false, revision: 'fixture-revision', metadata: {
                alertFrom: 'alerts@example.test', mailAdapters: [{ id: 'fixture_mail', label: 'Fixture', module: 'mail/index.mjs', credentialKeys: ['token'], feedback: false }] } }; } };
        expect(await dispatchAlertEmail({ ...f, alertEmail, payload: { noticeId, definitionDigest: ALERT_EMAIL_DEFINITION_DIGEST, senderConnectionId: 'sender' } }))
            .toEqual({ ok: false, retryable: false, errorCode: 'not_implemented', message: 'Weekly report email not enabled' });
        expect(send).not.toHaveBeenCalled();
        expect(f.native.prepare('SELECT COUNT(*) AS count FROM server_alert_email_reservation').get()).toEqual({ count: 0 });
    } finally { f.close(); }
});

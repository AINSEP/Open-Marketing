/** Written-only regressions: real SQLite/outbox, fixture capability and injected scheduling. */
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { metricBatchSchema } from '@open-marketing/contracts';
import type { CallContext, ObserverEvent, Outcome } from '@open-marketing/contracts';
import { createSqlJobRepo } from '@open-marketing/jobs';
import { metricSyncRequestSchema } from '@open-marketing/measure';
import { leadSchema, type Lead, type LeadsService } from '@open-marketing/leads';
import { createMemoryCampaignRepo } from '@open-marketing/campaigns';
import { createMemoryConfirmationExchange, createMemorySafetyRepo } from '@open-marketing/safety';
import { buildOmToolDefinitions } from '../src/om-tools.js';
import { generateOmToolCoverage } from '../src/om-tool-coverage.js';
import { bindServerDatabase } from '../src/composition/database.js';
import { formRetryPolicy } from '../src/composition/forms.js';
import { bindReporting, reportingJob } from '../src/composition/reporting.js';
import { createFormWorkers } from '../src/composition/workers.js';

const context: CallContext = { scope: { ownerId: 'owner', workspaceId: 'workspace' }, principal: { kind: 'owner', ownerId: 'owner' },
    correlationId: 'reporting-correlation', traceId: 'reporting-trace', runId: 'reporting-run' };
const now = Date.parse('2026-10-03T12:00:00Z');
const batch = metricBatchSchema.parse({
    schema: 'report.metrics.v1', pluginId: 'fixture-ads', connectionId: 'fixture-connection', accountId: 'fixture-account',
    currency: 'USD', timezone: 'UTC', grain: 'campaign', days: { start: '2026-10-01', end: '2026-10-02' },
    retrievedAt: now, dataThrough: now - 1000, complete: true, freshness: 'fresh', finality: 'provisional', restated: false,
    mapping: { pluginId: 'fixture-ads', version: 'fixture-v1', grains: { campaign: {
        spend: { vendorField: 'cost', meaning: 'Account currency micros' },
        impressions: { vendorField: 'impressions', meaning: 'Served impressions' },
        clicks: { vendorField: 'clicks', meaning: 'All clicks' },
    } } },
    rows: [{ day: '2026-10-01', entity: { grain: 'campaign', vendorCampaignId: 'campaign-1' },
        metrics: { spend: '9007199254740993', impressions: '10', clicks: null } }],
});
const request = metricSyncRequestSchema.parse({ syncId: 'sync-1', pluginId: batch.pluginId, connectionId: batch.connectionId,
    accountId: batch.accountId, input: { grain: batch.grain, days: batch.days } });
const query = { pluginId: request.pluginId, connectionId: request.connectionId, accountId: request.accountId, ...request.input };
type Host = NonNullable<Parameters<typeof bindReporting>[0]['host']>;

/** Failed setup must fail the test rather than skip its assertions. */
function value<T>({ result }: { result: Outcome<T> }): T {
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.code);
    return result.value;
}

/** Only the owning migrations are applied to a temporary fixture, never a product database.
 * Reopening the file proves enqueued work and observations survive binding/native-handle restart. */
function fixture(_input: Record<string, never>) {
    const directory = mkdtempSync(join(tmpdir(), 'om-p1-reporting-'));
    const path = join(directory, 'fixture.sqlite');
    let native = new Database(path);
    native.pragma('foreign_keys = ON');
    native.exec(readFileSync(new URL('../../../features/jobs/migrations/0001_jobs.sql', import.meta.url), 'utf8'));
    native.exec(readFileSync(new URL('../../../features/measure/migrations/0003_metrics.sql', import.meta.url), 'utf8'));
    native.exec(readFileSync(new URL('../migrations/0006_alerts.sql', import.meta.url), 'utf8'));
    let instant = now, sequence = 0;
    const clock = { now: () => instant };
    const ids = { next: () => 'reporting-fixture-' + String(++sequence).padStart(4, '0') };
    const events: ObserverEvent[] = [];
    const observer = { observe(event: ObserverEvent) { events.push(event); } };
    // Keep the generic host method's contract; Vitest's spy exposes its mock controls separately.
    const host: Host = { async invokeCapability() { throw new Error('Unconfigured fixture capability'); } };
    const invokeCapability = vi.spyOn(host, 'invokeCapability').mockResolvedValue({ ok: true, value: batch });
    const timers: { delayMs: number; callback: () => void; cancel: ReturnType<typeof vi.fn> }[] = [];
    let database = bindServerDatabase({ native, observer, context });
    return {
        context, clock, ids, observer, events, host, invokeCapability, timers,
        get native() { return native; },
        get unit() { return database.unit; },
        binding(options?: Parameters<typeof bindReporting>[1]) { return bindReporting({ database: database.workspace, unit: database.unit, clock, ids, observer, host,
            schedule(input) { const timer = { ...input, cancel: vi.fn() }; timers.push(timer); return timer.cancel; } }, options); },
        advance({ ms }: { ms: number }) { instant += ms; },
        restart() { native.close(); native = new Database(path); native.pragma('foreign_keys = ON'); database = bindServerDatabase({ native, observer, context }); },
        close() { native.close(); rmSync(directory, { force: true, recursive: true }); },
    };
}

/** Drive the production registry explicitly; no polling loop or forms handler may run. */
function workers(required: { fixture: ReturnType<typeof fixture>; reporting: ReturnType<typeof bindReporting> }) {
    return createFormWorkers({ ...required.fixture, reporting: required.reporting,
        forms: { async accept() { throw new Error('Unexpected forms job'); } },
        schedule() { throw new Error('Unexpected worker scheduling'); } });
}

it('stores fixture capability observations through the durable reporting worker after restart', async () => {
    const f = fixture({});
    try {
        const receipt = value({ result: await f.binding().enqueue({ context, request }) });
        expect(f.host.invokeCapability).not.toHaveBeenCalled();
        f.restart();
        const reporting = f.binding(), worker = workers({ fixture: f, reporting });
        expect(await worker.processOne()).toEqual({ kind: 'completed', state: 'succeeded', jobId: receipt.jobId });
        expect(f.host.invokeCapability).toHaveBeenCalledOnce();
        expect(f.host.invokeCapability).toHaveBeenCalledWith({ context, pluginId: request.pluginId, capabilityId: 'report.metrics.v1',
            connection: { connectionId: request.connectionId, accountId: request.accountId }, input: request.input },
        expect.objectContaining({ signal: expect.any(AbortSignal) }));
        const days = value({ result: await reporting.repo.readDays({ context, query }) });
        expect(days).toHaveLength(1);
        expect(days[0]!.batch.rows[0]!.metrics).toEqual({ spend: '9007199254740993', impressions: '10', clicks: null });
        expect(f.timers[0]!.cancel).toHaveBeenCalledOnce();
        // Successful campaign sync seeds a due weekly report; no evidence in its prior week stops recurrence.
        expect(await worker.processOne()).toMatchObject({ kind: 'completed', state: 'succeeded' });
        expect(await worker.processOne()).toEqual({ kind: 'idle' });
        await worker.stop({});
        f.restart();
        expect(value({ result: await f.binding().repo.readDays({ context, query }) })).toEqual(days);
    } finally { f.close(); }
});

it('deduplicates refresh requests and sync replay while rejecting changed arguments', async () => {
    const f = fixture({});
    try {
        const reporting = f.binding();
        const first = value({ result: await reporting.enqueue({ context, request }) });
        expect(await reporting.enqueue({ context: { ...context, traceId: 'new-trace' }, request })).toEqual({ ok: true,
            value: { ...first, status: 'existing' } });
        expect(await reporting.enqueue({ context, request: { ...request, connectionId: 'other' } })).toMatchObject({ ok: false, error: { code: 'conflict' } });
        const worker = workers({ fixture: f, reporting });
        expect(await worker.processOne()).toMatchObject({ kind: 'completed', state: 'succeeded' });
        expect(await reporting.sync({ context, request })).toEqual({ ok: true, value: { syncId: request.syncId, status: 'existing' } });
        expect(f.native.prepare('SELECT COUNT(*) AS count FROM job').get()).toEqual({ count: 2 });
        expect(f.native.prepare("SELECT COUNT(*) AS count FROM job WHERE operation='alerts.weekly_report'").get()).toEqual({ count: 1 });
        expect(f.native.prepare('SELECT COUNT(*) AS count FROM measure_metrics_batch').get()).toEqual({ count: 1 });
        expect(f.native.prepare('SELECT COUNT(*) AS count FROM measure_metrics_day').get()).toEqual({ count: 1 });
        await worker.stop({});
    } finally { f.close(); }
});

it.each(['forbidden', 'limit_exceeded'] as const)('preserves %s as a permanent reporting failure without inventing zero metrics', async code => {
    const f = fixture({});
    try {
        const error = { code, retryable: false, message: 'Fixture capability refusal' };
        f.invokeCapability.mockResolvedValue({ ok: false, error });
        const reporting = f.binding();
        expect(await reporting.sync({ context, request })).toEqual({ ok: false, error });
        const receipt = value({ result: await reporting.enqueue({ context, request }) });
        const worker = workers({ fixture: f, reporting });
        expect(await worker.processOne()).toEqual({ kind: 'completed', state: 'failed', jobId: receipt.jobId });
        expect(f.events).toContainEqual({ operation: 'server.forms.worker', outcome: code,
            correlationId: context.correlationId, traceId: context.traceId, runId: context.runId });
        expect(await reporting.repo.readDays({ context, query })).toEqual({ ok: true, value: [] });
        expect(f.native.prepare("SELECT COUNT(*) AS count FROM job WHERE operation='alerts.weekly_report'").get()).toEqual({ count: 0 });
        expect(f.native.prepare('SELECT COUNT(*) AS count FROM measure_metrics_batch').get()).toEqual({ count: 0 });
        expect(await worker.processOne()).toEqual({ kind: 'idle' });
        await worker.stop({});
    } finally { f.close(); }
});

it('cancels a never-settling capability at the injected 25 second deadline before storing data', async () => {
    const f = fixture({});
    try {
        let entered!: () => void;
        const started = new Promise<void>(resolve => { entered = resolve; });
        // The real host races plugin execution against AbortSignal; this double preserves that contract.
        f.invokeCapability.mockImplementation((_input, options) => {
            const aborted = new Promise<Outcome<never>>(resolve => {
                options!.signal!.addEventListener('abort', () => resolve({ ok: false,
                    error: { code: 'cancelled', message: 'Fixture cancelled', retryable: false } }), { once: true });
            });
            entered();
            return Promise.race([new Promise<never>(() => {}), aborted]);
        });
        const reporting = f.binding();
        value({ result: await reporting.enqueue({ context, request }) });
        const worker = workers({ fixture: f, reporting }), attempt = worker.processOne();
        await started;
        expect(f.timers).toHaveLength(1);
        expect(f.timers[0]!.delayMs).toBe(25000);
        f.advance({ ms: 25000 });
        f.timers[0]!.callback();
        expect(await attempt).toMatchObject({ kind: 'completed', state: 'retry' });
        expect(f.invokeCapability.mock.calls[0]![1]!.signal!.aborted).toBe(true);
        expect(f.timers[0]!.cancel).toHaveBeenCalledOnce();
        expect(await reporting.repo.readDays({ context, query })).toEqual({ ok: true, value: [] });
        expect(f.native.prepare('SELECT COUNT(*) AS count FROM measure_metrics_batch').get()).toEqual({ count: 0 });
        await worker.stop({});
    } finally { f.close(); }
});

it('denies a forged reporting idempotency key at worker authorization without invoking the capability', async () => {
    const f = fixture({});
    try {
        const reporting = f.binding();
        const jobs = createSqlJobRepo({ database: f.unit, clock: f.clock, ids: f.ids, retryPolicy: formRetryPolicy });
        const receipt = value({ result: await jobs.enqueue({ context, job: { ...reportingJob({ context, request }), idempotencyKey: 'forged' } }) });
        const worker = workers({ fixture: f, reporting });
        expect(await worker.processOne()).toEqual({ kind: 'completed', state: 'denied', jobId: receipt.jobId });
        expect(f.host.invokeCapability).not.toHaveBeenCalled();
        expect(await reporting.repo.readDays({ context, query })).toEqual({ ok: true, value: [] });
        await worker.stop({});
    } finally { f.close(); }
});

it('seeds one occurrence for two distinct successful campaign syncs and leaves leads explicitly unavailable', async () => {
    const f = fixture({});
    try {
        const reporting = f.binding();
        value({ result: await reporting.sync({ context, request }) });
        value({ result: await reporting.sync({ context, request: { ...request, syncId: 'sync-2' } }) });
        expect(f.invokeCapability).toHaveBeenCalledTimes(2);
        expect(f.native.prepare("SELECT COUNT(*) AS count FROM job WHERE operation='alerts.weekly_report'").get()).toEqual({ count: 1 });
        const read = value({ result: await reporting.results({ context, query: { pluginId: request.pluginId,
            connectionId: request.connectionId, accountId: request.accountId, days: request.input.days } }) });
        expect(read.campaigns[0]!.verifiedLeads).toEqual({ status: 'unavailable', reason: 'not_implemented' });
        expect(read.workspaceUnattributed).toEqual({ status: 'unavailable', reason: 'not_implemented' });
    } finally { f.close(); }
});

/** Schema-valid frozen attribution fixtures; no identifiers or vendor calls. */
function cohortLead(required: { id: string; at: string; stage?: Lead['stage']; erased?: boolean; campaign?: string | null; accountId?: string; pluginId?: string }): Lead {
    const at = Date.parse(required.at), campaign = required.campaign === undefined ? 'campaign-1' : required.campaign;
    return leadSchema.parse({ scope: context.scope, leadId: required.id, subjectId: required.erased ? null : 'subject-' + required.id,
        source: { kind: 'form', ref: 'fixture-form' }, occurredAt: at, createdAt: at, stage: required.stage ?? 'new',
        erased: required.erased ?? false, revision: 1, lastEventId: 'event-' + required.id,
        attribution: { campaign: campaign === null ? null : { pluginId: required.pluginId ?? request.pluginId,
            accountId: required.accountId ?? request.accountId, vendorCampaignId: campaign },
        touchId: campaign === null ? null : 'touch-' + required.id, touchedAt: campaign === null ? null : at - 1000,
        modelVersion: 'last_paid_touch_30d.v1' } });
}

it('binds creation-date cohorts across DST, retaining erased/disqualified counts and workspace unattributed enquiries', async () => {
    const f = fixture({});
    try {
        const days = { start: '2026-03-08', end: '2026-03-09' };
        const observed = metricBatchSchema.parse({ ...batch, timezone: 'America/Los_Angeles', days,
            rows: [{ ...batch.rows[0], day: days.start }] });
        const inRange = '2026-03-09T06:30:00Z'; // March 8 23:30 after the DST transition.
        const items = [
            cohortLead({ id: 'last-day', at: inRange }),
            cohortLead({ id: 'end-exclusive', at: '2026-03-09T07:30:00Z' }),
            cohortLead({ id: 'before-start', at: '2026-03-08T07:30:00Z' }),
            cohortLead({ id: 'spam', at: inRange, stage: 'spam' }),
            cohortLead({ id: 'erased', at: inRange, erased: true }),
            cohortLead({ id: 'disqualified', at: inRange, stage: 'disqualified' }),
            cohortLead({ id: 'foreign-account', at: inRange, accountId: 'other-account' }),
            cohortLead({ id: 'foreign-plugin', at: inRange, pluginId: 'other-plugin' }),
            cohortLead({ id: 'unattributed', at: inRange, campaign: null }),
            cohortLead({ id: 'lead-only', at: inRange, campaign: 'lead-only' }),
        ];
        const list = vi.fn<LeadsService['list']>().mockResolvedValueOnce({ ok: true, value: { items: items.slice(0, 5), cursor: 'page-2' } })
            .mockResolvedValueOnce({ ok: true, value: { items: items.slice(5), cursor: null } });
        const reporting = f.binding({ leads: { list } });
        value({ result: await reporting.repo.append({ context, batch: observed, request: { ...request, input: { grain: 'campaign', days } } }) });
        const signal = new AbortController().signal;
        const read = value({ result: await reporting.results({ context, query: { pluginId: request.pluginId, connectionId: request.connectionId, accountId: request.accountId, days } }, { signal }) });
        expect(read.campaigns.map(row => [row.campaign.vendorCampaignId, row.verifiedLeads])).toEqual([
            ['campaign-1', { status: 'available', count: 3 }], ['lead-only', { status: 'available', count: 1 }],
        ]);
        expect(read.workspaceUnattributed).toEqual({ status: 'available', count: 1 });
        expect(read.attributionModel).toBe('last_paid_touch_30d.v1');
        expect(list.mock.calls).toEqual([
            [{ context, query: { page: { limit: 100, cursor: undefined } } }, { signal }],
            [{ context, query: { page: { limit: 100, cursor: 'page-2' } } }, { signal }],
        ]);
    } finally { f.close(); }
});

it('returns explicit zero for a requested campaign with no leads', async () => {
    const f = fixture({});
    try {
        const reporting = f.binding({ leads: { list: vi.fn<LeadsService['list']>().mockResolvedValue({ ok: true, value: { items: [], cursor: null } }) } });
        value({ result: await reporting.repo.append({ context, request, batch }) });
        const read = value({ result: await reporting.results({ context, query: { pluginId: request.pluginId, connectionId: request.connectionId, accountId: request.accountId, days: batch.days } }) });
        expect(read.campaigns[0]!.verifiedLeads).toEqual({ status: 'available', count: 0 });
        expect(read.workspaceUnattributed).toEqual({ status: 'available', count: 0 });
    } finally { f.close(); }
});

it('makes cohort counts unavailable after 50 unfinished lead pages without returning partial totals', async () => {
    const f = fixture({});
    try {
        const items = Array.from({ length: 100 }, (_, index) => cohortLead({ id: 'lead-' + index, at: '2026-10-01T12:00:00Z' }));
        const list = vi.fn<LeadsService['list']>().mockResolvedValue({ ok: true, value: { items, cursor: 'more' } });
        const reporting = f.binding({ leads: { list } });
        value({ result: await reporting.repo.append({ context, request, batch }) });
        const read = value({ result: await reporting.results({ context, query: { pluginId: request.pluginId, connectionId: request.connectionId, accountId: request.accountId, days: batch.days } }) });
        expect(list).toHaveBeenCalledTimes(50);
        expect(read.campaigns[0]).toMatchObject({ metrics: batch.rows[0]!.metrics, verifiedLeads: { status: 'unavailable', reason: 'limit_exceeded' } });
        expect(read.workspaceUnattributed).toEqual({ status: 'unavailable', reason: 'limit_exceeded' });
    } finally { f.close(); }
});

it('does not seed weekly reports for a successful account-grain sync', async () => {
    const f = fixture({});
    try {
        const account = metricBatchSchema.parse({ ...batch, grain: 'account', mapping: { ...batch.mapping,
            grains: { account: batch.mapping.grains.campaign } }, rows: [{ ...batch.rows[0], entity: { grain: 'account' } }] });
        f.invokeCapability.mockResolvedValue({ ok: true, value: account });
        value({ result: await f.binding().sync({ context, request: { ...request, input: { ...request.input, grain: 'account' } } }) });
        expect(f.native.prepare('SELECT COUNT(*) AS count FROM job').get()).toEqual({ count: 0 });
    } finally { f.close(); }
});

it('observes seed enqueue failure while preserving the committed sync success', async () => {
    const f = fixture({});
    try {
        f.native.exec("CREATE TRIGGER fixture_enqueue_failure BEFORE INSERT ON job BEGIN SELECT RAISE(ABORT,'fixture failure'); END;");
        expect(await f.binding().sync({ context, request })).toEqual({ ok: true, value: { syncId: request.syncId, status: 'stored' } });
        expect(f.native.prepare('SELECT COUNT(*) AS count FROM measure_metrics_batch').get()).toEqual({ count: 1 });
        expect(f.events).toContainEqual({ operation: 'server.alerts.weekly_seed', outcome: 'unavailable',
            correlationId: context.correlationId, traceId: context.traceId, runId: context.runId });
    } finally { f.close(); }
});

it('exposes scoped results and replay-safe campaign refresh through the shared tool catalog', async () => {
    const f = fixture({});
    try {
        const reporting = f.binding({ leads: { list: vi.fn<LeadsService['list']>().mockResolvedValue({ ok: true, value: { items: [], cursor: null } }) } });
        value({ result: await reporting.repo.append({ context, request, batch }) });
        const confirmations = createMemoryConfirmationExchange({ clock: f.clock, ids: f.ids, async recordAnswer() { return { ok: true, value: undefined }; } });
        const services = { reporting, confirmations, campaigns: createMemoryCampaignRepo({}), safety: createMemorySafetyRepo({ clock: f.clock, ids: f.ids, ownerTimezone: 'UTC' }) };
        const definitions = value({ result: await buildOmToolDefinitions({ context, services }) });
        const results = definitions.find(tool => tool.name === 'om_measure_results')!;
        const refresh = definitions.find(tool => tool.name === 'om_measure_refresh')!;
        expect(results.policy).toBe('read');
        expect(refresh.policy).toBe('write');
        expect(refresh.ownerOnly).toBeUndefined();
        expect(refresh.ownerRoute).toBeUndefined();
        const resultQuery = { pluginId: request.pluginId, connectionId: request.connectionId, accountId: request.accountId, days: batch.days };
        const signal = new AbortController().signal;
        expect(await results.invoke({ context, input: { query: resultQuery }, signal })).toMatchObject({ ok: true, value: {
            query: resultQuery, campaigns: [{ verifiedLeads: { status: 'available', count: 0 } }], workspaceUnattributed: { status: 'available', count: 0 },
        } });
        const foreign = { ...context, scope: { ...context.scope, workspaceId: 'other-workspace' } };
        expect(await results.invoke({ context: foreign, input: { query: resultQuery }, signal })).toMatchObject({ ok: true, value: { campaigns: [], currency: null } });
        const call = { context, input: { syncId: 'tool-sync', query: resultQuery }, signal };
        const first = value({ result: await refresh.invoke(call) });
        expect(first).toMatchObject({ status: 'enqueued' });
        expect(await refresh.invoke(call)).toMatchObject({ ok: true, value: { ...first as object, status: 'existing' } });
        expect(f.native.prepare("SELECT COUNT(*) AS count FROM job WHERE operation='measure.sync_metrics'").get()).toEqual({ count: 1 });
        const stored = f.native.prepare("SELECT payload FROM job WHERE operation='measure.sync_metrics'").get() as { payload: string };
        expect(JSON.parse(stored.payload).payload).toEqual({ ...request, syncId: 'tool-sync', input: { grain: 'campaign', days: batch.days } });
        expect(f.host.invokeCapability).not.toHaveBeenCalled();
        expect(await refresh.invoke({ ...call, input: { syncId: 'too-wide', query: { ...resultQuery, days: { start: '2026-10-01', end: '2026-11-02' } } } }))
            .toMatchObject({ ok: false, error: { code: 'invalid_input' } });
        expect(results.parse({ input: { query: { ...resultQuery, days: { start: '2026-10-01', end: '2026-11-02' } } } })).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
        expect(generateOmToolCoverage({ definitions }).filter(row => ['om_measure_results', 'om_measure_refresh'].includes(row.tool ?? '')))
            .toMatchObject([{ status: 'connected', studio: 'Measure page and chat via execute_tool' }, { status: 'connected', studio: 'Measure page and chat via execute_tool' }]);
    } finally { f.close(); }
});

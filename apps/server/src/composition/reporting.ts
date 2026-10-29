/** Canonical reporting uses the admitted host and the existing metrics tables/jobs outbox. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { callContextSchema, parseBoundary } from '@open-marketing/contracts';
import type { CallContext, CallOptions, ClockPort, IdPort, ObserverPort, Outcome, SqlSession, UnitOfWork } from '@open-marketing/contracts';
import { createSqlJobRepo, type JobReceipt, type JobRequest } from '@open-marketing/jobs';
import { campaignResults, createSqlMetricsRepo, metricSyncRequestSchema, syncMetrics, type CampaignResultsQuery, type MetricSyncReceipt, type MetricSyncRequest, type VerifiedLeadCountsPort } from '@open-marketing/measure';
import type { Lead, LeadsService } from '@open-marketing/leads';
import { digestArguments } from '@open-marketing/safety';
import type { HttpEffects } from '../inbound/http.js';
import type { bindAgentPluginBackends } from './agent-plugin-backends.js';
import { formRetryPolicy } from './forms.js';
import { localFailure } from './local-auth.js';
import { enqueueWeeklyReport, weeklyReportSlot } from '../alerts/jobs.js';

const enqueueSchema = z.strictObject({ context: callContextSchema, request: metricSyncRequestSchema });

/** Frozen attribution is counted by creation date in the observed account timezone.
 * Spam is excluded; erasure does not silently restate anonymous aggregate counts.
 * Returns the workspace-unattributed increment and updates only this call's count map.
 * @complexity O(1) per lead, no I/O or hidden time reads.
 */
function countLead(required: { lead: Lead; query: Parameters<VerifiedLeadCountsPort['cohort']>[0]; formatter: Intl.DateTimeFormat; counts: Map<string, number> }): number {
    const { lead, query, formatter, counts } = required;
    if (lead.stage === 'spam') return 0;
    const parts = new Map(formatter.formatToParts(lead.createdAt).map(part => [part.type, part.value]));
    const day = `${parts.get('year')}-${parts.get('month')}-${parts.get('day')}`;
    if (day < query.days.start || day >= query.days.end) return 0;
    const campaign = lead.attribution.campaign;
    if (campaign === null) return 1;
    if (campaign.pluginId !== query.pluginId || campaign.accountId !== query.accountId) return 0;
    counts.set(campaign.vendorCampaignId, (counts.get(campaign.vendorCampaignId) ?? 0) + 1);
    return 0;
}

/** Read the existing scoped lead cursor protocol; cap the whole workspace scan.
 * O(leads + requested campaigns) time/space; <=50 reads of <=100, never partial totals.
 * Throws are converted to unavailable by measure's existing cohort boundary.
 */
async function leadCohort(required: { leads?: Pick<LeadsService, 'list'>; query: Parameters<VerifiedLeadCountsPort['cohort']>[0] }, options?: CallOptions): ReturnType<VerifiedLeadCountsPort['cohort']> {
    if (!required.leads) return localFailure({ code: 'not_implemented', message: 'Verified lead counts not bound' });
    const { query } = required;
    const formatter = new Intl.DateTimeFormat('en-US', { timeZone: query.timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
    const counts = new Map(query.campaigns.map(campaign => [campaign.vendorCampaignId, 0]));
    let cursor: string | undefined, unattributed = 0;
    for (let page = 0; page < 50; page++) {
        if (options?.signal?.aborted) return localFailure({ code: 'cancelled', message: 'Lead cohort cancelled' });
        const read = await required.leads.list({ context: query.context, query: { page: { limit: 100, cursor } } }, options);
        if (!read.ok) return read;
        for (const lead of read.value.items) unattributed += countLead({ lead, query, formatter, counts });
        if (read.value.cursor === null) return { ok: true, value: { counts: [...counts].map(([vendorCampaignId, count]) => ({ campaign: { pluginId: query.pluginId, accountId: query.accountId, vendorCampaignId }, count })), unattributed } };
        cursor = read.value.cursor;
    }
    return localFailure({ code: 'limit_exceeded', message: 'Lead cohort exceeds 5000 workspace leads' });
}

/** Pure scoped refresh identity, shared by enqueue and worker authorization.
 * A new syncId requests another observation; changed arguments under the same ID conflict.
 * Throws only for an unhashable request; callers validate the bounded request first.
 * @complexity O(request bytes), bounded IDs and one <=31-day request.
 * @example reportingJob({ context, request })
 */
export function reportingJob(required: { context: CallContext; request: MetricSyncRequest }): JobRequest {
    const { context, request } = required;
    const operationId = createHash('sha256').update(JSON.stringify([context.scope.ownerId, context.scope.workspaceId, request.syncId])).digest('hex');
    const digest = digestArguments({ arguments: request });
    if (!digest.ok) throw new Error('Invalid reporting job digest');
    return { handler: 'measure.sync_metrics', operationId, idempotencyKey: 'measure.sync_metrics:' + operationId,
        argumentsDigest: digest.value, payload: request };
}

/** Run work under the shared injected 25-second deadline and always release its timer.
 * The work owns its typed outcome and rejects late responses before accepting effects/evidence.
 * @example withDeadline({ schedule, work: ({ signal }) => read({ signal }) }, options)
 * @complexity O(1) timer/signal resources plus the bounded caller work.
 */
export async function withDeadline<T>(required: {
    schedule: HttpEffects['schedule']; work: (input: { signal: AbortSignal }) => Promise<Outcome<T>>;
}, options?: CallOptions): Promise<Outcome<T>> {
    const controller = new AbortController();
    const cancel = required.schedule({ delayMs: 25000, callback: () => controller.abort() });
    const signal = options?.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    try { return await required.work({ signal }); }
    finally { cancel(); }
}

/** Inert composition: enqueue explicit refreshes, then sync through current host admission.
 * Dependencies own SQL, time, observation and scheduling; no capability or credential is cached.
 * Missing hosts and capability refusals remain typed failures, never empty/zero observations.
 * @complexity One outbox enqueue or capability call plus bounded atomic metrics append.
 * @example const reporting = bindReporting({ database, unit, host, clock, ids, observer, schedule }, { leads });
 * await reporting.enqueue({ context, request });
 */
export function bindReporting(required: {
    database: SqlSession; unit: UnitOfWork; host: Pick<ReturnType<typeof bindAgentPluginBackends>, 'invokeCapability'> | undefined;
    clock: ClockPort; ids: IdPort; observer: ObserverPort; schedule: HttpEffects['schedule'];
}, optional?: { leads?: Pick<LeadsService, 'list'> }) {
    const repo = createSqlMetricsRepo({ database: required.database }, { observer: required.observer });
    const jobs = createSqlJobRepo({ database: required.unit, clock: required.clock, ids: required.ids, retryPolicy: formRetryPolicy });
    return {
        repo,
        /** Join persisted vendor evidence with the bounded creation-date cohort.
         * @example reporting.results({ context, query }) */
        results(input: { context: CallContext; query: CampaignResultsQuery }, options?: CallOptions) {
            return campaignResults({ ...input, repo, clock: required.clock, leads: {
                cohort: (query, callOptions) => leadCohort({ query, leads: optional?.leads }, callOptions),
            } }, { ...options, observer: required.observer });
        },
        /** Validate before constructing durable identity; the shared outbox owns replay/conflict. */
        async enqueue(input: { context: CallContext; request: MetricSyncRequest }, options?: CallOptions): Promise<Outcome<JobReceipt>> {
            const parsed = parseBoundary({ schema: enqueueSchema, input });
            if (!parsed.ok) return parsed;
            return jobs.enqueue({ context: parsed.value.context, job: reportingJob(parsed.value) }, options);
        },
        /** Abort at 25 s inside the 30 s job lease; host execution honors the signal and
         * syncMetrics rejects late responses before append. Always release the injected timer. */
        async sync(input: { context: CallContext; request: MetricSyncRequest }, options?: CallOptions): Promise<Outcome<MetricSyncReceipt>> {
            return withDeadline({ schedule: required.schedule, work: async ({ signal }) => {
                const result = await syncMetrics({ ...input, repo, clock: required.clock, report: (call, callOptions) => {
                    if (!required.host) return Promise.resolve(localFailure({ code: 'unavailable', message: 'Reporting host unavailable' }));
                    return required.host.invokeCapability({ ...call, context: input.context, pluginId: input.request.pluginId, capabilityId: 'report.metrics.v1' }, callOptions);
                } }, { ...options, signal, observer: required.observer });
                if (result.ok && input.request.input.grain === 'campaign') {
                    const { pluginId, connectionId, accountId } = input.request;
                    const seeded = await enqueueWeeklyReport({ ...required, context: input.context,
                        target: { pluginId, connectionId, accountId }, slot: weeklyReportSlot({ now: required.clock.now({}) }) });
                    try { required.observer.observe({ operation: 'server.alerts.weekly_seed', outcome: seeded.ok ? 'scheduled' : seeded.error.code,
                        correlationId: input.context.correlationId, traceId: input.context.traceId, runId: input.context.runId }); }
                    catch { /* Metrics already committed; diagnostics must not repeat the vendor read. */ }
                }
                return result;
            } }, options);
        },
    };
}

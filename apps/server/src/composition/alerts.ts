/** Alert bindings reuse local approvals, notice persistence and the single jobs outbox. */
import { createHash } from 'node:crypto';
import { parseBoundary } from '@open-marketing/contracts';
import type { AppError, ApproverRef, CallContext, CallOptions, CampaignStatusOutput, ClockPort, IdPort, ObserverPort, Outcome, PageQuery, UnitOfWork } from '@open-marketing/contracts';
import type { ConfirmationExchangePort } from '@open-marketing/safety';
import { listCredentialConnections, type CredentialSqlPort } from '@open-marketing/credentials';
import type { AccountBinding, AccountBindingListPort } from '@open-marketing/workspaces';
import { metricDaySchema, type MetricDay } from '@open-marketing/measure';
import { readBoundedPages } from '../addon-tools.js';
import { withDeadline, type bindReporting } from './reporting.js';
import type { bindAgentPluginBackends } from './agent-plugin-backends.js';
import type { HttpEffects } from '../inbound/http.js';
import { acknowledgeAlert, ALERT_EVALUATION_INTERVAL_MS, dailyPacingEvidence, enqueueAlertEvaluation, listAlerts, type AlertEvidence } from '../alerts/index.js';
import { alertFailure } from '../alerts/rules.js';

/** Inert bindings: sources read at evaluation time; seed is explicitly called before startup.
 * The approver is trusted server composition identity, never an HTTP/tool field.
 * @example const alerts = bindAlerts({ unit, clock, ids, confirmations, approver, accountBindings, db, reporting, host, schedule, observer }); await alerts.seed({ context });
 * @complexity Bounded paged local reads plus sequential catalog reads under one 25-second deadline.
 */
export function bindAlerts(required: {
    unit: UnitOfWork; clock: ClockPort; ids: IdPort; confirmations: Pick<ConfirmationExchangePort, 'list'>; approver: ApproverRef;
    accountBindings: AccountBindingListPort; db: CredentialSqlPort; reporting: Pick<ReturnType<typeof bindReporting>, 'repo' | 'enqueue'>;
    host: Pick<ReturnType<typeof bindAgentPluginBackends>, 'invokeCapability'> | undefined;
    schedule: HttpEffects['schedule']; observer: ObserverPort;
}) {
    return {
        /** First 100 pending cards; account gaps cannot suppress these approval notices. */
        async sources(input: { context: CallContext }, options?: CallOptions): Promise<Outcome<AlertEvidence>> {
            const pending = await required.confirmations.list({ context: input.context, query: { limit: 100 } }, options);
            if (!pending.ok) return pending;
            const evidence: AccountEvidence = { statuses: [], pacing: [] };
            try {
                await withDeadline({ schedule: required.schedule, work: async ({ signal }) => {
                    await collectEvidence({ ...required, ...input, evidence }, { ...options, signal });
                    return { ok: true, value: evidence };
                } }, options);
            } catch { evidenceGap({ ...required, ...input, code: 'unavailable' }); }
            return { ok: true, value: { pendingCards: pending.value.items.map(card => ({ cardId: card.cardId,
                status: 'pending', expiresAt: card.expiresAt })), ...evidence } };
        },
        /** Boot fails closed through its existing catch if the durable seed cannot be enqueued. */
        async seed(input: { context: CallContext }): Promise<void> {
            const result = await enqueueAlertEvaluation({ ...input, unit: required.unit, clock: required.clock, ids: required.ids,
                slot: Math.floor(required.clock.now({}) / ALERT_EVALUATION_INTERVAL_MS) });
            if (!result.ok) throw new Error('Alert evaluation seed failed: ' + result.error.code);
        },
        list: (input: { context: CallContext; query: PageQuery }) => listAlerts({ ...input, unit: required.unit }),
        acknowledge: (input: { context: CallContext; noticeId: string }) => acknowledgeAlert({ ...input,
            approver: required.approver, unit: required.unit, clock: required.clock }),
    };
}

type Dependencies = Parameters<typeof bindAlerts>[0];
type AccountEvidence = Pick<AlertEvidence, 'statuses' | 'pacing'>;
type JoinedAccount = AccountBinding & { pluginId: string };

/** Payload-free gap diagnostics cannot turn partial evidence into a failed evaluation. O(1). */
function evidenceGap(required: { observer: ObserverPort; context: CallContext; code: AppError['code'] }): void {
    try { required.observer.observe({ operation: 'server.alerts.evidence', outcome: required.code,
        correlationId: required.context.correlationId, traceId: required.context.traceId, runId: required.context.runId }); }
    catch { /* Diagnostics cannot suppress valid notices. */ }
}

/** Join only scoped, connected summaries; no secrets or dispatch authority are read.
 * Listing gaps fail this collection, not pending approval notices.
 * @complexity <=20 page reads, O(bindings + connections) time/space, each <=1,000.
 */
async function joinedAccounts(required: Pick<Dependencies, 'accountBindings' | 'db'> & { context: CallContext }, options?: CallOptions): Promise<Outcome<JoinedAccount[]>> {
    const connections = await readBoundedPages({ readPage: (input, callOptions) => listCredentialConnections({ ...input,
        context: required.context, db: required.db, query: { ...input.query, status: 'connected' } }, callOptions) }, options);
    if (!connections.ok) return connections;
    const bindings = await readBoundedPages({ readPage: (input, callOptions) => required.accountBindings.listAccountBindings({ ...input, context: required.context }, callOptions) }, options);
    if (!bindings.ok) return bindings;
    const plugins = new Map(connections.value.map(connection => [connection.connectionId, connection.pluginId]));
    return { ok: true, value: bindings.value.flatMap(binding => {
        const pluginId = plugins.get(binding.connectionId);
        return pluginId === undefined ? [] : [{ ...binding, pluginId }];
    }) };
}

/** One stable refresh per account/window/slot; enqueue only, never invoke reporting inline.
 * A refresh failure is observed without suppressing a status read. O(1) outbox operation.
 */
async function refreshAccount(required: Dependencies & { context: CallContext; account: JoinedAccount; days: MetricDay['batch']['days']; now: number }, options?: CallOptions): Promise<void> {
    const { pluginId, connectionId, externalAccountId: accountId } = required.account;
    const { days } = required;
    const slot = Math.floor(required.now / ALERT_EVALUATION_INTERVAL_MS);
    const syncId = createHash('sha256').update(JSON.stringify([pluginId, connectionId, accountId, days.start, days.end, slot])).digest('hex');
    try {
        const result = await required.reporting.enqueue({ context: required.context,
            request: { syncId, pluginId, connectionId, accountId, input: { grain: 'campaign', days } } }, options);
        if (!result.ok && !options?.signal?.aborted) evidenceGap({ ...required, code: result.error.code });
    } catch {
        if (!options?.signal?.aborted) evidenceGap({ ...required, code: 'unavailable' });
    }
}

/** Read stored IDs and one current status batch; no capability/credentials survive this call.
 * Refuse overflow/unrequested IDs and discard responses received after cancellation.
 * @complexity One refresh enqueue, one <=5,000-row read and one <=100-campaign catalog call.
 */
async function accountEvidence(required: Dependencies & { context: CallContext; account: JoinedAccount; days: MetricDay['batch']['days'];
    now: number; remaining: number }, options?: CallOptions): Promise<Outcome<{ status: CampaignStatusOutput; partitions: readonly MetricDay[]; count: number } | null>> {
    try {
        const { pluginId, connectionId, externalAccountId: accountId } = required.account;
        await refreshAccount(required, options);
        if (options?.signal?.aborted) return alertFailure({ code: 'cancelled', message: 'Alert evidence cancelled' });
        const stored = await required.reporting.repo.readDays({ context: required.context,
            query: { pluginId, connectionId, accountId, grain: 'campaign', days: required.days } }, options);
        if (!stored.ok) return stored;
        const partitions = parseBoundary({ schema: metricDaySchema.array(), input: stored.value });
        if (!partitions.ok) return partitions;
        const vendorCampaignIds = [...new Set(partitions.value.flatMap(partition => partition.batch.rows.flatMap(row =>
            row.entity.grain === 'campaign' ? [row.entity.vendorCampaignId] : [])))].sort();
        if (vendorCampaignIds.length > required.remaining) return alertFailure({ code: 'limit_exceeded', message: 'Alert campaign evidence limit exceeded' });
        if (!vendorCampaignIds.length) return { ok: true, value: null };
        if (options?.signal?.aborted) return alertFailure({ code: 'cancelled', message: 'Alert evidence cancelled' });
        if (!required.host) return alertFailure({ code: 'unavailable', message: 'Alert status host unavailable' });
        const status = await required.host.invokeCapability({ context: required.context, pluginId, capabilityId: 'campaign.status.v1',
            connection: { connectionId, accountId }, input: { vendorCampaignIds } }, options);
        if (!status.ok) return status;
        if (status.value.campaigns.some(campaign => !vendorCampaignIds.includes(campaign.vendorCampaignId)))
            return alertFailure({ code: 'protocol_mismatch', message: 'Alert status contains unrequested campaigns' });
        return { ok: true, value: { status: status.value, partitions: partitions.value, count: vendorCampaignIds.length } };
    } catch { return alertFailure({ code: 'unavailable', message: 'Alert account evidence unavailable' }); }
}

/** Append one validated account batch; unknown pacing leaves status/disapproval evidence intact.
 * @complexity O(campaigns * stored rows), <=100 campaigns and <=5,000 rows, no I/O.
 */
function appendAccountEvidence(required: { account: JoinedAccount; evidence: AccountEvidence; status: CampaignStatusOutput;
    partitions: readonly MetricDay[]; now: number }): void {
    const { pluginId, externalAccountId: accountId } = required.account;
    required.evidence.statuses.push({ ...required.status, pluginId, accountId });
    for (const observation of required.status.campaigns) {
        const pacing = dailyPacingEvidence({ campaign: { pluginId, accountId, vendorCampaignId: observation.vendorCampaignId },
            observation, observedAt: required.status.observedAt, partitions: required.partitions, now: required.now });
        if (pacing) required.evidence.pacing.push(pacing);
    }
}

/** Sequential account collection shares one deadline. Stop on abort and retain earlier evidence.
 * Each typed account/listing gap is observed once; never reject approval evidence.
 * @complexity <=1,000 accounts, <=100 discovered campaigns accepted, <=5,000 rows/read;
 * local reads/refreshes per account plus one status call per nonempty accepted account.
 */
async function collectEvidence(required: Dependencies & { context: CallContext; evidence: AccountEvidence }, options?: CallOptions): Promise<void> {
    const accounts = await joinedAccounts(required, options);
    if (options?.signal?.aborted) { evidenceGap({ ...required, code: 'cancelled' }); return; }
    if (!accounts.ok) { evidenceGap({ ...required, code: accounts.error.code }); return; }
    const now = required.clock.now({});
    const utcDay = Math.floor(now / 86400000) * 86400000;
    const days = { start: new Date(utcDay - 86400000).toISOString().slice(0, 10), end: new Date(utcDay + 86400000).toISOString().slice(0, 10) };
    let count = 0;
    for (const account of accounts.value) {
        const result = await accountEvidence({ ...required, account, days, now, remaining: 100 - count }, options);
        if (options?.signal?.aborted) { evidenceGap({ ...required, code: 'cancelled' }); break; }
        if (!result.ok) { evidenceGap({ ...required, code: result.error.code }); continue; }
        if (!result.value) continue;
        appendAccountEvidence({ ...required, account, ...result.value, now });
        count += result.value.count;
    }
}

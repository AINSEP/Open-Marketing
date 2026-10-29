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
import { accountLocalDay, acknowledgeAlert, ALERT_EVALUATION_INTERVAL_MS, dailyPacingEvidence, enqueueAlertEvaluation, lifetimePacingEvidence, listAlerts, type AlertEvidence, type PacingEvidence } from '../alerts/index.js';
import { alertFailure, historyDayCovered, LIFETIME_HISTORY_DAYS, shiftDay } from '../alerts/rules.js';

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

/** Earliest account-local start of an active lifetime flight inside the bounded history. O(campaigns). */
function lifetimeHistoryStart(required: { status: CampaignStatusOutput; timezone: string; end: string; now: number }): string | null {
    const floor = shiftDay({ day: required.end, days: -LIFETIME_HISTORY_DAYS });
    const starts = required.status.campaigns.flatMap(({ currentBudget: budget }) => {
        if (budget?.kind !== 'lifetime' || budget.flight.start > required.now || required.now >= budget.flight.end) return [];
        const day = accountLocalDay({ timezone: required.timezone, now: budget.flight.start });
        return day !== null && day >= floor ? [day] : [];
    });
    return starts.length ? starts.sort()[0]! : null;
}

/** Half-open 31-day windows; the 310-day floor keeps them within the pager's ten pages. O(windows). */
function historyWindows(required: { start: string; end: string }): MetricDay['batch']['days'][] {
    const windows: MetricDay['batch']['days'][] = [];
    for (let start = required.start; start < required.end; start = shiftDay({ day: start, days: 31 })) {
        const next = shiftDay({ day: start, days: 31 });
        windows.push({ start, end: next < required.end ? next : required.end });
    }
    return windows;
}

/** One stored read per window through the shared bounded pager; any gap fails the whole history.
 * @complexity <=10 reads of <=31 days and <=5,000 rows each.
 */
async function readFlightHistory(required: Dependencies & { context: CallContext; account: JoinedAccount; windows: readonly MetricDay['batch']['days'][] }, options?: CallOptions): Promise<Outcome<MetricDay[]>> {
    const { pluginId, connectionId, externalAccountId: accountId } = required.account;
    return readBoundedPages({ readPage: async (input, callOptions) => {
        const index = Number(input.query.cursor ?? '0');
        const stored = await required.reporting.repo.readDays({ context: required.context,
            query: { pluginId, connectionId, accountId, grain: 'campaign', days: required.windows[index]! } }, callOptions);
        if (!stored.ok) return stored;
        const partitions = parseBoundary({ schema: metricDaySchema.array(), input: stored.value });
        if (!partitions.ok) return partitions;
        return { ok: true, value: { items: partitions.value, cursor: index + 1 < required.windows.length ? String(index + 1) : null } };
    } }, options);
}

/** Enqueue only windows with an uncovered day; the UTC day start keeps each syncId stable all day. */
async function refreshFlightHistory(required: Dependencies & { context: CallContext; account: JoinedAccount; windows: readonly MetricDay['batch']['days'][];
    partitions: readonly MetricDay[]; now: number }, options?: CallOptions): Promise<void> {
    const covered = new Set(required.partitions.filter(partition => historyDayCovered({ partition })).map(partition => partition.day));
    const now = Math.floor(required.now / 86400000) * 86400000;
    for (const days of required.windows) {
        if (options?.signal?.aborted) return;
        if (!windowCovered({ days, covered })) await refreshAccount({ ...required, days, now }, options);
    }
}
function windowCovered(required: { days: MetricDay['batch']['days']; covered: ReadonlySet<string> }): boolean {
    for (let day = required.days.start; day < required.days.end; day = shiftDay({ day, days: 1 })) {
        if (!required.covered.has(day)) return false;
    }
    return true;
}

/** Lifetime pacing for one account: shared history read, missing-window refresh, pure projection.
 * Failures/aborts observe a gap and return no lifetime evidence; status/daily evidence is kept.
 * @complexity <=10 history reads + <=10 refresh enqueues, then O(campaigns * days * rows).
 */
async function lifetimeEvidence(required: Dependencies & { context: CallContext; account: JoinedAccount; status: CampaignStatusOutput;
    partitions: readonly MetricDay[]; days: MetricDay['batch']['days']; now: number }, options?: CallOptions): Promise<PacingEvidence[]> {
    const timezone = required.partitions[0]?.batch.timezone;
    const start = timezone === undefined ? null : lifetimeHistoryStart({ ...required, timezone, end: required.days.start });
    if (start === null) return [];
    try {
        const windows = historyWindows({ start, end: required.days.start });
        const history = windows.length ? await readFlightHistory({ ...required, windows }, options) : { ok: true as const, value: [] };
        if (options?.signal?.aborted) return [];
        if (!history.ok) { evidenceGap({ ...required, code: history.error.code }); return []; }
        await refreshFlightHistory({ ...required, windows, partitions: history.value }, options);
        const partitions = [...history.value, ...required.partitions];
        const { pluginId, externalAccountId: accountId } = required.account;
        return required.status.campaigns.flatMap(observation => lifetimePacingEvidence({ campaign: { pluginId, accountId, vendorCampaignId: observation.vendorCampaignId },
            observation, observedAt: required.status.observedAt, partitions, now: required.now }) ?? []);
    } catch {
        evidenceGap({ ...required, code: 'unavailable' });
        return [];
    }
}

/** Append one validated account batch; unknown pacing leaves status/disapproval evidence intact.
 * Lifetime evidence arriving after cancellation is discarded.
 * @complexity O(campaigns * stored rows), <=100 campaigns and <=5,000 rows, plus lifetimeEvidence's bounded reads.
 */
async function appendAccountEvidence(required: Dependencies & { context: CallContext; account: JoinedAccount; evidence: AccountEvidence; status: CampaignStatusOutput;
    partitions: readonly MetricDay[]; days: MetricDay['batch']['days']; now: number }, options?: CallOptions): Promise<void> {
    const { pluginId, externalAccountId: accountId } = required.account;
    required.evidence.statuses.push({ ...required.status, pluginId, accountId });
    for (const observation of required.status.campaigns) {
        const pacing = dailyPacingEvidence({ campaign: { pluginId, accountId, vendorCampaignId: observation.vendorCampaignId },
            observation, observedAt: required.status.observedAt, partitions: required.partitions, now: required.now });
        if (pacing) required.evidence.pacing.push(pacing);
    }
    const lifetime = await lifetimeEvidence(required, options);
    if (!options?.signal?.aborted) required.evidence.pacing.push(...lifetime);
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
        await appendAccountEvidence({ ...required, account, ...result.value, days, now }, options);
        count += result.value.count;
    }
}

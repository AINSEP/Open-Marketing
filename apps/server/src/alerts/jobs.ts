/** Recurrence uses the single durable jobs outbox; factories/imports never start workers. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { appErrorSchema, callContextSchema, epochSchema, parseBoundary } from '@open-marketing/contracts';
import type { CallContext, ClockPort, IdPort, ObserverPort, Outcome, UnitOfWork } from '@open-marketing/contracts';
import { createSqlJobRepo, type JobRequest } from '@open-marketing/jobs';
import { campaignResultsSchema, type CampaignResults, type CampaignResultsQuery } from '@open-marketing/measure';
import { alertFailure, alertCandidates, alertEvidenceSchema, weeklyReportCandidate, weeklyReportSchema, type AlertEvidence, type WeeklyReport } from './rules.js';
import { appendAlerts } from './store.js';
import { formRetryPolicy } from '../composition/forms.js';

export const ALERT_EVALUATION_INTERVAL_MS = 15 * 60 * 1000;
export const alertEvaluationPayloadSchema = z.strictObject({ slot: epochSchema.max(Math.floor(Number.MAX_SAFE_INTEGER / ALERT_EVALUATION_INTERVAL_MS) - 1) });
const evaluationInput = z.strictObject({ context: callContextSchema, slot: alertEvaluationPayloadSchema.shape.slot, now: epochSchema });
const sourceOutcome = z.discriminatedUnion('ok', [z.strictObject({ ok: z.literal(true), value: alertEvidenceSchema }),
    z.strictObject({ ok: z.literal(false), error: appErrorSchema })]);

const WEEK_MS = 7 * 86400000;
const WEEKLY_ANCHOR = 5 * 86400000; // Tuesday 1970-01-06 00:00 UTC.
/** A bounded occurrence payload, independent of trace and sync IDs. */
export const weeklyReportPayloadSchema = z.strictObject({ target: weeklyReportSchema.shape.target,
    slot: epochSchema.max(Math.floor((Number.MAX_SAFE_INTEGER - WEEKLY_ANCHOR) / WEEK_MS) - 1) });
const weeklyInput = weeklyReportPayloadSchema.extend({ context: callContextSchema });
const weeklyOutcome = z.discriminatedUnion('ok', [z.strictObject({ ok: z.literal(true), value: campaignResultsSchema }),
    z.strictObject({ ok: z.literal(false), error: appErrorSchema })]);
/** Most recent Tuesday occurrence from an injected instant; O(1), no effects.
 * @example weeklyReportSlot({ now: clock.now({}) }) */
export function weeklyReportSlot(required: { now: number }): number {
    return Math.floor((required.now - WEEKLY_ANCHOR) / WEEK_MS);
}
/** Previous Mon..Sun account-calendar dates, end-exclusive; O(1), no clock reads.
 * @example weeklyReportDays({ slot }) */
export function weeklyReportDays(required: { slot: number }): WeeklyReport['days'] {
    const availableAt = WEEKLY_ANCHOR + required.slot * WEEK_MS;
    return { start: new Date(availableAt - 8 * 86400000).toISOString().slice(0, 10),
        end: new Date(availableAt - 86400000).toISOString().slice(0, 10) };
}
/** Scoped account/occurrence identity shared by enqueue and worker admission; O(b), bounded IDs.
 * @example weeklyReportJob({ context, target, slot }) */
export function weeklyReportJob(required: { context: CallContext; target: WeeklyReport['target']; slot: number }): JobRequest {
    const { context, target, slot } = required;
    const digest = createHash('sha256').update(JSON.stringify([context.scope.ownerId, context.scope.workspaceId,
        target.pluginId, target.connectionId, target.accountId, slot])).digest('hex');
    return { handler: 'alerts.weekly_report', operationId: digest, idempotencyKey: 'alerts.weekly_report:' + digest,
        argumentsDigest: digest, payload: { target, slot } };
}
/** Enqueue once at its Tuesday due time in the existing outbox; validation/storage failures are typed.
 * @example await enqueueWeeklyReport({ context, target, slot, unit, clock, ids })
 * @complexity One bounded indexed outbox enqueue/transaction; no vendor I/O.
 */
export async function enqueueWeeklyReport(required: { context: CallContext; target: WeeklyReport['target']; slot: number; unit: UnitOfWork; clock: ClockPort; ids: IdPort }): Promise<Outcome<void>> {
    const parsed = parseBoundary({ schema: weeklyInput, input: { context: required.context, target: required.target, slot: required.slot } });
    if (!parsed.ok) return parsed;
    try {
        const repo = createSqlJobRepo({ database: required.unit, clock: required.clock, ids: required.ids, retryPolicy: formRetryPolicy });
        const result = await repo.enqueue({ context: parsed.value.context, job: weeklyReportJob(parsed.value),
            availableAt: WEEKLY_ANCHOR + parsed.value.slot * WEEK_MS });
        return result.ok ? { ok: true, value: undefined } : result;
    } catch { return alertFailure({ code: 'unavailable', message: 'Weekly report scheduling unavailable' }); }
}
/** Persist one immutable snapshot without email; empty evidence records a gap and stops recurrence.
 * A successor enqueue failure retries safely through notice/outbox dedup. Source failures remain typed.
 * @example await generateWeeklyReport({ context, target, slot, unit, clock, ids, observer, results })
 * @complexity One bounded results read, one notice append, at most one successor enqueue.
 */
export async function generateWeeklyReport(required: {
    context: CallContext; target: WeeklyReport['target']; slot: number; unit: UnitOfWork; clock: ClockPort; ids: IdPort; observer: ObserverPort;
    results(input: { context: CallContext; query: CampaignResultsQuery }): Promise<Outcome<CampaignResults>>;
}): Promise<Outcome<void>> {
    const parsed = parseBoundary({ schema: weeklyInput, input: { context: required.context, target: required.target, slot: required.slot } });
    if (!parsed.ok) return parsed;
    const currentSlot = weeklyReportSlot({ now: required.clock.now({}) });
    if (required.slot > currentSlot) return alertFailure({ code: 'invalid_input', message: 'Weekly report is not due' });
    try {
        const days = weeklyReportDays({ slot: required.slot });
        const loaded = parseBoundary({ schema: weeklyOutcome, input: await required.results({ context: required.context, query: { ...required.target, days } }) });
        if (!loaded.ok) return loaded;
        if (!loaded.value.ok) return loaded.value;
        const candidate = weeklyReportCandidate({ target: required.target, days, results: loaded.value.value });
        if (!candidate.ok) return candidate;
        const appended = await appendAlerts({ ...required, candidates: [candidate.value] });
        if (!appended.ok) return appended;
        observe({ ...required, operation: 'weekly_report', outcome: 'stored' });
        if (loaded.value.value.observations.length > 0) return enqueueWeeklyReport({ ...required, slot: currentSlot + 1 });
        return { ok: true, value: undefined };
    } catch { return alertFailure({ code: 'unavailable', message: 'Weekly report evidence unavailable' }); }
}

/** Build identity from validated scope/slot inputs for enqueue and worker admission; no effects.
 * Trace changes cannot create duplicate jobs. O(b) for <=512 ID characters.
 * @example alertEvaluationJob({ context, slot: Math.floor(now / ALERT_EVALUATION_INTERVAL_MS) })
 */
export function alertEvaluationJob(required: { context: CallContext; slot: number }): JobRequest {
    const digest = createHash('sha256').update(JSON.stringify([required.context.scope.ownerId, required.context.scope.workspaceId, required.slot])).digest('hex');
    return { handler: 'alerts.evaluate', operationId: digest, idempotencyKey: 'alerts:' + digest + ':' + required.slot,
        argumentsDigest: digest, payload: { slot: required.slot } };
}
/** Enqueue the current slot at boot, or a future successor, without starting anything.
 * Returns a typed enqueue/validation failure; first enqueue retains its due time.
 * @example enqueueAlertEvaluation({ context, slot: Math.floor(now / 900000), unit, clock, ids })
 * @complexity One indexed outbox enqueue/transaction with bounded payload.
 */
export async function enqueueAlertEvaluation(required: { context: CallContext; slot: number; unit: UnitOfWork; clock: ClockPort; ids: IdPort }): Promise<Outcome<void>> {
    const parsed = parseBoundary({ schema: evaluationInput, input: { context: required.context, slot: required.slot, now: required.clock.now({}) } });
    if (!parsed.ok) return parsed;
    const { context, slot } = parsed.value;
    try {
        const repo = createSqlJobRepo({ database: required.unit, clock: required.clock, ids: required.ids, retryPolicy: formRetryPolicy });
        const result = await repo.enqueue({ context, job: alertEvaluationJob({ context, slot }), availableAt: slot * ALERT_EVALUATION_INTERVAL_MS });
        return result.ok ? { ok: true, value: undefined } : result;
    } catch { return alertFailure({ code: 'unavailable', message: 'Alert scheduling unavailable' }); }
}
/** Payload-free diagnostics reuse the existing observer; they cannot alter persisted outcomes. O(1). */
function observe(required: { context: CallContext; observer: ObserverPort; operation: 'evaluate' | 'weekly_report'; outcome: string }): void {
    try { required.observer.observe({ operation: 'server.alerts.' + required.operation, outcome: required.outcome,
        correlationId: required.context.correlationId, traceId: required.context.traceId, runId: required.context.runId }); }
    catch { /* Diagnostics never cause duplicate notices. */ }
}
/** Schedule the next FUTURE slot durably before bounded source reads; missed slots are not replayed.
 * Sources return one complete bounded page or a typed gap; production paging/bindings are integrator work.
 * Email intent is added atomically only when the worker supplied a resolved sender connection.
 * @example evaluateAlerts({ context, slot, sources, unit, clock, ids, observer })
 * @complexity One successor enqueue, one bounded source callback, <=300 notice inserts.
 */
export async function evaluateAlerts(required: {
    context: CallContext; slot: number; unit: UnitOfWork; clock: ClockPort; ids: IdPort; observer: ObserverPort;
    email?: { senderConnectionId: string };
    sources(input: { context: CallContext; limit: 100 }): Promise<Outcome<AlertEvidence>>;
}): Promise<Outcome<void>> {
    const now = required.clock.now({});
    const parsed = parseBoundary({ schema: evaluationInput, input: { context: required.context, slot: required.slot, now } });
    if (!parsed.ok) return parsed;
    if (required.slot > Math.floor(now / ALERT_EVALUATION_INTERVAL_MS)) return alertFailure({ code: 'invalid_input', message: 'Evaluation is not due' });
    const scheduled = await enqueueAlertEvaluation({ ...required, slot: Math.floor(now / ALERT_EVALUATION_INTERVAL_MS) + 1 });
    if (!scheduled.ok) return scheduled;
    let result: Outcome<void>;
    try {
        const loaded = parseBoundary({ schema: sourceOutcome, input: await required.sources({ context: required.context, limit: 100 }) });
        if (!loaded.ok) { observe({ ...required, operation: 'evaluate', outcome: 'invalid_input' }); return loaded; }
        const evidence = loaded.value;
        result = evidence.ok ? await recordEvidence({ ...required, evidence: evidence.value, now: required.clock.now({}) }) : evidence;
    } catch { result = alertFailure({ code: 'unavailable', message: 'Alert evidence unavailable' }); }
    observe({ ...required, operation: 'evaluate', outcome: result.ok ? 'evaluated' : result.error.code });
    return result;
}
/** Keep validation/decisions separate from the notice transaction; no SQL during source I/O. */
async function recordEvidence(required: { context: CallContext; evidence: AlertEvidence; now: number; unit: UnitOfWork; clock: ClockPort; ids: IdPort; email?: { senderConnectionId: string } }): Promise<Outcome<void>> {
    const candidates = alertCandidates({ ...required.evidence, now: required.now });
    if (!candidates.ok) return candidates;
    const result = await appendAlerts({ ...required, candidates: candidates.value }, { email: required.email });
    return result.ok ? { ok: true, value: undefined } : result;
}

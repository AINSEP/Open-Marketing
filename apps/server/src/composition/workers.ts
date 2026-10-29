/** One bounded host loop over the existing jobs outbox, with acceptance registered before start. */
import { z } from 'zod';
import { haltStopRequestSchema, idSchema, parseBoundary } from '@open-marketing/contracts';
import type { CallContext, ClockPort, HaltStopPermit, HaltStopRequest, IdPort, ObserverPort, Outcome, UnitOfWork } from '@open-marketing/contracts';
import { createJobHandlerRegistry, createJobService, createSqlJobRepo, JobStoreError, type JobHandler, type JobHandlerRegistry, type JobRequest, type ProcessResult, type TransportResult } from '@open-marketing/jobs';
import { digestArguments } from '@open-marketing/safety';
import { metricSyncRequestSchema } from '@open-marketing/measure';
import type { AccountDispatchLockPort, HaltReceipt, SafetyService } from '@open-marketing/safety';
import type { HttpEffects } from '../inbound/http.js';
import { formJobDigest, formRetryPolicy, type bindForms } from './forms.js';
import type { CreativeToolBinding } from '../om-tool-types.js';
import { localFailure } from './local-auth.js';
import { reportingJob, type bindReporting } from './reporting.js';
import type { bindAgentPluginBackends } from './agent-plugin-backends.js';
import { alertEvaluationJob, alertEvaluationPayloadSchema, evaluateAlerts, alertEmailJob, alertEmailPayloadSchema, dispatchAlertEmail,
    resolveAlertSender, weeklyReportJob, weeklyReportPayloadSchema, generateWeeklyReport, type AlertEmailDependencies } from '../alerts/index.js';

const payloadSchema = z.strictObject({ publicationId: idSchema, submissionId: idSchema });
const formJobSchema = z.strictObject({ handler: z.literal('forms.accept'), operationId: idSchema, idempotencyKey: idSchema,
    argumentsDigest: z.string().regex(/^[a-f0-9]{64}$/), payload: payloadSchema });
const creativePayloadSchema = z.strictObject({ generationId: idSchema });
const creativeJobSchema = z.strictObject({ handler: z.literal('creative.generate'), operationId: idSchema, idempotencyKey: idSchema,
    argumentsDigest: z.string().regex(/^[a-f0-9]{64}$/), payload: creativePayloadSchema });
const stopPayloadSchema = z.strictObject({ pluginId: idSchema, request: haltStopRequestSchema });
const stopJobSchema = z.strictObject({ handler: z.literal('agent-plugin.halt-stop'), operationId: idSchema, idempotencyKey: idSchema,
    argumentsDigest: z.string().regex(/^[a-f0-9]{64}$/), payload: stopPayloadSchema });
const alertJobSchema = z.strictObject({ handler: z.literal('alerts.evaluate'), operationId: idSchema, idempotencyKey: idSchema,
    argumentsDigest: z.string().regex(/^[a-f0-9]{64}$/), payload: alertEvaluationPayloadSchema });
const emailJobSchema = z.strictObject({ handler: z.literal('alerts.email'), operationId: idSchema, idempotencyKey: idSchema,
    argumentsDigest: z.string().regex(/^[a-f0-9]{64}$/), payload: alertEmailPayloadSchema });
const reportingJobSchema = z.strictObject({ handler: z.literal('measure.sync_metrics'), operationId: idSchema, idempotencyKey: idSchema,
    argumentsDigest: z.string().regex(/^[a-f0-9]{64}$/), payload: metricSyncRequestSchema });
const conversionPayloadSchema = z.strictObject({ subjectId: idSchema, eventId: idSchema, deliveryId: idSchema });
const conversionJobSchema = z.strictObject({ handler: z.literal('measure.conversion'), operationId: idSchema, idempotencyKey: idSchema,
    argumentsDigest: z.string().regex(/^[a-f0-9]{64}$/), payload: conversionPayloadSchema });
const weeklyJobSchema = z.strictObject({ handler: z.literal('alerts.weekly_report'), operationId: idSchema, idempotencyKey: idSchema,
    argumentsDigest: z.string().regex(/^[a-f0-9]{64}$/), payload: weeklyReportPayloadSchema });
const jobSchema = z.discriminatedUnion('handler', [formJobSchema, creativeJobSchema, stopJobSchema, alertJobSchema, emailJobSchema, reportingJobSchema, conversionJobSchema, weeklyJobSchema]);
type ConversionDispatch = ReturnType<ReturnType<typeof bindAgentPluginBackends>['conversions']>['dispatch'];
/** Jobs validates the durable envelope; this binding owns handler payloads, IDs and local scope. */
function decode(required: { job: JobRequest; context: CallContext; expectedContext: CallContext }) {
    const job = jobSchema.parse(required.job);
    if (required.context.scope.ownerId !== required.expectedContext.scope.ownerId || required.context.scope.workspaceId !== required.expectedContext.scope.workspaceId) throw new Error('Worker scope mismatch');
    checkJobIdentity({ job, context: required.context });
    return job;
}
/** Handler-specific identities are closed; creative reloads and checks its durable digest again. */
function checkJobIdentity(required: { job: z.infer<typeof jobSchema>; context: CallContext }): void {
    const job = required.job;
    switch (job.handler) {
        // A3 conversionJob checks identity against the leased row before any effect.
        case 'measure.conversion': return;
        case 'measure.sync_metrics': return checkJobIdentityMatch({ job, expected: reportingJob({ context: required.context, request: job.payload }) });
        case 'alerts.weekly_report': return checkJobIdentityMatch({ job, expected: weeklyReportJob({ context: required.context, ...job.payload }) });
        case 'alerts.email': {
            const expected = alertEmailJob({ context: required.context, payload: job.payload });
            return checkJobIdentityMatch({ job, expected });
        }
        case 'alerts.evaluate': {
            const expected = alertEvaluationJob({ context: required.context, slot: job.payload.slot });
            return checkJobIdentityMatch({ job, expected });
        }
        case 'agent-plugin.halt-stop':
            if (job.operationId !== job.payload.request.operationId || job.idempotencyKey !== 'halt-stop:' + job.operationId
                || job.argumentsDigest !== stopJobDigest({ payload: job.payload })) throw new Error('Stop worker identity mismatch');
            return;
        case 'creative.generate':
            if (job.operationId !== job.payload.generationId || job.idempotencyKey !== 'creative:' + job.operationId) throw new Error('Creative worker identity mismatch');
            return;
        case 'forms.accept':
            if (job.operationId !== job.payload.submissionId || job.idempotencyKey !== job.payload.submissionId || formJobDigest(job.payload) !== job.argumentsDigest) throw new Error('Forms worker identity mismatch');
            return;
        default: { const exhaustive: never = job; throw new Error('Unknown worker job: ' + exhaustive); }
    }
}
/** Scoped jobs must match the identity reconstructed from their parsed payload. O(1). */
function checkJobIdentityMatch(required: { job: JobRequest; expected: JobRequest }): void {
    const { job, expected } = required;
    if (job.operationId !== expected.operationId || job.idempotencyKey !== expected.idempotencyKey
        || job.argumentsDigest !== expected.argumentsDigest) throw new Error('Worker identity mismatch');
}
function observe(required: { observer: ObserverPort; context: CallContext; outcome: string }): void {
    try { required.observer.observe({ operation: 'server.forms.worker', outcome: required.outcome,
        correlationId: required.context.correlationId, traceId: required.context.traceId, runId: required.context.runId }); }
    catch { /* Diagnostics cannot change a durable acknowledgement. */ }
}
/** Register at most eight inert handlers in order; throw before polling if registration fails.
 * Unbound email fails permanently without quota reservation; each handler retains its retry policy.
 * @complexity O(1) time and space: at most eight entries, no I/O until dispatch. */
function registerWorkers(required: Parameters<typeof createFormWorkers>[0] & { registry: JobHandlerRegistry }): void {
    const { alerts, halt, creative, reporting } = required;
    const entries: { name: string; handle: JobHandler['handle'] }[] = [
        { name: 'forms.accept', async handle(input): Promise<TransportResult> {
            const payload = payloadSchema.parse(input.job.payload);
            const result = await required.forms.accept({ context: input.context, ...payload });
            observe({ ...required, context: input.context, outcome: result.ok ? 'accepted' : result.error.code });
            return result.ok ? { kind: 'success' } : { kind: 'failure', classification: result.error.code === 'unavailable' ? 'transient' : 'permanent' };
        } },
        ...(reporting ? [{ name: 'measure.sync_metrics', async handle(input: Parameters<JobHandler['handle']>[0], options?: Parameters<JobHandler['handle']>[1]): Promise<TransportResult> {
            const result = await reporting.sync({ context: input.context, request: metricSyncRequestSchema.parse(input.job.payload) }, options);
            observe({ ...required, context: input.context, outcome: result.ok ? 'metrics_stored' : result.error.code });
            return result.ok ? { kind: 'success' } : { kind: 'failure', classification: ['unavailable', 'expired', 'cancelled'].includes(result.error.code) ? 'transient' : 'permanent' };
        } }, { name: 'alerts.weekly_report', async handle(input: Parameters<JobHandler['handle']>[0]): Promise<TransportResult> {
            const payload = weeklyReportPayloadSchema.parse(input.job.payload);
            const result = await generateWeeklyReport({ ...required, context: input.context, ...payload, results: reporting.results });
            observe({ ...required, context: input.context, outcome: result.ok ? 'weekly_report_stored' : result.error.code });
            return result.ok ? { kind: 'success' } : { kind: 'failure', classification: result.error.code === 'unavailable' ? 'transient' : 'permanent' };
        } }] : []),
        { name: 'alerts.email', async handle(input): Promise<TransportResult> {
            try {
                const result = await dispatchAlertEmail({ ...required, context: input.context, payload: alertEmailPayloadSchema.parse(input.job.payload) });
                const outcome = result.ok ? 'email_dispatched' : result.errorCode === 'not_implemented' ? 'sender_not_bound' : 'email_failed';
                observe({ observer: required.observer, context: input.context, outcome });
                return result.ok ? { kind: 'success' } : { kind: 'failure', classification: result.unknown ? 'unknown' : 'permanent' };
            } catch {
                observe({ observer: required.observer, context: input.context, outcome: 'email_unknown' });
                return { kind: 'failure', classification: 'unknown' };
            }
        } },
        ...(alerts ? [{ name: 'alerts.evaluate', async handle(input: Parameters<JobHandler['handle']>[0]): Promise<TransportResult> {
            const payload = alertEvaluationPayloadSchema.parse(input.job.payload);
            let email: { senderConnectionId: string } | undefined;
            if (required.alertEmail) {
                const sender = await resolveAlertSender({ context: input.context, unit: required.unit, agentPluginState: required.alertEmail.agentPluginState });
                // A broken/unavailable sender must never stop in-app alerts or the successor slot.
                if (sender.ok && sender.value) email = { senderConnectionId: sender.value.connectionId };
            }
            const result = await evaluateAlerts({ ...required, context: input.context, ...payload, sources: alerts.sources, email });
            return result.ok ? { kind: 'success' } : { kind: 'failure', classification: result.error.code === 'unavailable' ? 'transient' : 'permanent' };
        } }] : []),
        ...(halt ? [{ name: 'agent-plugin.halt-stop', async handle(input: Parameters<JobHandler['handle']>[0]): Promise<TransportResult> {
            const result = await halt.dispatch({ context: input.context, payload: stopPayloadSchema.parse(input.job.payload) });
            observe({ ...required, context: input.context, outcome: result.ok ? 'halt_stop_dispatched' : result.error.code });
            // No acknowledgement here establishes remote readback. Never retry uncertain stop writes.
            return stopCompletion({ result });
        } }] : []),
        ...(creative ? [{ name: 'creative.generate', async handle(input: Parameters<JobHandler['handle']>[0]): Promise<TransportResult> {
            const payload = creativePayloadSchema.parse(input.job.payload);
            const result = await creative.dispatchQueued({ context: input.context, ...payload, operationId: input.job.operationId, argumentsDigest: input.job.argumentsDigest });
            observe({ ...required, context: input.context, outcome: result.ok ? 'creative_dispatched' : result.error.code });
            return result.ok ? { kind: 'success' } : { kind: 'failure', classification: result.error.code === 'cancelled' ? 'permanent' : 'unknown' };
        } }] : []),
    ];
    for (const entry of entries) {
        const registered = required.registry.register({ name: entry.name, handler: { handle: entry.handle, async dispose() {} } });
        if (!registered.ok) throw new Error('Worker registration failed: ' + entry.name);
    }
    registerConversion(required);
}
/** Register a lease-owning conversion handler only when its committed evidence loader is bound.
 * A3 owns dispatch-start, consent and completion; no ordinary transport may send this job.
 * @complexity O(1) time/space registration; one bounded load and dispatch per claim. */
function registerConversion(required: Pick<Parameters<typeof createFormWorkers>[0], 'conversions' | 'observer'> & { registry: JobHandlerRegistry }): void {
    const { conversions } = required;
    if (!conversions) return;
    const registered = required.registry.register({ name: 'measure.conversion', handler: {
        async handle() { return { kind: 'failure', classification: 'unknown' }; },
        async handleClaim(claim, options) {
            const { subjectId, eventId, deliveryId } = conversionPayloadSchema.parse(claim.job.payload);
            const { scope, correlationId, traceId } = claim.context;
            const context = { scope, correlationId, traceId, serviceId: 'om-conversion-worker' };
            const loaded = await conversions.load({ context, subjectId, eventId }, options);
            if (!loaded.ok) {
                observe({ observer: required.observer, context: claim.context, outcome: loaded.error.code });
                return loaded;
            }
            const result = await conversions.dispatch({ context, ...loaded.value, deliveryId,
                claim: { jobId: claim.lease.id, leaseToken: claim.lease.leaseToken! } }, options);
            observe({ observer: required.observer, context: claim.context, outcome: result.ok ? 'conversion_dispatched' : result.error.code });
            return result;
        },
        async dispose() {},
    } });
    if (!registered.ok) throw new Error('Worker registration failed: measure.conversion');
}
/** Timer-free creation and registration; admission stays scoped to enabled handlers, stop cancels scheduling,
 * awaits the sole active attempt and disposes the registry before SQLite may close.
 * @example const workers = createFormWorkers({...}); workers.start({}); await workers.stop({});
 * @complexity One job per 250ms tick; one active attempt, no buffer or parallel root transactions. Unknown outcomes reconcile. */
export function createFormWorkers(required: {
    unit: UnitOfWork; clock: ClockPort; ids: IdPort; observer: ObserverPort; context: CallContext;
    creative?: Pick<CreativeToolBinding, 'dispatchQueued' | 'service'>;
    halt?: Pick<ReturnType<typeof bindAgentPluginHaltJobs>, 'dispatch'>;
    alerts?: Pick<Parameters<typeof evaluateAlerts>[0], 'sources'>;
    alertEmail?: AlertEmailDependencies;
    reporting?: Pick<ReturnType<typeof bindReporting>, 'sync' | 'results'>;
    conversions?: {
        dispatch: ConversionDispatch;
        load(required: Pick<Parameters<ConversionDispatch>[0], 'context'> & Omit<z.infer<typeof conversionPayloadSchema>, 'deliveryId'>,
            optional?: Parameters<ConversionDispatch>[1]): Promise<Outcome<Omit<Parameters<ConversionDispatch>[0], 'context' | 'claim' | 'deliveryId'>>>;
    };
    forms: Pick<ReturnType<typeof bindForms>, 'accept'>; schedule: HttpEffects['schedule'];
}) {
    const registry = createJobHandlerRegistry({ maxHandlers: 8, maxActive: 1 });
    registerWorkers({ ...required, registry });
    const repo = createSqlJobRepo({ database: required.unit, clock: required.clock, ids: required.ids, retryPolicy: formRetryPolicy });
    const service = createJobService({ repo, dispatcher: registry, clock: required.clock, ids: required.ids, retryPolicy: formRetryPolicy,
        authorization: { async authorize(input) {
            try { const job = decode({ ...input, expectedContext: required.context });
                return { ok: true, value: { allowed: workerEnabled({ handler: job.handler, creative: !!required.creative, halt: !!required.halt, alerts: !!required.alerts, reporting: !!required.reporting, conversions: !!required.conversions }) } };
            } catch { return { ok: true, value: { allowed: false } }; }
        } },
    }, { observer: required.observer });
    /** Retain the binding's raw process result; the service owns dispatch-result translation. */
    async function processOne(): Promise<ProcessResult> {
        const result = await service.processOne({ worker: { workerId: 'server-worker' } });
        if (!result.ok) throw new JobStoreError({ code: result.error.code, message: result.error.message });
        return result.value;
    }
    let running = false;
    let cancel: (() => void) | undefined;
    let active: Promise<unknown> | undefined;
    let creativeCursor: string | undefined;
    /** One due operation and one projection per tick; keep pagination across ticks, including empty outbox ticks.
     * @complexity O(1) bounded service calls; no second queue or concurrent worker. */
    async function pollCreative(): Promise<void> {
        if (!required.creative) return;
        const result = await required.creative.service.pollDue({ context: required.context,
            request: { leaseOwner: 'creative:' + required.context.traceId, leaseMs: 60000, limit: 1, ...(creativeCursor ? { cursor: creativeCursor } : {}) } });
        if (!result.ok) { observe({ ...required, outcome: 'creative_poll_' + result.error.code }); return; }
        creativeCursor = result.value.reconcileCursor ?? undefined;
    }
    /** Reschedule only after the previous attempt settles; typed busy failures wait for another tick. */
    async function tick(): Promise<void> {
        try { await processOne(); await pollCreative(); }
        catch { observe({ ...required, outcome: 'unavailable' }); }
        finally { if (running) cancel = required.schedule({ delayMs: 250, callback: onTick }); }
    }
    /** Host scheduler's zero-argument callback ABI. */
    function onTick(): void { active = tick(); }
    return {
        processOne,
        start(_input: Record<string, never>): Outcome<void> {
            if (running) return localFailure({ code: 'conflict', message: 'Worker already started' });
            running = true;
            cancel = required.schedule({ delayMs: 250, callback: onTick });
            return { ok: true, value: undefined };
        },
        async stop(_input: Record<string, never>): Promise<Outcome<void>> {
            running = false;
            cancel?.();
            await active;
            const disposed = await registry.dispose({});
            return disposed.ok ? { ok: true, value: undefined } : disposed;
        },
    };
}
function workerEnabled(required: { handler: z.infer<typeof jobSchema>['handler']; creative: boolean; halt: boolean; alerts: boolean; reporting: boolean; conversions: boolean }): boolean {
    switch (required.handler) {
        case 'forms.accept': return true;
        case 'alerts.email': return true;
        case 'creative.generate': return required.creative;
        case 'agent-plugin.halt-stop': return required.halt;
        case 'alerts.evaluate': return required.alerts;
        case 'measure.sync_metrics': return required.reporting;
        case 'alerts.weekly_report': return required.reporting;
        case 'measure.conversion': return required.conversions;
        default: { const exhaustive: never = required.handler; return exhaustive; }
    }
}
/** A transport ACK or uncertain readback cannot complete a stop job as observed success. */
function stopCompletion(required: { result: Outcome<unknown> }): TransportResult {
    if (!required.result.ok) return { kind: 'failure', classification: 'unknown' };
    const observed = z.union([z.object({ status: z.literal('stopped') }),
        z.object({ status: z.literal('succeeded'), observedState: z.literal('disabled') })]).safeParse(required.result.value);
    return observed.success ? { kind: 'success' } : { kind: 'failure', classification: 'unknown' };
}
function stopJobDigest(required: { payload: z.infer<typeof stopPayloadSchema> }): string {
    const result = digestArguments({ arguments: required.payload });
    if (!result.ok) throw new Error('Invalid stop job digest');
    return result.value;
}

/** Commit local halt before asking the host for verified connected/admitted stop targets.
 * The local host supplies no targets while vendors are unadmitted; remoteStatus stays pending.
 * Queue DTOs contain only IDs/digests. Worker authorization runs inside the shared account barrier.
 * @example const halt = bindAgentPluginHaltJobs({ ...ports, targets, stop });
 * @complexity <=5 vendor targets, <=100 entity IDs each; one existing outbox, no new scheduler.
 */
export function bindAgentPluginHaltJobs(required: {
    unit: UnitOfWork; clock: ClockPort; ids: IdPort; observer: ObserverPort; accountLocks: AccountDispatchLockPort;
    safety: Pick<SafetyService, 'haltAccount' | 'authorizeHaltStop'>;
    targets(input: { context: CallContext; receipt: HaltReceipt }): Promise<Outcome<readonly z.infer<typeof stopPayloadSchema>[]>>;
    stop(input: { context: CallContext; pluginId: string; permit: HaltStopPermit }): Promise<Outcome<unknown>>;
}) {
    const repo = createSqlJobRepo({ database: required.unit, clock: required.clock, ids: required.ids, retryPolicy: formRetryPolicy });
    return {
        async halt(input: Parameters<SafetyService['haltAccount']>[0]): Promise<Outcome<HaltReceipt>> {
            const halted = await required.safety.haltAccount(input);
            if (!halted.ok) return halted;
            const targets = await required.targets({ context: input.context, receipt: halted.value });
            if (!targets.ok) return targets;
            const parsed = parseBoundary({ schema: z.array(stopPayloadSchema).max(5), input: targets.value });
            if (!parsed.ok) return parsed;
            if (!parsed.value.every(payload => matchesHalt({ receipt: halted.value, request: payload.request })))
                return localFailure({ code: 'forbidden', message: 'Stop target differs from committed halt' });
            if (new Set(parsed.value.map(payload => payload.pluginId)).size !== parsed.value.length)
                return localFailure({ code: 'invalid_input', message: 'Duplicate vendor stop target' });
            for (const payload of parsed.value) {
                const queued = await repo.enqueue({ context: input.context, job: { handler: 'agent-plugin.halt-stop', operationId: payload.request.operationId,
                    idempotencyKey: 'halt-stop:' + payload.request.operationId, argumentsDigest: stopJobDigest({ payload }), payload } });
                if (!queued.ok) return queued;
            }
            return halted;
        },
        async dispatch(input: { context: CallContext; payload: z.infer<typeof stopPayloadSchema> }): Promise<Outcome<unknown>> {
            const parsed = parseBoundary({ schema: stopPayloadSchema, input: input.payload });
            if (!parsed.ok) return parsed;
            const lock = await required.accountLocks.acquire({ context: input.context, accountId: parsed.value.request.adAccountId });
            if (!lock.ok) return lock;
            try {
                const context = { scope: input.context.scope, serviceId: 'om-halt-worker', correlationId: input.context.correlationId, traceId: input.context.traceId };
                const permit = await required.safety.authorizeHaltStop({ context, request: parsed.value.request });
                if (!permit.ok) return permit;
                return await required.stop({ context: { ...input.context, principal: { kind: 'service', serviceId: context.serviceId } }, pluginId: parsed.value.pluginId, permit: permit.value });
            } finally {
                const released = await required.accountLocks.release({ lockId: lock.value.lockId });
                if (!released.ok) throw new Error('Stop account barrier release failed');
            }
        },
    };
}
function matchesHalt(required: { receipt: HaltReceipt; request: HaltStopRequest }): boolean {
    return required.request.haltId === required.receipt.haltId && required.request.haltEpoch === required.receipt.epoch && required.request.adAccountId === required.receipt.adAccountId;
}

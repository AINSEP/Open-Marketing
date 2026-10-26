/** One bounded host loop over the existing jobs outbox, with acceptance registered before start. */
import { z } from 'zod';
import { callContextSchema, haltStopRequestSchema, idSchema, parseBoundary } from '@open-marketing/contracts';
import type { CallContext, ClockPort, HaltStopPermit, HaltStopRequest, IdPort, ObserverPort, Outcome, UnitOfWork } from '@open-marketing/contracts';
import { createJobHandlerRegistry, createOutbox, createSqlJobRepo, createSqlOutboxStore, jobTenant, type EnqueueRequest, type TransportResult } from '@open-marketing/jobs';
import { digestArguments } from '@open-marketing/safety';
import type { AccountDispatchLockPort, HaltReceipt, SafetyService } from '@open-marketing/safety';
import type { HttpEffects } from '../inbound/http.js';
import { formJobDigest, formRetryPolicy, type bindForms } from './forms.js';
import type { CreativeToolBinding } from '../om-tool-types.js';
import { localFailure } from './local-auth.js';

const payloadSchema = z.strictObject({ publicationId: idSchema, submissionId: idSchema });
const formJobSchema = z.strictObject({ handler: z.literal('forms.accept'), operationId: idSchema, idempotencyKey: idSchema,
    argumentsDigest: z.string().regex(/^[a-f0-9]{64}$/), payload: payloadSchema });
const creativePayloadSchema = z.strictObject({ generationId: idSchema });
const creativeJobSchema = z.strictObject({ handler: z.literal('creative.generate'), operationId: idSchema, idempotencyKey: idSchema,
    argumentsDigest: z.string().regex(/^[a-f0-9]{64}$/), payload: creativePayloadSchema });
const stopPayloadSchema = z.strictObject({ pluginId: z.enum(['google-ads', 'linkedin-ads', 'tiktok-ads']), request: haltStopRequestSchema });
const stopJobSchema = z.strictObject({ handler: z.literal('agent-plugin.halt-stop'), operationId: idSchema, idempotencyKey: idSchema,
    argumentsDigest: z.string().regex(/^[a-f0-9]{64}$/), payload: stopPayloadSchema });
const jobSchema = z.discriminatedUnion('handler', [formJobSchema, creativeJobSchema, stopJobSchema]);
/** Durable tainted data must agree with operation/key/digest, authenticated local scope and IDs. */
function decode(required: { request: EnqueueRequest; context: CallContext }) {
    const context = callContextSchema.parse(required.request.context);
    const job = jobSchema.parse(JSON.parse(z.string().max(65536).parse(required.request.payload)));

    if (context.scope.ownerId !== required.context.scope.ownerId || context.scope.workspaceId !== required.context.scope.workspaceId
        || required.request.tenantId !== jobTenant({ context }) || required.request.operation !== job.handler) throw new Error('Worker scope mismatch');
    if (required.request.idempotencyKey !== job.idempotencyKey || required.request.requestDigest !== job.argumentsDigest) throw new Error('Worker identity mismatch');
    checkJobIdentity({ job });
    return { context, job };
}
/** Handler-specific identities are closed; creative reloads and checks its durable digest again. */
function checkJobIdentity(required: { job: z.infer<typeof jobSchema> }): void {
    const job = required.job;
    if (job.handler === 'agent-plugin.halt-stop') {
        if (job.operationId !== job.payload.request.operationId || job.idempotencyKey !== 'halt-stop:' + job.operationId
            || job.argumentsDigest !== stopJobDigest({ payload: job.payload })) throw new Error('Stop worker identity mismatch');
        return;
    }
    if (job.handler === 'creative.generate') {
        if (job.operationId !== job.payload.generationId || job.idempotencyKey !== 'creative:' + job.operationId) throw new Error('Creative worker identity mismatch');
        return;
    }
    if (job.operationId !== job.payload.submissionId || job.idempotencyKey !== job.payload.submissionId || formJobDigest(job.payload) !== job.argumentsDigest) throw new Error('Forms worker identity mismatch');
}
function observe(required: { observer: ObserverPort; context: CallContext; outcome: string }): void {
    try { required.observer.observe({ operation: 'server.forms.worker', outcome: required.outcome,
        correlationId: required.context.correlationId, traceId: required.context.traceId, runId: required.context.runId }); }
    catch { /* Diagnostics cannot change a durable acknowledgement. */ }
}
/** Timer-free creation and registration; start admits only this handler, stop cancels scheduling,
 * awaits the sole active attempt and disposes the registry before SQLite may close.
 * @example const workers = createFormWorkers({...}); workers.start({}); await workers.stop({});
 * @complexity One job per 250ms tick; one active attempt, no buffer or parallel root transactions. Unknown outcomes reconcile. */
export function createFormWorkers(required: {
    unit: UnitOfWork; clock: ClockPort; ids: IdPort; observer: ObserverPort; context: CallContext;
    creative?: Pick<CreativeToolBinding, 'dispatchQueued' | 'service'>;
    halt?: Pick<ReturnType<typeof bindAgentPluginHaltJobs>, 'dispatch'>;
    forms: Pick<ReturnType<typeof bindForms>, 'accept'>; schedule: HttpEffects['schedule'];
}) {
    const registry = createJobHandlerRegistry({ maxHandlers: 3, maxActive: 1 });
    const registered = registry.register({ name: 'forms.accept', handler: {
        async handle(input): Promise<TransportResult> {
            const payload = payloadSchema.parse(input.job.payload);
            const result = await required.forms.accept({ context: input.context, ...payload });
            observe({ ...required, context: input.context, outcome: result.ok ? 'accepted' : result.error.code });
            return result.ok ? { kind: 'success' } : { kind: 'failure', classification: result.error.code === 'unavailable' ? 'transient' : 'permanent' };
        }, async dispose() {},
    } });
    if (!registered.ok) throw new Error('Forms worker registration failed');
    if (required.halt) {
        const halt = required.halt;
        const result = registry.register({ name: 'agent-plugin.halt-stop', handler: {
            async handle(input): Promise<TransportResult> {
                const result = await halt.dispatch({ context: input.context, payload: stopPayloadSchema.parse(input.job.payload) });
                observe({ ...required, context: input.context, outcome: result.ok ? 'halt_stop_dispatched' : result.error.code });
                // No acknowledgement here establishes remote readback. Never retry uncertain stop writes.
                return stopCompletion({ result });
            }, async dispose() {},
        } });
        if (!result.ok) throw new Error('Stop worker registration failed');
    }
    if (required.creative) {
        const creative = required.creative;
        const registeredCreative = registry.register({ name: 'creative.generate', handler: {
            async handle(input) {
                const payload = creativePayloadSchema.parse(input.job.payload);
                const result = await creative.dispatchQueued({ context: input.context, ...payload, operationId: input.job.operationId, argumentsDigest: input.job.argumentsDigest });
                observe({ ...required, context: input.context, outcome: result.ok ? 'creative_dispatched' : result.error.code });
                return result.ok ? { kind: 'success' } : { kind: 'failure', classification: result.error.code === 'cancelled' ? 'permanent' : 'unknown' };
            }, async dispose() {},
        } });
        if (!registeredCreative.ok) throw new Error('Creative worker registration failed');
    }
    const store = createSqlOutboxStore({ database: required.unit });
    const outbox = createOutbox({ inputPolicy: formRetryPolicy, ports: {
        store, clock: required.clock, generateId: () => required.ids.next({}),
        async authorize(request) { try { const input = decode({ request, context: required.context }); return workerEnabled({ handler: input.job.handler, creative: !!required.creative, halt: !!required.halt }); } catch { return false; } },
        transport: { idempotent: false, async dispatch(request): Promise<TransportResult> {
            const input = decode({ request, context: required.context });
            const result = await registry.dispatch(input);
            if (!result.ok || result.value.kind !== 'completed') return { kind: 'failure', classification: 'unknown' };
            switch (result.value.state) {
                case 'succeeded': return { kind: 'success' };
                case 'retry': return { kind: 'failure', classification: 'transient' };
                case 'denied': case 'failed': return { kind: 'failure', classification: 'permanent' };
                default: return { kind: 'failure', classification: 'unknown' };
            }
        } },
    } });
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
        try { await outbox.processOne(); await pollCreative(); }
        catch { observe({ ...required, outcome: 'unavailable' }); }
        finally { if (running) cancel = required.schedule({ delayMs: 250, callback: onTick }); }
    }
    /** Host scheduler's zero-argument callback ABI. */
    function onTick(): void { active = tick(); }
    return {
        processOne: () => outbox.processOne(),
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
function workerEnabled(required: { handler: z.infer<typeof jobSchema>['handler']; creative: boolean; halt: boolean }): boolean {
    switch (required.handler) {
        case 'forms.accept': return true;
        case 'creative.generate': return required.creative;
        case 'agent-plugin.halt-stop': return required.halt;
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

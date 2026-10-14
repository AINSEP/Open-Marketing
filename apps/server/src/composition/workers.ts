/** One bounded host loop over the existing jobs outbox, with acceptance registered before start. */
import { z } from 'zod';
import { callContextSchema, idSchema } from '@open-marketing/contracts';
import type { CallContext, ClockPort, IdPort, ObserverPort, Outcome, UnitOfWork } from '@open-marketing/contracts';
import { createJobHandlerRegistry, createOutbox, createSqlOutboxStore, jobTenant, type EnqueueRequest, type TransportResult } from '@open-marketing/jobs';
import type { HttpEffects } from '../inbound/http.js';
import { formJobDigest, formRetryPolicy, jobsDatabase, type bindForms } from './forms.js';
import type { CreativeToolBinding } from '../om-tool-types.js';
import { localFailure } from './local-auth.js';

const payloadSchema = z.strictObject({ publicationId: idSchema, submissionId: idSchema });
const formJobSchema = z.strictObject({ handler: z.literal('forms.accept'), operationId: idSchema, idempotencyKey: idSchema,
    argumentsDigest: z.string().regex(/^[a-f0-9]{64}$/), payload: payloadSchema });
const creativePayloadSchema = z.strictObject({ generationId: idSchema });
const creativeJobSchema = z.strictObject({ handler: z.literal('creative.generate'), operationId: idSchema, idempotencyKey: idSchema,
    argumentsDigest: z.string().regex(/^[a-f0-9]{64}$/), payload: creativePayloadSchema });
const jobSchema = z.discriminatedUnion('handler', [formJobSchema, creativeJobSchema]);
/** Durable tainted data must agree with operation/key/digest, authenticated local scope and IDs. */
function decode(required: { request: EnqueueRequest; context: CallContext }) {
    const context = callContextSchema.parse(required.request.context);
    const job = jobSchema.parse(JSON.parse(z.string().max(4096).parse(required.request.payload)));

    if (context.scope.ownerId !== required.context.scope.ownerId || context.scope.workspaceId !== required.context.scope.workspaceId
        || required.request.tenantId !== jobTenant({ context }) || required.request.operation !== job.handler) throw new Error('Worker scope mismatch');
    if (required.request.idempotencyKey !== job.idempotencyKey || required.request.requestDigest !== job.argumentsDigest) throw new Error('Worker identity mismatch');
    checkJobIdentity({ job });
    return { context, job };
}
/** Handler-specific identities are closed; creative reloads and checks its durable digest again. */
function checkJobIdentity(required: { job: z.infer<typeof jobSchema> }): void {
    const job = required.job;
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
    creative?: Pick<CreativeToolBinding, 'dispatchQueued'>;
    forms: Pick<ReturnType<typeof bindForms>, 'accept'>; schedule: HttpEffects['schedule'];
}) {
    const registry = createJobHandlerRegistry({ maxHandlers: 2, maxActive: 1 });
    const registered = registry.register({ name: 'forms.accept', handler: {
        async handle(input): Promise<TransportResult> {
            const payload = payloadSchema.parse(input.job.payload);
            const result = await required.forms.accept({ context: input.context, ...payload });
            observe({ ...required, context: input.context, outcome: result.ok ? 'accepted' : result.error.code });
            return result.ok ? { kind: 'success' } : { kind: 'failure', classification: result.error.code === 'unavailable' ? 'transient' : 'permanent' };
        }, async dispose() {},
    } });
    if (!registered.ok) throw new Error('Forms worker registration failed');
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
    const store = createSqlOutboxStore({ database: jobsDatabase({ unit: required.unit }) });
    const outbox = createOutbox({ inputPolicy: formRetryPolicy, ports: {
        store, clock: required.clock, generateId: () => required.ids.next({}),
        async authorize(request) { try { const input = decode({ request, context: required.context }); return input.job.handler === 'forms.accept' || !!required.creative; } catch { return false; } },
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
    /** Reschedule only after the previous attempt settles; typed busy failures wait for another tick. */
    async function tick(): Promise<void> {
        try { await outbox.processOne(); }
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

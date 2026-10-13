import type { CallContext, ClockPort, IdPort, ObserverPort, Outcome } from "@open-marketing/contracts";
import type { JobRepoPort, JobDispatchPort, JobAuthorizationPort, JobObserverPort } from "./ports.js";
import type { JobService, ProcessResult, RetryPolicy, TransportResult } from "./types.js";
import { createOutbox } from "./outbox.js";
import { validateRetryPolicy } from "./retry.js";
import { decodeClaim, decodeRequest, storeFailure } from "./repository.js";
import { processResultSchema, workerSchema } from "./schema.js";
import { jobFailure } from "./errors.js";
/** Map a single attempt without inventing a known failure from an error/timeout. Non-idempotent uncertainty reconciles.
 * @complexity O(1). Dispatch adapters own trustworthy transient/permanent classification.
 */
export function dispatchResult(required: { outcome: Outcome<ProcessResult>; operationId: string }): TransportResult {
    if (!required.outcome.ok) return { kind: "failure", classification: "unknown" };
    const parsed = processResultSchema.safeParse(required.outcome.value);
    if (!parsed.success) return { kind: "failure", classification: "unknown" };
    const result = parsed.data;
    if (result.kind !== "completed" || result.jobId !== required.operationId) return { kind: "failure", classification: "unknown" };
    switch (result.state) {
        case "succeeded": return { kind: "success" };
        case "retry": return { kind: "failure", classification: "transient" };
        case "denied": case "failed": return { kind: "failure", classification: "permanent" };
        case "cancelled": case "reconcile": return { kind: "failure", classification: "unknown" };
        default: { const exhaustive: never = result.state; throw new TypeError("Invalid dispatch state: " + exhaustive); }
    }
}
/** Observers cannot turn a successful dispatch into a retry or leak provider/driver errors. @complexity O(1). */
export function observeJob(required: { observer?: ObserverPort; context: CallContext; operation: string; outcome: string }): void {
    try {
        required.observer?.observe({ operation: required.operation, outcome: required.outcome,
            correlationId: required.context.correlationId, traceId: required.context.traceId, runId: required.context.runId });
    } catch { /* Best-effort telemetry must not alter durable delivery. */ }
}
/** Timer-free worker over the repository's one outbox. Authorization is refreshed for each attempt.
 * Construction performs no I/O. Host schedules processOne independently of agent/studio sessions.
 * @example createJobService({ repo, dispatcher, authorization, clock, ids, retryPolicy })
 * @complexity O(n) bounded validation plus atomic store operations and one injected dispatch.
 */
export function createJobService(required: {
    repo: JobRepoPort; dispatcher: JobDispatchPort; authorization: JobAuthorizationPort;
    clock: ClockPort; ids: IdPort; retryPolicy: RetryPolicy;
}, optional?: { observer?: JobObserverPort }): JobService {
    validateRetryPolicy(required.retryPolicy);
    const policy = Object.freeze({ ...required.retryPolicy });
    return {
        async enqueue(input, options) {
            try {
                const outcome = await required.repo.enqueue(input, options);
                observeJob({ observer: optional?.observer, context: input.context, operation: "jobs.enqueue", outcome: outcome.ok ? outcome.value.status : outcome.error.code });
                return outcome;
            } catch (error) { return storeFailure({ error }); }
        },
        async processOne(input, options): Promise<Outcome<ProcessResult>> {
            if (!workerSchema.safeParse(input.worker).success) return jobFailure({ code: "invalid_input", message: "Invalid worker identity" });
            // Context is per invocation, so concurrent workers cannot cross-contaminate trace IDs.
            let context: CallContext | undefined;
            const outbox = createOutbox({ inputPolicy: policy, ports: {
                store: required.repo.outbox, clock: required.clock, generateId: () => required.ids.next({}),
                async authorize(lease) {
                    const claimed = decodeClaim({ lease });
                    context = claimed.context;
                    const result = await required.authorization.authorize(claimed, options);
                    if (!result.ok) throw new TypeError("Authorization unavailable");
                    return result.value.allowed === true;
                },
                transport: {
                    // The existing dispatch port has no deduplication-horizon proof. Fail closed for unknown effects.
                    idempotent: false,
                    async dispatch(request) {
                        const claimed = decodeRequest({ request });
                        const operationId = claimed.job.operationId;
                        const outcome = await required.dispatcher.dispatch({ context: claimed.context, job: claimed.job }, options);
                        return dispatchResult({ outcome, operationId });
                    },
                },
                observe(event) {
                    if (!context) return;
                    observeJob({ observer: optional?.observer, context, operation: "jobs." + event.operation, outcome: event.outcome });
                },
            } });
            try { return { ok: true, value: await outbox.processOne(options?.signal) }; }
            catch (error) { return storeFailure({ error }); }
        },
    };
}

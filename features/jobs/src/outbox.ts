import { assertEpochMilliseconds } from "@open-marketing/om-clock";
import { failureCompletion, validateRetryPolicy } from "./retry.js";
import { enqueueTimingSchema, parseTransportResult } from "./schema.js";
import { JobStoreError } from "./errors.js";
import type { AbortSignalPort, Completion, EnqueueRequest, EnqueueResult, OutboxEvent, OutboxJob, OutboxPorts, ProcessResult, RetryPolicy, TransportResult } from "./types.js";
/** Construct a timer-free outbox service. Call processOne from a host-owned scheduler.
 * Store failures propagate: never repeat an external operation merely because its ack failed.
 * @complexity O(1) local work/space per operation plus injected adapter work.
 */
export function createOutbox({ ports, inputPolicy }: {
    ports: OutboxPorts;
    inputPolicy: RetryPolicy;
}) {
    validateRetryPolicy(inputPolicy);
    const policy = Object.freeze({ ...inputPolicy });
    /** Observer failure is isolated from persistence/transport semantics. @complexity O(1).  */
    function observe(event: OutboxEvent): void {
        try {
            ports.observe?.(event);
        }
        catch { /* Telemetry must not cause duplicate delivery. */ }
    }
    /** Validate injected epoch time before storage transitions. @complexity O(1).  */
    function now(): number {
        const value = ports.clock.now({});
        assertEpochMilliseconds({ value: value });
        return value;
    }
    /** Complete only while the claim fence remains live. Adapter errors propagate. @complexity O(1).  */
    async function complete(job: OutboxJob, completion: Completion): Promise<ProcessResult> {
        const applied = await ports.store.complete({ id: job.id, tenantId: job.tenantId, token: job.leaseToken!, now: now() }, completion);
        observe({ operation: "complete", outcome: applied ? completion.state : "stale" });
        return applied ? { kind: "completed", state: completion.state, jobId: job.id } : { kind: "stale" };
    }
    /** Authorized claim processing retains pre-dispatch cancellation and current authority checks. */
    async function processClaim(required: {
        job: OutboxJob;
        signal?: AbortSignalPort;
    }): Promise<ProcessResult> {
        const { job, signal } = required;
        if (signal?.aborted)
            return complete(job, failureCompletion({ kind: "transient", attempt: job.attempts, now: now(), policy: policy, idempotent: false }));
        let authorized: boolean;
        try {
            authorized = await ports.authorize(structuredClone(job));
        }
        catch {
            observe({ operation: "authorization", outcome: "unavailable" });
            return complete(job, failureCompletion({ kind: "transient", attempt: job.attempts, now: now(), policy: policy, idempotent: false }));
        }
        observe({ operation: "authorization", outcome: authorized ? "allowed" : "denied" });
        if (!authorized)
            return complete(job, { state: "denied" });
        if (signal?.aborted)
            return complete(job, failureCompletion({ kind: "transient", attempt: job.attempts, now: now(), policy: policy, idempotent: false }));
        const result = await ports.dispatchClaim?.({ job: structuredClone(job), signal });
        if (result != null) return result;
        return dispatchTransport({ job, signal });
    }
    /** Begin-dispatch fencing precedes the transport; thrown/in-flight outcomes remain unknown. */
    async function dispatchTransport(required: {
        job: OutboxJob;
        signal?: AbortSignalPort;
    }): Promise<ProcessResult> {
        const { job, signal } = required;
        const live = await ports.store.beginDispatch({ id: job.id, tenantId: job.tenantId, token: job.leaseToken!, now: now() });
        if (!live)
            return { kind: "stale" };
        // An awaited store may return after the fence expires or cancellation arrives.
        if (now() >= job.leaseExpiresAt!)
            return { kind: "stale" };
        if (signal?.aborted)
            return complete(job, failureCompletion({ kind: "transient", attempt: job.attempts, now: now(), policy, idempotent: false }));
        let result: TransportResult;
        const request: EnqueueRequest = { tenantId: job.tenantId, idempotencyKey: job.idempotencyKey, requestDigest: job.requestDigest, operation: job.operation, payload: job.payload, context: job.context };
        try {
            result = parseTransportResult({ value: await ports.transport.dispatch(request, signal) });
        }
        catch {
            result = { kind: "failure", classification: "unknown" };
        }
        observe({ operation: "dispatch", outcome: result.kind === "success" ? "success" : result.classification });
        return complete(job, result.kind === "success" ? { state: "succeeded" } : failureCompletion({ kind: result.classification, attempt: job.attempts, now: now(), policy: policy, idempotent: ports.transport.idempotent }));
    }
    return Object.freeze({
        /** Persist one opaque request. Caller computes its canonical digest; adapters validate untrusted input.
         * Duplicate tenant/key retains its first schedule, or conflicts for different content. No payload logging.
         * @throws JobStoreError for invalid timing, before storage; omitted timing uses one injected clock read.
         * @complexity O(1) local work plus input length validation/storage.
         */
        async enqueue(input: EnqueueRequest): Promise<EnqueueResult> {
            if (![input.tenantId, input.idempotencyKey, input.requestDigest, input.operation].every(value => typeof value === "string" && value.trim().length > 0 && value.length <= 256) || typeof input.payload !== "string" || input.payload.length > 262144)
                throw new TypeError("Invalid or oversized outbox request");
            const timing = enqueueTimingSchema.safeParse({ availableAt: input.availableAt });
            if (!timing.success) throw new JobStoreError({ code: "invalid_input", message: "Invalid job timing" });
            const time = now();
            const id = ports.generateId();
            if (!id.trim())
                throw new TypeError("Empty outbox ID");
            const result = await ports.store.enqueue({ ...input, id, createdAt: time, availableAt: timing.data.availableAt ?? time, state: "pending", attempts: 0, leaseToken: null, leaseExpiresAt: null });
            observe({ operation: "enqueue", outcome: result.kind });
            return result;
        },
        /** Claim at most one job, refresh authorization and dispatch once. No sleeps or timers.
         * Thrown transport errors and in-flight cancellation are uncertain outcomes, never known failures.
         * @complexity O(1) local work/space plus atomic adapter operations.
         */
        async processOne(signal?: AbortSignalPort): Promise<ProcessResult> {
            if (signal?.aborted)
                return { kind: "aborted" };
            const time = now();
            const leaseExpiresAt = time + policy.leaseMs;
            if (!Number.isSafeInteger(leaseExpiresAt))
                throw new RangeError("Outbox lease exceeds epoch range");
            const recovered = await ports.store.recoverExpired({ now: time, limit: 100 });
            observe({ operation: "recovery", outcome: recovered > 0 ? "reconcile" : "none" });
            const leaseToken = ports.generateId();
            if (!leaseToken.trim())
                throw new TypeError("Empty outbox lease token");
            const job = await ports.store.claim({ now: time, leaseToken, leaseExpiresAt, maxAttempts: policy.maxAttempts });
            observe({ operation: "claim", outcome: job ? "claimed" : "idle" });
            if (!job)
                return { kind: "idle" };
            return processClaim({ job, signal });
        },
    });
}

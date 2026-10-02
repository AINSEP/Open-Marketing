import type { CallContext, ClockPort, IdPort, Outcome } from "@open-marketing/contracts";
import { callContextSchema } from "@open-marketing/contracts";
import type { JobRepoPort, ClaimedJob } from "./ports.js";
import type { EnqueueRequest, JobRequest, JobReceipt, OutboxJob, RetryPolicy } from "./types.js";
import type { ManagedOutboxStore } from "./store.js";
import { canonicalJson, decodeJob, jobRequestSchema, workerSchema } from "./schema.js";
import { jobFailure, JobStoreError } from "./errors.js";
import { validateRetryPolicy } from "./retry.js";
import { validateTime } from "./store.js";
/** Scope identity is unambiguous, including IDs containing separators. @complexity O(i), i <=512. */
export function jobTenant(required: { context: CallContext }): string {
    return JSON.stringify([required.context.scope.ownerId, required.context.scope.workspaceId]);
}
/** Parse and detach a domain request before persisting; digest ownership remains with its domain caller.
 * @complexity O(n log k), JSON nodes <=10000 and encoded bytes <=256KiB.
 */
export function prepareJob(required: { context: CallContext; job: JobRequest; clock: ClockPort; ids: IdPort }): OutboxJob {
    const context = callContextSchema.parse(required.context);
    const payload = canonicalJson({ value: required.job });
    const job = jobRequestSchema.parse(JSON.parse(payload));
    const now = required.clock.now({});
    validateTime({ now });
    return {
        id: required.ids.next({}), tenantId: jobTenant({ context }), context,
        idempotencyKey: job.idempotencyKey, requestDigest: job.argumentsDigest, operation: job.handler,
        payload, state: "pending", attempts: 0, availableAt: now, createdAt: now,
        leaseToken: null, leaseExpiresAt: null,
    };
}
/** Persisted scope and immutable operation identity must match the envelope before any authorization/effect.
 * @complexity O(n) under the JSON bounds. Throws for corrupt storage; caller fails closed.
 */
export function decodeClaim(required: { lease: OutboxJob }): ClaimedJob {
    return { ...decodeRequest({ request: required.lease }), lease: structuredClone(required.lease) };
}
/** Decode an outbound envelope without inventing a lease. @complexity O(n) bounded JSON parsing. */
export function decodeRequest(required: { request: EnqueueRequest }): { context: CallContext; job: JobRequest } {
    const context = callContextSchema.parse(required.request.context);
    const job = decodeJob(required.request);
    if (required.request.tenantId !== jobTenant({ context })) throw new TypeError("Job scope mismatch");
    if (job.handler !== required.request.operation || job.idempotencyKey !== required.request.idempotencyKey || job.argumentsDigest !== required.request.requestDigest) throw new TypeError("Job identity mismatch");
    return { context, job };
}
/** Repository wrapper supplies typed boundaries around one injected store. Construction performs no I/O.
 * @example createJobRepository({ outbox, clock, ids, retryPolicy })
 * @complexity O(n) bounded validation plus one enqueue transaction or recovery/claim transactions.
 */
export function createJobRepository(required: { outbox: ManagedOutboxStore; clock: ClockPort; ids: IdPort; retryPolicy: RetryPolicy }): JobRepoPort {
    validateRetryPolicy(required.retryPolicy);
    const policy = Object.freeze({ ...required.retryPolicy });
    return {
        outbox: required.outbox,
        async enqueue(input, optional): Promise<Outcome<JobReceipt>> {
            if (optional?.signal?.aborted) return jobFailure({ code: "cancelled", message: "Enqueue cancelled" });
            let pending: OutboxJob;
            try { pending = prepareJob({ ...input, ...required }); }
            catch { return jobFailure({ code: "invalid_input", message: "Invalid job request" }); }
            try {
                const result = await required.outbox.enqueue(pending);
                if (result.kind === "conflict") return jobFailure({ code: "conflict", message: "Idempotency key already binds another request" });
                return { ok: true, value: { jobId: result.job.id, operationId: input.job.operationId, status: result.kind === "inserted" ? "enqueued" : "existing" } };
            } catch (error) { return storeFailure({ error }); }
        },
        async claim(input, optional): Promise<Outcome<ClaimedJob | null>> {
            if (!workerSchema.safeParse(input.worker).success) return jobFailure({ code: "invalid_input", message: "Invalid worker identity" });
            if (optional?.signal?.aborted) return jobFailure({ code: "cancelled", message: "Claim cancelled" });
            try {
                const now = required.clock.now({});
                await required.outbox.recoverExpired({ now, limit: 100 });
                const lease = await required.outbox.claim({ now, leaseToken: required.ids.next({}), leaseExpiresAt: now + policy.leaseMs, maxAttempts: policy.maxAttempts });
                if (!lease) return { ok: true, value: null };
                return { ok: true, value: decodeClaim({ lease }) };
            } catch (error) { return storeFailure({ error }); }
        },
    };
}
/** Infrastructure errors are never treated as proof that an external effect did not occur. @complexity O(1). */
export function storeFailure<T>(required: { error: unknown }): Outcome<T> {
    if (required.error instanceof JobStoreError) return jobFailure({ code: required.error.code, message: required.error.message, retryable: required.error.code === "unavailable" });
    return jobFailure({ code: "unavailable", message: "Job storage unavailable or invalid; durable state requires recovery", retryable: true });
}

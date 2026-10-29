import type { CallContext, CallOptions, Outcome } from "@open-marketing/contracts";
import type { JobRequest, JobReceipt, WorkerIdentity, OutboxJob, ProcessResult } from "./types.js";
import type { ManagedOutboxStore } from "./store.js";
import type { z } from "zod";
import type { enqueueTimingSchema } from "./schema.js";
/** A claim retains the immutable context and complete fence; callers never dispatch a bare request. */
export interface ClaimedJob {
    readonly context: CallContext;
    readonly job: JobRequest;
    readonly lease: OutboxJob;
}
/** One repository owns the single outbox. Durable implementations expose the same fenced store to the worker. */
export interface JobRepoPort {
    readonly outbox: ManagedOutboxStore;
    /** Timing is earliest eligibility, validated before storage; duplicates preserve the original schedule. */
    enqueue(required: { context: CallContext; job: JobRequest } & z.infer<typeof enqueueTimingSchema>, optional?: CallOptions): Promise<Outcome<JobReceipt>>;
    claim(required: { worker: WorkerIdentity }, optional?: CallOptions): Promise<Outcome<ClaimedJob | null>>;
}
/** Dispatch performs one attempt only. A returned retry means known transient failure; reconcile means uncertain effect.
 * Implementations must preserve the stable operation/key/digest and recheck authority through their dispatch barrier.
 * A completed dispatch's jobId is the request's operationId; the worker reports the persisted outbox ID to its caller.
 * The jobs worker owns persistence/retries unless a claim handler settles the same fenced outbox.
 * Adapters cannot implement another queue.
 */
export interface JobDispatchPort {
    dispatch(required: { context: CallContext; job: JobRequest }, optional?: CallOptions): Promise<Outcome<ProcessResult>>;
    /** Optional claim owner; null means no claim handler; a handler's own result is always wrapped. Durable state determines completion. */
    dispatchClaim?(required: ClaimedJob, optional?: CallOptions): Promise<Outcome<{ readonly settled: unknown } | null>>;
}
/** Fresh caller-owned authority/halt decision immediately before each attempt. Failure grants no authority. */
export interface JobAuthorizationPort {
    authorize(required: { context: CallContext; job: JobRequest }, optional?: CallOptions): Promise<Outcome<{ readonly allowed: boolean }>>;
}

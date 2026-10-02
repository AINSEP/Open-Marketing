import type { CallContext, CallOptions, ObserverPort, Outcome } from "@open-marketing/contracts";
import type { JobRequest, JobReceipt, WorkerIdentity, OutboxJob, ProcessResult } from "./types.js";
import type { ManagedOutboxStore } from "./store.js";
/** A claim retains the immutable context and complete fence; callers never dispatch a bare request. */
export interface ClaimedJob {
    readonly context: CallContext;
    readonly job: JobRequest;
    readonly lease: OutboxJob;
}
/** One repository owns the single outbox. Durable implementations expose the same fenced store to the worker. */
export interface JobRepoPort {
    readonly outbox: ManagedOutboxStore;
    enqueue(required: { context: CallContext; job: JobRequest }, optional?: CallOptions): Promise<Outcome<JobReceipt>>;
    claim(required: { worker: WorkerIdentity }, optional?: CallOptions): Promise<Outcome<ClaimedJob | null>>;
}
/** Dispatch performs one attempt only. A returned retry means known transient failure; reconcile means uncertain effect.
 * Implementations must preserve the stable operation/key/digest and recheck authority through their dispatch barrier.
 * The jobs worker owns persistence/retries; adapters cannot implement another queue.
 */
export interface JobDispatchPort {
    dispatch(required: { context: CallContext; job: JobRequest }, optional?: CallOptions): Promise<Outcome<ProcessResult>>;
}
/** Fresh caller-owned authority/halt decision immediately before each attempt. Failure grants no authority. */
export interface JobAuthorizationPort {
    authorize(required: { context: CallContext; job: JobRequest }, optional?: CallOptions): Promise<Outcome<{ readonly allowed: boolean }>>;
}
export type JobObserverPort = ObserverPort;

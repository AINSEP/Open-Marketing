import type { Outcome, CallContext, CallOptions, ClockPort, IdPort, ObserverPort, Scope, Page, PageQuery, ConfirmationCard, EffectEnvelope, GenerationAllowanceSettings, GenerationCostQuote, GenerationApprovalRequirement, HaltStopRequest, HaltStopPermit, ServiceContext, MeasurementGrant, CapabilityEnvelope } from "@open-marketing/contracts";
import type { Clock } from "@open-marketing/om-clock";
export type JobState = "pending" | "leased" | "dispatching" | "retry" | "succeeded" | "denied" | "failed" | "reconcile";
export type FailureKind = "permanent" | "transient" | "unknown";
/** Payload is opaque serialized data. Digest must cover operation and payload exactly. */
export interface EnqueueRequest {
    readonly tenantId: string;
    readonly idempotencyKey: string;
    readonly requestDigest: string;
    readonly operation: string;
    readonly payload: string;
}
export interface OutboxJob extends EnqueueRequest {
    readonly id: string;
    readonly state: JobState;
    readonly attempts: number;
    readonly availableAt: number;
    readonly createdAt: number;
    readonly leaseToken: string | null;
    readonly leaseExpiresAt: number | null;
}
export interface LeaseFence {
    readonly id: string;
    readonly tenantId: string;
    readonly token: string;
    readonly now: number;
}
export type Completion = {
    readonly state: "succeeded" | "denied" | "failed" | "reconcile";
} | {
    readonly state: "retry";
    readonly availableAt: number;
};
export type EnqueueResult = {
    readonly kind: "inserted" | "existing";
    readonly job: OutboxJob;
} | {
    readonly kind: "conflict";
};
/** Every method MUST be atomic and durable in production. No in-memory implementation ships.
 * Tenant/key uniqueness compares digest AND exact operation/payload; conflicts never overwrite.
 * claim selects one due pending/retry job, installs a unique lease and increments attempts.
 * beginDispatch and complete compare tenant, id, token, state AND unexpired lease atomically.
 * Expired leased/dispatching jobs become reconcile, never automatically eligible for a claim.
 * Returned values must be detached immutable snapshots, not mutable storage records.
 */
export interface OutboxStore {
    enqueue(job: OutboxJob): Promise<EnqueueResult>;
    recoverExpired(input: {
        readonly now: number;
        readonly limit: number;
    }): Promise<number>;
    claim(input: {
        readonly now: number;
        readonly leaseToken: string;
        readonly leaseExpiresAt: number;
        readonly maxAttempts: number;
    }): Promise<OutboxJob | null>;
    beginDispatch(fence: LeaseFence): Promise<boolean>;
    complete(fence: LeaseFence, completion: Completion): Promise<boolean>;
}
/** An aborted signal prevents new transport calls; an in-flight call may still have succeeded. */
export interface AbortSignalPort {
    readonly aborted: boolean;
}
export type TransportResult = {
    readonly kind: "success";
} | {
    readonly kind: "failure";
    readonly classification: FailureKind;
};
export interface Transport {
    /** True only when destination deduplicates this tenant/key across the entire retry horizon. */
    readonly idempotent: boolean;
    dispatch(input: EnqueueRequest, signal?: AbortSignalPort): Promise<TransportResult>;
}
export interface RetryPolicy {
    readonly maxAttempts: number;
    readonly baseDelayMs: number;
    readonly maxDelayMs: number;
    readonly leaseMs: number;
}
/** Contains no tenant, payload, digest, provider response, or exception text. */
export interface OutboxEvent {
    readonly operation: "enqueue" | "claim" | "authorization" | "dispatch" | "complete" | "recovery";
    readonly outcome: string;
}
export interface OutboxPorts {
    readonly store: OutboxStore;
    readonly clock: Clock;
    /** Must generate globally unique values, including distinct claim tokens. */
    readonly generateId: () => string;
    readonly transport: Transport;
    /** Refresh permission/halt state immediately before each outbound attempt; no gate duplication. */
    readonly authorize: (job: OutboxJob) => Promise<boolean>;
    /** Best-effort observer: exceptions cannot alter delivery or manufacture a retry. */
    readonly observe?: (event: OutboxEvent) => void;
}
export type ProcessResult = {
    readonly kind: "idle" | "aborted" | "stale";
} | {
    readonly kind: "completed";
    readonly state: Completion["state"];
    readonly jobId: string;
};
/** JobRequest domain value; validation belongs at the boundary. */
export type JobRequest = {
    readonly operationId: string;
    readonly idempotencyKey: string;
    readonly argumentsDigest: string;
    readonly handler: string;
    readonly payload: Readonly<Record<string, unknown>>;
};
/** JobReceipt domain value; validation belongs at the boundary. */
export type JobReceipt = {
    readonly jobId: string;
    readonly operationId: string;
    readonly status: "enqueued" | "existing";
};
/** WorkerIdentity domain value; validation belongs at the boundary. */
export type WorkerIdentity = {
    readonly workerId: string;
};
/** TransactionalEnqueue domain value; validation belongs at the boundary. */
export type TransactionalEnqueue = {
    enqueue(required: {
        context: CallContext;
        job: JobRequest;
    }, optional?: CallOptions): Promise<Outcome<JobReceipt>>;
};
/** DomainIntentTransactionPort domain value; validation belongs at the boundary. */
export type DomainIntentTransactionPort = {
    commit(required: {
        context: CallContext;
        intentId: string;
        job: JobRequest;
    }, optional?: CallOptions): Promise<Outcome<JobReceipt>>;
};
export interface JobService {
    enqueue(required: {
        context: CallContext;
        job: JobRequest;
    }, optional?: CallOptions): Promise<Outcome<JobReceipt>>;
    processOne(required: {
        worker: WorkerIdentity;
    }, optional?: CallOptions): Promise<Outcome<ProcessResult>>;
}

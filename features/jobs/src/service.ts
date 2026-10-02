import type { Outcome, CallContext, CallOptions, ClockPort, IdPort, ObserverPort, Scope, Money, TimeWindow, Page, PageQuery, ConfirmationCard, EffectEnvelope, GenerationAllowanceSettings, GenerationCostQuote, GenerationApprovalRequirement, HaltStopRequest, HaltStopPermit, ServiceContext, MeasurementGrant, CapabilityEnvelope } from "@open-marketing/contracts";
import { notImplemented } from "@open-marketing/contracts";
import type { JobRepoPort, JobDispatchPort, JobAuthorizationPort, JobObserverPort } from "./ports.js";
import type { JobState, FailureKind, EnqueueRequest, OutboxJob, LeaseFence, Completion, EnqueueResult, OutboxStore, AbortSignalPort, TransportResult, Transport, RetryPolicy, OutboxEvent, OutboxPorts, ProcessResult, JobRequest, JobReceipt, WorkerIdentity, TransactionalEnqueue, DomainIntentTransactionPort, JobService } from "./types.js";
/** Inert jobs factory. @returns Service whose operations fail with typed not_implemented; no I/O or startup. @example createJobService({ injectedPorts: undefined } as Parameters<typeof createJobService>[0]) @complexity O(1). */
export function createJobService(required: {
    repo: JobRepoPort;
    dispatcher: JobDispatchPort;
    authorization: JobAuthorizationPort;
    clock: ClockPort;
    ids: IdPort;
    retryPolicy: RetryPolicy;
}, optional?: {
    observer?: JobObserverPort;
}): JobService {
    return {
        async enqueue() { return notImplemented({ operation: "jobs.enqueue" }); },
        async processOne() { return notImplemented({ operation: "jobs.processOne" }); },
    };
}

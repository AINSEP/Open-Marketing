import type { Outcome, CallContext, CallOptions, ClockPort, IdPort, ObserverPort, Scope, Money, TimeWindow, Page, PageQuery, ConfirmationCard, EffectEnvelope, GenerationAllowanceSettings, GenerationCostQuote, GenerationApprovalRequirement, HaltStopRequest, HaltStopPermit, ServiceContext, MeasurementGrant, CapabilityEnvelope } from "@open-marketing/contracts";
import type { JobState, FailureKind, EnqueueRequest, OutboxJob, LeaseFence, Completion, EnqueueResult, OutboxStore, AbortSignalPort, TransportResult, Transport, RetryPolicy, OutboxEvent, OutboxPorts, ProcessResult, JobRequest, JobReceipt, WorkerIdentity, TransactionalEnqueue, DomainIntentTransactionPort, JobService } from "./types.js";
/** JobRepoPort: caller-owned, injected boundary. j00 doubles fail explicitly until its owning job implements the suite. */
export interface JobRepoPort {
    enqueue(required: {
        context: CallContext;
        job: JobRequest;
    }, optional?: CallOptions): Promise<Outcome<JobReceipt>>;
    claim(required: {
        worker: WorkerIdentity;
    }, optional?: CallOptions): Promise<Outcome<JobRequest | null>>;
}
/** JobDispatchPort: caller-owned, injected boundary. j00 doubles fail explicitly until its owning job implements the suite. */
export interface JobDispatchPort {
    dispatch(required: {
        context: CallContext;
        job: JobRequest;
    }, optional?: CallOptions): Promise<Outcome<ProcessResult>>;
}
/** JobAuthorizationPort: caller-owned, injected boundary. j00 doubles fail explicitly until its owning job implements the suite. */
export interface JobAuthorizationPort {
    authorize(required: {
        context: CallContext;
        job: JobRequest;
    }, optional?: CallOptions): Promise<Outcome<{
        readonly allowed: boolean;
    }>>;
}
export type JobObserverPort = ObserverPort;

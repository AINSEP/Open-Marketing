import type { Outcome, CallContext, CallOptions, ClockPort, IdPort, ObserverPort, Scope, Money, TimeWindow, Page, PageQuery, ConfirmationCard, EffectEnvelope, GenerationAllowanceSettings, GenerationCostQuote, GenerationApprovalRequirement, HaltStopRequest, HaltStopPermit, ServiceContext, MeasurementGrant, CapabilityEnvelope } from "@open-marketing/contracts";
import type { GenerationRequest, GenerationReceipt, GenerationStatus, GenerationCostObservation, GenerationProvenance, GenerationOutput, GenerationPollRequest } from "./types.js";
import type { PollDueStats, RecoverResult, AsyncOperationStore } from '@jini-ai/integrations/media-providers';
/** Public durable async store reused by plugin/platform adapters; no driver or credential material. */
export type GenerationOperationStore = AsyncOperationStore;
/** CreativeRepoPort: caller-owned, injected boundary. j00 doubles fail explicitly until its owning job implements the suite. */
export interface CreativeRepoPort {
 save(required: { context: CallContext; status: GenerationStatus }, optional?: CallOptions): Promise<Outcome<GenerationStatus>>;
 get(required: { context: CallContext; generationId: string }, optional?: CallOptions): Promise<Outcome<GenerationStatus>>;
 appendCost(required: { context: CallContext; cost: GenerationCostObservation }, optional?: CallOptions): Promise<Outcome<void>>;
}
/** Caller-owned adapter over Jini startOperation/pollDueOperations/recoverAfterRestart.
 * Runtime execution and vendor adapters live in plugins. Safety is rechecked before every dispatch.
 * Cancel stops local scheduling only; it must never imply vendor cancellation or a refund.
 */
export interface GenerationCapabilityPort {
 quote(required: { context: CallContext; request: GenerationRequest }, optional?: CallOptions): Promise<Outcome<GenerationCostQuote>>;
 generate(required: { context: CallContext; request: GenerationRequest }, optional?: CallOptions): Promise<Outcome<GenerationReceipt>>;
 status(required: { context: CallContext; generationId: string }, optional?: CallOptions): Promise<Outcome<GenerationStatus>>;
 pollDue(required: { context: CallContext; request: GenerationPollRequest }, optional?: CallOptions): Promise<Outcome<PollDueStats>>;
 recover(required: { context: CallContext }, optional?: CallOptions): Promise<Outcome<RecoverResult>>;
 cancel(required: { context: CallContext; generationId: string }, optional?: CallOptions): Promise<Outcome<GenerationStatus>>;
}
/** CreativeAssetPort: caller-owned, injected boundary. j00 doubles fail explicitly until its owning job implements the suite. */
export interface CreativeAssetPort {
 import(required: { context: CallContext; generationId: string; operationId: string; output: GenerationOutput; provenance: GenerationProvenance }, optional?: CallOptions): Promise<Outcome<{ readonly assetId: string }>>;
 recordProvenance(required: { context: CallContext; provenance: GenerationProvenance }, optional?: CallOptions): Promise<Outcome<void>>;
 recordCost(required: { context: CallContext; cost: GenerationCostObservation }, optional?: CallOptions): Promise<Outcome<void>>;
}
/** CreativeJobPort: caller-owned, injected boundary. j00 doubles fail explicitly until its owning job implements the suite. */
export interface CreativeJobPort {
 enqueue(required: { context: CallContext; operationId: string; argumentsDigest: string }, optional?: CallOptions): Promise<Outcome<{ readonly jobId: string }>>;
}
/** CreativeSpendPort: caller-owned, injected boundary. j00 doubles fail explicitly until its owning job implements the suite. */
export interface CreativeSpendPort {
 assess(required: { context: CallContext; request: GenerationRequest; quote: GenerationCostQuote }, optional?: CallOptions): Promise<Outcome<GenerationApprovalRequirement>>;
}
/** CreativeAuditPort: caller-owned, injected boundary. j00 doubles fail explicitly until its owning job implements the suite. */
export interface CreativeAuditPort {
 record(required: { context: CallContext; operationId: string; outcome: string }, optional?: CallOptions): Promise<Outcome<void>>;
}
export type CreativeObserverPort = ObserverPort;

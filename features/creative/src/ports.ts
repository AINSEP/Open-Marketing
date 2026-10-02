import type { Outcome, CallContext, CallOptions, ObserverPort, GenerationCostQuote, GenerationApprovalRequirement } from "@open-marketing/contracts";
import type { PollDueStats, RecoverResult, AsyncOperationStore } from "@jini-ai/integrations/media-providers";
import type { GenerationRequest, GenerationReceipt, GenerationStatus, GenerationCostObservation, GenerationProvenance, GenerationOutput, GenerationPollRequest } from "./types.js";

/** Public durable store injected by plugin/platform composition, never MediaTaskStore. */
export type GenerationOperationStore = AsyncOperationStore;

/** Scoped persistence, optimistic revisions, immutable intent, and append-only cost identities. */
export interface CreativeRepoPort {
  save(required: { context: CallContext; status: GenerationStatus; expectedRevision?: number }, optional?: CallOptions): Promise<Outcome<GenerationStatus>>;
  get(required: { context: CallContext; generationId: string }, optional?: CallOptions): Promise<Outcome<GenerationStatus>>;
  claimDispatch(required: { context: CallContext; generationId: string }, optional?: CallOptions): Promise<Outcome<{ readonly claimed: boolean; readonly status: GenerationStatus }>>;
  list(required: { context: CallContext; limit: number; cursor?: string }, optional?: CallOptions): Promise<Outcome<{ readonly items: readonly GenerationStatus[]; readonly cursor: string | null }>>;
  appendCost(required: { context: CallContext; cost: GenerationCostObservation }, optional?: CallOptions): Promise<Outcome<void>>;
}

/** Generic capability over Jini's durable runtime. Generate consumes the original quote, never a new one. */
export interface GenerationCapabilityPort {
  quote(required: { context: CallContext; request: GenerationRequest }, optional?: CallOptions): Promise<Outcome<GenerationCostQuote>>;
  generate(required: { context: CallContext; request: GenerationRequest; quote: GenerationCostQuote; generationId: string }, optional?: CallOptions): Promise<Outcome<GenerationReceipt>>;
  status(required: { context: CallContext; generationId: string }, optional?: CallOptions): Promise<Outcome<GenerationStatus>>;
  pollDue(required: { context: CallContext; request: GenerationPollRequest }, optional?: CallOptions): Promise<Outcome<PollDueStats>>;
  recover(required: { context: CallContext }, optional?: CallOptions): Promise<Outcome<RecoverResult>>;
  cancel(required: { context: CallContext; generationId: string }, optional?: CallOptions): Promise<Outcome<GenerationStatus>>;
}

/** Effects deduplicate stable identities; failed generation may have cost/provenance without an asset. */
export interface CreativeAssetPort {
  import(required: { context: CallContext; generationId: string; operationId: string; output: GenerationOutput; provenance: GenerationProvenance }, optional?: CallOptions): Promise<Outcome<{ readonly assetId: string }>>;
  recordProvenance(required: { context: CallContext; provenance: GenerationProvenance }, optional?: CallOptions): Promise<Outcome<void>>;
  recordCost(required: { context: CallContext; cost: GenerationCostObservation }, optional?: CallOptions): Promise<Outcome<void>>;
}

/** One jobs outbox. Adapter MUST insert intent and enqueue in the SAME transaction, or fail. */
export interface CreativeJobPort {
  enqueue(required: { context: CallContext; operationId: string; argumentsDigest: string; intent: GenerationStatus }, optional?: CallOptions): Promise<Outcome<{ readonly jobId: string }>>;
}

/** Safety owns cards, authority, allowance and settlement. assess is presentation evidence only.
 * withDispatch rechecks authority and reserves before exactly one bounded handoff.
 * Unknown/failed/cancelled outcomes never release exposure or imply a refund.
 */
export interface CreativeSpendPort {
  assess(required: { context: CallContext; request: GenerationRequest; quote: GenerationCostQuote }, optional?: CallOptions): Promise<Outcome<GenerationApprovalRequirement>>;
  withDispatch<T>(required: { context: CallContext; request: GenerationRequest; quote: GenerationCostQuote; dispatch: (required: { reservationId: string }) => Promise<Outcome<T>> }, optional?: CallOptions): Promise<Outcome<T>>;
  settle(required: { context: CallContext; reservationId: string; cost: GenerationCostObservation }, optional?: CallOptions): Promise<Outcome<void>>;
}

/** Append-only lifecycle events carry context; prompts/credentials are not logged. */
export interface CreativeAuditPort {
  record(required: { context: CallContext; operationId: string; outcome: string }, optional?: CallOptions): Promise<Outcome<void>>;
}

/** Injected observer must not throw or affect authority. */
export type CreativeObserverPort = ObserverPort;

import type { Outcome, CallContext, CallOptions, Money, GenerationCostQuote, GenerationApprovalRequirement } from "@open-marketing/contracts";
import type { AsyncOperationRecord, AsyncOperationResult, MediaSurface, PollDueStats, RecoverResult } from "@jini-ai/integrations/media-providers";

/** Reviewed arguments. Digests cover the payload excluding approvalId; rights evidence is mandatory. */
export type GenerationRequest = {
  readonly capabilityId: string;
  readonly operationId: string;
  readonly argumentsDigest: string;
  readonly configurationDigest: string;
  readonly prompt: string;
  readonly surface: MediaSurface;
  readonly model: string;
  readonly seed: number | null;
  readonly maxAttempts: number;
  readonly deadlineAt: number;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly rightsEvidenceId: string;
  readonly vendorTermsDigest: string | null;
  readonly approvalId?: string;
};

/** A queued receipt has no async operation until the durable worker dispatches it. */
export type GenerationReceipt = {
  readonly generationId: string;
  readonly operationId: string;
  readonly asyncOperationId: string | null;
  readonly status: "pending" | "succeeded";
};

/** Durable intent and projection. Original request, quote and assessment are immutable after enqueue. */
export type GenerationStatus = {
  readonly generationId: string;
  readonly state: "pending" | "running" | "succeeded" | "failed" | "cancelled" | "unknown";
  readonly request: GenerationRequest;
  readonly approval: GenerationApprovalRequirement;
  readonly dispatchState: "queued" | "dispatching" | "submitted";
  readonly reservationId: string | null;
  readonly asyncOperationId: string | null;
  readonly revision: number;
  readonly operation: AsyncOperationRecord | null;
  readonly providerJobId: string | null;
  readonly assetIds: readonly string[];
  readonly quote: GenerationCostQuote;
  readonly actualCost: Money | null;
  readonly costs: readonly GenerationCostObservation[];
};

/** Append-only observations. Corrections name an existing observation; identities deduplicate retries. */
export type GenerationCostObservation = {
  readonly observationId: string;
  readonly generationId: string;
  readonly operationId: string;
  readonly amount: Money;
  readonly kind: "estimated" | "actual" | "correction";
  readonly correctionOf?: string;
};

/** Provenance remains recordable when failed/delayed generation produced no asset. */
export type GenerationProvenance = {
  readonly operationId: string;
  readonly generationId: string;
  readonly prompt: string;
  readonly model: string;
  readonly seed: number | null;
  readonly quoteId: string;
  readonly vendorTermsDigest: string | null;
  readonly rightsEvidenceId: string;
  readonly assetId?: string;
};

/** URL outputs are validated/fetched by the media adapter, never creative core. */
export type GenerationOutput = { readonly kind: "bytes"; readonly result: AsyncOperationResult }
  | { readonly kind: "url"; readonly sourceUrl: string; readonly expectedDigest: string };

/** One tick is capped at 100 operations with a 1–60 second lease. */
export type GenerationPollRequest = { readonly leaseOwner: string; readonly leaseMs: number; readonly limit: number; readonly cursor?: string };

/** Server/job-worker lifecycle; construction performs no effects and no agent session is needed. */
export interface CreativeService {
  requestGeneration(required: { context: CallContext; request: GenerationRequest }, optional?: CallOptions): Promise<Outcome<GenerationReceipt>>;
  dispatchGeneration(required: { context: CallContext; generationId: string }, optional?: CallOptions): Promise<Outcome<GenerationReceipt>>;
  refreshJob(required: { context: CallContext; generationId: string }, optional?: CallOptions): Promise<Outcome<GenerationStatus>>;
  pollDue(required: { context: CallContext; request: GenerationPollRequest }, optional?: CallOptions): Promise<Outcome<PollDueStats & { readonly reconcileCursor: string | null }>>;
  recover(required: { context: CallContext }, optional?: CallOptions): Promise<Outcome<RecoverResult>>;
  cancelGeneration(required: { context: CallContext; generationId: string }, optional?: CallOptions): Promise<Outcome<GenerationStatus>>;
}

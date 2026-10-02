import type { Outcome, CallContext, CallOptions, Money, GenerationCostQuote } from "@open-marketing/contracts";
import type { AsyncOperationRecord, AsyncOperationResult, MediaSurface, PollDueStats, RecoverResult } from '@jini-ai/integrations/media-providers';
/** GenerationRequest domain value; validation belongs at the boundary. */
export type GenerationRequest = { readonly capabilityId: string; readonly operationId: string; readonly argumentsDigest: string; readonly configurationDigest: string; readonly prompt: string; readonly surface: MediaSurface; readonly model: string; readonly seed: number | null; readonly maxAttempts: number; readonly deadlineAt: number; readonly parameters: Readonly<Record<string, unknown>> };
/** GenerationReceipt domain value; validation belongs at the boundary. */
export type GenerationReceipt = { readonly generationId: string; readonly operationId: string; readonly asyncOperationId: string; readonly status: "pending" | "succeeded" };
/** GenerationStatus domain value; validation belongs at the boundary. */
export type GenerationStatus = { readonly generationId: string; readonly state: "pending" | "running" | "succeeded" | "failed" | "cancelled" | "unknown"; readonly operation: AsyncOperationRecord | null; readonly providerJobId: string | null; readonly assetIds: readonly string[]; readonly quote: GenerationCostQuote; readonly actualCost: Money | null };
/** Append-only cost observations, including charged failures and linked corrections. */
export type GenerationCostObservation = { readonly observationId: string; readonly generationId: string; readonly operationId: string; readonly amount: Money; readonly kind: 'estimated' | 'actual' | 'correction'; readonly correctionOf?: string };
/** Caller-owned media evidence; assetId may be absent for failed or delayed output. */
export type GenerationProvenance = { readonly operationId: string; readonly generationId: string; readonly prompt: string; readonly model: string; readonly seed: number | null; readonly quoteId: string; readonly vendorTermsDigest: string | null; readonly rightsEvidenceId: string; readonly assetId?: string };
/** Jini's async result carries bytes; URL-based plugin outputs use the guarded import seam. */
export type GenerationOutput = { readonly kind: 'bytes'; readonly result: AsyncOperationResult } | { readonly kind: 'url'; readonly sourceUrl: string; readonly expectedDigest: string };
/** One bounded durable worker tick; jobs owns scheduling and credentials stay inside plugins. */
export type GenerationPollRequest = { readonly leaseOwner: string; readonly leaseMs: number; readonly limit: number };
/** Safety-authorized lifecycle over Jini async operations; no vendor execution in this core. */
export interface CreativeService {
  requestGeneration(
    required: { context: CallContext; request: GenerationRequest },
    optional?: CallOptions,
  ): Promise<Outcome<GenerationReceipt>>;

  refreshJob(
    required: { context: CallContext; generationId: string },
    optional?: CallOptions,
  ): Promise<Outcome<GenerationStatus>>;

  pollDue(required: { context: CallContext; request: GenerationPollRequest }, optional?: CallOptions): Promise<Outcome<PollDueStats>>;
  recover(required: { context: CallContext }, optional?: CallOptions): Promise<Outcome<RecoverResult>>;
  cancelGeneration(required: { context: CallContext; generationId: string }, optional?: CallOptions): Promise<Outcome<GenerationStatus>>;
}

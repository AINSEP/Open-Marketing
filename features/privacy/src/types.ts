import type { CallContext, CallOptions, Outcome, Scope } from "@open-marketing/contracts";

/** Plan removal before purging reloadable local data; attest after every participant completes. */
export type ErasurePhase = "plan" | "externalRemoval" | "purgeLocal" | "attest";
/** Kept by policy after erasure; contains no address or rendered content. */
export interface RetainedSuppressionDigest { readonly identifierDigest: string; readonly keyVersion: string; readonly purpose: string; readonly topic: string; readonly reason: string }
/** Progress retains counts/IDs, purging payloads. Pending external removal is never reported complete. */
export interface ParticipantProgress { readonly participantId: string; readonly phase: ErasurePhase; readonly status: "pending" | "complete" | "failed"; readonly removedCount: number }
/** Durable request freezes participant IDs and blocks processing before removal begins. */
export interface ErasureRequest {
  readonly scope: Scope;
  readonly requestId: string;
  readonly subjectId: string;
  readonly requestedAt: number;
  readonly phase: ErasurePhase;
  readonly status: "pending" | "complete" | "failed";
  readonly participants: readonly ParticipantProgress[];
  readonly retainedSuppression: readonly RetainedSuppressionDigest[];
}
/** Frozen API; participant failures are explicit and leave the subject blocked. */
export interface PrivacyService {
  requestErasure(required: { context: CallContext; subjectId: string }, optional?: CallOptions): Promise<Outcome<ErasureRequest>>;
  advance(required: { context: CallContext; requestId: string }, optional?: CallOptions): Promise<Outcome<ErasureRequest>>;
  status(required: { context: CallContext; requestId: string }, optional?: CallOptions): Promise<Outcome<ErasureRequest>>;
}

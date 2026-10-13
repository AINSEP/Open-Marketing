import type { CallContext, CallOptions, Outcome } from "@open-marketing/contracts";
import type { ErasurePhase, ErasureRequest } from "./types.js";

/** Owner removes external copies, local PII and hashed transmission payloads idempotently by request/phase.
 * @example participant.run({ context, requestId, subjectId, phase: "purgeLocal" }) */
export interface ErasureParticipantPort {
  readonly id: string;
  run(required: { context: CallContext; requestId: string; subjectId: string; phase: ErasurePhase }, optional?: CallOptions): Promise<Outcome<{ readonly complete: boolean; readonly removedCount: number }>>;
}
/** Instance-owned, bounded participants (<=100); duplicate IDs conflict, dispose releases registrations.
 * Composition registers contacts/forms/web-events/measure now and later owners without editing privacy.
 * @example participants.register({ participant }) */
export interface ErasureParticipantRegistry {
  register(required: { participant: ErasureParticipantPort }): Outcome<void>;
  unregister(required: { id: string }): Outcome<void>;
  list(required: Record<string, never>): Outcome<readonly ErasureParticipantPort[]>;
  reset(required: Record<string, never>): Outcome<void>;
  dispose(required: Record<string, never>): Outcome<void>;
}
/** Scoped durable progress; preserve row/counts and suppression digests, never addresses/payloads.
 * @example repo.get({ context, requestId }) */
export interface PrivacyRepoPort {
  create(required: { context: CallContext; request: ErasureRequest }, optional?: CallOptions): Promise<Outcome<ErasureRequest>>;
  get(required: { context: CallContext; requestId: string }, optional?: CallOptions): Promise<Outcome<ErasureRequest | null>>;
  save(required: { context: CallContext; request: ErasureRequest }, optional?: CallOptions): Promise<Outcome<ErasureRequest>>;
}
/** Shared dispatch barrier blocks processing before any erasure phase; missing authority denies.
 * @example block.block({ context, requestId, subjectId }) */
export interface PrivacyProcessingBlockPort {
  block(required: { context: CallContext; requestId: string; subjectId: string }, optional?: CallOptions): Promise<Outcome<void>>;
}

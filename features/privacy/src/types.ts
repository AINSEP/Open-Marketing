import { z } from "zod";
import { digestSchema, epochSchema, idSchema, scopeSchema } from "@open-marketing/contracts";
import type { CallContext, CallOptions, Outcome } from "@open-marketing/contracts";

/** Fixed phase order; at most 100 participants and 400 checkpoints. */
export const phases = ["plan", "externalRemoval", "purgeLocal", "attest"] as const;
const phaseSchema = z.enum(phases);
const statusSchema = z.enum(["pending", "complete", "failed"]);
/** Tombstones contain keyed digests and bounded metadata, never raw identifiers. */
export const suppressionSchema = z.strictObject({ identifierDigest: digestSchema, keyVersion: idSchema, purpose: idSchema, topic: idSchema, reason: idSchema });
const progressSchema = z.strictObject({ participantId: idSchema, phase: phaseSchema, status: statusSchema, removedCount: epochSchema });
/** Persisted records are tainted until both their shape and phase invariants pass. */
export const requestSchema = z.strictObject({ scope: scopeSchema, requestId: idSchema, subjectId: idSchema, requestedAt: epochSchema, phase: phaseSchema, status: statusSchema, participants: progressSchema.array().min(1).max(400), retainedSuppression: suppressionSchema.array().max(1000) });

/** Plan removal before purging reloadable local data; attest after every participant completes. */
export type ErasurePhase = (typeof phases)[number];
/** Kept by policy after erasure; contains no address or rendered content. */
export type RetainedSuppressionDigest = Readonly<z.infer<typeof suppressionSchema>>;
/** Progress retains counts/IDs, purging payloads. Pending external removal is never reported complete. */
export type ParticipantProgress = Readonly<z.infer<typeof progressSchema>>;
/** Durable request freezes participant IDs and blocks processing before removal begins. */
export type ErasureRequest = Readonly<Omit<z.infer<typeof requestSchema>, "participants" | "retainedSuppression"> & {
  participants: readonly ParticipantProgress[];
  retainedSuppression: readonly RetainedSuppressionDigest[];
}>;
/** Frozen API; participant failures are explicit and leave the subject blocked. */
export interface PrivacyService {
  requestErasure(required: { context: CallContext; subjectId: string }, optional?: CallOptions): Promise<Outcome<ErasureRequest>>;
  advance(required: { context: CallContext; requestId: string }, optional?: CallOptions): Promise<Outcome<ErasureRequest>>;
  status(required: { context: CallContext; requestId: string }, optional?: CallOptions): Promise<Outcome<ErasureRequest>>;
}

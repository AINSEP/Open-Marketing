import type { Outcome, CallContext, CallOptions, ObserverPort, ConfirmationCard, ApprovalResponse, EffectEnvelope, GenerationAllowanceSettings, GenerationCostQuote, GenerationApprovalRequirement, HaltStopRequest, ServiceContext } from "@open-marketing/contracts";
import type { EffectRequest, FrozenDispatchRequest, DispatchPermit, HaltReceipt, FrozenGenerationRequest, PlatformLimitEvidence, SafetySnapshot, DispatchAdmission, GenerationReservation, GenerationSettlement } from "./types.js";
/** Durable atomic financial state. All mutations and their accounting journal commit together. */
export interface SafetyRepoPort {
 snapshot(required: { context: CallContext; accountId: string }, optional?: CallOptions): Promise<Outcome<SafetySnapshot>>;
 reserve(required: { context: CallContext; request: FrozenDispatchRequest; admission?: DispatchAdmission }, optional?: CallOptions): Promise<Outcome<DispatchPermit>>;
 halt(required: { context: CallContext; adAccountId: string }, optional?: CallOptions): Promise<Outcome<HaltReceipt>>;
 getHalt(required: { context: CallContext; accountId: string }, optional?: CallOptions): Promise<Outcome<HaltReceipt>>;
 getGenerationAllowance(required: { context: CallContext }, optional?: CallOptions): Promise<Outcome<GenerationAllowanceSettings>>;
 setGenerationAllowance(required: { context: CallContext; settings: GenerationAllowanceSettings }, optional?: CallOptions): Promise<Outcome<GenerationAllowanceSettings>>;
 assessGeneration(required: { context: CallContext; request: FrozenGenerationRequest; quote: GenerationCostQuote }, optional?: CallOptions): Promise<Outcome<GenerationApprovalRequirement>>;
 reserveGeneration(required: { context: CallContext; request: FrozenGenerationRequest; quote: GenerationCostQuote; expectedKind: "normal_write" | "exact_spend"; expectedRevision: number }, optional?: CallOptions): Promise<Outcome<GenerationReservation>>;
 getGenerationReservation(required: { context: CallContext; reservationId: string }, optional?: CallOptions): Promise<Outcome<GenerationReservation>>;
 settleGeneration(required: { context: CallContext; settlement: GenerationSettlement }, optional?: CallOptions): Promise<Outcome<void>>;
}
export interface SpendPolicyPort {
 assess(required: { context: CallContext; envelope: EffectEnvelope }, optional?: CallOptions): Promise<Outcome<{ readonly allowed: boolean; readonly reason?: string }>>;
}
/** Confirmation is explicit and owner-only; presentation alone never creates authority. */
export interface ConfirmationExchangePort {
 present(required: { context: CallContext; request: EffectRequest; policyRevision?: number; classification?: ConfirmationCard["classification"] }, optional?: CallOptions): Promise<Outcome<ConfirmationCard>>;
 confirm(required: { context: CallContext; response: ApprovalResponse }, optional?: CallOptions): Promise<Outcome<void>>;
 verify(required: { context: CallContext; request: FrozenDispatchRequest; classification: ConfirmationCard["classification"] }, optional?: CallOptions): Promise<Outcome<void>>;
}
/** Host-verified effects and scoped existing entities; plugin declarations alone are insufficient. */
export interface VerifiedEffectResolverPort {
 resolve(required: { context: CallContext; request: EffectRequest }, optional?: CallOptions): Promise<Outcome<EffectEnvelope>>;
 verifyGenerationQuote(required: { context: CallContext; request: FrozenGenerationRequest; quote: GenerationCostQuote; pluginDigest?: string; schemaFingerprint?: string }, optional?: CallOptions): Promise<Outcome<void>>;
 verifyHaltStop(required: { context: ServiceContext; request: HaltStopRequest }, optional?: CallOptions): Promise<Outcome<void>>;
}
export interface PlatformLimitEvidencePort {
 get(required: { context: CallContext; accountId: string }, optional?: CallOptions): Promise<Outcome<PlatformLimitEvidence>>;
}
/** Shared server barrier. Cancellation fails acquisition; release never releases another scope's lock. */
export interface AccountDispatchLockPort {
 acquire(required: { context: CallContext; accountId: string }, optional?: CallOptions): Promise<Outcome<{ readonly lockId: string }>>;
 release(required: { lockId: string }, optional?: CallOptions): Promise<Outcome<void>>;
}
export interface SafetyAuditPort {
 record(required: { context: CallContext; operationId: string; outcome: string }, optional?: CallOptions): Promise<Outcome<void>>;
}
export type SafetyObserverPort = ObserverPort;

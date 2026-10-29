import type { ApproverRef, Outcome, CallContext, CallOptions, ConfirmationCard, ApprovalResponse, EffectEnvelope, GenerationAllowanceSettings, GenerationCostQuote, GenerationApprovalRequirement, HaltStopRequest, ServiceContext, Page, PageQuery, Money } from "@open-marketing/contracts";
import type { EffectRequest, FrozenDispatchRequest, DispatchPermit, HaltReceipt, FrozenGenerationRequest, PlatformLimitEvidence, SafetySnapshot, DispatchAdmission, GenerationReservation, GenerationSettlement } from "./types.js";
/** Durable atomic financial state. All mutations and their accounting journal commit together. */
export interface SafetyRepoPort {
 /** Read-only balance includes all unresolved reservations, even from prior days. No authority granted. */
 getGenerationAllowanceView(required: { context: CallContext }, optional?: CallOptions): Promise<Outcome<{ daily: Money; remaining: Money; timezone: string }>>;
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
 /** Revoke only within the authenticated scope; durable adapters await deletion. */
 revoke(required: { context: CallContext; cardId: string }, optional?: CallOptions): Promise<Outcome<void>>;
 /** Scoped card reads expose pending, unexpired cards only; get retains exact answered cards. */
 list(required: { context: CallContext; query: PageQuery }, optional?: CallOptions): Promise<Outcome<Page<ConfirmationCard>>>;
 get(required: { context: CallContext; cardId: string }, optional?: CallOptions): Promise<Outcome<ConfirmationCard | null>>;
 present(required: { context: CallContext; request: EffectRequest; policyRevision?: number; classification?: ConfirmationCard["classification"] }, optional?: CallOptions): Promise<Outcome<ConfirmationCard>>;
 /** Approver is derived by trusted server authentication; success includes required answer audit. */
 confirm(required: { context: CallContext; response: ApprovalResponse; approver: ApproverRef }, optional?: CallOptions): Promise<Outcome<void>>;
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

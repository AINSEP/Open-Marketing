import type { Outcome, CallContext, CallOptions, Scope, Money, ConfirmationCard, EffectEnvelope, GenerationAllowanceSettings, GenerationCostQuote, GenerationApprovalRequirement, HaltStopRequest, HaltStopPermit, ServiceContext } from "@open-marketing/contracts";
/** Frozen arguments and trusted implementation fingerprints for one operation. */
export type CampaignConstituent = { readonly envelope: EffectEnvelope; readonly arguments: Readonly<Record<string, unknown>>; readonly pluginDigest: string; readonly schemaFingerprint: string };
export type EffectRequest = CampaignConstituent & { readonly pausedCampaignCalls?: readonly CampaignConstituent[]; readonly operationScope?: string; readonly generation?: { readonly request: FrozenGenerationRequest; readonly quote: GenerationCostQuote } };
/** A constituent references one position in one exact owning campaign card; never a grant. */
export type FrozenDispatchRequest = EffectRequest & { readonly approvalId: string; readonly policyRevision: number; readonly campaignApproval?: { readonly operationId: string; readonly argumentsDigest: string; readonly index: number } };
/** Evidence of admission, not an egress bypass: use withDispatch at the server boundary. */
export type DispatchPermit = { readonly operationId: string; readonly argumentsDigest: string; readonly approvalId: string; readonly expiresAt: number; readonly reservationId: string };
export type HaltReceipt = { readonly haltId: string; readonly adAccountId: string; readonly epoch: number; readonly remoteStatus: "pending" | "stopped" | "partial" | "unknown" };
export type FrozenGenerationRequest = { readonly operationId: string; readonly connectionId: string; readonly argumentsDigest: string; readonly configurationDigest: string };
export type PlatformLimitEvidence = { readonly evidenceId: string; readonly accountId: string; readonly amount: Money; readonly window: { readonly start: number; readonly end: number }; readonly observedAt: number; readonly semantics: "hard_limit" | "average_budget" | "maximum_billed"; readonly pluginDigest: string };
export type SafetySnapshot = { readonly scope: Scope; readonly revision: number; readonly halted: boolean; readonly reserved: Money; readonly settled: Money };
/** Repo receives verified admission separately from caller-controlled arguments. */
export type DispatchAdmission = { readonly maximum: Money | null; readonly window: { readonly start: number; readonly end: number } | null; readonly expiresAt: number };
export type GenerationReservation = { readonly reservationId: string; readonly operationId: string; readonly quoteId: string; readonly dispatchDay: string; readonly allowanceRevision: number; readonly amount: Money; readonly kind: "normal_write" | "exact_spend" };
/** Observations are append-only. A correction names the prior observation it replaces. */
export type GenerationSettlement = { readonly reservationId: string; readonly observationId: string; readonly actual: Money; readonly correctsObservationId?: string };
export type GenerationAuthorization = { readonly request: FrozenGenerationRequest; readonly quote: GenerationCostQuote; readonly dispatch: FrozenDispatchRequest };
export interface SafetyService {
 prepareApproval(required: { context: CallContext; request: EffectRequest }, optional?: CallOptions): Promise<Outcome<ConfirmationCard>>;
 authorizeDispatch(required: { context: CallContext; request: FrozenDispatchRequest }, optional?: CallOptions): Promise<Outcome<DispatchPermit>>;
 /** Holds the same barrier as halt through actual transport handoff. Callback must perform one bounded egress. */
 withDispatch<T>(required: { context: CallContext; request: FrozenDispatchRequest; dispatch: (required: { context: CallContext; permit: DispatchPermit; request: FrozenDispatchRequest }) => Promise<Outcome<T>> }, optional?: CallOptions): Promise<Outcome<T>>;
 haltAccount(required: { context: CallContext; adAccountId: string }, optional?: CallOptions): Promise<Outcome<HaltReceipt>>;
 authorizeHaltStop(required: { context: ServiceContext; request: HaltStopRequest }, optional?: CallOptions): Promise<Outcome<HaltStopPermit>>;
 getGenerationAllowance(required: { context: CallContext }, optional?: CallOptions): Promise<Outcome<GenerationAllowanceSettings>>;
 setGenerationAllowance(required: { context: CallContext; settings: GenerationAllowanceSettings }, optional?: CallOptions): Promise<Outcome<GenerationAllowanceSettings>>;
 assessGeneration(required: { context: CallContext; request: FrozenGenerationRequest; quote: GenerationCostQuote }, optional?: CallOptions): Promise<Outcome<GenerationApprovalRequirement>>;
 reserveGeneration(required: { context: CallContext; authorization: GenerationAuthorization }, optional?: CallOptions): Promise<Outcome<GenerationReservation>>;
 settleGeneration(required: { context: ServiceContext; settlement: GenerationSettlement }, optional?: CallOptions): Promise<Outcome<void>>;
}

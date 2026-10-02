import type { Outcome, CallContext, CallOptions, ClockPort, IdPort, ObserverPort, Scope, Page, PageQuery, ConfirmationCard, EffectEnvelope, GenerationAllowanceSettings, GenerationCostQuote, GenerationApprovalRequirement, HaltStopRequest, HaltStopPermit, ServiceContext, MeasurementGrant, CapabilityEnvelope } from "@open-marketing/contracts";
import type { TimeWindow, Consent, Suppression, FrequencyCap, SubjectPolicy, ShareDestination, MessageChannel, Money, BudgetAuthorization, AdAccountPolicy, DenialReason, GateDecision, SubjectReference, PolicyEvidence, PolicyService } from "./types.js";
/** PolicyRepoPort: caller-owned, injected boundary. j00 doubles fail explicitly until its owning job implements the suite. */
export interface PolicyRepoPort {
 snapshot(required: { context: CallContext; subjectId: string }, optional?: CallOptions): Promise<Outcome<SubjectPolicy>>;
 appendEvidence(required: { context: CallContext; evidence: PolicyEvidence }, optional?: CallOptions): Promise<Outcome<PolicyEvidence>>;
}
/** CanonicalIdentityPort: caller-owned, injected boundary. j00 doubles fail explicitly until its owning job implements the suite. */
export interface CanonicalIdentityPort {
 resolve(required: { context: CallContext; identifier: string }, optional?: CallOptions): Promise<Outcome<SubjectReference>>;
}
export type PolicyObserverPort = ObserverPort;

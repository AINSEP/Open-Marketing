import type { Outcome, CallContext, CallOptions, ClockPort, IdPort, ObserverPort, Scope, Page, PageQuery, ConfirmationCard, EffectEnvelope, GenerationAllowanceSettings, GenerationCostQuote, GenerationApprovalRequirement, HaltStopRequest, HaltStopPermit, ServiceContext, MeasurementGrant, CapabilityEnvelope } from "@open-marketing/contracts";
import type { TimeWindow, Consent, Suppression, FrequencyCap, SubjectPolicy, ShareDestination, MessageChannel, Money, BudgetAuthorization, AdAccountPolicy, DenialReason, GateDecision, SubjectReference, PolicyEvidence, PolicyService } from "./types.js";
/** Scoped append-only evidence and refreshed policy snapshots; failures are explicit typed values. */
export interface PolicyRepoPort {
 snapshot(required: { context: CallContext; subjectId: string }, optional?: CallOptions): Promise<Outcome<SubjectPolicy>>;
 appendEvidence(required: { context: CallContext; evidence: PolicyEvidence }, optional?: CallOptions): Promise<Outcome<PolicyEvidence>>;
}
/** Exact scoped identifier resolution; missing or ambiguous bindings never create identities. */
export interface CanonicalIdentityPort {
 resolve(required: { context: CallContext; identifier: string }, optional?: CallOptions): Promise<Outcome<SubjectReference>>;
}
export type PolicyObserverPort = ObserverPort;

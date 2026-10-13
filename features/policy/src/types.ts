import type { Outcome, CallContext, CallOptions, ClockPort, IdPort, ObserverPort, Scope, Page, PageQuery, ConfirmationCard, EffectEnvelope, GenerationAllowanceSettings, GenerationCostQuote, GenerationApprovalRequirement, HaltStopRequest, HaltStopPermit, ServiceContext, MeasurementGrant, CapabilityEnvelope } from "@open-marketing/contracts";
/** All times are UTC epoch milliseconds; windows include start and exclude end. */
export interface TimeWindow {
    readonly start: number;
    readonly end: number;
}
export interface Consent extends TimeWindow {
    /** Optional exact publication capture; legacy evidence remains valid. */
    readonly topic?: string;
    readonly wordingVersion?: string;
    readonly wordingDigest?: string;
    readonly purpose: string;
    readonly scope: "channel" | "destination";
    readonly target: string;
    readonly status: "granted" | "withdrawn";
}
export interface Suppression extends TimeWindow {
    readonly channel: string;
}
export interface FrequencyCap {
    readonly count: number;
    readonly limit: number;
}
/** Trusted typed snapshot, resolved from canonical identity and refreshed before dispatch.
 * Future adapters must validate untrusted JSON before constructing this value; gates are
 * not general-purpose runtime schema parsers. readonly prevents mutation through this API.
 */
export interface SubjectPolicy {
    readonly consents: readonly Consent[];
    readonly suppressions: readonly Suppression[];
    readonly holdout: boolean;
    readonly frequencyCap?: FrequencyCap;
}
/** Intent is explicit so measurement cannot accidentally become audience activation. */
export interface ShareDestination {
    readonly id: string;
    readonly intent: "audience" | "measurement";
}
export interface MessageChannel {
    readonly id: string;
    readonly intent: "marketing" | "transactional";
}
export interface Money {
    readonly minorUnits: number;
    readonly currency: string;
}
export interface BudgetAuthorization extends TimeWindow {
    readonly currency: string;
    readonly capMinorUnits: number;
    readonly committedMinorUnits: number;
    readonly reservedMinorUnits: number;
    readonly revoked: boolean;
}
/** Legacy snapshot counters are policy evidence only; safety must bind exact operation authority. */
export interface AdAccountPolicy {
    readonly halted: boolean;
    readonly authorization: BudgetAuthorization | null;
}
export type DenialReason = "invalid_input" | "consent_missing" | "consent_withdrawn" | "suppressed" | "holdout" | "frequency_cap" | "account_halted" | "authorization_missing" | "authorization_revoked" | "outside_window" | "currency_mismatch" | "budget_exceeded";
export type GateDecision = {
    readonly allowed: true;
} | {
    readonly allowed: false;
    readonly reason: DenialReason;
};
/** SubjectReference domain value; validation belongs at the boundary. */
export type SubjectReference = {
    readonly scope: Scope;
    readonly subjectId: string;
};
/** PolicyEvidence domain value; validation belongs at the boundary. */
type EvidenceMetadata = {
    readonly id: string;
    readonly scope: Scope;
    readonly subjectId: string;
    readonly recordedAt: number;
    readonly sourceId: string;
};
/** Exact authenticated evidence; metadata alone cannot confer consent. */
export type PolicyEvidence = EvidenceMetadata & (
    | { readonly kind: "consent" | "withdrawal"; readonly consent: Consent }
    | { readonly kind: "suppression"; readonly suppression: Suppression }
    | { readonly kind: "merge"; readonly target: SubjectReference }
);
/** Ingress owns identifier normalization and authentication. */
export type IdentifierBinding = { readonly identifier: string; readonly subject: SubjectReference };
export interface PolicyService {
    snapshot(required: {
        context: CallContext;
        subjectId: string;
    }, optional?: CallOptions): Promise<Outcome<SubjectPolicy>>;
    appendEvidence(required: {
        context: CallContext;
        evidence: PolicyEvidence;
    }, optional?: CallOptions): Promise<Outcome<PolicyEvidence>>;
}

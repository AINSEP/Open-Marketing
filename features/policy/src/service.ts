import type { Outcome, CallContext, CallOptions, ClockPort, IdPort, ObserverPort, Scope, Page, PageQuery, ConfirmationCard, EffectEnvelope, GenerationAllowanceSettings, GenerationCostQuote, GenerationApprovalRequirement, HaltStopRequest, HaltStopPermit, ServiceContext, MeasurementGrant, CapabilityEnvelope } from "@open-marketing/contracts";
import { notImplemented } from "@open-marketing/contracts";
import type { PolicyRepoPort, CanonicalIdentityPort, PolicyObserverPort } from "./ports.js";
import type { TimeWindow, Consent, Suppression, FrequencyCap, SubjectPolicy, ShareDestination, MessageChannel, Money, BudgetAuthorization, AdAccountPolicy, DenialReason, GateDecision, SubjectReference, PolicyEvidence, PolicyService } from "./types.js";
/** Inert policy factory. @returns Service whose operations fail with typed not_implemented; no I/O or startup. @example createPolicyService({ injectedPorts: undefined } as Parameters<typeof createPolicyService>[0]) @complexity O(1). */
export function createPolicyService(
  required: {
    repo: PolicyRepoPort;
    clock: ClockPort;
    ids: IdPort;
  },
  optional?: { observer?: PolicyObserverPort },
): PolicyService {
return {
 async snapshot() { return notImplemented({ operation: "policy.snapshot" }); },
 async appendEvidence() { return notImplemented({ operation: "policy.appendEvidence" }); },
};
}

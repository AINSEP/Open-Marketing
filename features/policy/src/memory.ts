import type { Outcome, CallContext, CallOptions, ClockPort, IdPort, ObserverPort, Scope, Money, TimeWindow, Page, PageQuery, ConfirmationCard, EffectEnvelope, GenerationAllowanceSettings, GenerationCostQuote, GenerationApprovalRequirement, HaltStopRequest, HaltStopPermit, ServiceContext, MeasurementGrant, CapabilityEnvelope } from "@open-marketing/contracts";
import { notImplemented } from "@open-marketing/contracts";
import type { PolicyRepoPort, CanonicalIdentityPort } from "./ports.js";
/** Stub double for PolicyRepoPort; B1 suite is shared with its future real adapter. No persistence claim. */
export function createMemoryPolicyRepo(required: Record<string, never>): PolicyRepoPort { return {
 async snapshot() { return notImplemented({ operation: "PolicyRepoPort.snapshot" }); },
 async appendEvidence() { return notImplemented({ operation: "PolicyRepoPort.appendEvidence" }); },
}; }
/** Stub double for CanonicalIdentityPort; B1 suite is shared with its future real adapter. No persistence claim. */
export function createMemoryCanonicalIdentity(required: Record<string, never>): CanonicalIdentityPort { return {
 async resolve() { return notImplemented({ operation: "CanonicalIdentityPort.resolve" }); },
}; }

import type { Outcome, CallContext, CallOptions, ClockPort, IdPort, ObserverPort, Scope, Money, TimeWindow, Page, PageQuery, ConfirmationCard, EffectEnvelope, GenerationAllowanceSettings, GenerationCostQuote, GenerationApprovalRequirement, HaltStopRequest, HaltStopPermit, ServiceContext, MeasurementGrant, CapabilityEnvelope } from "@open-marketing/contracts";
import { notImplemented } from "@open-marketing/contracts";
import type { WorkspaceRepoPort, IdentityPort, AccountBindingLookupPort } from "./ports.js";
/** Stub double for WorkspaceRepoPort; B1 suite is shared with its future real adapter. No persistence claim. */
export function createMemoryWorkspaceRepo(required: Record<string, never>): WorkspaceRepoPort { return {
 async resolve() { return notImplemented({ operation: "WorkspaceRepoPort.resolve" }); },
 async bind() { return notImplemented({ operation: "WorkspaceRepoPort.bind" }); },
}; }
/** Stub double for IdentityPort; B1 suite is shared with its future real adapter. No persistence claim. */
export function createMemoryIdentity(required: Record<string, never>): IdentityPort { return {
 async verify() { return notImplemented({ operation: "IdentityPort.verify" }); },
}; }
/** Stub double for AccountBindingLookupPort; B1 suite is shared with its future real adapter. No persistence claim. */
export function createMemoryAccountBindingLookup(required: Record<string, never>): AccountBindingLookupPort { return {
 async find() { return notImplemented({ operation: "AccountBindingLookupPort.find" }); },
}; }

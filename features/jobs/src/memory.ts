import type { Outcome, CallContext, CallOptions, ClockPort, IdPort, ObserverPort, Scope, Money, TimeWindow, Page, PageQuery, ConfirmationCard, EffectEnvelope, GenerationAllowanceSettings, GenerationCostQuote, GenerationApprovalRequirement, HaltStopRequest, HaltStopPermit, ServiceContext, MeasurementGrant, CapabilityEnvelope } from "@open-marketing/contracts";
import { notImplemented } from "@open-marketing/contracts";
import type { JobRepoPort, JobDispatchPort, JobAuthorizationPort } from "./ports.js";
/** Stub double for JobRepoPort; B1 suite is shared with its future real adapter. No persistence claim. */
export function createMemoryJobRepo(required: Record<string, never>): JobRepoPort {
    return {
        async enqueue() { return notImplemented({ operation: "JobRepoPort.enqueue" }); },
        async claim() { return notImplemented({ operation: "JobRepoPort.claim" }); },
    };
}
/** Stub double for JobDispatchPort; B1 suite is shared with its future real adapter. No persistence claim. */
export function createMemoryJobDispatch(required: Record<string, never>): JobDispatchPort {
    return {
        async dispatch() { return notImplemented({ operation: "JobDispatchPort.dispatch" }); },
    };
}
/** Stub double for JobAuthorizationPort; B1 suite is shared with its future real adapter. No persistence claim. */
export function createMemoryJobAuthorization(required: Record<string, never>): JobAuthorizationPort {
    return {
        async authorize() { return notImplemented({ operation: "JobAuthorizationPort.authorize" }); },
    };
}

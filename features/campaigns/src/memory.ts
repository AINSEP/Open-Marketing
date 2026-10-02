import type { Outcome, CallContext, CallOptions, ClockPort, IdPort, ObserverPort, Scope, Money, TimeWindow, Page, PageQuery, ConfirmationCard, EffectEnvelope, GenerationAllowanceSettings, GenerationCostQuote, GenerationApprovalRequirement, HaltStopRequest, HaltStopPermit, ServiceContext, MeasurementGrant, CapabilityEnvelope } from "@open-marketing/contracts";
import { notImplemented } from "@open-marketing/contracts";
import type { CampaignRepoPort, CampaignCapabilityPort, CampaignAssetPort, CampaignSafetyPort, CampaignJobPort, CampaignAuditPort } from "./ports.js";
/** Stub double for CampaignRepoPort; B1 suite is shared with its future real adapter. No persistence claim. */
export function createMemoryCampaignRepo(required: Record<string, never>): CampaignRepoPort { return {
 async save() { return notImplemented({ operation: "CampaignRepoPort.save" }); },
 async observe() { return notImplemented({ operation: "CampaignRepoPort.observe" }); },
}; }
/** Stub double for CampaignCapabilityPort; B1 suite is shared with its future real adapter. No persistence claim. */
export function createMemoryCampaignCapability(required: Record<string, never>): CampaignCapabilityPort { return {
 async createPaused() { return notImplemented({ operation: "CampaignCapabilityPort.createPaused" }); },
 async launch() { return notImplemented({ operation: "CampaignCapabilityPort.launch" }); },
}; }
/** Stub double for CampaignAssetPort; B1 suite is shared with its future real adapter. No persistence claim. */
export function createMemoryCampaignAsset(required: Record<string, never>): CampaignAssetPort { return {
 async resolve() { return notImplemented({ operation: "CampaignAssetPort.resolve" }); },
}; }
/** Stub double for CampaignSafetyPort; B1 suite is shared with its future real adapter. No persistence claim. */
export function createMemoryCampaignSafety(required: Record<string, never>): CampaignSafetyPort { return {
 async authorize() { return notImplemented({ operation: "CampaignSafetyPort.authorize" }); },
}; }
/** Stub double for CampaignJobPort; B1 suite is shared with its future real adapter. No persistence claim. */
export function createMemoryCampaignJob(required: Record<string, never>): CampaignJobPort { return {
 async enqueue() { return notImplemented({ operation: "CampaignJobPort.enqueue" }); },
}; }
/** Stub double for CampaignAuditPort; B1 suite is shared with its future real adapter. No persistence claim. */
export function createMemoryCampaignAudit(required: Record<string, never>): CampaignAuditPort { return {
 async record() { return notImplemented({ operation: "CampaignAuditPort.record" }); },
}; }

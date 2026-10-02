import type { Outcome, CallContext, CallOptions, ClockPort, IdPort, ObserverPort, Scope, Money, TimeWindow, Page, PageQuery, ConfirmationCard, EffectEnvelope, GenerationAllowanceSettings, GenerationCostQuote, GenerationApprovalRequirement, HaltStopRequest, HaltStopPermit, ServiceContext, MeasurementGrant, CapabilityEnvelope } from "@open-marketing/contracts";
import { notImplemented } from "@open-marketing/contracts";
import type { AuditRepoPort, AuditRedactorPort } from "./ports.js";
/** Stub double for AuditRepoPort; B1 suite is shared with its future real adapter. No persistence claim. */
export function createMemoryAuditRepo(required: Record<string, never>): AuditRepoPort { return {
 async append() { return notImplemented({ operation: "AuditRepoPort.append" }); },
 async list() { return notImplemented({ operation: "AuditRepoPort.list" }); },
}; }
/** Stub double for AuditRedactorPort; B1 suite is shared with its future real adapter. No persistence claim. */
export function createMemoryAuditRedactor(required: Record<string, never>): AuditRedactorPort { return {
 async redact() { return notImplemented({ operation: "AuditRedactorPort.redact" }); },
}; }

import type { Outcome, CallContext, CallOptions, ClockPort, IdPort, ObserverPort, Scope, Money, TimeWindow, Page, PageQuery, ConfirmationCard, EffectEnvelope, GenerationAllowanceSettings, GenerationCostQuote, GenerationApprovalRequirement, HaltStopRequest, HaltStopPermit, ServiceContext, MeasurementGrant, CapabilityEnvelope } from "@open-marketing/contracts";
import { notImplemented } from "@open-marketing/contracts";
import type { MeasureRepoPort, MeasurementShareabilityPort, ConversionDeliveryPort, PlatformReportingPort, MeasureJobPort, TrackedLinkPort, MeasureAuditPort } from "./ports.js";
/** Stub double for MeasureRepoPort; B1 suite is shared with its future real adapter. No persistence claim. */
export function createMemoryMeasureRepo(required: Record<string, never>): MeasureRepoPort { return {
 async appendConversion() { return notImplemented({ operation: "MeasureRepoPort.appendConversion" }); },
 async appendSnapshot() { return notImplemented({ operation: "MeasureRepoPort.appendSnapshot" }); },
}; }
/** Stub double for MeasurementShareabilityPort; B1 suite is shared with its future real adapter. No persistence claim. */
export function createMemoryMeasurementShareability(required: Record<string, never>): MeasurementShareabilityPort { return {
 async assess() { return notImplemented({ operation: "MeasurementShareabilityPort.assess" }); },
}; }
/** Stub double for ConversionDeliveryPort; B1 suite is shared with its future real adapter. No persistence claim. */
export function createMemoryConversionDelivery(required: Record<string, never>): ConversionDeliveryPort { return {
 async deliver() { return notImplemented({ operation: "ConversionDeliveryPort.deliver" }); },
}; }
/** Stub double for PlatformReportingPort; B1 suite is shared with its future real adapter. No persistence claim. */
export function createMemoryPlatformReporting(required: Record<string, never>): PlatformReportingPort { return {
 async snapshot() { return notImplemented({ operation: "PlatformReportingPort.snapshot" }); },
}; }
/** Stub double for MeasureJobPort; B1 suite is shared with its future real adapter. No persistence claim. */
export function createMemoryMeasureJob(required: Record<string, never>): MeasureJobPort { return {
 async enqueue() { return notImplemented({ operation: "MeasureJobPort.enqueue" }); },
}; }
/** Stub double for TrackedLinkPort; B1 suite is shared with its future real adapter. No persistence claim. */
export function createMemoryTrackedLink(required: Record<string, never>): TrackedLinkPort { return {
 async create() { return notImplemented({ operation: "TrackedLinkPort.create" }); },
}; }
/** Stub double for MeasureAuditPort; B1 suite is shared with its future real adapter. No persistence claim. */
export function createMemoryMeasureAudit(required: Record<string, never>): MeasureAuditPort { return {
 async record() { return notImplemented({ operation: "MeasureAuditPort.record" }); },
}; }

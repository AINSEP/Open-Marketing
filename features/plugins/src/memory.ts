import type { Outcome, CallContext, CallOptions, ClockPort, IdPort, ObserverPort, Scope, Money, TimeWindow, Page, PageQuery, ConfirmationCard, EffectEnvelope, GenerationAllowanceSettings, GenerationCostQuote, GenerationApprovalRequirement, HaltStopRequest, HaltStopPermit, ServiceContext, MeasurementGrant, CapabilityEnvelope } from "@open-marketing/contracts";
import { notImplemented } from "@open-marketing/contracts";
import type { PluginRepoPort, PluginLifecyclePort, AgentPluginLayoutPort, AgentPluginMcpProvisioningPort, PluginTrustPort, PluginAuditPort } from "./ports.js";
/** Stub double for PluginRepoPort; B1 suite is shared with its future real adapter. No persistence claim. */
export function createMemoryPluginRepo(required: Record<string, never>): PluginRepoPort { return {
 async get() { return notImplemented({ operation: "PluginRepoPort.get" }); },
 async save() { return notImplemented({ operation: "PluginRepoPort.save" }); },
}; }
/** Stub double for PluginLifecyclePort; B1 suite is shared with its future real adapter. No persistence claim. */
export function createMemoryPluginLifecycle(required: Record<string, never>): PluginLifecyclePort { return {
 async install() { return notImplemented({ operation: "PluginLifecyclePort.install" }); },
 async dispose() { return notImplemented({ operation: "PluginLifecyclePort.dispose" }); },
}; }
/** Stub double for AgentPluginLayoutPort; B1 suite is shared with its future real adapter. No persistence claim. */
export function createMemoryAgentPluginLayout(required: Record<string, never>): AgentPluginLayoutPort { return {
 async validate() { return notImplemented({ operation: "AgentPluginLayoutPort.validate" }); },
}; }
/** Stub double for AgentPluginMcpProvisioningPort; B1 suite is shared with its future real adapter. No persistence claim. */
export function createMemoryAgentPluginMcpProvisioning(required: Record<string, never>): AgentPluginMcpProvisioningPort { return {
 async provision() { return notImplemented({ operation: "AgentPluginMcpProvisioningPort.provision" }); },
 async dispose() { return notImplemented({ operation: "AgentPluginMcpProvisioningPort.dispose" }); },
}; }
/** Stub double for PluginTrustPort; B1 suite is shared with its future real adapter. No persistence claim. */
export function createMemoryPluginTrust(required: Record<string, never>): PluginTrustPort { return {
 async verify() { return notImplemented({ operation: "PluginTrustPort.verify" }); },
}; }
/** Stub double for PluginAuditPort; B1 suite is shared with its future real adapter. No persistence claim. */
export function createMemoryPluginAudit(required: Record<string, never>): PluginAuditPort { return {
 async record() { return notImplemented({ operation: "PluginAuditPort.record" }); },
}; }

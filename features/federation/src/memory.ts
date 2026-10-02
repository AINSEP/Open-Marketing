import type { Outcome, CallContext, CallOptions, ClockPort, IdPort, ObserverPort, Scope, Money, TimeWindow, Page, PageQuery, ConfirmationCard, EffectEnvelope, GenerationAllowanceSettings, GenerationCostQuote, GenerationApprovalRequirement, HaltStopRequest, HaltStopPermit, ServiceContext, MeasurementGrant, CapabilityEnvelope } from "@open-marketing/contracts";
import { notImplemented } from "@open-marketing/contracts";
import type { FederationConnectionRepoPort, McpTransportPort, FederationCredentialPort, FederatedToolPermissionGate, FederatedCallConfirmation, ExternalMcpToolApprovalRepoPort, FederatedDispatchGatePort, FederationAuditPort, ToolRegistryPort } from "./ports.js";
/** Stub double for FederationConnectionRepoPort; B1 suite is shared with its future real adapter. No persistence claim. */
export function createMemoryFederationConnectionRepo(required: Record<string, never>): FederationConnectionRepoPort { return {
 async get() { return notImplemented({ operation: "FederationConnectionRepoPort.get" }); },
}; }
/** Stub double for McpTransportPort; B1 suite is shared with its future real adapter. No persistence claim. */
export function createMemoryMcpTransport(required: Record<string, never>): McpTransportPort { return {
 async invoke() { return notImplemented({ operation: "McpTransportPort.invoke" }); },
 async dispose() { return notImplemented({ operation: "McpTransportPort.dispose" }); },
}; }
/** Stub double for FederationCredentialPort; B1 suite is shared with its future real adapter. No persistence claim. */
export function createMemoryFederationCredential(required: Record<string, never>): FederationCredentialPort { return {
 async authorizeUse() { return notImplemented({ operation: "FederationCredentialPort.authorizeUse" }); },
}; }
/** Stub double for FederatedToolPermissionGate; B1 suite is shared with its future real adapter. No persistence claim. */
export function createMemoryFederatedToolPermissionGate(required: Record<string, never>): FederatedToolPermissionGate { return {
 async assess() { return notImplemented({ operation: "FederatedToolPermissionGate.assess" }); },
}; }
/** Stub double for FederatedCallConfirmation; B1 suite is shared with its future real adapter. No persistence claim. */
export function createMemoryFederatedCallConfirmation(required: Record<string, never>): FederatedCallConfirmation { return {
 async confirm() { return notImplemented({ operation: "FederatedCallConfirmation.confirm" }); },
}; }
/** Stub double for ExternalMcpToolApprovalRepoPort; B1 suite is shared with its future real adapter. No persistence claim. */
export function createMemoryExternalMcpToolApprovalRepo(required: Record<string, never>): ExternalMcpToolApprovalRepoPort { return {
 async get() { return notImplemented({ operation: "ExternalMcpToolApprovalRepoPort.get" }); },
}; }
/** Stub double for FederatedDispatchGatePort; B1 suite is shared with its future real adapter. No persistence claim. */
export function createMemoryFederatedDispatchGate(required: Record<string, never>): FederatedDispatchGatePort { return {
 async authorize() { return notImplemented({ operation: "FederatedDispatchGatePort.authorize" }); },
}; }
/** Stub double for FederationAuditPort; B1 suite is shared with its future real adapter. No persistence claim. */
export function createMemoryFederationAudit(required: Record<string, never>): FederationAuditPort { return {
 async record() { return notImplemented({ operation: "FederationAuditPort.record" }); },
}; }
/** Stub double for ToolRegistryPort; B1 suite is shared with its future real adapter. No persistence claim. */
export function createMemoryToolRegistry(required: Record<string, never>): ToolRegistryPort { return {
 async register() { return notImplemented({ operation: "ToolRegistryPort.register" }); },
 async unregister() { return notImplemented({ operation: "ToolRegistryPort.unregister" }); },
 async reset() { return notImplemented({ operation: "ToolRegistryPort.reset" }); },
 async dispose() { return notImplemented({ operation: "ToolRegistryPort.dispose" }); },
}; }

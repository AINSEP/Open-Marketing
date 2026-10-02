import type { Outcome, CallContext, CallOptions, ClockPort, IdPort, ObserverPort, Scope, Money, TimeWindow, Page, PageQuery, ConfirmationCard, EffectEnvelope, GenerationAllowanceSettings, GenerationCostQuote, GenerationApprovalRequirement, HaltStopRequest, HaltStopPermit, ServiceContext, MeasurementGrant, CapabilityEnvelope } from "@open-marketing/contracts";
import { notImplemented } from "@open-marketing/contracts";
import type { FederationConnectionRepoPort, McpTransportPort, FederationCredentialPort, FederatedToolPermissionGate, FederatedCallConfirmation, ExternalMcpToolApprovalRepoPort, FederatedDispatchGatePort, FederationAuditPort, ToolRegistryPort, FederationObserverPort } from "./ports.js";
import type { ExternalToolCall, ExternalToolResult, ReloadReceipt, FederationConnection, FederatedToolDescriptor, FederationHost } from "./types.js";
/** Inert federation factory. @returns Service whose operations fail with typed not_implemented; no I/O or startup. @example createFederationHost({ injectedPorts: undefined } as Parameters<typeof createFederationHost>[0]) @complexity O(1). */
export function createFederationHost(
  required: {
    connections: FederationConnectionRepoPort;
    transport: McpTransportPort;
    credentials: FederationCredentialPort;
    permissionGate: FederatedToolPermissionGate;
    confirmation: FederatedCallConfirmation;
    approvalRepo: ExternalMcpToolApprovalRepoPort;
    dispatchGate: FederatedDispatchGatePort;
    audit: FederationAuditPort;
    registry: ToolRegistryPort;
    clock: ClockPort;
  },
  optional?: { observer?: FederationObserverPort },
): FederationHost {
return {
 async invoke() { return notImplemented({ operation: "federation.invoke" }); },
 async reload() { return notImplemented({ operation: "federation.reload" }); },
};
}

import type { Outcome, CallContext, CallOptions, ClockPort, IdPort, ObserverPort, Scope, Money, TimeWindow, Page, PageQuery, ConfirmationCard, EffectEnvelope, GenerationAllowanceSettings, GenerationCostQuote, GenerationApprovalRequirement, HaltStopRequest, HaltStopPermit, ServiceContext, MeasurementGrant, CapabilityEnvelope } from "@open-marketing/contracts";
import type { ExternalToolCall, ExternalToolResult, ReloadReceipt, FederationConnection, FederatedToolDescriptor, FederationHost } from "./types.js";
/** FederationConnectionRepoPort: caller-owned, injected boundary. j00 doubles fail explicitly until its owning job implements the suite. */
export interface FederationConnectionRepoPort {
 get(required: { context: CallContext; connectionId: string }, optional?: CallOptions): Promise<Outcome<FederationConnection>>;
}
/** McpTransportPort: caller-owned, injected boundary. j00 doubles fail explicitly until its owning job implements the suite. */
export interface McpTransportPort {
 invoke(required: { context: CallContext; call: ExternalToolCall }, optional?: CallOptions): Promise<Outcome<ExternalToolResult>>;
 dispose(required: { connectionId: string }, optional?: CallOptions): Promise<Outcome<void>>;
}
/** FederationCredentialPort: caller-owned, injected boundary. j00 doubles fail explicitly until its owning job implements the suite. */
export interface FederationCredentialPort {
 authorizeUse(required: { context: CallContext; connectionId: string; operationId: string }, optional?: CallOptions): Promise<Outcome<{ readonly credentialReference: string }>>;
}
/** FederatedToolPermissionGate: caller-owned, injected boundary. j00 doubles fail explicitly until its owning job implements the suite. */
export interface FederatedToolPermissionGate {
 assess(required: { context: CallContext; call: ExternalToolCall }, optional?: CallOptions): Promise<Outcome<EffectEnvelope>>;
}
/** FederatedCallConfirmation: caller-owned, injected boundary. j00 doubles fail explicitly until its owning job implements the suite. */
export interface FederatedCallConfirmation {
 confirm(required: { context: CallContext; call: ExternalToolCall }, optional?: CallOptions): Promise<Outcome<{ readonly approvalId: string }>>;
}
/** ExternalMcpToolApprovalRepoPort: caller-owned, injected boundary. j00 doubles fail explicitly until its owning job implements the suite. */
export interface ExternalMcpToolApprovalRepoPort {
 get(required: { context: CallContext; operationId: string }, optional?: CallOptions): Promise<Outcome<{ readonly approvalId: string; readonly argumentsDigest: string }>>;
}
/** FederatedDispatchGatePort: caller-owned, injected boundary. j00 doubles fail explicitly until its owning job implements the suite. */
export interface FederatedDispatchGatePort {
 authorize(required: { context: CallContext; call: ExternalToolCall }, optional?: CallOptions): Promise<Outcome<{ readonly permitId: string }>>;
}
/** FederationAuditPort: caller-owned, injected boundary. j00 doubles fail explicitly until its owning job implements the suite. */
export interface FederationAuditPort {
 record(required: { context: CallContext; operationId: string; outcome: string }, optional?: CallOptions): Promise<Outcome<void>>;
}
/** ToolRegistryPort: caller-owned, injected boundary. j00 doubles fail explicitly until its owning job implements the suite. */
export interface ToolRegistryPort {
 register(required: { descriptor: FederatedToolDescriptor }, optional?: CallOptions): Promise<Outcome<void>>;
 unregister(required: { name: string }, optional?: CallOptions): Promise<Outcome<void>>;
 reset(required: {  }, optional?: CallOptions): Promise<Outcome<void>>;
 dispose(required: {  }, optional?: CallOptions): Promise<Outcome<void>>;
}
export type FederationObserverPort = ObserverPort;

import type { Outcome, CallContext, CallOptions, EffectEnvelope } from "@open-marketing/contracts";
import type { ExternalToolCall, ExternalToolResult, FederationConnection, FederatedToolDescriptor, FederatedApproval } from "./types.js";

/** Caller-owned server connection lookup; cross-scope and revoked connections must deny. */
export interface FederationConnectionRepoPort {
  get(required: { context: CallContext; connectionId: string }, optional?: CallOptions): Promise<Outcome<FederationConnection>>;
}
/** Server-only egress. The opaque broker reference is never placed in arguments or results.
 * Probe dispatchFence again after session initialization, immediately before actual tool egress. */
export interface McpTransportPort {
  invoke(required: { context: CallContext; call: ExternalToolCall; credentialReference: string; dispatchFence: { isCurrent: () => boolean } }, optional?: CallOptions): Promise<Outcome<ExternalToolResult>>;
  dispose(required: { connectionId: string }, optional?: CallOptions): Promise<Outcome<void>>;
}
/** Check current broker revocation/version on every use; return a reference, never a token. */
export interface FederationCredentialPort {
  authorizeUse(required: { context: CallContext; connectionId: string; operationId: string }, optional?: CallOptions): Promise<Outcome<{ readonly credentialReference: string }>>;
}
/** Safety classifies effects from trusted server metadata, never remote MCP annotations. */
export interface FederatedToolPermissionGate {
  assess(required: { context: CallContext; call: ExternalToolCall }, optional?: CallOptions): Promise<Outcome<EffectEnvelope>>;
}
/** Display the exact immutable call; the server persists its complete binding in approvalRepo. */
export interface FederatedCallConfirmation {
  confirm(required: { context: CallContext; call: ExternalToolCall }, optional?: CallOptions): Promise<Outcome<{ readonly approvalId: string }>>;
}
/** Current exact approval lookup. Expiry, revocation and implementation drift invalidate it. */
export interface ExternalMcpToolApprovalRepoPort {
  get(required: { context: CallContext; operationId: string }, optional?: CallOptions): Promise<Outcome<FederatedApproval>>;
}
/**
 * Safety/jobs authority seam. dispatch must hold the halt/consent/authority fence through
 * the synchronous handoff to execute and consume a durable single-use operation permit.
 * Memory implementation is a test double, not durable financial authority.
 */
export interface FederatedDispatchGatePort {
  authorize(required: { context: CallContext; call: ExternalToolCall }, optional?: CallOptions): Promise<Outcome<{ readonly permitId: string }>>;
  dispatch(required: { context: CallContext; call: ExternalToolCall; execute: (required: { isCurrent: () => boolean }) => Promise<Outcome<ExternalToolResult>> }, optional?: CallOptions): Promise<Outcome<ExternalToolResult>>;
}
/** Append redacted evidence; audit failures never imply a successful operation. */
export interface FederationAuditPort {
  record(required: { context: CallContext; operationId: string; outcome: string }, optional?: CallOptions): Promise<Outcome<void>>;
}
/** Per-host trusted catalog with collision rejection and connection-scoped invalidation. */
export interface ToolRegistryPort {
  register(required: { descriptor: FederatedToolDescriptor }, optional?: CallOptions): Promise<Outcome<void>>;
  resolve(required: { name: string }, optional?: CallOptions): Promise<Outcome<FederatedToolDescriptor>>;
  invalidate(required: { connectionId: string }, optional?: CallOptions): Promise<Outcome<void>>;
  unregister(required: { name: string }, optional?: CallOptions): Promise<Outcome<void>>;
  reset(required: Record<string, never>, optional?: CallOptions): Promise<Outcome<void>>;
  dispose(required: Record<string, never>, optional?: CallOptions): Promise<Outcome<void>>;
}

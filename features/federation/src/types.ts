import type { CallContext, CallOptions, CapabilityEnvelope, Outcome, Scope } from "@open-marketing/contracts";

/** Exact server operation. Arguments are canonical JSON and digests use SHA-256. */
export type ExternalToolCall = {
  readonly operationId: string;
  readonly connectionId: string;
  readonly toolName: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly argumentsDigest: string;
  readonly pluginDigest: string;
  readonly schemaFingerprint: string;
};
/** Agent-safe envelope; raw MCP metadata, credentials and configuration are excluded. */
export type ExternalToolResult = {
  readonly operationId: string;
  readonly status: "succeeded" | "failed" | "unknown";
  readonly content: readonly unknown[];
};
/** Reload disposes the session and invalidates admission; it performs no automatic replay. */
export type ReloadReceipt = { readonly connectionId: string; readonly revision: number };
/** Server-owned connection binding. No vendor configuration is part of this DTO. */
export type FederationConnection = {
  readonly connectionId: string;
  readonly scope: Scope;
  readonly pluginId: string;
  readonly pluginDigest: string;
};
/** Trusted catalog entry. MCP annotations never grant admission or classify effects. */
export type FederatedToolDescriptor = {
  readonly name: string;
  readonly connectionId: string;
  readonly fingerprint: string;
  readonly capability: CapabilityEnvelope;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly outputSchema?: Readonly<Record<string, unknown>>;
};
/** Immutable safety-owned approval for one operation, principal, scope and implementation. */
export type FederatedApproval = {
  readonly approvalId: string;
  readonly context: CallContext;
  readonly call: ExternalToolCall;
  readonly argumentsDigest: string;
  readonly expiresAt: number;
  readonly revoked: boolean;
};
/** Server-only invocation surface. @example host.invoke({ context, call }) */
export interface FederationHost {
  invoke(required: { context: CallContext; call: ExternalToolCall }, optional?: CallOptions): Promise<Outcome<ExternalToolResult>>;
  reload(required: { context: CallContext; connectionId: string }, optional?: CallOptions): Promise<Outcome<ReloadReceipt>>;
}

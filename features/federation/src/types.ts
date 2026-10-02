import type { Outcome, CallContext, CallOptions, ClockPort, IdPort, ObserverPort, Scope, Money, TimeWindow, Page, PageQuery, ConfirmationCard, EffectEnvelope, GenerationAllowanceSettings, GenerationCostQuote, GenerationApprovalRequirement, HaltStopRequest, HaltStopPermit, ServiceContext, MeasurementGrant, CapabilityEnvelope } from "@open-marketing/contracts";
/** ExternalToolCall domain value; validation belongs at the boundary. */
export type ExternalToolCall = { readonly operationId: string; readonly connectionId: string; readonly toolName: string; readonly arguments: Readonly<Record<string, unknown>>; readonly argumentsDigest: string; readonly pluginDigest: string; readonly schemaFingerprint: string };
/** ExternalToolResult domain value; validation belongs at the boundary. */
export type ExternalToolResult = { readonly operationId: string; readonly status: "succeeded" | "failed" | "unknown"; readonly content: readonly unknown[] };
/** ReloadReceipt domain value; validation belongs at the boundary. */
export type ReloadReceipt = { readonly connectionId: string; readonly revision: number };
/** FederationConnection domain value; validation belongs at the boundary. */
export type FederationConnection = { readonly connectionId: string; readonly scope: Scope; readonly pluginId: string; readonly pluginDigest: string };
/** FederatedToolDescriptor domain value; validation belongs at the boundary. */
export type FederatedToolDescriptor = { readonly name: string; readonly fingerprint: string; readonly capability: CapabilityEnvelope };
export interface FederationHost {
  invoke(
    required: { context: CallContext; call: ExternalToolCall },
    optional?: CallOptions,
  ): Promise<Outcome<ExternalToolResult>>;

  reload(
    required: { context: CallContext; connectionId: string },
    optional?: CallOptions,
  ): Promise<Outcome<ReloadReceipt>>;
}

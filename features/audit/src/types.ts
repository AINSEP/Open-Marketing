import type { Outcome, CallContext, CallOptions, ClockPort, IdPort, ObserverPort, Scope, Money, TimeWindow, Page, PageQuery, ConfirmationCard, EffectEnvelope, GenerationAllowanceSettings, GenerationCostQuote, GenerationApprovalRequirement, HaltStopRequest, HaltStopPermit, ServiceContext, MeasurementGrant, CapabilityEnvelope } from "@open-marketing/contracts";
/** AuditEntry domain value; validation belongs at the boundary. */
export type AuditEntry = { readonly operationId: string; readonly kind: "intent" | "approval" | "dispatch" | "outcome" | "correction"; readonly argumentsDigest: string; readonly references: readonly string[]; readonly correctionOf?: string };
/** AuditReceipt domain value; validation belongs at the boundary. */
export type AuditReceipt = { readonly entryId: string; readonly recordedAt: number };
/** AuditQuery domain value; validation belongs at the boundary. */
export type AuditQuery = PageQuery & { readonly operationId?: string };
/** AuditPage domain value; validation belongs at the boundary. */
export type AuditPage = Page<AuditEntry>;
export interface AuditService {
  record(
    required: { context: CallContext; entry: AuditEntry },
    optional?: CallOptions,
  ): Promise<Outcome<AuditReceipt>>;

  list(
    required: { context: CallContext; query: AuditQuery },
    optional?: CallOptions,
  ): Promise<Outcome<AuditPage>>;
}

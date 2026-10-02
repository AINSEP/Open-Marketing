import type { Outcome, CallContext, CallOptions, ClockPort, IdPort, ObserverPort, Scope, Money, TimeWindow, Page, PageQuery, ConfirmationCard, EffectEnvelope, GenerationAllowanceSettings, GenerationCostQuote, GenerationApprovalRequirement, HaltStopRequest, HaltStopPermit, ServiceContext, MeasurementGrant, CapabilityEnvelope } from "@open-marketing/contracts";
import type { AuditEntry, AuditReceipt, AuditQuery, AuditPage, AuditService } from "./types.js";
/** AuditRepoPort: caller-owned, injected boundary. j00 doubles fail explicitly until its owning job implements the suite. */
export interface AuditRepoPort {
 append(required: { context: CallContext; entry: AuditEntry }, optional?: CallOptions): Promise<Outcome<AuditReceipt>>;
 list(required: { context: CallContext; query: AuditQuery }, optional?: CallOptions): Promise<Outcome<AuditPage>>;
}
/** AuditRedactorPort: caller-owned, injected boundary. j00 doubles fail explicitly until its owning job implements the suite. */
export interface AuditRedactorPort {
 redact(required: { context: CallContext; entry: AuditEntry }, optional?: CallOptions): Promise<Outcome<AuditEntry>>;
}
export type AuditObserverPort = ObserverPort;

import type { Outcome, CallContext, CallOptions, ClockPort, IdPort, ObserverPort, Scope, Money, TimeWindow, Page, PageQuery, ConfirmationCard, EffectEnvelope, GenerationAllowanceSettings, GenerationCostQuote, GenerationApprovalRequirement, HaltStopRequest, HaltStopPermit, ServiceContext, MeasurementGrant, CapabilityEnvelope } from "@open-marketing/contracts";
import type { TrackedLinkRequest, TrackedLink, VerifiedConversionSource, ConversionInput, ConversionReceipt, CacQuery, CacReport, PlatformMetricSnapshot, AttributionResult, MeasureService } from "./types.js";
/** MeasureRepoPort: caller-owned, injected boundary. j00 doubles fail explicitly until its owning job implements the suite. */
export interface MeasureRepoPort {
 appendConversion(required: { source: VerifiedConversionSource; event: ConversionInput }, optional?: CallOptions): Promise<Outcome<ConversionReceipt>>;
 appendSnapshot(required: { context: CallContext; snapshot: PlatformMetricSnapshot }, optional?: CallOptions): Promise<Outcome<PlatformMetricSnapshot>>;
}
/** MeasurementShareabilityPort: caller-owned, injected boundary. j00 doubles fail explicitly until its owning job implements the suite. */
export interface MeasurementShareabilityPort {
 assess(required: { context: CallContext; event: ConversionInput }, optional?: CallOptions): Promise<Outcome<{ readonly allowed: boolean; readonly reason?: string }>>;
}
/** ConversionDeliveryPort: caller-owned, injected boundary. j00 doubles fail explicitly until its owning job implements the suite. */
export interface ConversionDeliveryPort {
 deliver(required: { context: ServiceContext; event: ConversionInput; grant: MeasurementGrant }, optional?: CallOptions): Promise<Outcome<{ readonly status: "delivered" | "unknown" }>>;
}
/** PlatformReportingPort: caller-owned, injected boundary. j00 doubles fail explicitly until its owning job implements the suite. */
export interface PlatformReportingPort {
 snapshot(required: { context: CallContext; query: CacQuery }, optional?: CallOptions): Promise<Outcome<PlatformMetricSnapshot>>;
}
/** MeasureJobPort: caller-owned, injected boundary. j00 doubles fail explicitly until its owning job implements the suite. */
export interface MeasureJobPort {
 enqueue(required: { source: VerifiedConversionSource; event: ConversionInput }, optional?: CallOptions): Promise<Outcome<{ readonly jobId: string }>>;
}
/** TrackedLinkPort: caller-owned, injected boundary. j00 doubles fail explicitly until its owning job implements the suite. */
export interface TrackedLinkPort {
 create(required: { context: CallContext; request: TrackedLinkRequest }, optional?: CallOptions): Promise<Outcome<TrackedLink>>;
}
/** MeasureAuditPort: caller-owned, injected boundary. j00 doubles fail explicitly until its owning job implements the suite. */
export interface MeasureAuditPort {
 record(required: { context: CallContext; operationId: string; outcome: string }, optional?: CallOptions): Promise<Outcome<void>>;
}
export type MeasureObserverPort = ObserverPort;

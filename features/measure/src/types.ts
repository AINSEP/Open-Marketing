import type { Outcome, CallContext, CallOptions, ClockPort, IdPort, ObserverPort, Scope, Money, TimeWindow, Page, PageQuery, ConfirmationCard, EffectEnvelope, GenerationAllowanceSettings, GenerationCostQuote, GenerationApprovalRequirement, HaltStopRequest, HaltStopPermit, ServiceContext, MeasurementGrant, CapabilityEnvelope } from "@open-marketing/contracts";
/** TrackedLinkRequest domain value; validation belongs at the boundary. */
export type TrackedLinkRequest = { readonly destinationUrl: string; readonly campaignId: string; readonly utm: Readonly<Record<string, string>> };
/** TrackedLink domain value; validation belongs at the boundary. */
export type TrackedLink = { readonly linkId: string; readonly url: string; readonly destinationUrl: string };
/** VerifiedConversionSource domain value; validation belongs at the boundary. */
export type VerifiedConversionSource = { readonly sourceId: string; readonly scope: Scope; readonly authenticationRevision: number; readonly context?: CallContext };
/** ConversionInput domain value; validation belongs at the boundary. */
export type ConversionInput = { readonly eventId: string; readonly eventType: "signup" | "trial"; readonly subjectId: string; readonly occurredAt: number; readonly destination: string; readonly purpose: string; readonly identifiers: Readonly<Record<string, string>> };
/** ConversionReceipt domain value; validation belongs at the boundary. */
export type ConversionReceipt = { readonly eventId: string; readonly status: "accepted" | "duplicate"; readonly jobId: string };
/** CacQuery domain value; validation belongs at the boundary. */
export type CacQuery = { readonly window: TimeWindow; readonly currency: string; readonly timezone: string; readonly attributionModel: string };
/** CacReport domain value; validation belongs at the boundary. */
export type CacReport = { readonly spendSource: "platform_report"; readonly conversionSource: "om_attribution"; readonly spend: Money; readonly conversions: number; readonly cacMinorUnits: number | null; readonly modelVersion: string; readonly retrievedAt: number; readonly watermark: number };
/** PlatformMetricSnapshot domain value; validation belongs at the boundary. */
export type PlatformMetricSnapshot = { readonly snapshotId: string; readonly accountId: string; readonly window: TimeWindow; readonly spend: Money; readonly timezone: string; readonly attributionWindow: string; readonly retrievedAt: number; readonly restatementOf?: string };
/** AttributionResult domain value; validation belongs at the boundary. */
export type AttributionResult = { readonly resultId: string; readonly eventId: string; readonly modelVersion: string; readonly campaignId: string | null };
/** Declared OM-attributed verified events only; watermark uses event time. */
export type AttributionSummary = { readonly conversions: number; readonly modelVersion: string; readonly watermark: number };
/** Immutable evidence; uncertain/interrupted attempts require reconciliation. */
export type ConversionDispatchRecord = { readonly deliveryId: string; readonly identity: string; readonly status: "dispatching" | "delivered" | "unknown"; readonly recordedAt: number };
/** Server-only workflow, never registered as an arbitrary agent tool. */
export interface ConversionDispatcher {
  dispatch(required: { context: ServiceContext; event: ConversionInput; grant: MeasurementGrant; deliveryId: string }, optional?: CallOptions): Promise<Outcome<{ readonly status: "delivered" | "unknown" }>>;
}
export interface MeasureService {
  createTrackedLink(
    required: { context: CallContext; request: TrackedLinkRequest },
    optional?: CallOptions,
  ): Promise<Outcome<TrackedLink>>;

  ingestConversion(
    required: { source: VerifiedConversionSource; event: ConversionInput },
    optional?: CallOptions,
  ): Promise<Outcome<ConversionReceipt>>;

  reportCac(
    required: { context: CallContext; query: CacQuery },
    optional?: CallOptions,
  ): Promise<Outcome<CacReport>>;
}

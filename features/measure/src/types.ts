import type { Outcome, CallContext, CallOptions, Scope, Money, TimeWindow, ServiceContext, MeasurementGrant } from "@open-marketing/contracts";
/** TrackedLinkRequest domain value; validation belongs at the boundary. */
export type TrackedLinkRequest = { readonly destinationUrl: string; readonly campaignId: string; readonly utm: Readonly<Record<string, string>> };
/** TrackedLink domain value; validation belongs at the boundary. */
export type TrackedLink = { readonly linkId: string; readonly url: string; readonly destinationUrl: string; readonly campaignId: string };
/** VerifiedConversionSource domain value; validation belongs at the boundary. */
export type VerifiedConversionSource = { readonly sourceId: string; readonly scope: Scope; readonly authenticationRevision: number; readonly context?: CallContext };
/** Immutable outcome evidence: caller-owned canonical subject and identifier digests.
 * definitionId is open; value/orderRef share this eventId across plugin destinations. */
export type ConversionInput = { readonly eventId: string; readonly definitionId: string; readonly subjectId: string; readonly occurredAt: number; readonly destination: string; readonly purpose: string; readonly identifierDigests: Readonly<Record<string, string>>; readonly value?: Money; readonly orderRef?: string };
/** Identifiers exist only in transient plugin payloads, never immutable evidence. */
export type ResolvedConversionInput = ConversionInput & { readonly identifiers: Readonly<Record<string, string>> };
/** Local definition-bound authority until shared contracts are amended by step0a. */
export type MeasureGrant = Omit<MeasurementGrant, "eventTypes"> & { readonly definitionIds: readonly string[] };
/** Generic backend conversion capability; adjustments are reserved, not implemented. */
export const CONVERSION_EVENT_CAPABILITY = "conversion.event.v1";
/** Bounded first-party touches supplied by the caller; measure owns no touch store. */
export type AttributionTouch = { readonly touchId: string; readonly occurredAt: number; readonly linkId: string | null; readonly campaignId: string | null };
/** ConversionReceipt domain value; validation belongs at the boundary. */
export type ConversionReceipt = { readonly eventId: string; readonly status: "accepted" | "duplicate"; readonly jobId: string };
/** Account and platform attribution window must be explicit; workspace totals cannot
 * be divided by one account's spend. Periods use [start,end) event-time boundaries. */
export type CacQuery = { readonly definitionId: string; readonly accountId: string; readonly attributionWindow: string; readonly window: TimeWindow; readonly currency: string; readonly timezone: string; readonly attributionModel: string };
/** CacReport domain value; validation belongs at the boundary. */
export type CacReport = { readonly definitionId: string; readonly accountId: string; readonly attributionWindow: string; readonly spendSource: "platform_report"; readonly conversionSource: "om_attribution"; readonly spend: Money; readonly conversions: number; readonly cacMinorUnits: number | null; readonly modelVersion: string; readonly retrievedAt: number; readonly watermark: number };
/** PlatformMetricSnapshot domain value; validation belongs at the boundary. */
export type PlatformMetricSnapshot = { readonly snapshotId: string; readonly accountId: string; readonly window: TimeWindow; readonly spend: Money; readonly timezone: string; readonly attributionWindow: string; readonly retrievedAt: number; readonly restatementOf?: string };
/** Immutable declared attribution binds an account as well as its campaign/model.
 * A correction uses a new model version, never overwrites the original result. */
export type AttributionResult = { readonly resultId: string; readonly eventId: string; readonly modelVersion: string; readonly accountId: string; readonly campaignId: string | null };
/** First verified acquisition per canonical subject/definition; watermark uses event time. */
export type AttributionSummary = { readonly conversions: number; readonly modelVersion: string; readonly watermark: number };
/** Immutable evidence; uncertain/interrupted attempts require reconciliation. */
export type ConversionDispatchRecord = { readonly deliveryId: string; readonly subjectId: string; readonly eventId: string; readonly identity: string; readonly status: "dispatching" | "delivered" | "unknown"; readonly recordedAt: number };
/** Server-only workflow, never registered as an arbitrary agent tool. */
export interface ConversionDispatcher {
  dispatch(required: { context: ServiceContext; event: ConversionInput; grant: MeasureGrant; deliveryId: string }, optional?: CallOptions): Promise<Outcome<{ readonly status: "delivered" | "unknown" }>>;
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

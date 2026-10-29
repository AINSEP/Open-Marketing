import type { Outcome, CallContext, CallOptions, Scope, Money, TimeWindow, ServiceContext, MeasurementGrant } from "@open-marketing/contracts";
import { appErrorSchema, callContextSchema, digestSchema, epochSchema, idSchema, moneySchema, scopeSchema } from "@open-marketing/contracts";
import { z } from "zod";

/** Shared strict conversion/source schemas stay outside reporting's delivery boundary. */
const digestMap = z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/), digestSchema).refine(value => Object.keys(value).length <= 16);
export const conversionSchema = z.strictObject({ eventId: idSchema, definitionId: idSchema, subjectId: idSchema, occurredAt: epochSchema, destination: idSchema, purpose: idSchema, identifierDigests: digestMap, value: moneySchema.optional(), orderRef: idSchema.optional() });
export const sourceSchema = z.strictObject({ sourceId: idSchema, scope: scopeSchema, authenticationRevision: epochSchema, context: callContextSchema.optional() });
/** Intake owns leadId + ":" + definitionId, never a stage-occurrence event ID.
 * Submit the first qualifying transition's evidence; retries retain its time/value.
 * Re-qualification cannot send again; spam corrections send no vendor adjustment.
 * @example leadOutcomeInputSchema.parse({ source, leadId: "lead-1", event }) */
export const leadOutcomeInputSchema = z.strictObject({ source: sourceSchema, leadId: idSchema,
  event: conversionSchema.omit({ eventId: true }).extend({ definitionId: z.enum(["qualified", "won"]) }) });
/** Strict leads-facing intent; callers cannot choose their own event ID. */
export type LeadOutcomeInput = z.input<typeof leadOutcomeInputSchema>;

/** Verified vendor evidence; null means unknown, independently for each stage.
 * Transport success and local inbox acceptance establish none of these fields. */
export const conversionDiagnosticsSchema = z.strictObject({
  accepted: z.boolean().nullable(),
  processed: z.boolean().nullable(),
  attributed: z.boolean().nullable(),
  observedAt: epochSchema,
});
/** Bounded transport outcome with optional, explicit vendor evidence. */
export const conversionDeliveryOutcomeSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("delivered"), diagnostics: conversionDiagnosticsSchema.optional(), receiptId: idSchema.optional() }),
  z.strictObject({ status: z.literal("unknown"), diagnostics: conversionDiagnosticsSchema.optional() }),
  z.strictObject({ status: z.literal("not_sent"), reason: appErrorSchema.shape.code }),
]);
/** Vendor stages are observations, never inferred from transport status. */
export type ConversionDiagnostics = z.infer<typeof conversionDiagnosticsSchema>;
/** Unknown outcomes reconcile under the original delivery identity. */
export type ConversionDeliveryOutcome = z.infer<typeof conversionDeliveryOutcomeSchema>;
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
/** Canonical definition-bound measurement authority. */
export type MeasureGrant = MeasurementGrant;
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
export const dispatchRecordSchema = z.strictObject({ deliveryId: idSchema, subjectId: idSchema, eventId: idSchema, identity: digestSchema, status: z.enum(["dispatching", "delivered", "unknown", "not_sent"]), recordedAt: epochSchema, diagnostics: conversionDiagnosticsSchema.optional(), reason: appErrorSchema.shape.code.optional(), receiptId: idSchema.optional() });
export type ConversionDispatchRecord = z.infer<typeof dispatchRecordSchema>;
/** Server-only workflow, never registered as an arbitrary agent tool. */
export interface ConversionDispatcher {
  dispatch(required: { context: ServiceContext; event: ConversionInput; grant: MeasureGrant; deliveryId: string }, optional?: CallOptions): Promise<Outcome<ConversionDeliveryOutcome>>;
  /** Refresh saved receipts without sending or resolving visitor identifiers.
   * @example dispatcher.reconcile({ context, event, grant, deliveryId }) */
  reconcile(required: { context: ServiceContext; event: ConversionInput; grant: MeasureGrant; deliveryId: string }, optional?: CallOptions): Promise<Outcome<ConversionDeliveryOutcome>>;
}
export interface MeasureService {
  createTrackedLink(
    required: { context: CallContext; request: TrackedLinkRequest },
    optional?: CallOptions,
  ): Promise<Outcome<TrackedLink>>;

  /** Generic events only; qualified/won require the lead-level identity path.
   * Reserved definitions return invalid_input before authentication or storage. */
  ingestConversion(
    required: { source: VerifiedConversionSource; event: ConversionInput },
    optional?: CallOptions,
  ): Promise<Outcome<ConversionReceipt>>;

  /** Share the first qualifying transition's immutable evidence once per lead/definition.
   * Exact retries reuse the job; changed evidence conflicts. Corrections/spam send
   * no vendor adjustment. Caller-owned sink: Pick<MeasureService, "ingestLeadOutcome">.
   * @example service.ingestLeadOutcome({ source, leadId, event }) */
  ingestLeadOutcome(
    required: LeadOutcomeInput,
    optional?: CallOptions,
  ): Promise<Outcome<ConversionReceipt>>;

  reportCac(
    required: { context: CallContext; query: CacQuery },
    optional?: CallOptions,
  ): Promise<Outcome<CacReport>>;
}

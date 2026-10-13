import type { CallContext, CallOptions, MeasurementGrant, ObserverPort, Outcome, ServiceContext } from "@open-marketing/contracts";
import type { AttributionResult, AttributionSummary, CacQuery, ConversionDispatchRecord, ConversionInput, ConversionReceipt, PlatformMetricSnapshot, TrackedLink, TrackedLinkRequest, VerifiedConversionSource } from "./types.js";

/** Atomic inbox boundary. appendConversion MUST commit the event and the ONE jobs
 * outbox together. Exact duplicates return the original job; conflicts never overwrite.
 * A SQL adapter binds its transaction-scoped enqueue in the composition root. */
export interface MeasureRepoPort {
  appendConversion(required: { source: VerifiedConversionSource; event: ConversionInput }, optional?: CallOptions): Promise<Outcome<ConversionReceipt>>;
  appendSnapshot(required: { context: CallContext; snapshot: PlatformMetricSnapshot }, optional?: CallOptions): Promise<Outcome<PlatformMetricSnapshot>>;
  appendAttribution?(required: { context: CallContext; sourceId: string; result: AttributionResult }, optional?: CallOptions): Promise<Outcome<AttributionResult>>;
  readAttribution?(required: { context: CallContext; query: CacQuery }, optional?: CallOptions): Promise<Outcome<AttributionSummary>>;
}
/** Consent covers scope, subject, purpose, destination and ALL identifier keys. */
export interface MeasurementShareabilityPort {
  assess(required: { context: CallContext; event: ConversionInput }, optional?: CallOptions): Promise<Outcome<{ readonly allowed: boolean; readonly reason?: string }>>;
}
/** Typed backend capability only. deliveryId is stable across reconciliation.
 * Adapters must not retry an uncertain non-idempotent effect. */
export interface ConversionDeliveryPort {
  deliver(required: { context: ServiceContext; event: ConversionInput; grant: MeasurementGrant; deliveryId?: string }, optional?: CallOptions): Promise<Outcome<{ readonly status: "delivered" | "unknown" }>>;
  reconcile?(required: { context: ServiceContext; deliveryId: string; event: ConversionInput; grant: MeasurementGrant }, optional?: CallOptions): Promise<Outcome<{ readonly status: "delivered" | "unknown" }>>;
}
/** Returns one account/period observation; platform conversion totals are not inputs. */
export interface PlatformReportingPort {
  snapshot(required: { context: CallContext; query: CacQuery }, optional?: CallOptions): Promise<Outcome<PlatformMetricSnapshot>>;
}
/** Composition seam. Ingestion uses the repo's atomic binding, never sequential enqueue. */
export interface MeasureJobPort {
  enqueue(required: { source: VerifiedConversionSource; event: ConversionInput }, optional?: CallOptions): Promise<Outcome<{ readonly jobId: string }>>;
}
/** Resolution validates the stored destination again before redirect. */
export interface TrackedLinkPort {
  create(required: { context: CallContext; request: TrackedLinkRequest }, optional?: CallOptions): Promise<Outcome<TrackedLink>>;
  resolve?(required: { context: CallContext; linkId: string }, optional?: CallOptions): Promise<Outcome<TrackedLink>>;
}
/** Append controlled evidence. A pre-dispatch audit failure prevents egress. */
export interface MeasureAuditPort {
  record(required: { context: CallContext; operationId: string; outcome: string }, optional?: CallOptions): Promise<Outcome<void>>;
}
/** Trusted adapter verifies current scope/revision, never caller claims alone. */
export interface ConversionSourceAuthenticationPort {
  verify(required: { source: VerifiedConversionSource }, optional?: CallOptions): Promise<Outcome<{ readonly authenticated: boolean }>>;
}
/** Dispatch consumes only an exact event from the committed verified inbox.
 * Scope and canonical identity must match; caller claims are insufficient. */
export interface ConversionVerificationPort {
  verify(required: { context: ServiceContext; event: ConversionInput }, optional?: CallOptions): Promise<Outcome<{ readonly verified: boolean }>>;
}
/** Reads CURRENT grant authority immediately before dispatch. */
export interface MeasurementGrantPort {
  current(required: { context: ServiceContext; grantId: string }, optional?: CallOptions): Promise<Outcome<MeasurementGrant>>;
}
/** Durable claim with append-only outcomes. Existing dispatching/unknown claims
 * require reconciliation and NEVER authorize a fresh send. */
export interface ConversionDeliveryStatePort {
  begin(required: { context: ServiceContext; record: ConversionDispatchRecord }, optional?: CallOptions): Promise<Outcome<{ readonly acquired: boolean; readonly record: ConversionDispatchRecord }>>;
  append(required: { context: ServiceContext; record: ConversionDispatchRecord }, optional?: CallOptions): Promise<Outcome<ConversionDispatchRecord>>;
}
/** Portable DB-shaped seam; the server adapts its SQLite OM DB port. */
export interface MeasureSqlQueryable {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(required: { text: string; values?: unknown[] }): Promise<{ rows: Row[]; rowCount: number | null }>;
}
/** Serialize writers and roll back all changes when work throws. */
export interface MeasureSqlDatabase extends MeasureSqlQueryable {
  transaction<T>(required: { work: (transaction: MeasureSqlQueryable) => Promise<T> }): Promise<T>;
}
/** Bind the jobs outbox to this EXACT transaction; failed enqueue rolls back intent. */
export interface MeasureTransactionalJobPort {
  enqueue(required: { transaction: MeasureSqlQueryable; source: VerifiedConversionSource; event: ConversionInput; context: CallContext }, optional?: CallOptions): Promise<Outcome<{ readonly jobId: string }>>;
}
export type MeasureObserverPort = ObserverPort;

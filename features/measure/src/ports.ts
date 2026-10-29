import type { CallContext, CallOptions, TimeWindow, Outcome, ServiceContext, SqlSession } from "@open-marketing/contracts";
import type { ConversionDeliveryOutcome } from "./types.js";
import type { AttributionTouch, MeasureGrant, ResolvedConversionInput, AttributionResult, AttributionSummary, CacQuery, ConversionDispatchRecord, ConversionInput, ConversionReceipt, PlatformMetricSnapshot, TrackedLink, TrackedLinkRequest, VerifiedConversionSource } from "./types.js";

/** Caller owns current contacts/erasure lookup. A missing/erased subject is a typed failure.
 * @example identifiers.identifiersFor({ context, subjectId, destination, purpose }) */
export interface ConversionIdentifiersPort {
  identifiersFor(required: { context: ServiceContext; subjectId: string; destination: string; purpose: string }, optional?: CallOptions): Promise<Outcome<{ readonly subjectId: string; readonly identifiers: Readonly<Record<string, string>>; readonly identifierDigests: Readonly<Record<string, string>> }>>;
}
/** Types only: web-events supplies scoped touches later; limit must be 1..100.
 * @example touches.touchesFor({ context, subjectId, window, limit: 100 }) */
export interface AttributionTouchPort {
  touchesFor(required: { context: CallContext; subjectId: string; window: TimeWindow; limit: number }, optional?: CallOptions): Promise<Outcome<readonly AttributionTouch[]>>;
}
/** Atomic inbox boundary. appendConversion MUST commit the event and the ONE jobs
 * outbox together. Exact duplicates return the original job; conflicts never overwrite.
 * A SQL adapter binds its transaction-scoped enqueue in the composition root.
 * Production jobs serialize source/event IDs, then reload the committed event. */
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
 * Adapters must not retry an uncertain non-idempotent effect. Diagnostics require
 * explicit vendor evidence; delivered does not imply processed or attributed. */
export interface ConversionDeliveryPort {
  deliver(required: { context: ServiceContext; event: ResolvedConversionInput; grant: MeasureGrant; deliveryId?: string }, optional?: CallOptions): Promise<Outcome<ConversionDeliveryOutcome>>;
  reconcile?(required: { context: ServiceContext; deliveryId: string; event: ConversionInput & { readonly identifiers?: Readonly<Record<string, string>> }; grant: MeasureGrant; receiptId?: string }, optional?: CallOptions): Promise<Outcome<ConversionDeliveryOutcome>>;
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
/** Trusted signed-webhook or authorized-operator adapter verifies current scope/revision, never caller claims alone. */
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
  current(required: { context: ServiceContext; grantId: string }, optional?: CallOptions): Promise<Outcome<MeasureGrant>>;
  /** Create immutable authority; identical retries return current revocation state.
   * Changed content conflicts; revoked input or mismatched scope is forbidden.
   * @example grants.grant({ context, grant }) */
  grant(required: { context: CallContext; grant: MeasureGrant }, optional?: CallOptions): Promise<Outcome<MeasureGrant>>;
  /** Idempotently revoke in this scope; missing/foreign grants are forbidden.
   * @example grants.revoke({ context, grantId }) */
  revoke(required: { context: CallContext; grantId: string }, optional?: CallOptions): Promise<Outcome<MeasureGrant>>;
}
/** Durable claim with append-only outcomes. Existing dispatching/unknown claims
 * require reconciliation and NEVER authorize a fresh send. Appends without new
 * diagnostics retain the previous verified diagnostic observation. */
export interface ConversionDeliveryStatePort {
  /** Latest evidence in this scope, or null; never authorizes egress.
   * @example ledger.read({ context, deliveryId }) */
  read(required: { context: ServiceContext; deliveryId: string }, optional?: CallOptions): Promise<Outcome<ConversionDispatchRecord | null>>;
  begin(required: { context: ServiceContext; record: ConversionDispatchRecord }, optional?: CallOptions): Promise<Outcome<{ readonly acquired: boolean; readonly record: ConversionDispatchRecord }>>;
  append(required: { context: ServiceContext; record: ConversionDispatchRecord }, optional?: CallOptions): Promise<Outcome<ConversionDispatchRecord>>;
}
/** Query-only view of the canonical SQL session. */
export type MeasureSqlQueryable = Pick<SqlSession, "query">;
/** Server owns serialized transaction and root query lifecycle. */
export type MeasureSqlDatabase = SqlSession;
/** Bind the jobs outbox to this EXACT transaction; failed enqueue rolls back intent.
 * Persist source/event IDs only; workers reload committed evidence at dispatch. */
export interface MeasureTransactionalJobPort {
  enqueue(required: { transaction: MeasureSqlQueryable; source: VerifiedConversionSource; event: ConversionInput; context: CallContext }, optional?: CallOptions): Promise<Outcome<{ readonly jobId: string }>>;
}

/** Owning privacy API clears reloadable order references; immutable IDs/digests remain.
 * Idempotent and scoped; does not authorize delivery or erase append-only evidence.
 * @example repo.purgeSubject({ context, subjectId }); */
export interface MeasurePrivacyPort {
  purgeSubject(required: { context: CallContext; subjectId: string }, optional?: CallOptions): Promise<Outcome<void>>;
}

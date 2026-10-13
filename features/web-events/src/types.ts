import type { CallContext, CallOptions, Outcome, Scope, TimeWindow } from "@open-marketing/contracts";

/** One envelope for collection, attribution and later event consumers.
 * Ingress limits: properties <=32 keys, each string <=2048 chars, total JSON <=16 KiB.
 * Property values are JSON scalars; addresses/answers are excluded. Cursor is server-assigned and monotonic. */
export interface WebEvent {
  readonly eventId: string;
  readonly schema: string;
  readonly version: number;
  readonly source: string;
  readonly subjectId?: string;
  readonly anonymousId?: string;
  readonly name: string;
  readonly properties: Readonly<Record<string, string | number | boolean | null>>;
  readonly occurredAt: number;
  readonly receivedAt: number;
  readonly cursor: number;
  readonly traceId: string;
}
/** Visit tokens bind a workspace-scoped anonymous visit and expiry; never grant marketing authority. */
export interface Visit { readonly visitId: string; readonly scope: Scope; readonly anonymousId: string; readonly subjectId: string | null; readonly expiresAt: number }
/** Click IDs are short-lived PII and privacy participants, excluded from immutable ledgers. */
export interface AttributionTouch {
  readonly touchId: string;
  readonly eventId: string;
  readonly occurredAt: number;
  readonly linkId: string | null;
  readonly campaignId: string | null;
  readonly clickIdentifiers: Readonly<Record<string, string>>;
}
/** Frozen collection API; adapters validate authority, scope, bounds and visit tokens at ingress. */
export interface WebEventService {
  recordTouch(required: { context: CallContext; event: WebEvent }, optional?: CallOptions): Promise<Outcome<AttributionTouch>>;
  bindVisitor(required: { context: CallContext; visitToken: string; subjectId: string }, optional?: CallOptions): Promise<Outcome<Visit>>;
  touchesFor(required: { context: CallContext; subjectId: string; window: TimeWindow; limit: number }, optional?: CallOptions): Promise<Outcome<readonly AttributionTouch[]>>;
}

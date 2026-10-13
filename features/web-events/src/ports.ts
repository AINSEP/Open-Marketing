import type { CallContext, CallOptions, Outcome, TimeWindow } from "@open-marketing/contracts";
import type { AttributionTouch, Visit, WebEvent } from "./types.js";

/** Scoped event/visit storage with deduplication and bounded reads (limit 1..100).
 * @example repo.touchesFor({ context, subjectId, window, limit: 100 }) */
export interface WebEventRepoPort {
  /** Persist an issued, unbound visit; exact replay preserves any later binding.
   * @example repo.saveVisit({ context, visit }) */
  saveVisit(required: { context: CallContext; visit: Visit }, optional?: CallOptions): Promise<Outcome<Visit>>;
  recordTouch(required: { context: CallContext; event: WebEvent; touch: AttributionTouch }, optional?: CallOptions): Promise<Outcome<AttributionTouch>>;
  bindVisitor(required: { context: CallContext; visitId: string; subjectId: string }, optional?: CallOptions): Promise<Outcome<Visit>>;
  touchesFor(required: { context: CallContext; subjectId: string; window: TimeWindow; limit: number }, optional?: CallOptions): Promise<Outcome<readonly AttributionTouch[]>>;
  /** Privacy participant: clear direct/bound click IDs and delete bound visits atomically.
   * Immutable IDs/digests remain. Replays must never restore erased click values.
   * @example repo.purgeSubject({ context, subjectId }) */
  purgeSubject(required: { context: CallContext; subjectId: string }, optional?: CallOptions): Promise<Outcome<void>>;
}
/** Host authenticates visit tokens; expired or cross-workspace tokens fail closed.
 * @example tokens.verify({ context, visitToken }) */
export interface VisitTokenPort {
  verify(required: { context: CallContext; visitToken: string }, optional?: CallOptions): Promise<Outcome<Visit>>;
}
/** Caller adapts policy's CURRENT identifier collection authority; absent evidence denies.
 * @example collectionAuthority.assess({ context, event }) */
export interface CollectionAuthorityPort {
  assess(required: { context: CallContext; event: WebEvent }, optional?: CallOptions): Promise<Outcome<{ readonly allowed: boolean }>>;
}

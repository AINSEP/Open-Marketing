import type { CallContext, CallOptions, Outcome, ServiceContext } from "@open-marketing/contracts";
import type { Identifier, IdentifierKind, Subject } from "./types.js";

/** Atomic subject/identifier writes. Merges retain the earliest canonical identity and append lineage.
 * @example repo.findByDigest({ context, kind: "email", identifierDigest }) */
export interface ContactRepoPort {
  findByDigest(required: { context: CallContext; kind: IdentifierKind; identifierDigest: string }, optional?: CallOptions): Promise<Outcome<Subject | null>>;
  get(required: { context: CallContext | ServiceContext; subjectId: string }, optional?: CallOptions): Promise<Outcome<Subject | null>>;
  upsert(required: { context: CallContext; subject: Subject; identifiers: readonly Identifier[] }, optional?: CallOptions): Promise<Outcome<Subject>>;
  merge(required: { context: CallContext; sourceSubjectId: string; targetSubjectId: string; mergedAt: number }, optional?: CallOptions): Promise<Outcome<Subject>>;
  identifiersFor(required: { context: CallContext | ServiceContext; subjectId: string }, optional?: CallOptions): Promise<Outcome<readonly Identifier[]>>;
}
/** Caller adapts current policy consent/suppression/erasure. Digests remain queryable after address erasure.
 * Missing authority denies. No policy implementation import is permitted here.
 * @example suppression.assess({ context, subjectId, identifierDigests, destination, purpose }) */
export interface ContactSuppressionPort {
  assess(required: { context: CallContext | ServiceContext; subjectId: string; identifierDigests: readonly string[]; destination: string; purpose: string }, optional?: CallOptions): Promise<Outcome<{ readonly allowed: boolean }>>;
}

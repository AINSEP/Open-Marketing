import type { CallContext, CallOptions, Outcome, Scope, ServiceContext } from "@open-marketing/contracts";

/** Phone values are E.164. Click identifiers never authorize automatic subject merges. */
export type IdentifierKind = "email" | "phone" | "external_customer_id" | "fbclid" | "fbc" | "fbp" | "gclid" | "gbraid" | "wbraid";
/** Raw input exists only at the contacts boundary; ledgers/outboxes carry IDs and digests. */
export interface IdentifierInput { readonly kind: IdentifierKind; readonly raw: string }
/** Contacts alone persists normalized identifiers. Local HMAC is separate from destination SHA-256. */
export interface Identifier {
  readonly identifierId: string;
  readonly subjectId: string;
  readonly kind: IdentifierKind;
  readonly normalizedValue: string;
  readonly normalizationVersion: string;
  readonly identifierDigest: string;
  readonly keyVersion: string;
}
/** Append merge lineage; resolve pointers at read. The earliest canonical ID keeps its experiment bucket. */
export interface MergeLineage { readonly sourceSubjectId: string; readonly targetSubjectId: string; readonly mergedAt: number }
/** creationOrder is immutable; ties use subjectId. Erasure purges addresses, retaining policy suppression digests. */
export interface Subject {
  readonly scope: Scope;
  readonly subjectId: string;
  readonly createdAt: number;
  readonly creationOrder: number;
  readonly mergedInto: string | null;
  readonly timezone?: string;
  readonly lineage: readonly MergeLineage[];
}
/** Transient, purpose/destination-bound output; never serialize the identifiers to durable evidence. */
export interface DestinationIdentifiers {
  readonly subjectId: string;
  readonly identifiers: Readonly<Record<string, string>>;
  readonly identifierDigests: Readonly<Record<string, string>>;
}
/** Frozen caller API. Missing subjects, suppression or authority yield explicit failed Outcomes. */
export interface ContactService {
  upsert(required: { context: CallContext; identifiers: readonly IdentifierInput[]; timezone?: string }, optional?: CallOptions): Promise<Outcome<Subject>>;
  resolve(required: { context: CallContext; identifier: IdentifierInput }, optional?: CallOptions): Promise<Outcome<Subject>>;
  merge(required: { context: CallContext; sourceSubjectId: string; targetSubjectId: string }, optional?: CallOptions): Promise<Outcome<Subject>>;
  identifiersFor(required: { context: CallContext | ServiceContext; subjectId: string; destination: string; purpose: string }, optional?: CallOptions): Promise<Outcome<DestinationIdentifiers>>;
}

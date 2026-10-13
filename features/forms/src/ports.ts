import type { CallContext, CallOptions, Outcome, SqlSession } from "@open-marketing/contracts";
import type { FormDefinitionRepoPort, FormSubmissionRepoPort } from "@jini-ai/cms/forms";
import type { ConsentCapture, FormPublication, SubmissionReceipt, FormSubjectReceipt } from "./types.js";

/** Published Jini repository shapes; request-local adapters preserve their foreign callback ABI. */
export type { FormDefinitionRepoPort, FormSubmissionRepoPort };
/** Immutable publication storage, scoped to a globally unique workspace UUID.
 * @example publications.append({ context, publication, session }) */
export interface FormPublicationPort {
  append(required: { context: CallContext; publication: FormPublication; session: SqlSession }, optional?: CallOptions): Promise<Outcome<FormPublication>>;
  find(required: { context: CallContext; publicationId: string }, optional?: CallOptions): Promise<Outcome<FormPublication | null>>;
  findBySlug(required: { context: CallContext; slug: string }, optional?: CallOptions): Promise<Outcome<FormPublication | null>>;
}
/** Durable replay check and receipt insert participate in the EXACT submission transaction.
 * @example receipts.find({ context, publicationId, attemptId, session }) */
export interface FormReceiptPort {
  find(required: { context: CallContext; publicationId: string; attemptId: string; session: SqlSession }, optional?: CallOptions): Promise<Outcome<SubmissionReceipt | null>>;
  append(required: { context: CallContext; receipt: SubmissionReceipt; session: SqlSession }, optional?: CallOptions): Promise<Outcome<SubmissionReceipt>>;
}
/** ONE jobs outbox, atomic with submission/receipt. Durable payload contains these IDs only.
 * @example jobs.enqueue({ context, submissionId, publicationId, session }) */
export interface FormJobsPort {
  enqueue(required: { context: CallContext; submissionId: string; publicationId: string; session: SqlSession }, optional?: CallOptions): Promise<Outcome<{ readonly jobId: string }>>;
}
/** Reload answers/wording from their owning stores. Acceptance is idempotent by submissionId.
 * The run-2 spike decides synchronous transaction binding versus an asynchronous jobs worker.
 * @example acceptance.accept({ context, submissionId, publicationId, consent, visitToken }) */
export interface FormAcceptancePort {
  accept(required: { context: CallContext; submissionId: string; publicationId: string; consent: readonly ConsentCapture[]; visitToken?: string; session?: SqlSession }, optional?: CallOptions): Promise<Outcome<{ readonly subjectId: string }>>;
}
/** Forms owns submission→subject linkage and answer erasure. Writes join acceptance's session.
 * Reads/purge use the injected transaction owner; list is bounded to 100 ID-only receipts.
 * @example subjects.append({ context, receipt, session }); */
export interface FormSubjectPort {
  find(required: { context: CallContext; submissionId: string; session: SqlSession }, optional?: CallOptions): Promise<Outcome<FormSubjectReceipt | null>>;
  append(required: { context: CallContext; receipt: FormSubjectReceipt; session: SqlSession }, optional?: CallOptions): Promise<Outcome<FormSubjectReceipt>>;
  list(required: { context: CallContext; limit: number }, optional?: CallOptions): Promise<Outcome<readonly FormSubjectReceipt[]>>;
  /** Clears answers, source IP and visit metadata; retains ID/digest receipts. Idempotent. */
  purgeSubject(required: { context: CallContext; subjectId: string }, optional?: CallOptions): Promise<Outcome<void>>;
}

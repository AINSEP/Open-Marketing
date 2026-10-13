import type { CallContext, CallOptions, Outcome, Page, PageQuery, Scope } from "@open-marketing/contracts";
import type { FieldDescriptor, FormSubmissionRecord } from "@jini-ai/cms/forms";

/** Immutable authored wording. Purpose is open (marketing_email, marketing_sms, audience, measurement).
 * Topic and target remain distinct; consent cannot be retroactively widened. */
export interface ConsentWording {
  readonly fieldId: string;
  readonly purpose: string;
  readonly topic: string;
  readonly target: string;
  readonly wording: string;
  readonly wordingVersion: string;
  readonly wordingDigest: string;
}
/** Captured choice binds the exact publication wording; policy owns evidence and withdrawal. */
export type ConsentCapture = Omit<ConsentWording, "wording"> & { readonly choice: boolean };
/** Publications append immutable form descriptors and wording; publish never mutates prior submissions. */
export interface FormPublication {
  readonly scope: Scope;
  readonly publicationId: string;
  readonly formDefinitionId: string;
  readonly slug: string;
  readonly version: number;
  readonly fields: readonly FieldDescriptor[];
  readonly consent: readonly ConsentWording[];
  readonly publishedAt: number;
}
/** Replay identity is workspace/publication/attempt. Same digest returns the original receipt; drift conflicts. */
export interface SubmissionReceipt {
  readonly publicationId: string;
  readonly attemptId: string;
  readonly bodyDigest: string;
  readonly submissionId: string;
  readonly jobId: string;
}
/** ID-only acceptance receipt; the original subject/time survive retries and answer erasure. */
export interface FormSubjectReceipt {
  readonly submissionId: string;
  readonly publicationId: string;
  readonly subjectId: string;
  readonly acceptedAt: number;
}
/** Discard creates no durable receipt, subject or job. Accepted/duplicate share the original identity. */
export type PublicSubmissionResult = { readonly status: "accepted" | "duplicate"; readonly receipt: SubmissionReceipt } | { readonly status: "discarded" };
/** Frozen service; adapters validate unknown bodies before invoking published submitForm. */
export interface FormsService {
  publish(required: { context: CallContext; publication: FormPublication }, optional?: CallOptions): Promise<Outcome<FormPublication>>;
  submitPublic(required: { context: CallContext; slug: string; publicationId: string; attemptId: string; body: unknown; visitToken?: string }, optional?: CallOptions): Promise<Outcome<PublicSubmissionResult>>;
  renderHostedForm(required: { context: CallContext; slug: string }, optional?: CallOptions): Promise<Outcome<{ readonly html: string; readonly publicationId: string }>>;
  listSubmissions(required: { context: CallContext; publicationId: string; page: PageQuery }, optional?: CallOptions): Promise<Outcome<Page<FormSubmissionRecord>>>;
}

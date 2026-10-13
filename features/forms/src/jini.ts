/** Narrow foreign callbacks for Jini submit/render, and sanitized forms boundary failures. */
import { z } from "zod";
import { idSchema } from "@open-marketing/contracts";
import type { AppError, CallContext, CallOptions, ClockPort, IdPort, Outcome, SqlSession } from "@open-marketing/contracts";
import { escapeFormHtml, FormDefinitionNotFoundError, FormRateLimitExceededError, FormSlugConflictError, FormSubmissionValidationError, renderHtmlForm, submitForm } from "@jini-ai/cms/forms";
import type { FormDefinitionRepoPort, FormJobsPort, FormReceiptPort, FormSubmissionRepoPort } from "./ports.js";
import type { FormPublication, SubmissionReceipt } from "./types.js";
import { definitionView, deny, parseReceipt } from "./rules.js";

/** Internal failure carrier makes a failed port Outcome abort the owning transaction. */
class FormsFailure extends Error {
  readonly detail: AppError;
  constructor(required: { error: AppError }) { super(required.error.message); this.detail = required.error; }
}

/** Unwrap only inside a root boundary: port denials must roll back partial writes. */
export function unwrap<T>(required: { outcome: Outcome<T> }): T {
  if (!required.outcome.ok) throw new FormsFailure(required.outcome);
  return required.outcome.value;
}

/** Catch opaque DB/Jini/port failures once; preserve typed denials without exposing input or SQL. */
export async function formsBoundary<T>(required: { work: () => Promise<Outcome<T>> }): Promise<Outcome<T>> {
  try { return await required.work(); }
  catch (error) { return failureOutcome({ error }); }
}

/** Classify foreign failures without depending on unstable error-message text. O(1), no effects. */
function failureOutcome<T>(required: { error: unknown }): Outcome<T> {
  const error = required.error;
  if (error instanceof FormsFailure) return { ok: false, error: error.detail };
  if (error instanceof FormSubmissionValidationError) return deny({ code: "invalid_input", message: "Form answers failed validation" });
  if (error instanceof FormSlugConflictError) return deny({ code: "conflict", message: "Form identity conflict" });
  if (error instanceof FormDefinitionNotFoundError) return deny({ code: "unavailable", message: "Form unavailable" });
  if (error instanceof FormRateLimitExceededError) return deny({ code: "limit_exceeded", message: "Form rate limit exceeded" });
  return deny({ code: "unavailable", message: "Forms boundary failed" });
}

/** Submit through Jini, joining the caller's session. Callback denials throw to the root.
 * No attempt cache or dispatcher work; ingress owns rate limits. O(b + f), fixed persistence calls.
 * @example submitWithJini({ context, publication, body, attemptId, digest, session, ...ports }); */
export async function submitWithJini(required: {
  context: CallContext; publication: FormPublication; body: Record<string, unknown>; attemptId: string; digest: string; visitToken?: string;
  session: SqlSession; definitions: FormDefinitionRepoPort; submissions: FormSubmissionRepoPort; jobs: FormJobsPort; receipts: FormReceiptPort; clock: ClockPort; ids: IdPort;
}, optional?: CallOptions): Promise<SubmissionReceipt> {
  let receipt: SubmissionReceipt | undefined;
  const publication = required.publication;
  const body = { ...required.body, om_publication: publication.publicationId, ...(required.visitToken === undefined ? {} : { om_vt: required.visitToken }) };
  await submitForm({ input: { workspaceId: required.context.scope.workspaceId, slug: publication.slug, body, sourceIp: "" }, deps: {
    definitionRepo: required.definitions, submissionRepo: required.submissions,
    clock: { nowMs: () => required.clock.now({}) }, idGen: { newId: () => idSchema.parse(required.ids.next({})) },
    rateLimiter: { check: () => ({ allowed: true }) }, logger: { warn() {} }, dispatcher: { async dispatch() {} },
    // Scalar-only Jini writes are awaited inside the caller's already-open root transaction.
    // The injected repositories and outbox join that root; no second transaction owner is needed.
    outbox: { async enqueue(event) {
      const submissionId = idSchema.parse(event.aggregateId);
      const job = unwrap({ outcome: await required.jobs.enqueue({ context: required.context, submissionId, publicationId: publication.publicationId, session: required.session }, optional) });
      const jobId = z.strictObject({ jobId: idSchema }).parse(job).jobId;
      const expected = { publicationId: publication.publicationId, attemptId: required.attemptId, bodyDigest: required.digest, submissionId, jobId };
      receipt = unwrap({ outcome: parseReceipt({ value: unwrap({ outcome: await required.receipts.append({ context: required.context, receipt: expected, session: required.session }, optional) }) }) });
      if (JSON.stringify(receipt) !== JSON.stringify(expected)) unwrap({ outcome: deny({ code: "conflict", message: "Receipt association mismatch" }) });
    } },
  } }, { definitionView: ({ definition }) => {
    if (definition.id !== publication.formDefinitionId || definition.workspaceId !== required.context.scope.workspaceId || definition.slug !== publication.slug) return unwrap({ outcome: deny<never>({ code: "conflict", message: "Jini definition association mismatch" }) });
    return { ...definitionView(required), status: definition.status };
  }, validateEmails: true });
  if (!receipt) return unwrap({ outcome: deny<never>({ code: "unavailable", message: "Submission did not create a durable receipt" }) });
  return receipt;
}

/** Render captured consent wording through Jini; metadata values are escaped independently.
 * O(f + o) bounded render work, no effects. @example renderPublication({ publication, attemptId }); */
export function renderPublication(required: { publication: FormPublication; attemptId: string }): string {
  const publication = required.publication;
  const wording = new Map(publication.consent.map(item => [item.fieldId, item.wording]));
  const fields = publication.fields.map(field => ({ ...field, label: wording.get(field.id) ?? field.label }));
  const html = renderHtmlForm({ slug: publication.slug, fields, action: "/f/" + encodeURIComponent(publication.slug),
    hooks: { field: "data-om-field", form: "data-om-form", success: "data-om-success", error: "data-om-error" } });
  const hidden = `<input type="hidden" name="om_publication" value="${escapeFormHtml({ value: publication.publicationId })}"><input type="hidden" name="_attempt" value="${escapeFormHtml({ value: required.attemptId })}">`;
  return html.replace("</form>", hidden + "</form>");
}

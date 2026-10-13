/** Forms orchestration behind the frozen contracts; all I/O is injected. */
import { idSchema, pageQuerySchema, parseBoundary } from "@open-marketing/contracts";
import type { CallContext, ClockPort, IdPort, Outcome, Page, UnitOfWork } from "@open-marketing/contracts";
import { isHoneypotTripped } from "@jini-ai/cms/forms";
import type { FormSubmissionRecord } from "@jini-ai/cms/forms";
import type { FormAcceptancePort, FormDefinitionRepoPort, FormJobsPort, FormPublicationPort, FormReceiptPort, FormSubmissionRepoPort } from "./ports.js";
import type { FormPublication, FormsService, PublicSubmissionResult } from "./types.js";
import { boundedJson, checkContext, definitionView, deny, parseBody, parsePublication, parseReceipt, submissionDigest, submissionPageSchema, visitTokenSchema } from "./rules.js";
import { formsBoundary, renderPublication, submitWithJini, unwrap } from "./jini.js";

/** Require a present, valid snapshot from the injected port. */
function requirePublication(required: { publication: FormPublication | null; context: CallContext }): FormPublication {
  if (!required.publication) return unwrap({ outcome: deny<never>({ code: "unavailable", message: "Form publication unavailable" }) });
  return unwrap({ outcome: parsePublication({ value: required.publication, context: required.context }) });
}

/** Durable identical replay returns original IDs; drift never overwrites its receipt. */
function replay(required: { receipt: unknown; digest: string; publicationId: string; attemptId: string }): PublicSubmissionResult {
  const receipt = unwrap({ outcome: parseReceipt({ value: required.receipt }) });
  if (receipt.bodyDigest !== required.digest || receipt.publicationId !== required.publicationId || receipt.attemptId !== required.attemptId) return unwrap({ outcome: deny<never>({ code: "conflict", message: "Submission replay conflict" }) });
  return { status: "duplicate", receipt };
}

/** Inert service. Publication snapshots append; public writes commit submission/receipt/one job.
 * Acceptance is performed only by the separate worker. Definition factories never start services.
 * O(b + f) bounded validation/render work, fixed submission writes, one bounded list page.
 * @example createFormsService({ definitions, submissions, publications, receipts, unitOfWork, jobs, acceptance, clock, ids }); */
export function createFormsService(required: { definitions: FormDefinitionRepoPort; submissions: FormSubmissionRepoPort; publications: FormPublicationPort; receipts: FormReceiptPort; unitOfWork: UnitOfWork; jobs: FormJobsPort; acceptance: FormAcceptancePort; clock: ClockPort; ids: IdPort }): FormsService {
  return {
    publish(input, optional) { return formsBoundary<FormPublication>({ work: async () => {
      unwrap({ outcome: checkContext(input, optional) });
      const publication = unwrap({ outcome: parsePublication({ value: input.publication, context: input.context }) });
      return required.unitOfWork.transaction({ work: async ({ session }): Promise<Outcome<FormPublication>> => {
        const existing = await required.definitions.findById({ workspaceId: input.context.scope.workspaceId, id: publication.formDefinitionId });
        if (existing && (existing.slug !== publication.slug || existing.id !== publication.formDefinitionId || existing.workspaceId !== input.context.scope.workspaceId)) return deny({ code: "conflict", message: "Definition identity conflict" });
        if (!existing) await required.definitions.create({ ...definitionView({ publication }), fields: structuredClone([...publication.fields]) });
        const saved = unwrap({ outcome: await required.publications.append({ context: input.context, publication, session }, optional) });
        return { ok: true, value: saved };
      } });
    } }); },
    submitPublic(input, optional) { return formsBoundary<PublicSubmissionResult>({ work: async () => {
      unwrap({ outcome: checkContext(input, optional) });
      for (const identifier of [input.slug, input.publicationId, input.attemptId]) unwrap({ outcome: parseBoundary({ schema: idSchema, input: identifier }) });
      if (input.visitToken !== undefined) unwrap({ outcome: parseBoundary({ schema: visitTokenSchema, input: input.visitToken }) });
      const body = unwrap({ outcome: parseBody(input) });
      if (isHoneypotTripped({ hp: body._hp })) return { ok: true, value: { status: "discarded" } };
      const { _hp, ...answers } = body;
      const publication = requirePublication({ context: input.context, publication: unwrap({ outcome: await required.publications.find(input, optional) }) });
      if (publication.slug !== input.slug || publication.publicationId !== input.publicationId) return deny({ code: "conflict", message: "Publication identity mismatch" });
      const digest = submissionDigest({ publicationId: input.publicationId, body: answers, ...(input.visitToken === undefined ? {} : { visitToken: input.visitToken }) });
      // Include server metadata in the same storage-size bound before any durable write.
      unwrap({ outcome: boundedJson({ value: { ...answers, om_publication: publication.publicationId, ...(input.visitToken === undefined ? {} : { om_vt: input.visitToken }) } }) });
      return required.unitOfWork.transaction({ work: async ({ session }): Promise<Outcome<PublicSubmissionResult>> => {
        const prior = unwrap({ outcome: await required.receipts.find({ ...input, session }, optional) });
        if (prior) return { ok: true, value: replay({ receipt: prior, digest, publicationId: input.publicationId, attemptId: input.attemptId }) };
        const receipt = await submitWithJini({ ...required, context: input.context, publication, body: answers, attemptId: input.attemptId, digest, session, ...(input.visitToken === undefined ? {} : { visitToken: input.visitToken }) }, optional);
        return { ok: true, value: { status: "accepted", receipt } };
      } });
    } }); },
    renderHostedForm(input, optional) { return formsBoundary<{ html: string; publicationId: string }>({ work: async () => {
      unwrap({ outcome: checkContext(input, optional) });
      unwrap({ outcome: parseBoundary({ schema: idSchema, input: input.slug }) });
      const publication = requirePublication({ context: input.context, publication: unwrap({ outcome: await required.publications.findBySlug(input, optional) }) });
      if (publication.slug !== input.slug) return deny({ code: "conflict", message: "Publication slug mismatch" });
      const attemptId = unwrap({ outcome: parseBoundary({ schema: idSchema, input: required.ids.next({}) }) });
      return { ok: true, value: { html: renderPublication({ publication, attemptId }), publicationId: publication.publicationId } };
    } }); },
    listSubmissions(input, optional) { return formsBoundary<Page<FormSubmissionRecord>>({ work: async () => {
      unwrap({ outcome: checkContext(input, optional) });
      unwrap({ outcome: parseBoundary({ schema: idSchema, input: input.publicationId }) });
      const page = unwrap({ outcome: parseBoundary({ schema: pageQuerySchema, input: input.page }) });
      const publication = requirePublication({ context: input.context, publication: unwrap({ outcome: await required.publications.find(input, optional) }) });
      if (publication.publicationId !== input.publicationId) return deny({ code: "conflict", message: "Publication identity mismatch" });
      const result = unwrap({ outcome: parseBoundary({ schema: submissionPageSchema, input: await required.submissions.listByDefinition({ workspaceId: input.context.scope.workspaceId, formDefinitionId: publication.formDefinitionId, limit: page.limit }, { cursor: page.cursor }) }) });
      if (result.items.length > page.limit) return deny({ code: "unavailable", message: "Submission page exceeds limit" });
      return { ok: true, value: { items: result.items.filter(item => item.workspaceId === input.context.scope.workspaceId && item.formDefinitionId === publication.formDefinitionId && item.data.om_publication === publication.publicationId), cursor: result.nextCursor } };
    } }); },
  };
}

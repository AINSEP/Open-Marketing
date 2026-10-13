/** ID-only jobs reload immutable wording and live, erasable answers before acceptance. */
import { idSchema, parseBoundary } from "@open-marketing/contracts";
import type { CallContext, CallOptions, Outcome, UnitOfWork } from "@open-marketing/contracts";
import type { FormAcceptancePort, FormPublicationPort, FormSubmissionRepoPort } from "./ports.js";
import { acceptanceData, checkContext, deny, parsePublication, submissionRecordSchema } from "./rules.js";
import { formsBoundary, unwrap } from "./jini.js";

/** Run retry-safe acceptance keyed by submissionId. The supplier owns atomic contact/evidence/visit
 * effects and current withdrawal/suppression checks; captured choices never restore authority.
 * Publication loads before opening the acceptance transaction to avoid a second pool lease.
 * O(b + f) bounded validation, two reloads and one supplier call; no second ledger or outbox.
 * @example acceptFormSubmission({ context, submissionId, publicationId, submissions, publications, acceptance, unitOfWork }); */
export function acceptFormSubmission(required: {
  context: CallContext; submissionId: string; publicationId: string; submissions: FormSubmissionRepoPort;
  publications: FormPublicationPort; acceptance: FormAcceptancePort; unitOfWork: UnitOfWork;
}, optional?: CallOptions): Promise<Outcome<{ subjectId: string }>> {
  return formsBoundary({ work: async () => {
    unwrap({ outcome: checkContext(required, optional) });
    unwrap({ outcome: parseBoundary({ schema: idSchema, input: required.submissionId }) });
    unwrap({ outcome: parseBoundary({ schema: idSchema, input: required.publicationId }) });
    const saved = unwrap({ outcome: await required.publications.find(required, optional) });
    if (!saved) return deny({ code: "unavailable", message: "Acceptance publication unavailable" });
    const publication = unwrap({ outcome: parsePublication({ value: saved, context: required.context }) });
    if (publication.publicationId !== required.publicationId) return deny({ code: "conflict", message: "Acceptance publication mismatch" });
    return required.unitOfWork.transaction({ work: async ({ session }): Promise<Outcome<{ subjectId: string }>> => {
      const savedSubmission = await required.submissions.findById({ workspaceId: required.context.scope.workspaceId, id: required.submissionId });
      if (!savedSubmission) return deny({ code: "unavailable", message: "Acceptance submission unavailable" });
      const submission = unwrap({ outcome: parseBoundary({ schema: submissionRecordSchema, input: savedSubmission }) });
      if (submission.id !== required.submissionId || submission.workspaceId !== required.context.scope.workspaceId || submission.formDefinitionId !== publication.formDefinitionId) return deny({ code: "conflict", message: "Acceptance submission mismatch" });
      const data = unwrap({ outcome: acceptanceData({ publication, data: submission.data }) });
      const result = unwrap({ outcome: await required.acceptance.accept({ context: required.context, submissionId: required.submissionId, publicationId: publication.publicationId, ...data, session }, optional) });
      const subjectId = unwrap({ outcome: parseBoundary({ schema: idSchema, input: result.subjectId }) });
      return { ok: true, value: { subjectId } };
    } });
  } });
}

import { notImplemented } from "@open-marketing/contracts";
import type { ClockPort, IdPort, UnitOfWork } from "@open-marketing/contracts";
import type { FormAcceptancePort, FormDefinitionRepoPort, FormJobsPort, FormPublicationPort, FormReceiptPort, FormSubmissionRepoPort } from "./ports.js";
import type { FormsService } from "./types.js";

/** Inert scaffold. Composition binds Jini repositories to the single owning kernel.
 * @example createFormsService({ definitions, submissions, publications, receipts, unitOfWork, jobs, acceptance, clock, ids })
 * @complexity O(1) time/space; methods fail explicitly without I/O. */
export function createFormsService(_required: { definitions: FormDefinitionRepoPort; submissions: FormSubmissionRepoPort; publications: FormPublicationPort; receipts: FormReceiptPort; unitOfWork: UnitOfWork; jobs: FormJobsPort; acceptance: FormAcceptancePort; clock: ClockPort; ids: IdPort }): FormsService {
  return {
    async publish() { return notImplemented({ operation: "forms.publish" }); },
    async submitPublic() { return notImplemented({ operation: "forms.submitPublic" }); },
    async renderHostedForm() { return notImplemented({ operation: "forms.renderHostedForm" }); },
    async listSubmissions() { return notImplemented({ operation: "forms.listSubmissions" }); },
  };
}

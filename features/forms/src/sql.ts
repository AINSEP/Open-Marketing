/** OM snapshot/receipt storage over injected sessions; no driver or transaction construction. */
import { z } from "zod";
import { idSchema, parseBoundary } from "@open-marketing/contracts";
import type { CallContext, Outcome, SqlSession, UnitOfWork } from "@open-marketing/contracts";
import type { FormPublicationPort, FormReceiptPort, FormSubjectPort } from "./ports.js";
import type { FormPublication, SubmissionReceipt, FormSubjectReceipt } from "./types.js";
import { formSubjectSchema, checkContext, deny, parsePublication, parseReceipt, samePublication } from "./rules.js";
import { formsBoundary, unwrap } from "./jini.js";

/** Read and validate snapshot JSON from SQL before trusting it. */
function publicationRow(required: { row: Record<string, unknown>; context: CallContext }): Outcome<FormPublication> {
  const json = z.string().max(65536).safeParse(required.row.publication_json);
  if (!json.success) return deny({ code: "unavailable", message: "Invalid stored publication" });
  return parsePublication({ value: JSON.parse(json.data), context: required.context });
}

/** SQL column names never leak into the public receipt shape. */
function receiptRow(required: { row: Record<string, unknown> }): Outcome<SubmissionReceipt> {
  const row = required.row;
  return parseReceipt({ value: { publicationId: row.publication_id, attemptId: row.attempt_id, bodyDigest: row.body_digest, submissionId: row.submission_id, jobId: row.job_id } });
}

/** Collision reads use the exact caller transaction; uniqueness is the concurrent tie-break. */
async function existingPublication(required: { context: CallContext; publication: FormPublication; session: SqlSession }): Promise<FormPublication | null> {
  const result = await required.session.query({ text: "SELECT publication_json FROM om_form_publications WHERE workspace_id=$1 AND (publication_id=$2 OR (slug=$3 AND version=$4))", values: [required.context.scope.workspaceId, required.publication.publicationId, required.publication.slug, required.publication.version] });
  if (!result.rows[0]) return null;
  return unwrap({ outcome: publicationRow({ row: result.rows[0], context: required.context }) });
}

/** Inert SQL adapters; append joins the supplied session, independent reads use the injected unit.
 * O(b) bounded JSON work plus indexed reads/inserts; no retries or migrations.
 * @example const storage = createSqlFormsStorage({ unitOfWork }); */
export function createSqlFormsStorage(required: { unitOfWork: UnitOfWork }): { publications: FormPublicationPort; receipts: FormReceiptPort; subjects: FormSubjectPort } {
  const publications: FormPublicationPort = {
    append(input, optional) { return formsBoundary<FormPublication>({ work: async () => {
      unwrap({ outcome: checkContext(input, optional) });
      const publication = unwrap({ outcome: parsePublication({ value: input.publication, context: input.context }) });
      const existing = await existingPublication({ ...input, publication });
      if (existing && !samePublication({ left: existing, right: publication })) return deny({ code: "conflict", message: "Publication identity conflict" });
      if (existing) return { ok: true, value: existing };
      await input.session.query({ text: "INSERT INTO om_form_publications (workspace_id,publication_id,form_definition_id,slug,version,publication_json,published_at) VALUES ($1,$2,$3,$4,$5,$6,$7)", values: [publication.scope.workspaceId, publication.publicationId, publication.formDefinitionId, publication.slug, publication.version, JSON.stringify(publication), publication.publishedAt] });
      return { ok: true, value: publication };
    } }); },
    find(input, optional) { return formsBoundary<FormPublication | null>({ work: async () => {
      unwrap({ outcome: checkContext(input, optional) });
      unwrap({ outcome: parseBoundary({ schema: idSchema, input: input.publicationId }) });
      return required.unitOfWork.transaction({ work: async ({ session }): Promise<Outcome<FormPublication | null>> => {
        const result = await session.query({ text: "SELECT publication_json FROM om_form_publications WHERE workspace_id=$1 AND publication_id=$2", values: [input.context.scope.workspaceId, input.publicationId] });
        if (!result.rows[0]) return { ok: true, value: null };
        return publicationRow({ row: result.rows[0], context: input.context });
      } });
    } }); },
    findBySlug(input, optional) { return formsBoundary<FormPublication | null>({ work: async () => {
      unwrap({ outcome: checkContext(input, optional) });
      unwrap({ outcome: parseBoundary({ schema: idSchema, input: input.slug }) });
      return required.unitOfWork.transaction({ work: async ({ session }): Promise<Outcome<FormPublication | null>> => {
        const result = await session.query({ text: "SELECT publication_json FROM om_form_publications WHERE workspace_id=$1 AND slug=$2 ORDER BY version DESC LIMIT 1", values: [input.context.scope.workspaceId, input.slug] });
        if (!result.rows[0]) return { ok: true, value: null };
        return publicationRow({ row: result.rows[0], context: input.context });
      } });
    } }); },
  };
  const receipts: FormReceiptPort = {
    find(input, optional) { return formsBoundary<SubmissionReceipt | null>({ work: async () => {
      unwrap({ outcome: checkContext(input, optional) });
      unwrap({ outcome: parseBoundary({ schema: idSchema, input: input.publicationId }) });
      unwrap({ outcome: parseBoundary({ schema: idSchema, input: input.attemptId }) });
      const result = await input.session.query({ text: "SELECT publication_id,attempt_id,body_digest,submission_id,job_id FROM om_form_submission_receipts WHERE workspace_id=$1 AND publication_id=$2 AND attempt_id=$3", values: [input.context.scope.workspaceId, input.publicationId, input.attemptId] });
      if (!result.rows[0]) return { ok: true, value: null };
      return receiptRow({ row: result.rows[0] });
    } }); },
    append(input, optional) { return formsBoundary<SubmissionReceipt>({ work: async () => {
      unwrap({ outcome: checkContext(input, optional) });
      const receipt = unwrap({ outcome: parseReceipt({ value: input.receipt }) });
      const existing = unwrap({ outcome: await receipts.find({ context: input.context, ...receipt, session: input.session }, optional) });
      if (existing && JSON.stringify(existing) !== JSON.stringify(receipt)) return deny({ code: "conflict", message: "Receipt identity conflict" });
      if (existing) return { ok: true, value: existing };
      await input.session.query({ text: "INSERT INTO om_form_submission_receipts (workspace_id,publication_id,attempt_id,body_digest,submission_id,job_id) VALUES ($1,$2,$3,$4,$5,$6)", values: [input.context.scope.workspaceId, receipt.publicationId, receipt.attemptId, receipt.bodyDigest, receipt.submissionId, receipt.jobId] });
      return { ok: true, value: receipt };
    } }); },
  };
  const subjects: FormSubjectPort = {
    find(input, optional) { return formsBoundary<FormSubjectReceipt | null>({ work: async () => {
      unwrap({ outcome: checkContext(input, optional) });
      idSchema.parse(input.submissionId);
      const result = await input.session.query({ text: "SELECT submission_id AS submissionId, publication_id AS publicationId, subject_id AS subjectId, accepted_at AS acceptedAt FROM om_form_subject_receipts WHERE workspace_id=$1 AND submission_id=$2", values: [input.context.scope.workspaceId, input.submissionId] });
      return { ok: true, value: result.rows[0] ? formSubjectSchema.parse(result.rows[0]) : null };
    } }); },
    append(input, optional) { return formsBoundary<FormSubjectReceipt>({ work: async () => {
      unwrap({ outcome: checkContext(input, optional) });
      const receipt = formSubjectSchema.parse(input.receipt);
      const prior = unwrap({ outcome: await subjects.find({ context: input.context, submissionId: receipt.submissionId, session: input.session }, optional) });
      if (prior && JSON.stringify(prior) !== JSON.stringify(receipt)) return deny({ code: "conflict", message: "Acceptance receipt conflict" });
      if (prior) return { ok: true, value: prior };
      await input.session.query({ text: "INSERT INTO om_form_subject_receipts (workspace_id,submission_id,publication_id,subject_id,accepted_at) VALUES ($1,$2,$3,$4,$5)", values: [input.context.scope.workspaceId, receipt.submissionId, receipt.publicationId, receipt.subjectId, receipt.acceptedAt] });
      return { ok: true, value: receipt };
    } }); },
    list(input, optional) { return formsBoundary<readonly FormSubjectReceipt[]>({ work: async () => {
      unwrap({ outcome: checkContext(input, optional) });
      const limit = z.number().int().min(1).max(100).parse(input.limit);
      return required.unitOfWork.transaction({ work: async ({ session }) => {
        const result = await session.query({ text: "SELECT submission_id AS submissionId, publication_id AS publicationId, subject_id AS subjectId, accepted_at AS acceptedAt FROM om_form_subject_receipts WHERE workspace_id=$1 ORDER BY accepted_at DESC, submission_id DESC LIMIT $2", values: [input.context.scope.workspaceId, limit] });
        return { ok: true as const, value: result.rows.map(row => formSubjectSchema.parse(row)) };
      } });
    } }); },
    purgeSubject(input, optional) { return formsBoundary<void>({ work: async () => {
      unwrap({ outcome: checkContext(input, optional) });
      idSchema.parse(input.subjectId);
      return required.unitOfWork.transaction({ work: async ({ session }) => {
        await session.query({ text: "UPDATE om_form_submissions SET data_json='{}', source_ip=NULL, deleted_at=COALESCE(deleted_at,submitted_at) WHERE workspace_id=$1 AND id IN (SELECT submission_id FROM om_form_subject_receipts WHERE workspace_id=$1 AND subject_id=$2)", values: [input.context.scope.workspaceId, input.subjectId] });
        return { ok: true as const, value: undefined };
      } });
    } }); },
  };
  return { publications, receipts, subjects };
}

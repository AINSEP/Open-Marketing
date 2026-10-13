/** OM snapshot/receipt storage over injected sessions; no driver or transaction construction. */
import { z } from "zod";
import { idSchema, parseBoundary } from "@open-marketing/contracts";
import type { CallContext, Outcome, SqlSession, UnitOfWork } from "@open-marketing/contracts";
import type { FormPublicationPort, FormReceiptPort } from "./ports.js";
import type { FormPublication, SubmissionReceipt } from "./types.js";
import { checkContext, deny, parsePublication, parseReceipt, samePublication } from "./rules.js";
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
export function createSqlFormsStorage(required: { unitOfWork: UnitOfWork }): { publications: FormPublicationPort; receipts: FormReceiptPort } {
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
  return { publications, receipts };
}

/** Bounded publication/submission rules; no persistence or authority decisions live here. */
import { createHash } from "node:crypto";
import { z } from "zod";
import { callContextSchema, digestSchema, epochSchema, idSchema, scopeSchema } from "@open-marketing/contracts";
import type { AppError, CallContext, CallOptions, Outcome } from "@open-marketing/contracts";
import { validateFieldDescriptors, validateSubmissionPayload } from "@jini-ai/cms/forms";
import type { FieldDescriptor, FormDefinitionRecord } from "@jini-ai/cms/forms";
import type { ConsentCapture, FormPublication, SubmissionReceipt } from "./types.js";

const scalar = z.union([z.string().max(5000), z.number().finite(), z.boolean(), z.array(z.string().max(200)).max(100)]);
const fieldSchema = z.strictObject({
  id: idSchema, label: z.string().min(1).max(200),
  type: z.enum(["text", "textarea", "email", "phone", "url", "number", "range", "date", "time", "datetime", "select", "multi-select", "radio", "checkbox", "checkbox-group", "toggle", "hidden"]),
  required: z.boolean(), name: idSchema.optional(), placeholder: z.string().max(500).optional(), helpText: z.string().max(500).optional(),
  default: scalar.optional(), options: z.array(z.strictObject({ value: z.string().min(1).max(200), label: z.string().min(1).max(200) })).max(100).optional(),
  minLength: z.number().int().nonnegative().optional(), maxLength: z.number().int().nullable().optional(), pattern: z.string().max(500).optional(),
  min: z.union([z.number().finite(), z.string().max(256)]).optional(), max: z.union([z.number().finite(), z.string().max(256)]).optional(), step: z.number().finite().optional(),
  checkboxValue: z.string().max(200).optional(), className: z.string().max(300).optional(),
  attributes: z.record(z.string().max(100), z.string().max(300)).refine(value => Object.keys(value).length <= 12).optional(),
});
const wordingSchema = z.strictObject({ fieldId: idSchema, purpose: idSchema, topic: idSchema, target: idSchema,
  wording: z.string().min(1).max(5000), wordingVersion: idSchema, wordingDigest: digestSchema });
/** Full bounded publication wire schema; publish additionally checks scope, CMS fields and independent consent wording. */
export const publicationSchema = z.strictObject({ scope: scopeSchema, publicationId: idSchema, formDefinitionId: idSchema,
  slug: idSchema, version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  fields: z.array(fieldSchema).min(1).max(20), consent: z.array(wordingSchema).max(20), publishedAt: epochSchema.max(8_640_000_000_000_000) });
/** Receipt data has only reload IDs and a digest; validates SQL and injected port results. */
export const receiptSchema = z.strictObject({ publicationId: idSchema, attemptId: idSchema, bodyDigest: digestSchema, submissionId: idSchema, jobId: idSchema });
/** Opaque visit tokens match the web-events consumer's 4096-character boundary; never an ID. */
export const visitTokenSchema = z.string().min(1).max(4096);
const bodySchema = z.record(idSchema, scalar).refine(value => Object.keys(value).length <= 25);
/** Jini records are tainted until their identity, scalar answers and page shape are validated. */
export const submissionRecordSchema = z.strictObject({ id: idSchema, workspaceId: idSchema, formDefinitionId: idSchema,
  data: bodySchema, sourceIp: z.string().max(256).nullable(), submittedAt: z.iso.datetime() });
/** Listing preserves Jini's scanned cursor, even for an empty filtered page. */
export const submissionPageSchema = z.strictObject({ items: z.array(submissionRecordSchema).max(100), nextCursor: idSchema.nullable() });

/** Stable errors never include answers, tokens or third-party error messages. */
export function deny<T>(required: { code: AppError["code"]; message: string }): Outcome<T> {
  return { ok: false, error: { ...required, retryable: required.code === "unavailable" } };
}

/** Check bounded JSON before schema traversal. O(b) time/space, b capped at 64 KiB. */
export function boundedJson(required: { value: unknown }): Outcome<string> {
  try {
    const json = JSON.stringify(required.value);
    if (json === undefined || Buffer.byteLength(json, "utf8") > 65536) return deny({ code: "invalid_input", message: "Form JSON exceeds its bound" });
    return { ok: true, value: json };
  } catch {
    return deny({ code: "invalid_input", message: "Form JSON is not serializable" });
  }
}

/** Boundary context is supplied by authenticated ingress; owner/workspace authorization stays there. */
export function checkContext(required: { context: CallContext }, optional?: CallOptions): Outcome<CallContext> {
  if (optional?.signal?.aborted) return deny({ code: "cancelled", message: "Forms operation cancelled" });
  const parsed = callContextSchema.safeParse(required.context);
  if (!parsed.success) return deny({ code: "invalid_input", message: "Invalid forms context" });
  if (parsed.data.principal.kind === "owner" && parsed.data.principal.ownerId !== parsed.data.scope.ownerId) return deny({ code: "forbidden", message: "Owner scope mismatch" });
  return { ok: true, value: parsed.data };
}

/** SHA-256 of the exact captured UTF-8 wording, without normalization. */
export function wordingDigest(required: { wording: string }): string {
  return createHash("sha256").update(required.wording, "utf8").digest("hex");
}

/** Enforce one independent, optional, initially unchecked boolean field per consent entry. */
function validConsent(required: { publication: FormPublication }): boolean {
  const fields = new Map(required.publication.fields.map(field => [field.id, field]));
  const seen = new Set<string>();
  return required.publication.consent.every(item => {
    const field = fields.get(item.fieldId);
    if (!field || seen.has(item.fieldId)) return false;
    seen.add(item.fieldId);
    if (field.type !== "checkbox" || field.required || field.checkboxValue !== undefined) return false;
    if (field.default !== undefined && field.default !== false) return false;
    return item.wordingDigest === wordingDigest(item);
  });
}

/** Parse immutable snapshots and reserved names. O(f + o + b), all collections bounded.
 * @example parsePublication({ value: publication, context }); */
export function parsePublication(required: { value: unknown; context: CallContext }): Outcome<FormPublication> {
  const json = boundedJson(required);
  if (!json.ok) return json;
  const parsed = publicationSchema.safeParse(required.value);
  if (!parsed.success) return deny({ code: "invalid_input", message: "Invalid form publication" });
  const publication = parsed.data;
  if (publication.scope.workspaceId !== required.context.scope.workspaceId || publication.scope.ownerId !== required.context.scope.ownerId) return deny({ code: "forbidden", message: "Publication scope mismatch" });
  if (publication.fields.some(field => field.id.startsWith("om_") || field.id === "_hp" || field.id === "_attempt")) return deny({ code: "invalid_input", message: "Reserved form field" });
  if (!validateFieldDescriptors({ fields: publication.fields }).valid || !validConsent({ publication })) return deny({ code: "invalid_input", message: "Invalid fields or consent wording" });
  return { ok: true, value: publication };
}

/** Sorted-key JSON for the shallow scalar/choice envelope. Arrays retain their meaningful order. */
export function canonicalJson(required: { value: unknown }): string {
  return JSON.stringify(sortedValue(required));
}

/** Only schema-validated, bounded JSON reaches this traversal; recursion follows descriptor depth.
 * O(k log k) per object's k keys, O(b) space for the capped envelope. */
function sortedValue(required: { value: unknown }): unknown {
  const value = required.value;
  if (Array.isArray(value)) return value.map(item => sortedValue({ value: item }));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortedValue({ value: (value as Record<string, unknown>)[key] })]));
}

/** Exact replay/collision comparison does not depend on object insertion order. */
export function samePublication(required: { left: FormPublication; right: FormPublication }): boolean {
  return canonicalJson({ value: required.left }) === canonicalJson({ value: required.right });
}

/** Strip transport metadata; only explicit method arguments may supply publication/visit identity. */
export function parseBody(required: { body: unknown }): Outcome<Record<string, z.infer<typeof scalar>>> {
  const json = boundedJson({ value: required.body });
  if (!json.ok) return json;
  const parsed = bodySchema.safeParse(required.body);
  if (!parsed.success) return deny({ code: "invalid_input", message: "Invalid form answers" });
  const { _attempt, om_publication, om_vt, ...answers } = parsed.data;
  return { ok: true, value: answers };
}

/** A request-local view preserves history and captures server-owned metadata in erasable data. */
export function definitionView(required: { publication: FormPublication; visitToken?: string }): FormDefinitionRecord {
  const publication = required.publication;
  const wording = new Map(publication.consent.map(item => [item.fieldId, item.wording]));
  const fields: FieldDescriptor[] = publication.fields.map(field => ({ ...field, label: wording.get(field.id) ?? field.label }));
  fields.push({ id: "om_publication", label: "Publication", type: "hidden", required: true });
  if (required.visitToken !== undefined) fields.push({ id: "om_vt", label: "Visit", type: "hidden", required: true });
  const at = new Date(publication.publishedAt).toISOString();
  return { id: publication.formDefinitionId, workspaceId: publication.scope.workspaceId, name: publication.slug, slug: publication.slug,
    fields, notify: { enabled: false, recipients: [] }, status: "active", createdAt: at, updatedAt: at, version: 1 };
}

/** Canonical bounded submission envelope; absent optional metadata is omitted, never undefined. */
export function submissionDigest(required: { publicationId: string; body: Record<string, unknown>; visitToken?: string }): string {
  const envelope = { publicationId: required.publicationId, body: required.body, ...(required.visitToken === undefined ? {} : { visitToken: required.visitToken }) };
  return createHash("sha256").update(canonicalJson({ value: envelope })).digest("hex");
}

/** Validate live reloaded answers and derive each independent choice. Missing checkboxes mean false.
 * O(f + o + b); no historical scan or effects. Malformed/erased records deny acceptance. */
export function acceptanceData(required: { publication: FormPublication; data: unknown }): Outcome<{ consent: readonly ConsentCapture[]; visitToken?: string }> {
  const json = boundedJson({ value: required.data });
  if (!json.ok) return json;
  const parsed = bodySchema.safeParse(required.data);
  if (!parsed.success || parsed.data.om_publication !== required.publication.publicationId) return deny({ code: "conflict", message: "Submission publication mismatch" });
  const visitToken = parsed.data.om_vt;
  if (visitToken !== undefined && !visitTokenSchema.safeParse(visitToken).success) return deny({ code: "invalid_input", message: "Invalid stored visit token" });
  const definition = definitionView({ publication: required.publication, ...(typeof visitToken === "string" ? { visitToken } : {}) });
  if (!validateSubmissionPayload({ definition, body: parsed.data }).valid) return deny({ code: "invalid_input", message: "Invalid stored form answers" });
  const captures = required.publication.consent.map(({ wording: _wording, ...item }) => ({ ...item, choice: parsed.data[item.fieldId] === true }));
  if (required.publication.consent.some(item => parsed.data[item.fieldId] !== undefined && typeof parsed.data[item.fieldId] !== "boolean")) return deny({ code: "invalid_input", message: "Invalid stored consent choice" });
  return { ok: true, value: { consent: captures, ...(typeof visitToken === "string" ? { visitToken } : {}) } };
}

/** Parse receipts without trusting injected or database output. */
export function parseReceipt(required: { value: unknown }): Outcome<SubmissionReceipt> {
  const parsed = receiptSchema.safeParse(required.value);
  if (!parsed.success) return deny({ code: "unavailable", message: "Invalid stored receipt" });
  return { ok: true, value: parsed.data };
}

/** Exact ID-only receipt parser shared by the memory and SQL stores. */
export const formSubjectSchema = z.strictObject({ submissionId: idSchema, publicationId: idSchema, subjectId: idSchema, acceptedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) });

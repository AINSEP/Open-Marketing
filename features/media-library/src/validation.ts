import { z } from 'zod';
import { callContextSchema, digestSchema, epochSchema, idSchema, moneySchema, pageQuerySchema } from '@open-marketing/contracts';
import type { AppError, CallContext, CallOptions, Outcome, Scope } from '@open-marketing/contracts';
import { computeBlobStorageKey } from '@jini-ai/cms/media';

/** Marketing evidence is bounded and separate from Jini editorial records. */
export const provenanceSchema = z.strictObject({
  operationId: idSchema, source: z.string().min(1).max(2048), prompt: z.string().max(16000).nullable(),
  model: z.string().min(1).max(256).nullable(), seed: z.number().int().safe().nullable(), cost: moneySchema.nullable(),
  vendorTerms: z.strictObject({ url: z.url().max(2048), digest: digestSchema, observedAt: epochSchema }).nullable(),
  rights: z.strictObject({ evidenceId: idSchema, license: z.string().min(1).max(1024), permittedUses: z.array(idSchema).max(100) }),
  generationId: idSchema.optional(), quoteId: idSchema.optional(), providerJobId: idSchema.optional(), reservationId: idSchema.optional(),
});
export const importSchema = z.strictObject({ sourceUrl: z.url().max(2048), operationId: idSchema, expectedDigest: digestSchema, provenance: provenanceSchema })
  .refine(value => value.operationId === value.provenance.operationId);
const isoSchema = z.iso.datetime({ offset: true });
const pixelsSchema = z.number().int().positive().max(8000).nullable();
export const recordSchema = z.strictObject({
  id: idSchema, workspaceId: idSchema, title: z.string().max(2048), slug: z.string().min(1).max(256),
  alt: z.string().max(4096), caption: z.string().max(16000), credit: z.string().max(4096),
  source: z.strictObject({ sha256: digestSchema }), status: z.enum(['active', 'trashed']),
  createdAt: isoSchema, updatedAt: isoSchema, version: z.number().int().positive(),
  width: pixelsSchema, height: pixelsSchema, cssClass: z.string().max(2048).nullable(), htmlAttributes: z.string().max(4096).nullable(),
});
export const blobSchema = z.strictObject({ id: idSchema, workspaceId: idSchema, sha256: digestSchema, storageKey: z.string().max(1024),
  createdByPrincipal: idSchema, createdAt: isoSchema, status: z.enum(['active', 'tombstoned']), tombstonedAt: isoSchema.optional() });
export const assetSchema = z.strictObject({ record: recordSchema, blob: blobSchema, provenance: provenanceSchema.nullable() })
  .refine(value => value.record.workspaceId === value.blob.workspaceId && value.record.source.sha256 === value.blob.sha256)
  .refine(value => value.blob.storageKey === computeBlobStorageKey(value.blob));
export const renditionSchema = z.strictObject({ id: idSchema, workspaceId: idSchema, assetId: idSchema, transformName: idSchema,
  version: z.number().int().positive(), storageKey: z.string().max(1024), createdAt: isoSchema })
  .refine(value => canonicalKey({ storageKey: value.storageKey, workspaceId: value.workspaceId }));
export const cropRequestSchema = z.strictObject({ assetId: idSchema, placement: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/), presetVersion: z.number().int().min(1).max(10000) });
export const cropSchema = cropRequestSchema.extend({ cropId: idSchema, rendition: renditionSchema })
  .refine(value => value.rendition.assetId === value.assetId);
export const querySchema = pageQuerySchema;
export const linkSchema = z.strictObject({ provenance: provenanceSchema, assetId: idSchema.optional() });
export const costSchema = z.strictObject({ observationId: idSchema, operationId: idSchema, amount: moneySchema,
  kind: z.enum(['estimated', 'actual', 'correction']), correctionOf: idSchema.optional() })
  .refine(value => (value.kind === 'correction') === (value.correctionOf !== undefined))
  .refine(value => value.correctionOf !== value.observationId);
export const presetSchema = z.strictObject({ placement: cropRequestSchema.shape.placement, version: cropRequestSchema.shape.presetVersion,
  params: z.strictObject({ width: z.number().int().min(1).max(8000), height: z.number().int().min(1).max(8000),
    fit: z.enum(['cover', 'fill']), format: z.enum(['jpeg', 'png', 'webp']) }) });

/** Stable boundary failures do not disclose input, paths or driver errors. */
export function fail<T>(required: { code: AppError['code']; message: string }): Outcome<T> {
  return { ok: false, error: { ...required, retryable: false } };
}
export function success<T>(required: { value: T }): Outcome<T> { return { ok: true, value: required.value }; }
export function sameScope(required: { left: Scope; right: Scope }): boolean {
  return required.left.ownerId === required.right.ownerId && required.left.workspaceId === required.right.workspaceId;
}
/** Authenticated host contexts are checked before I/O; bound adapters deny another tenant. @complexity O(1). */
export function checkContext(required: { context: CallContext; options?: CallOptions; scope?: Scope }): Outcome<void> {
  if (!callContextSchema.safeParse(required.context).success) return fail({ code: 'invalid_input', message: 'Invalid call context' });
  if (required.options?.signal?.aborted) return fail({ code: 'cancelled', message: 'Call cancelled' });
  const { principal, scope } = required.context;
  if (principal.kind === 'owner' && principal.ownerId !== scope.ownerId) return fail({ code: 'forbidden', message: 'Owner scope mismatch' });
  if (required.scope && !sameScope({ left: scope, right: required.scope })) return fail({ code: 'forbidden', message: 'Scope mismatch' });
  return success({ value: undefined });
}
export function scopeKey(required: { context: CallContext }): string { return JSON.stringify([required.context.scope.ownerId, required.context.scope.workspaceId]); }
/** Validate Jini's exact key grammar before storage access; no traversal or cross-workspace keys. @complexity O(1). */
export function checkStorageKey(required: { context: CallContext; storageKey: string }): Outcome<void> {
  const match = /^ws\/([A-Za-z0-9_-]{1,256})\/blobs\/([a-f0-9]{2})\/([a-f0-9]{64})$/.exec(required.storageKey);
  if (!match || match[2] !== match[3].slice(0, 2)) return fail({ code: 'invalid_input', message: 'Invalid storage key' });
  if (match[1] !== required.context.scope.workspaceId) return fail({ code: 'forbidden', message: 'Blob scope mismatch' });
  return success({ value: undefined });
}

/** Canonical key identity is checked on tainted rendition metadata as well as direct blob calls. @complexity O(1). */
function canonicalKey(required: { storageKey: string; workspaceId: string }): boolean {
  const parts = /^ws\/([A-Za-z0-9_-]{1,256})\/blobs\/([a-f0-9]{2})\/([a-f0-9]{64})$/.exec(required.storageKey);
  if (!parts) return false;
  return parts[1] === required.workspaceId && parts[2] === parts[3].slice(0, 2);
}

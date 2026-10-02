import { z } from "zod";
import { callContextSchema, digestSchema, epochSchema, idSchema, moneySchema, pageQuerySchema, scopeSchema } from "@open-marketing/contracts";
import type { AppError, CallContext, CallOptions, Outcome, Scope } from "@open-marketing/contracts";
/** Conservative decoded raster allowlist; active content (SVG/HTML) is never stored. */
export const mimeSchema = z.enum(["image/png", "image/jpeg", "image/webp"]);
export const provenanceSchema = z.strictObject({ operationId: idSchema, source: z.string().min(1).max(2048), rightsEvidenceId: idSchema, generationId: idSchema.optional(), quoteId: idSchema.optional(), providerJobId: idSchema.optional(), reservationId: idSchema.optional() });
export const importSchema = z.strictObject({ sourceUrl: z.string().url().max(2048), operationId: idSchema, expectedDigest: digestSchema, provenance: provenanceSchema }).refine(value => value.operationId === value.provenance.operationId);
export const dimensionsSchema = z.strictObject({ mimeType: mimeSchema, width: z.number().int().min(1).max(32768), height: z.number().int().min(1).max(32768) }).refine(value => value.width * value.height <= 100_000_000);
export const assetSchema = z.strictObject({ assetId: idSchema, scope: scopeSchema, contentDigest: digestSchema, mimeType: mimeSchema, width: z.number().int().positive().max(32768), height: z.number().int().positive().max(32768), provenance: provenanceSchema, blobId: idSchema, byteLength: z.number().int().positive().max(25_000_000), createdAt: epochSchema });
export const cropRequestSchema = z.strictObject({ assetId: idSchema, placement: idSchema, x: z.number().int().nonnegative(), y: z.number().int().nonnegative(), width: z.number().int().positive().max(32768), height: z.number().int().positive().max(32768) });
export const cropSchema = cropRequestSchema.extend({ cropId: idSchema, blobId: idSchema });
export const querySchema = pageQuerySchema.extend({ mimeType: mimeSchema.optional() });
export const linkSchema = z.strictObject({ provenance: provenanceSchema, assetId: idSchema.optional() });
export const costSchema = z.strictObject({ observationId: idSchema, operationId: idSchema, amount: moneySchema, kind: z.enum(["estimated", "actual", "correction"]), correctionOf: idSchema.optional() }).refine(value => (value.kind === "correction") === (value.correctionOf !== undefined));
/** Stable errors carry no tainted input or driver details. */
export function fail<T>(required: { code: AppError["code"]; message: string }): Outcome<T> { return { ok: false, error: { ...required, retryable: false } }; }
export function success<T>(required: { value: T }): Outcome<T> { return { ok: true, value: required.value }; }
export function sameScope(required: { left: Scope; right: Scope }): boolean { return required.left.ownerId === required.right.ownerId && required.left.workspaceId === required.right.workspaceId; }
/** Validation before effects. Owner principals cannot forge a different owner's scope. @complexity O(1), bounded context. */
export function checkContext(required: { context: CallContext; options?: CallOptions }): Outcome<void> {
  if (!callContextSchema.safeParse(required.context).success) return fail({ code: "invalid_input", message: "Invalid call context" });
  if (required.options?.signal?.aborted) return fail({ code: "cancelled", message: "Call cancelled" });
  const { principal, scope } = required.context;
  if (principal.kind === "owner" && principal.ownerId !== scope.ownerId) return fail({ code: "forbidden", message: "Owner scope mismatch" });
  return success({ value: undefined });
}
/** O(1) unambiguous owner/workspace keys, including IDs with separators. */
export function scopeKey(required: { context: CallContext }): string { return JSON.stringify([required.context.scope.ownerId, required.context.scope.workspaceId]); }
/** Crop stays inside original pixels and matches a configured placement exactly. @complexity O(1). */
export function checkCrop(required: { request: { x: number; y: number; width: number; height: number }; original: { width: number; height: number }; placement?: { width: number; height: number } }): Outcome<void> {
  if (!required.placement) return fail({ code: "invalid_input", message: "Unknown placement" });
  const { request, original, placement } = required;
  if (request.x + request.width > original.width || request.y + request.height > original.height) return fail({ code: "invalid_input", message: "Crop exceeds original dimensions" });
  if (request.width !== placement.width || request.height !== placement.height) return fail({ code: "invalid_input", message: "Crop dimensions do not match placement" });
  return success({ value: undefined });
}

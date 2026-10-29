import { z } from "zod";
import { approvalResponseSchema, approverRefSchema, digestSchema, idSchema } from "@open-marketing/contracts";
import type { CallContext, CallOptions, Outcome, Page, PageQuery } from "@open-marketing/contracts";

/** Bounded digest/reference evidence plus authenticated approval identity; raw arguments/secrets are rejected. */
export const auditEntrySchema = z.strictObject({
  operationId: idSchema,
  kind: z.enum(["intent", "approval", "dispatch", "outcome", "correction"]),
  argumentsDigest: digestSchema,
  references: z.array(idSchema).max(64),
  correctionOf: idSchema.optional(),
  approval: z.strictObject({ response: approvalResponseSchema, approver: approverRefSchema }).optional(),
}).refine(value => (value.kind === "correction") === (value.correctionOf !== undefined))
  .refine(value => (value.kind === "approval") === (value.approval !== undefined))
  .refine(value => !value.approval || (value.approval.response.operationId === value.operationId && value.approval.response.argumentsDigest === value.argumentsDigest))
  .refine(value => JSON.stringify(value).length <= 32768);

/** Schema-derived evidence. Approval entries include exact response and nonsecret approver reference.
 * References identify caller-secured evidence, never raw arguments.
 * Corrections name a receipt's entryId and append evidence for the same operation. */
export type AuditEntry = z.infer<typeof auditEntrySchema>;
/** Returned only after append commits. Keep this receipt to identify correction lineage.
 * IDs must be opaque non-personal identifiers using letters, digits, colon, underscore or hyphen. */
export type AuditReceipt = { readonly entryId: string; readonly recordedAt: number };
/** Forward-only pagination: 1..100 entries, optionally filtered to an operation. */
export type AuditQuery = PageQuery & { readonly operationId?: string };
/** Cursor identifies the last returned entry; null means no further entries at read time. */
export type AuditPage = Page<AuditEntry>;
/** Required evidence must succeed before the caller starts a new effect.
 * @example const receipt = await audit.record({ context, entry }); if (!receipt.ok) return receipt;
 */
export interface AuditService {
  record(required: { context: CallContext; entry: AuditEntry }, optional?: CallOptions): Promise<Outcome<AuditReceipt>>;
  /** Operational view: each bounded page is redacted; the repository is a trusted server boundary. */
  list(required: { context: CallContext; query: AuditQuery }, optional?: CallOptions): Promise<Outcome<AuditPage>>;
}

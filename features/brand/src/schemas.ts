import { z } from "zod";
import { callContextSchema, epochSchema, idSchema, parseBoundary, principalSchema, scopeSchema } from "@open-marketing/contracts";
import type { AppError, CallContext, CallOptions, Outcome } from "@open-marketing/contracts";

const text = z.string().trim().min(1).max(2_000);
const texts = z.array(text).max(50);
export const revisionNumberSchema = epochSchema.min(1);
export const expectedRevisionSchema = epochSchema.max(Number.MAX_SAFE_INTEGER - 1);
/** Whole-kit confirmation covers all suggested facts; no field can grant itself authority. */
export const brandKitSchema = z.strictObject({
  business: z.strictObject({ name: text, facts: texts }),
  offers: z.array(z.strictObject({ name: text, facts: z.array(text).max(10) })).max(20),
  audience: z.strictObject({ pains: texts, goals: texts }),
  voice: z.strictObject({ use: texts, avoid: texts }),
  colours: z.array(z.strictObject({ hex: z.string().regex(/^#(?:[a-fA-F0-9]{3}|[a-fA-F0-9]{6})$/), role: text })).max(50),
  fonts: z.array(z.strictObject({ family: text, role: text })).max(50),
  logoAssetIds: z.array(idSchema).max(50),
  assetIds: z.array(idSchema).max(50),
  prohibitedClaims: texts,
}).refine(kit => new TextEncoder().encode(JSON.stringify(kit)).length <= 128 * 1024, "Kit exceeds 128 KiB");
/** Immutable scoped evidence; confirmed records require a matching owner actor.
 * Parsing validates shape only: trusted contexts and an exact current draft are still required.
 */
export const brandRevisionSchema = z.strictObject({
  scope: scopeSchema, revision: revisionNumberSchema, status: z.enum(["draft", "confirmed"]),
  kit: brandKitSchema, actor: principalSchema, at: epochSchema,
  correlationId: idSchema, traceId: idSchema, runId: idSchema.optional(),
}).refine(value => value.status !== "confirmed" || (value.actor.kind === "owner" && value.actor.ownerId === value.scope.ownerId), "Confirmation requires the scoped owner");
export type BrandKit = z.infer<typeof brandKitSchema>;
export type BrandRevision = z.infer<typeof brandRevisionSchema>;
export const readSchema = z.strictObject({ context: callContextSchema, revision: revisionNumberSchema.optional() });
export const contextSchema = z.strictObject({ context: callContextSchema });
export const draftSchema = z.strictObject({ context: callContextSchema, kit: brandKitSchema, expectedRevision: expectedRevisionSchema });
export const confirmSchema = z.strictObject({ context: callContextSchema, revision: expectedRevisionSchema.min(1) });
export const appendSchema = z.strictObject({ context: callContextSchema, expectedRevision: expectedRevisionSchema, revision: brandRevisionSchema });

/** Stable boundary failures omit storage details and never invite blind retries. */
export function brandFailure<T>(required: { code: AppError["code"]; message: string }): Outcome<T> {
  return { ok: false, error: { ...required, retryable: false } };
}
/** Parse and detach caller data before I/O; contexts must already be server-authenticated.
 * Returns invalid_input, forbidden or cancelled; no effects. O(b) time/space for bounded input bytes.
 */
export function parseBrandInput<T extends { context: CallContext }>(required: { schema: z.ZodType<T>; input: unknown }, optional?: CallOptions): Outcome<T> {
  if (optional?.signal?.aborted) return brandFailure({ code: "cancelled", message: "Brand operation cancelled" });
  const parsed = parseBoundary(required);
  if (!parsed.ok) return parsed;
  const { principal, scope } = parsed.value.context;
  if (principal.kind === "owner" && principal.ownerId !== scope.ownerId) return brandFailure({ code: "forbidden", message: "Owner scope mismatch" });
  return parsed;
}
/** Enforce CAS and confirmation invariants in each adapter's atomic write boundary.
 * No effects; returns conflict/forbidden/invalid_input. O(b) time/space for bounded kit comparison.
 */
export function checkBrandAppend(required: { input: z.infer<typeof appendSchema>; current: BrandRevision | null }): Outcome<BrandRevision> {
  const { context, expectedRevision, revision } = required.input;
  if ((required.current?.revision ?? 0) !== expectedRevision) return brandFailure({ code: "conflict", message: "Brand revision changed" });
  if (revision.revision !== expectedRevision + 1) return brandFailure({ code: "invalid_input", message: "Invalid next revision" });
  const identity = checkRevisionContext({ context, revision });
  if (!identity.ok) return identity;
  if (revision.status === "draft") return { ok: true, value: revision };
  if (context.principal.kind !== "owner" || context.principal.ownerId !== context.scope.ownerId) return brandFailure({ code: "forbidden", message: "Owner confirmation required" });
  if (required.current?.status !== "draft" || JSON.stringify(required.current.kit) !== JSON.stringify(revision.kit)) return brandFailure({ code: "conflict", message: "Confirm the exact current draft" });
  return { ok: true, value: revision };
}

/** Require exact context evidence, preventing adapters from accepting forged revision attribution.
 * Returns forbidden/invalid_input; no effects. O(1) bounded context comparison.
 */
function checkRevisionContext(required: { context: CallContext; revision: BrandRevision }): Outcome<BrandRevision> {
  const { context, revision } = required;
  if (JSON.stringify(revision.scope) !== JSON.stringify(context.scope) || JSON.stringify(revision.actor) !== JSON.stringify(context.principal)) return brandFailure({ code: "forbidden", message: "Revision scope or actor mismatch" });
  if (revision.correlationId !== context.correlationId || revision.traceId !== context.traceId || revision.runId !== context.runId) return brandFailure({ code: "invalid_input", message: "Revision trace mismatch" });
  return { ok: true, value: revision };
}

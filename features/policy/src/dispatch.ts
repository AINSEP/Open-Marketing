import { z } from "zod";
import { epochSchema } from "@open-marketing/contracts";
import type { DispatchDecision } from "@open-marketing/contracts";
import { sendability, shareability } from "./gates.js";
import { consentSchema, referenceSchema, sameScope, suppressionSchema } from "./validation.js";

const label = referenceSchema.shape.subjectId;
const policySchema = z.strictObject({
  consents: z.array(consentSchema).max(100_000).readonly(),
  suppressions: z.array(suppressionSchema).max(100_000).readonly(),
  holdout: z.boolean(),
  frequencyCap: z.strictObject({ count: epochSchema, limit: epochSchema }).optional(),
}).refine(({ consents, suppressions }) => consents.length + suppressions.length <= 100_000);
const dispatchEvidenceSchema = z.strictObject({
  subject: referenceSchema,
  policy: policySchema,
  lineage: z.array(z.strictObject({
    subject: referenceSchema,
    erasure: z.enum(["none", "pending", "erased"]),
  })).min(1).max(100).readonly(),
  action: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("conversion_sharing"), destinationId: label, purpose: label }),
    z.strictObject({ kind: z.literal("messaging"), channel: z.strictObject({
      id: label, intent: z.enum(["marketing", "transactional"]),
    }), purpose: label }),
  ]),
  now: epochSchema,
});

/** Reject duplicate or foreign members and require the requested subject itself.
 * Completeness beyond supplied evidence remains the caller's responsibility.
 * @complexity O(l) time/space for l supplied lineage members, capped at 100.
 */
function validLineage(required: z.infer<typeof dispatchEvidenceSchema>): boolean {
  const subjectIds = new Set<string>();
  for (const member of required.lineage) {
    if (!sameScope({ left: member.subject.scope, right: required.subject.scope })) return false;
    subjectIds.add(member.subject.subjectId);
  }
  return subjectIds.size === required.lineage.length && subjectIds.has(required.subject.subjectId);
}

const dispatchInputSchema = dispatchEvidenceSchema.refine(validLineage);

/** Current merged policy plus complete erasure lineage, loaded under the caller's subject lane. */
export type DispatchInput = z.infer<typeof dispatchInputSchema>;

/** Decide dispatch eligibility without I/O, reservation or input mutation.
 * @param required - Current merged evidence, exact action and injected epoch time.
 * @returns Invalid evidence, erasure and durable processing suppression deny before the action gate.
 * An allowed result is evidence only; the caller must retain serialization through dispatch.
 * @complexity O(c + s + l) time/space for supplied consent, suppression and lineage records.
 * @example dispatchDecision({ subject, policy, lineage: [{ subject, erasure: "none" }],
 *   action: { kind: "conversion_sharing", destinationId: "meta", purpose: "signup" }, now: 50 });
 */
export function dispatchDecision(required: DispatchInput): DispatchDecision {
  const parsed = dispatchInputSchema.safeParse(required);
  if (!parsed.success) return { allowed: false, reason: "invalid_input" };
  const { policy, lineage, action, now } = parsed.data;
  if (lineage.some(member => member.erasure === "erased")) return { allowed: false, reason: "erased" };
  if (lineage.some(member => member.erasure === "pending")) return { allowed: false, reason: "erasure_pending" };
  // Erasure's processing marker is durable, unlike ordinary channel suppression windows.
  if (policy.suppressions.some(record => record.channel === "om.processing")) return { allowed: false, reason: "suppressed" };
  if (action.kind === "conversion_sharing") {
    return shareability({ subject: policy, destination: { id: action.destinationId, intent: "measurement" }, purpose: action.purpose, now });
  }
  return sendability({ subject: policy, channel: action.channel, purpose: action.purpose, now });
}

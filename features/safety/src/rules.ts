import { createHash } from "node:crypto";
import { z } from "zod";
import { callContextSchema, canonicalizeArguments, digestSchema, effectEnvelopeSchema, idSchema, epochSchema, generationCostQuoteSchema, generationAllowanceSettingsSchema, moneySchema, timeWindowSchema } from "@open-marketing/contracts";
import type { Outcome, AppError, CallContext, ConfirmationCard, EffectEnvelope } from "@open-marketing/contracts";
const generationInputSchema = z.strictObject({ operationId: idSchema, connectionId: idSchema, argumentsDigest: digestSchema, configurationDigest: digestSchema });
const campaignCallSchema = z.strictObject({ envelope: effectEnvelopeSchema, arguments: z.record(z.string(), z.json()), pluginDigest: digestSchema, schemaFingerprint: digestSchema });
export const effectRequestSchema = campaignCallSchema.extend({ pausedCampaignCalls: z.array(campaignCallSchema).min(1).max(16).optional(), operationScope: idSchema.optional(), generation: z.strictObject({ request: generationInputSchema, quote: generationCostQuoteSchema }).optional() });
export const dispatchRequestSchema = effectRequestSchema.extend({ approvalId: idSchema, policyRevision: epochSchema, campaignApproval: z.strictObject({ operationId: idSchema, argumentsDigest: digestSchema, index: z.number().int().min(0).max(15) }).optional() });
export const generationRequestSchema = z.strictObject({ operationId: idSchema, connectionId: idSchema, argumentsDigest: digestSchema, configurationDigest: digestSchema });
export const generationAssessmentSchema = z.strictObject({ context: callContextSchema, request: generationRequestSchema, quote: generationCostQuoteSchema });
export const allowanceEditSchema = z.strictObject({ context: callContextSchema, settings: generationAllowanceSettingsSchema });
export const evidenceSchema = z.strictObject({ evidenceId: idSchema, accountId: idSchema, amount: moneySchema, window: timeWindowSchema, observedAt: epochSchema, semantics: z.enum(["hard_limit", "average_budget", "maximum_billed"]), pluginDigest: digestSchema });
export const settlementSchema = z.strictObject({ reservationId: idSchema, observationId: idSchema, actual: moneySchema, correctsObservationId: idSchema.optional() });
/** Stable typed failure without tainted payloads. @complexity O(1). */
export function failure<T>(required: { code?: AppError["code"]; message: string }): Outcome<T> {
 return { ok: false, error: { code: required.code ?? "forbidden", message: required.message, retryable: false } };
}
/** Success constructor; no effects. @complexity O(1). */
export function success<T>(required: { value: T }): Outcome<T> { return { ok: true, value: required.value }; }
/** Digest bounded JSON using contracts' canonical string; returns validation failures unchanged, no I/O. @example digestArguments({ arguments: { budget: 100 } }) @complexity O(n log n), O(n) space. */
export function digestArguments(required: { arguments: unknown }): Outcome<string> {
 const canonical = canonicalizeArguments({ arguments: required.arguments });
 if (!canonical.ok) return canonical;
 return success({ value: createHash("sha256").update(canonical.value).digest("hex") });
}
/** Canonical equality for bounded trusted DTOs. @complexity O(n log n), O(n) space. */
export function sameValue(required: { left: unknown; right: unknown }): boolean {
 const left = digestArguments({ arguments: required.left });
 const right = digestArguments({ arguments: required.right });
 return left.ok && right.ok && left.value === right.value;
}
/** An authenticated owner must match scope; server-authenticated agent/service contexts are accepted for non-owner actions. @complexity O(1). */
export function validContext(required: { context: CallContext; ownerOnly?: boolean }): boolean {
 const parsed = callContextSchema.safeParse(required.context);
 if (!parsed.success) return false;
 const principal = parsed.data.principal;
 if (principal.kind === "owner") return principal.ownerId === parsed.data.scope.ownerId;
 return !required.ownerOnly;
}
/** Generic choices are filtered by host classification. @complexity O(1). */
export function choices(required: { classification: ConfirmationCard["classification"]; grantable?: boolean }): ConfirmationCard["allowedChoices"] {
 if (required.classification === "spend" || required.classification === "destructive" || required.grantable === false) return ["allow", "cancel"];
 return ["allow", "allow_chat", "always_allow", "cancel"];
}
/** Financial fields always raise classification, never downgrade a spend or destructive effect. @complexity O(e), bounded e <=10. */
export function classify(required: { envelope: EffectEnvelope }): ConfirmationCard["classification"] {
 if (required.envelope.effects.includes("ad_spend") || required.envelope.moneyExposure !== null) return "spend";
 if (required.envelope.effects.includes("destructive")) return "destructive";
 if (required.envelope.effects.includes("generation")) return "generation";
 return "write";
}
/** Scope key is collision-free, unlike delimiter joining. @complexity O(1) bounded identifiers. */
export function scopeKey(required: { context: Pick<CallContext, "scope"> }): string { return JSON.stringify([required.context.scope.ownerId, required.context.scope.workspaceId]); }

/** Freeze validated JSON values so the reviewed request cannot be inflated during handoff. Used by normal and stop-only dispatch. @complexity O(n), O(depth) stack, bounded depth <=16 for arguments. */
export function freezeJson<T>(required: { value: T }): T {
 if (required.value === null || typeof required.value !== "object") return required.value;
 Object.values(required.value).forEach(value => freezeJson({ value }));
 return Object.freeze(required.value);
}

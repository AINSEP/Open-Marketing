import { createHash } from "node:crypto";
import { generationCostQuoteSchema, parseBoundary } from "@open-marketing/contracts";
import type { GenerationCostQuote, Money, Outcome } from "@open-marketing/contracts";
import { bindingSchema, intentSchema, pricingSchema } from "./schemas.js";
import type { ImageIntent, PricingEvidence, VerifiedBinding } from "./types.js";
import { failure } from "./results.js";

/** Evidence must refer to the exact reviewed account/model/configuration and provider schema.
 * @returns false for missing/mismatched/future-dated evidence. Does not grant authority.
 * @complexity O(1), bounded schema fields.
 */
export function matchesPricing(required: { pricing: PricingEvidence; binding: VerifiedBinding; intent: ImageIntent; now: number }): boolean {
  const evidence = pricingSchema.safeParse(required.pricing);
  if (!evidence.success) return false;
  const p = evidence.data;
  const b = required.binding;
  return p.pluginDigest === b.pluginDigest && p.configurationDigest === b.configurationDigest
    && p.generationSchemaFingerprint === b.generationSchemaFingerprint && p.accountId === b.accountId
    && p.model === required.intent.model && p.argumentsDigest === required.intent.argumentsDigest
    && p.observedAt <= required.now && p.observedAt < p.expiresAt;
}

/** Local, non-spending quote. Unknown/expired evidence never turns credits/unlim into zero dollars.
 * Host must supply reviewed evidence; pricing metadata cannot select card/allowance policy.
 * @example createHiggsfieldQuote({ binding, intent, pricing: null, now, quoteId: "q1" })
 * @returns Shared quote or invalid_input/conflict for malformed intent/binding.
 * @complexity O(1) time/space; one image per durable operation.
 */
export function createHiggsfieldQuote(required: {
  binding: VerifiedBinding; intent: ImageIntent; pricing: PricingEvidence | null; now: number; quoteId: string;
}): Outcome<GenerationCostQuote> {
  if (!bindingSchema.safeParse(required.binding).success || !intentSchema.safeParse(required.intent).success) {
    return failure({ code: "invalid_input", message: "Invalid Higgsfield quote binding" });
  }
  if (required.intent.configurationDigest !== required.binding.configurationDigest) return failure({ code: "conflict", message: "Model configuration changed" });
  const known = required.pricing !== null && matchesPricing({ ...required, pricing: required.pricing });
  const pricing = known ? required.pricing : null;
  const expiresAt = Math.min(pricing?.expiresAt ?? required.now + 60000, required.binding.expiresAt);
  const expired = expiresAt <= required.now;
  const amount = expired ? null : pricing?.unitUpperBound ?? null;
  const evidenceId = pricing?.evidenceId ?? createHash("sha256").update("unknown:" + required.binding.evidenceId).digest("hex");
  return parseBoundary({ schema: generationCostQuoteSchema, input: {
    quoteId: required.quoteId, pluginId: "higgsfield-media", pluginDigest: required.binding.pluginDigest,
    modelConfigurationDigest: required.intent.configurationDigest, argumentsDigest: required.intent.argumentsDigest,
    estimated: amount, upperBound: amount, pricingEvidenceId: evidenceId, expiresAt,
    status: expired ? "expired" : pricing === null ? "unknown" : "known",
  } });
}

/** Convert a validated vendor credit observation with reviewed, unexpired rational evidence.
 * Uses integer millionths of a credit. Fractional values outside that precision remain unknown.
 * @returns null when conversion is unverifiable/expired/unsafe; never silently rounds down.
 * @complexity O(1) integer arithmetic, fixed precision and magnitude bounds.
 */
export function observedCreditCharge(required: {
  credits: number; pricing: PricingEvidence | null; binding: VerifiedBinding; intent: ImageIntent; now: number;
}): Money | null {
  const p = required.pricing;
  if (p === null || !matchesPricing({ ...required, pricing: p })) return null;
  if (p.expiresAt <= required.now || p.creditRate === null) return null;
  if (!Number.isFinite(required.credits) || required.credits < 0 || required.credits > 1_000_000) return null;
  const scaled = required.credits * 1_000_000;
  if (!Number.isSafeInteger(scaled)) return null;
  const numerator = BigInt(scaled) * BigInt(p.creditRate.minorUnits);
  const denominator = BigInt(p.creditRate.creditUnits) * 1_000_000n;
  const minorUnits = (numerator + denominator - 1n) / denominator;
  if (minorUnits > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return { minorUnits: Number(minorUnits), currency: p.unitUpperBound.currency };
}

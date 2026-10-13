import { effectEnvelopeSchema, generationCostQuoteSchema, parseBoundary } from "@open-marketing/contracts";
import type { EffectEnvelope, GenerationCostQuote, Outcome } from "@open-marketing/contracts";
import { bindingSchema } from "./schemas.js";
import { failure } from "./results.js";
import type { VerifiedBinding } from "./types.js";

/** Conservative trusted binding. generate_image is generation/spend-class even for a claimed
 * get_cost/unlim request. Only the server can admit a separately verified non-spending preflight.
 * @example bindHiggsfieldEffect({ binding, toolName: "generate_image", operationId, argumentsDigest, intentArgumentsDigest, schemaFingerprint, quote, now })
 * @returns Shared effect envelope or forbidden/conflict/expired. No approval/card decision.
 * @complexity O(1) time/space.
 */
export function bindHiggsfieldEffect(required: {
  binding: VerifiedBinding; toolName: string; operationId: string; argumentsDigest: string;
  intentArgumentsDigest: string; schemaFingerprint: string; quote: GenerationCostQuote | null; now: number;
}): Outcome<EffectEnvelope> {
  if (!bindingSchema.safeParse(required.binding).success) return failure({ code: "forbidden", message: "Missing verified Higgsfield binding" });
  if (required.binding.expiresAt <= required.now) return failure({ code: "expired", message: "Higgsfield admission evidence expired" });
  if (required.toolName === "job_status") return statusEffect(required);
  if (required.toolName !== "generate_image") return failure({ code: "forbidden", message: "Tool is outside the Higgsfield binding" });
  if (required.schemaFingerprint !== required.binding.generationSchemaFingerprint) return failure({ code: "conflict", message: "Generation schema changed" });
  const quote = required.quote;
  if (quote === null || !generationCostQuoteSchema.safeParse(quote).success) return failure({ code: "forbidden", message: "Generation requires an original quote" });
  if (quote.pluginId !== required.binding.pluginId || quote.pluginDigest !== required.binding.pluginDigest || quote.modelConfigurationDigest !== required.binding.configurationDigest || quote.argumentsDigest !== required.intentArgumentsDigest) {
    return failure({ code: "conflict", message: "Generation quote binding changed" });
  }
  if (quote.expiresAt <= required.now || quote.status === "expired") return failure({ code: "expired", message: "Generation quote expired" });
  return parseBoundary({ schema: effectEnvelopeSchema, input: {
    operationId: required.operationId, connectionId: required.binding.connectionId, accountId: null,
    effects: ["write", "generation"], argumentsDigest: required.argumentsDigest,
    moneyExposure: null,
    requiredLimit: null,
  } });
}

/** Status is bound to its own reviewed schema; vendor annotations never widen this read. */
function statusEffect(required: { binding: VerifiedBinding; schemaFingerprint: string; operationId: string; argumentsDigest: string }): Outcome<EffectEnvelope> {
  if (required.schemaFingerprint !== required.binding.statusSchemaFingerprint) return failure({ code: "conflict", message: "Status schema changed" });
  return parseBoundary({ schema: effectEnvelopeSchema, input: {
    operationId: required.operationId, connectionId: required.binding.connectionId, accountId: null,
    effects: ["read"], argumentsDigest: required.argumentsDigest, moneyExposure: null, requiredLimit: null,
  } });
}

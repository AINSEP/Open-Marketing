import type { EffectEnvelope, GenerationCostQuote, Outcome } from "@open-marketing/contracts";
import type { HiggsfieldDependencies } from "./types.js";
import { imageArguments } from "./adapter.js";
import { bindHiggsfieldEffect } from "./effects.js";
import { intentSchema } from "./schemas.js";
import { parseBoundary } from "@open-marketing/contracts";

/** Reviewed mapping from creative's original intent digest to the vendor's exact wire digest.
 * Safety's generation request and quote both use the wire digest at this boundary. The original
 * digest is retained as provenance, not as authority to send different arguments.
 */
export type HiggsfieldDispatchEvidence = {
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly originalArgumentsDigest: string;
  readonly quote: GenerationCostQuote;
  readonly effect: EffectEnvelope;
};

/** Supply host-verified safety evidence for the frozen federation call. The host must validate
 * package/schema pins and store this mapping; constructing it cannot grant execution or funds.
 * Generation has accountId/moneyExposure null: the separate quote is safety's allowance input.
 * @example createHiggsfieldDispatchEvidence({ dependencies })
 * @returns Shared wire quote/effect with original provenance, or typed digest/binding failure.
 * @complexity O(p) bounded prompt hashing; no I/O, confirmation or reservation.
 */
export function createHiggsfieldDispatchEvidence(required: {
  dependencies: Pick<HiggsfieldDependencies, "binding" | "intent" | "quote" | "digest" | "clock">;
}): Outcome<HiggsfieldDispatchEvidence> {
  const d = required.dependencies;
  const intent = parseBoundary({ schema: intentSchema, input: d.intent });
  if (!intent.ok) return intent;
  const args = imageArguments({ dependencies: { intent: intent.value } });
  const digest = d.digest.digest({ arguments: args });
  if (!digest.ok) return digest;
  const effect = bindHiggsfieldEffect({ binding: d.binding, toolName: "generate_image", operationId: d.intent.operationId,
    argumentsDigest: digest.value, intentArgumentsDigest: d.intent.argumentsDigest,
    schemaFingerprint: d.binding.generationSchemaFingerprint, quote: d.quote, now: d.clock.now({}) });
  if (!effect.ok) return effect;
  return { ok: true, value: { arguments: args, originalArgumentsDigest: d.intent.argumentsDigest,
    quote: { ...d.quote, argumentsDigest: digest.value }, effect: effect.value } };
}

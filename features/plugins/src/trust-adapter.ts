import { parseBoundary } from "@open-marketing/contracts";
import type { CallOptions, Outcome } from "@open-marketing/contracts";
import type { PluginTrustPort } from "./ports.js";
import type { PluginReference, PluginSource } from "./types.js";
import { referenceSchema, sourceSchema } from "./schemas.js";
import { attempt, failure } from "./results.js";

/** Host verification adapter: inspect pinned bytes first, then an independent host trust decision.
 * The verifier should reuse Jini package containment/digest APIs; a digest alone is not admission.
 * @example createPluginTrustAdapter({ inspectPinned, isTrusted })
 * @complexity O(1) port calls plus bounded upstream package work.
 */
export function createPluginTrustAdapter(required: {
  inspectPinned(required: { source: PluginSource }, optional?: CallOptions): Promise<Outcome<PluginReference>>;
  isTrusted(required: { reference: PluginReference }, optional?: CallOptions): Promise<Outcome<void>>;
}): PluginTrustPort {
  return { async verify(input, options) {
    const source = parseBoundary({ schema: sourceSchema, input: input.source });
    if (!source.ok) return source;
    return attempt({ run: async () => {
      const inspected = await required.inspectPinned({ source: source.value }, options);
      if (!inspected.ok) return inspected;
      const reference = parseBoundary({ schema: referenceSchema, input: inspected.value });
      if (!reference.ok) return reference;
      if (reference.value.digest !== source.value.expectedDigest) return failure({ code: "forbidden", message: "Verified source digest mismatch" });
      const trusted = await required.isTrusted({ reference: reference.value }, options);
      if (!trusted.ok) return trusted;
      return reference;
    } });
  } };
}

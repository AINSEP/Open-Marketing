import type { CallContext, CallOptions, Outcome } from "@open-marketing/contracts";
import type { CampaignAssetPort } from "./ports.js";
import { assetResultSchema, fail, parseBoundary, success } from "./rules.js";

/** Resolve current revisions in one bounded batch and compare the frozen creative set.
 * Missing assets/invalid output/drift fail closed before any provider mutation.
 * @complexity One port call, O(c) validation for at most 100 creative references.
 */
export async function checkCreativeSet(required: { assets: CampaignAssetPort; context: CallContext; creativeIds: readonly string[]; creativeDigest: string }, optional?: CallOptions): Promise<Outcome<void>> {
  const resolved = await required.assets.resolve({ context: required.context, creativeIds: required.creativeIds }, optional);
  if (!resolved.ok) return resolved;
  const parsed = parseBoundary({ schema: assetResultSchema, input: resolved.value });
  if (!parsed.ok) return parsed;
  if (parsed.value.creativeDigest !== required.creativeDigest) return fail({ code: "conflict", message: "Creative revisions changed" });
  return success({ value: undefined });
}

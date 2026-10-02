import { z } from "zod";
import { callContextSchema, digestSchema, idSchema } from "@open-marketing/contracts";
import type { CallContext, Outcome } from "@open-marketing/contracts";
import type { CampaignAssetPort } from "./ports.js";
import { checkCancelled } from "./repo-rules.js";
import { digest, fail, parseBoundary, scopedKey, success } from "./rules.js";
const resolveSchema = z.strictObject({ context: callContextSchema, creativeIds: z.array(idSchema).min(1).max(100).refine(ids => new Set(ids).size === ids.length) });
const putSchema = z.strictObject({ context: callContextSchema, creativeId: idSchema, revisionDigest: digestSchema });
/** Test control updates asset revisions; resolve never invents missing assets. */
export interface MemoryCampaignAsset extends CampaignAssetPort {
  put(required: { context: CallContext; creativeId: string; revisionDigest: string }): Outcome<void>;
}
/** Scoped revision double, with order-independent creative-set digests.
 * @example const assets = createMemoryCampaignAsset({}); assets.put({context,creativeId,revisionDigest});
 * @complexity O(c log c), capped at 100 references and 10000 stored revisions.
 */
export function createMemoryCampaignAsset(required: { maxEntries?: number }): MemoryCampaignAsset {
  const revisions = new Map<string, string>();
  const maxEntries = required.maxEntries ?? 10000;
  return {
    put(input) {
      const parsed = parseBoundary({ schema: putSchema, input });
      if (!parsed.ok) return parsed;
      const key = scopedKey({ scope: parsed.value.context.scope, id: parsed.value.creativeId });
      if (!revisions.has(key) && revisions.size >= maxEntries) return fail({ code: "limit_exceeded", message: "Asset capacity reached" });
      revisions.set(key, parsed.value.revisionDigest);
      return success({ value: undefined });
    },
    async resolve(input, options) {
      const parsed = parseBoundary({ schema: resolveSchema, input });
      if (!parsed.ok) return parsed;
      const cancelled = checkCancelled({ options });
      if (!cancelled.ok) return cancelled;
      const { context, creativeIds } = parsed.value;
      const entries = [...creativeIds].sort().map(creativeId => ({ creativeId, revisionDigest: revisions.get(scopedKey({ scope: context.scope, id: creativeId })) }));
      if (entries.some(entry => !entry.revisionDigest)) return fail({ code: "forbidden", message: "Creative unavailable in scope" });
      return success({ value: { creativeDigest: digest({ value: entries }) } });
    },
  };
}

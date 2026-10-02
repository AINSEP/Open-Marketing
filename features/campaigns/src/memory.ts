import { z } from "zod";
import { callContextSchema, idSchema } from "@open-marketing/contracts";
import type { CallContext } from "@open-marketing/contracts";
import type { CampaignAuditPort } from "./ports.js";
import { checkCancelled } from "./repo-rules.js";
import { fail, parseBoundary, success } from "./rules.js";
export { createMemoryCampaignRepo } from "./memory-repo.js";
export { createMemoryCampaignCapability } from "./memory-capability.js";
export { createMemoryCampaignAsset } from "./memory-assets.js";
export { createMemoryCampaignSafety } from "./memory-safety.js";
export { createMemoryCampaignJob } from "./memory-jobs.js";
/** An independent read of append-only test audit evidence. */
export interface MemoryCampaignAudit extends CampaignAuditPort {
  entries(required: Record<string, never>): readonly { context: CallContext; operationId: string; outcome: string }[];
}
/** Bounded append-only audit double. Copies protect recorded trace evidence.
 * @example createMemoryCampaignAudit({}).entries({}) @complexity O(1) append, O(n) snapshot.
 */
export function createMemoryCampaignAudit(required: { maxEntries?: number }): MemoryCampaignAudit {
  const entries: { context: CallContext; operationId: string; outcome: string }[] = [];
  return {
    async record(input, options) {
      const parsed = parseBoundary({ schema: z.strictObject({ context: callContextSchema, operationId: idSchema, outcome: idSchema }), input });
      if (!parsed.ok) return parsed;
      const cancelled = checkCancelled({ options });
      if (!cancelled.ok) return cancelled;
      if (entries.length >= (required.maxEntries ?? 10000)) return fail({ code: "limit_exceeded", message: "Audit capacity reached" });
      entries.push(structuredClone(parsed.value));
      return success({ value: undefined });
    },
    entries() { return structuredClone(entries); },
  };
}

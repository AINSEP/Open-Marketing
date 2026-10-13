import { z } from "zod";
import { callContextSchema, idSchema } from "@open-marketing/contracts";
import type { CallContext, ObserverEvent } from "@open-marketing/contracts";
import type { CampaignAuditPort, CampaignObserverPort } from "./ports.js";
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
/** Snapshot access for the injected observer double; events retain run/correlation/trace IDs. */
export interface MemoryCampaignObserver extends CampaignObserverPort {
  events(required: Record<string, never>): readonly ObserverEvent[];
}
/** Bounded observer double. Invalid events/capacity throw because the shared observer
 * ABI is void; service/adapters isolate telemetry failures from domain outcomes.
 * @example createCampaignService(dependencies, { observer: createMemoryCampaignObserver({}) });
 * @complexity O(1) append, O(n) snapshot for at most 10000 events.
 */
export function createMemoryCampaignObserver(required: { maxEntries?: number }): MemoryCampaignObserver {
  const maxEntries = required.maxEntries ?? 10000;
  if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 10000) throw new RangeError("Observer capacity must be 1..10000");
  const events: ObserverEvent[] = [];
  const schema = z.strictObject({ operation: idSchema, outcome: idSchema, correlationId: idSchema, traceId: idSchema, runId: idSchema.optional() });
  return {
    observe(input) {
      const parsed = parseBoundary({ schema, input });
      if (!parsed.ok) throw new TypeError("Invalid campaign observer event");
      if (events.length >= maxEntries) throw new RangeError("Observer capacity reached");
      events.push(parsed.value);
    },
    events() { return structuredClone(events); },
  };
}

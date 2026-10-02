import { z } from "zod";
import { callContextSchema, idSchema } from "@open-marketing/contracts";
import type { CallContext, ClockPort, Outcome } from "@open-marketing/contracts";
import type { CampaignCapabilityPort } from "./ports.js";
import type { CampaignReadback } from "./types.js";
import { checkCancelled } from "./repo-rules.js";
import { digest, draftSchema, exactMatch, fail, parseBoundary, proposalSchema, readbackSchema, requestSchema, scopedKey, success } from "./rules.js";
import { capabilityCreateSchema, capabilityLaunchSchema, capabilityReadSchema } from "./capability-schemas.js";
interface PlatformRecord { connectionId: string; accountId: string; draftDigest: string; readback: CampaignReadback }
/** Fixture controls model a provider completing partial/unknown writes asynchronously. */
export interface MemoryCampaignCapability extends CampaignCapabilityPort {
  setReadback(required: { context: CallContext; readback: CampaignReadback }): Outcome<void>;
}
/** Strict provider double. Builds campaign/ad-set/ad hierarchy paused; stable write
 * keys reject altered replays. Unknown outcomes are explicit fixture configuration.
 * @example createMemoryCampaignCapability({ clock, creation: "partial", launch: "unknown" });
 * @complexity O(c) hierarchy, bounded by draft validation; O(1) scoped lookup.
 */
export function createMemoryCampaignCapability(required: { clock?: ClockPort; creation?: "complete" | "partial"; launch?: "submitted" | "unknown"; maxEntries?: number }): MemoryCampaignCapability {
  const records = new Map<string, PlatformRecord>();
  const launches = new Map<string, { digest: string; status: "submitted" | "unknown" }>();
  const maxEntries = required.maxEntries ?? 10000;
  function now(): number { return required.clock?.now({}) ?? 0; }
  return {
    async createPaused(input, options) {
      const parsed = parseBoundary({ schema: capabilityCreateSchema, input });
      if (!parsed.ok) return parsed;
      const cancelled = checkCancelled({ options });
      if (!cancelled.ok) return cancelled;
      const { context, draft, campaignId } = parsed.value;
      const key = scopedKey({ scope: context.scope, id: campaignId });
      const existing = records.get(key);
      if (existing && existing.draftDigest !== digest({ value: draft })) return fail({ code: "conflict", message: "Provider creation identity reused" });
      if (!existing && records.size >= maxEntries) return fail({ code: "limit_exceeded", message: "Provider fixture capacity reached" });
      if (!existing) records.set(key, { connectionId: draft.connectionId, accountId: draft.accountId, draftDigest: digest({ value: draft }), readback: { state: { campaignId, state: "paused", observedAt: now(), providerReference: "memory:" + campaignId }, hierarchy: [{ entityId: campaignId, state: "paused" }, { entityId: campaignId + "/ad-set", state: "paused" }, ...draft.creativeIds.map(id => ({ entityId: campaignId + "/ad/" + id, state: "paused" as const }))], complete: required.creation !== "partial", operationId: draft.operationId } });
      const observedState = required.creation === "partial" ? "unknown" : "paused";
      return success({ value: { campaignId, desiredState: "paused" as const, observedState } });
    },
    async launch(input, options) {
      const parsed = parseBoundary({ schema: capabilityLaunchSchema, input });
      if (!parsed.ok) return parsed;
      const cancelled = checkCancelled({ options });
      if (!cancelled.ok) return cancelled;
      return submitLaunch({ input: parsed.value, records, launches, now: now(), outcome: required.launch ?? "submitted", maxEntries });
    },
    async readState(input, options) {
      const parsed = parseBoundary({ schema: capabilityReadSchema, input });
      if (!parsed.ok) return parsed;
      const cancelled = checkCancelled({ options });
      if (!cancelled.ok) return cancelled;
      const { context, campaignId, connectionId, accountId } = parsed.value;
      const record = records.get(scopedKey({ scope: context.scope, id: campaignId }));
      if (!record || record.connectionId !== connectionId || record.accountId !== accountId) return fail({ code: "forbidden", message: "Provider account/campaign mismatch" });
      return success({ value: structuredClone({ ...record.readback, state: { ...record.readback.state, observedAt: now() } }) });
    },
    setReadback(input) {
      const parsed = parseBoundary({ schema: z.strictObject({ context: callContextSchema, readback: readbackSchema }), input });
      if (!parsed.ok) return parsed;
      const key = scopedKey({ scope: parsed.value.context.scope, id: parsed.value.readback.state.campaignId });
      const record = records.get(key);
      if (!record) return fail({ code: "forbidden", message: "Fixture campaign missing" });
      records.set(key, { ...record, readback: structuredClone(parsed.value.readback) });
      return success({ value: undefined });
    },
  };
}
function submitLaunch(required: { input: z.infer<typeof capabilityLaunchSchema>; records: Map<string, PlatformRecord>; launches: Map<string, { digest: string; status: "submitted" | "unknown" }>; now: number; outcome: "submitted" | "unknown"; maxEntries: number }) {
  const { context, request, proposal } = required.input;
  if (!exactMatch({ request, proposal })) return fail<{ operationId: string; status: "submitted" | "unknown" }>({ code: "conflict", message: "Provider launch arguments mismatch" });
  const key = scopedKey({ scope: context.scope, id: request.campaignId });
  const record = required.records.get(key);
  if (!record || record.accountId !== proposal.arguments.accountId || record.connectionId !== proposal.arguments.connectionId) return fail<{ operationId: string; status: "submitted" | "unknown" }>({ code: "forbidden", message: "Provider launch account mismatch" });
  const launchKey = scopedKey({ scope: context.scope, id: request.operationId });
  const existing = required.launches.get(launchKey);
  if (existing) {
    if (existing.digest !== request.argumentsDigest) return fail<{ operationId: string; status: "submitted" | "unknown" }>({ code: "conflict", message: "Provider launch identity reused" });
    return success({ value: { operationId: request.operationId, status: existing.status } });
  }
  if (required.launches.size >= required.maxEntries) return fail<{ operationId: string; status: "submitted" | "unknown" }>({ code: "limit_exceeded", message: "Provider launch capacity reached" });
  required.launches.set(launchKey, { digest: request.argumentsDigest, status: required.outcome });
  if (required.outcome === "submitted") required.records.set(key, { ...record, readback: { ...record.readback, operationId: request.operationId, state: { ...record.readback.state, state: "active", observedAt: required.now }, hierarchy: record.readback.hierarchy.map(entity => ({ ...entity, state: "active" as const })) } });
  return success({ value: { operationId: request.operationId, status: required.outcome } });
}

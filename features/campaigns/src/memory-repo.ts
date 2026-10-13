import { z } from "zod";
import { callContextSchema, idSchema } from "@open-marketing/contracts";
import type { CallContext, CallOptions, Outcome } from "@open-marketing/contracts";
import type { CampaignRepoPort } from "./ports.js";
import type { CampaignRecord, CampaignReceipt, LaunchProposal, ObservedCampaignState } from "./types.js";
import { campaignId, createInputSchema, digest, fail, observationSchema, parseBoundary, proposalSchema, scopedKey, success } from "./rules.js";

import { checkCancelled, existingDraft, existingProposal, getInputSchema, listInputSchema, observeInputSchema, proposalInputSchema, proposalGetSchema, proposalForRecord, observationFreshness, withObservation } from "./repo-rules.js";

/** Bounded isolated repository double. Copies reads/writes, never grants authority.
 * @example createMemoryCampaignRepo({}) @complexity O(n) DTO bytes; O(1) key lookup.
 */
export function createMemoryCampaignRepo(required: { maxEntries?: number }): CampaignRepoPort {
  const records = new Map<string, CampaignRecord>();
  const proposals = new Map<string, LaunchProposal>();
  const observations: ObservedCampaignState[] = [];
  const maxEntries = required.maxEntries ?? 10000;
  return {
    /** O(n log n) over the bounded memory double; returned page is a copy, <=100 records. */
    async list(input, options) {
      const parsed = parseBoundary({ schema: listInputSchema, input });
      if (!parsed.ok) return parsed;
      const cancelled = checkCancelled({ options });
      if (!cancelled.ok) return cancelled;
      const { context, query } = parsed.value;
      const candidates = [...records.values()].filter(record => record.scope.ownerId === context.scope.ownerId
        && record.scope.workspaceId === context.scope.workspaceId && record.receipt.campaignId > (query.cursor ?? ""));
      candidates.sort((left, right) => left.receipt.campaignId < right.receipt.campaignId ? -1 : 1);
      const items = candidates.slice(0, query.limit);
      return success({ value: structuredClone({ items, cursor: candidates.length > query.limit ? items.at(-1)!.receipt.campaignId : null }) });
    },
    async save(input, options) {
      const parsed = parseBoundary({ schema: createInputSchema, input });
      if (!parsed.ok) return parsed;
      const cancelled = checkCancelled({ options });
      if (!cancelled.ok) return cancelled;
      const { context, draft } = parsed.value;
      const id = campaignId({ operationId: draft.operationId });
      const key = scopedKey({ scope: context.scope, id });
      const existing = records.get(key);
      if (existing) return existingDraft({ record: existing, draftDigest: digest({ value: draft }) });
      if (records.size >= maxEntries) return fail({ code: "limit_exceeded", message: "Memory campaign capacity reached" });
      const receipt: CampaignReceipt = { campaignId: id, desiredState: "paused", observedState: "unknown" };
      records.set(key, structuredClone({ scope: context.scope, draft, receipt, observation: null }));
      return success({ value: receipt });
    },
    async get(input, options) {
      const parsed = parseBoundary({ schema: getInputSchema, input });
      if (!parsed.ok) return parsed;
      const cancelled = checkCancelled({ options });
      if (!cancelled.ok) return cancelled;
      const record = records.get(scopedKey({ scope: parsed.value.context.scope, id: parsed.value.campaignId })) ?? null;
      return success({ value: structuredClone(record) });
    },
    async observe(input, options) {
      const parsed = parseBoundary({ schema: observeInputSchema, input });
      if (!parsed.ok) return parsed;
      const cancelled = checkCancelled({ options });
      if (!cancelled.ok) return cancelled;
      const { context, state } = parsed.value;
      const key = scopedKey({ scope: context.scope, id: state.campaignId });
      const record = records.get(key);
      if (!record) return fail({ code: "forbidden", message: "Campaign unavailable in scope" });
      const freshness = observationFreshness({ previous: record.observation, state });
      if (!freshness.ok) return freshness;
      if (observations.length >= maxEntries) return fail({ code: "limit_exceeded", message: "Observation capacity reached" });
      observations.push(structuredClone(state));
      records.set(key, withObservation({ record, state }));
      return success({ value: structuredClone(state) });
    },
    async saveProposal(input, options) {
      const parsed = parseBoundary({ schema: proposalInputSchema, input });
      if (!parsed.ok) return parsed;
      const cancelled = checkCancelled({ options });
      if (!cancelled.ok) return cancelled;
      const { context, proposal } = parsed.value;
      const record = records.get(scopedKey({ scope: context.scope, id: proposal.campaignId }));
      const valid = proposalForRecord({ record: record ?? null, proposal });
      if (!valid.ok) return valid;
      const key = scopedKey({ scope: context.scope, id: proposal.operations[0].operationId });
      const existing = proposals.get(key);
      if (existing) return existingProposal({ existing, proposal });
      if (proposals.size >= maxEntries) return fail({ code: "limit_exceeded", message: "Proposal capacity reached" });
      proposals.set(key, structuredClone(proposal));
      return success({ value: structuredClone(proposal) });
    },
    async getProposal(input, options) {
      const parsed = parseBoundary({ schema: proposalGetSchema, input });
      if (!parsed.ok) return parsed;
      const cancelled = checkCancelled({ options });
      if (!cancelled.ok) return cancelled;
      const { context, operationId } = parsed.value;
      return success({ value: structuredClone(proposals.get(scopedKey({ scope: context.scope, id: operationId })) ?? null) });
    },
  };
}

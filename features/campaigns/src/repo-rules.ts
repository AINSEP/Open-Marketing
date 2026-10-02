import { z } from "zod";
import { callContextSchema, idSchema } from "@open-marketing/contracts";
import type { CallContext, CallOptions, Outcome } from "@open-marketing/contracts";
import type { CampaignRepoPort } from "./ports.js";
import type { CampaignRecord, CampaignReceipt, LaunchProposal, ObservedCampaignState } from "./types.js";
import { campaignId, createInputSchema, digest, fail, observationSchema, parseBoundary, proposalSchema, scopedKey, success } from "./rules.js";

export const getInputSchema = z.strictObject({ context: callContextSchema, campaignId: idSchema });
export const observeInputSchema = z.strictObject({ context: callContextSchema, state: observationSchema });
export const proposalInputSchema = z.strictObject({ context: callContextSchema, proposal: proposalSchema });
export const proposalGetSchema = z.strictObject({ context: callContextSchema, operationId: idSchema });

export function checkCancelled(required: { options?: CallOptions }): Outcome<void> {
  if (required.options?.signal?.aborted) return fail({ code: "cancelled", message: "Campaign call cancelled" });
  return success({ value: undefined });
}
export function existingDraft(required: { record: CampaignRecord; draftDigest: string }): Outcome<CampaignReceipt> {
  if (digest({ value: required.record.draft }) !== required.draftDigest) return fail({ code: "conflict", message: "Creation operation reused with changed draft" });
  return success({ value: structuredClone(required.record.receipt) });
}
export function existingProposal(required: { existing: LaunchProposal; proposal: LaunchProposal }): Outcome<LaunchProposal> {
  if (digest({ value: required.existing }) !== digest({ value: required.proposal })) return fail({ code: "conflict", message: "Proposal operation reused" });
  return success({ value: structuredClone(required.existing) });
}
export function observationFreshness(required: { previous: ObservedCampaignState | null; state: ObservedCampaignState }): Outcome<void> {
  if (required.previous && required.state.observedAt < required.previous.observedAt) return fail({ code: "conflict", message: "Stale observation" });
  return success({ value: undefined });
}
export function withObservation(required: { record: CampaignRecord; state: ObservedCampaignState }): CampaignRecord {
  const observedState = required.state.state === "paused" ? "paused" : "unknown";
  return structuredClone({ ...required.record, receipt: { ...required.record.receipt, observedState }, observation: required.state });
}
/** Storage rejects proposal/account substitutions even when called outside the service. */
export function proposalForRecord(required: { record: CampaignRecord | null; proposal: LaunchProposal }): Outcome<void> {
  const { record, proposal } = required;
  if (!record) return fail({ code: "forbidden", message: "Campaign unavailable in scope" });
  const args = proposal.arguments;
  if (args.campaignId !== record.receipt.campaignId || proposal.campaignId !== args.campaignId) return fail({ code: "conflict", message: "Proposal campaign mismatch" });
  if (args.connectionId !== record.draft.connectionId || args.accountId !== record.draft.accountId) return fail({ code: "forbidden", message: "Proposal account mismatch" });
  if (args.creativeDigest !== record.draft.creativeDigest || proposal.creativeDigest !== args.creativeDigest) return fail({ code: "conflict", message: "Proposal creative mismatch" });
  return proposalOperationValid({ proposal });
}
/** One exact ad-spend operation; exposure describes arguments, never a reusable grant. */
function proposalOperationValid(required: { proposal: LaunchProposal }): Outcome<void> {
  const { proposal } = required;
  const args = proposal.arguments;
  const operation = proposal.operations[0];
  if (operation.argumentsDigest !== digest({ value: args })) return fail({ code: "conflict", message: "Proposal arguments mismatch" });
  if (operation.accountId !== args.accountId || operation.connectionId !== args.connectionId) return fail({ code: "forbidden", message: "Operation account mismatch" });
  if (operation.effects.length !== 1 || operation.effects[0] !== "ad_spend" || operation.requiredLimit !== null) return fail({ code: "conflict", message: "Unexpected launch effect" });
  const exposure = { amount: args.flight.expectedExposure, window: args.flight.window };
  if (digest({ value: operation.moneyExposure }) !== digest({ value: exposure })) return fail({ code: "conflict", message: "Launch exposure mismatch" });
  return success({ value: undefined });
}

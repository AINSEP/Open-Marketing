import { z } from "zod";
import { callContextSchema, idSchema } from "@open-marketing/contracts";
import type { CallContext, CallOptions, Outcome } from "@open-marketing/contracts";
import type { CampaignRepoPort } from "./ports.js";
import type { CampaignRecord, CampaignReceipt, LaunchProposal, ObservedCampaignState } from "./types.js";
import { digest, fail, observationSchema, parseBoundary, proposalBinding, proposalSchema, recordSchema, scopeKey, success } from "./rules.js";

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
  return proposalBinding({ proposal });
}
/** Validate repository output against the requested key, including nested evidence.
 * Rejects tainted/cross-scope records before they influence dispatch decisions.
 * @complexity O(n) bounded record bytes; pure, no I/O.
 */
export function boundRecord(required: { context: CallContext; campaignId: string; value: unknown }): Outcome<CampaignRecord> {
  const parsed = parseBoundary({ schema: recordSchema, input: required.value });
  if (!parsed.ok) return parsed;
  const record = parsed.value;
  if (scopeKey({ scope: record.scope }) !== scopeKey({ scope: required.context.scope })) return fail({ code: "forbidden", message: "Campaign scope mismatch" });
  if (record.receipt.campaignId !== required.campaignId) return fail({ code: "conflict", message: "Stored campaign identity mismatch" });
  if (record.observation && record.observation.campaignId !== required.campaignId) return fail({ code: "conflict", message: "Stored observation campaign mismatch" });
  const observedState = record.observation?.state === "paused" ? "paused" : "unknown";
  if (record.receipt.observedState !== observedState) return fail({ code: "conflict", message: "Receipt contradicts observed evidence" });
  return parsed;
}
/** Validate a scoped repository read before it can supply effect arguments.
 * @complexity One port read and O(n) bounded record validation; no retries.
 */
export async function readCampaign(required: { repo: CampaignRepoPort; context: CallContext; campaignId: string }, optional?: CallOptions): Promise<Outcome<CampaignRecord | null>> {
  const result = await required.repo.get({ context: required.context, campaignId: required.campaignId }, optional);
  if (!result.ok) return result;
  if (result.value === null) return success({ value: null });
  return boundRecord({ ...required, value: result.value });
}
/** Bind a persisted launch card to its operation key before accessing its arguments.
 * @complexity One port read and O(n) bounded proposal bytes; malformed output fails closed.
 */
export async function readLaunchProposal(required: { repo: CampaignRepoPort; context: CallContext; operationId: string }, optional?: CallOptions): Promise<Outcome<LaunchProposal | null>> {
  const result = await required.repo.getProposal({ context: required.context, operationId: required.operationId }, optional);
  if (!result.ok) return result;
  if (result.value === null) return success({ value: null });
  const parsed = parseBoundary({ schema: proposalSchema, input: result.value });
  if (!parsed.ok) return parsed;
  if (parsed.value.operations[0].operationId !== required.operationId) return fail({ code: "conflict", message: "Proposal operation identity mismatch" });
  const bound = proposalBinding({ proposal: parsed.value });
  if (!bound.ok) return bound;
  return parsed;
}
/** A storage adapter cannot replace the exact card returned to the user.
 * @complexity One port write and O(n) bounded proposal bytes; no retries.
 */
export async function persistProposal(required: { repo: CampaignRepoPort; context: CallContext; proposal: LaunchProposal }, optional?: CallOptions): Promise<Outcome<LaunchProposal>> {
  const result = await required.repo.saveProposal({ context: required.context, proposal: required.proposal }, optional);
  if (!result.ok) return result;
  const parsed = parseBoundary({ schema: proposalSchema, input: result.value });
  if (!parsed.ok) return parsed;
  if (digest({ value: parsed.value }) !== digest({ value: required.proposal })) return fail({ code: "conflict", message: "Stored launch card changed" });
  return parsed;
}

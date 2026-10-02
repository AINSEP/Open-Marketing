import type { CallContext, Outcome, CampaignDraft, LaunchProposal, ApprovedLaunchRequest, ClockPort } from "../index.js";
import { createCampaignService, createMemoryCampaignRepo, createMemoryCampaignCapability, createMemoryCampaignAsset, createMemoryCampaignSafety, createMemoryCampaignJob, createMemoryCampaignAudit } from "../index.js";
import { createHash } from "node:crypto";

export const context: CallContext = { scope: { ownerId: "owner", workspaceId: "workspace" }, principal: { kind: "owner", ownerId: "owner" }, correlationId: "correlation", traceId: "trace", runId: "run" };
export const otherContext: CallContext = { ...context, scope: { ownerId: "owner", workspaceId: "other" } };
export const revisionDigest = "a".repeat(64);
export const draft: CampaignDraft = { operationId: "create-1", connectionId: "connection", accountId: "account", name: "Paused plan", objective: "signups", creativeIds: ["creative-1"], creativeDigest: revisionDigest, placements: ["search"] };
export const flight = { window: { start: 1000, end: 5000 }, expectedExposure: { minorUnits: 1200, currency: "USD" }, timezone: "America/Los_Angeles" };

/** Test fixture assertion helper: failure cannot make an assertion conditional/vacuous. */
export function value<T>(required: { outcome: Outcome<T> }): T {
  if (!required.outcome.ok) throw new Error(required.outcome.error.code + ": " + required.outcome.error.message);
  return required.outcome.value;
}
export function proposal(required: { campaignId: string; operationId?: string; exposure?: number }): LaunchProposal {
  const args = { campaignId: required.campaignId, connectionId: draft.connectionId, accountId: draft.accountId, creativeDigest: draft.creativeDigest, flight: { ...flight, expectedExposure: { ...flight.expectedExposure, minorUnits: required.exposure ?? 1200 } }, action: "launch" as const };
  const argumentsDigest = createHash("sha256").update(JSON.stringify(args)).digest("hex");
  return { campaignId: required.campaignId, creativeDigest: draft.creativeDigest, arguments: args, proposedAt: 900, operations: [{ operationId: required.operationId ?? "launch-1", connectionId: draft.connectionId, accountId: draft.accountId, effects: ["ad_spend"], argumentsDigest, moneyExposure: { amount: args.flight.expectedExposure, window: args.flight.window }, requiredLimit: null }] };
}
export function request(required: { proposal: LaunchProposal; approvalId?: string }): ApprovedLaunchRequest {
  return { campaignId: required.proposal.campaignId, operationId: required.proposal.operations[0].operationId, approvalId: required.approvalId ?? "approval-1", argumentsDigest: required.proposal.operations[0].argumentsDigest, creativeDigest: required.proposal.creativeDigest };
}
export async function fixture(required: { creation?: "complete" | "partial"; launch?: "submitted" | "unknown"; mode?: "always-on" | "local-sandbox" | "read-only"; accountMode?: "sandbox" | "production" } = {}) {
  let currentTime = 900;
  let nextId = 0;
  const clock: ClockPort = { now() { return currentTime; } };
  const repo = createMemoryCampaignRepo({});
  const capabilities = createMemoryCampaignCapability({ clock, creation: required.creation, launch: required.launch });
  const assets = createMemoryCampaignAsset({});
  value({ outcome: assets.put({ context, creativeId: "creative-1", revisionDigest }) });
  const creativeDigest = value({ outcome: await assets.resolve({ context, creativeIds: draft.creativeIds }) }).creativeDigest;
  const safety = createMemoryCampaignSafety({ mode: required.mode, accounts: [{ scope: context.scope, connectionId: draft.connectionId, accountId: draft.accountId, accountMode: required.accountMode ?? "sandbox", allowCreation: true }] });
  const jobs = createMemoryCampaignJob({});
  const audit = createMemoryCampaignAudit({});
  const dependencies = { repo, capabilities, assets, safety, jobs, audit, clock, ids: { next() { nextId += 1; return "launch-" + nextId; } } };
  const service = createCampaignService(dependencies);
  return { ...dependencies, service, draft: { ...draft, creativeDigest }, setTime(input: { now: number }) { currentTime = input.now; } };
}

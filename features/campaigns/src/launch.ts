import type { CallContext, CallOptions, Outcome } from "@open-marketing/contracts";
import type { ApprovedLaunchRequest, FlightProposal, LaunchProposal, LaunchReceipt } from "./types.js";
import type { CampaignDependencies } from "./dependencies.js";
import { proposalForRecord, readCampaign, readLaunchProposal, persistProposal } from "./repo-rules.js";
import { digest, exactMatch, fail, jobReceipt, launchInputSchema, parseBoundary, proposeInputSchema, success } from "./rules.js";
import { checkCreativeSet } from "./creative-rules.js";
import { readJob } from "./job-rules.js";
import { pausedCreationReady } from "./creation-ready.js";

/** One exact launch call per proposal. Injected ID/clock and persisted arguments survive restart. */
export async function proposeLaunch(required: { dependencies: CampaignDependencies; input: { context: CallContext; campaignId: string; flight: FlightProposal } }, optional?: CallOptions): Promise<Outcome<LaunchProposal>> {
  const parsed = parseBoundary({ schema: proposeInputSchema, input: required.input });
  if (!parsed.ok) return parsed;
  const { context, campaignId, flight } = parsed.value;
  const ports = required.dependencies;
  if (flight.window.end <= ports.clock.now({})) return fail({ code: "expired", message: "Flight ended" });
  const record = await readCampaign({ repo: ports.repo, context, campaignId }, optional);
  if (!record.ok) return record;
  if (!record.value) return fail({ code: "forbidden", message: "Campaign unavailable in scope" });
  const { draft } = record.value;
  const creation = await pausedCreationReady({ jobs: ports.jobs, context, record: record.value }, optional);
  if (!creation.ok) return creation;
  const authority = await ports.safety.authorizeCreation({ context, draft }, optional);
  if (!authority.ok) return authority;
  const assets = await checkCreativeSet({ assets: ports.assets, context, creativeIds: draft.creativeIds, creativeDigest: draft.creativeDigest }, optional);
  if (!assets.ok) return assets;
  const args = { campaignId, connectionId: draft.connectionId, accountId: draft.accountId, creativeDigest: draft.creativeDigest, flight, action: "launch" as const };
  const proposal: LaunchProposal = { campaignId, creativeDigest: draft.creativeDigest, arguments: args, proposedAt: ports.clock.now({}), operations: [{ operationId: ports.ids.next({}), connectionId: draft.connectionId, accountId: draft.accountId, effects: ["ad_spend"], argumentsDigest: digest({ value: args }), moneyExposure: { amount: flight.expectedExposure, window: flight.window }, requiredLimit: null }] };
  return persistProposal({ repo: ports.repo, context, proposal }, optional);
}

/** Validates approval before enqueue; enqueue stores the exact request+arguments atomically. */
export async function queueLaunch(required: { dependencies: CampaignDependencies; input: { context: CallContext; request: ApprovedLaunchRequest } }, optional?: CallOptions): Promise<Outcome<LaunchReceipt>> {
  const parsed = parseBoundary({ schema: launchInputSchema, input: required.input });
  if (!parsed.ok) return parsed;
  const { context, request } = parsed.value;
  const ports = required.dependencies;
  const proposal = await readLaunchProposal({ repo: ports.repo, context, operationId: request.operationId }, optional);
  if (!proposal.ok) return proposal;
  if (!proposal.value || !exactMatch({ request, proposal: proposal.value })) return fail({ code: "conflict", message: "Exact proposal changed or is missing" });
  return enqueueApproved({ dependencies: ports, context, request, proposal: proposal.value }, optional);

}

async function enqueueApproved(required: { dependencies: CampaignDependencies; context: CallContext; request: ApprovedLaunchRequest; proposal: LaunchProposal }, optional?: CallOptions): Promise<Outcome<LaunchReceipt>> {
  const { dependencies: ports, context, request, proposal } = required;
  const previous = await existingLaunch({ dependencies: ports, context, request, proposal: proposal }, optional);
  if (!previous.ok) return previous;
  if (previous.value) return success({ value: previous.value });
  const current = await launchReady({ dependencies: ports, context, proposal: proposal }, optional);
  if (!current.ok) return current;
  const authority = await ports.safety.authorize({ context, request, proposal: proposal }, optional);
  if (!authority.ok) return authority;
  const queued = await ports.jobs.enqueue({ context, operationId: request.operationId, argumentsDigest: request.argumentsDigest, intent: { kind: "launch", request, proposal: proposal } }, optional);
  if (!queued.ok) return queued;
  const job = await readJob({ jobs: ports.jobs, context, operationId: request.operationId }, optional);
  if (!job.ok) return job;
  if (!job.value) return fail({ code: "unavailable", message: "Enqueued intent missing" });
  return success({ value: jobReceipt({ job: job.value }) });
}
async function existingLaunch(required: { dependencies: CampaignDependencies; context: CallContext; request: ApprovedLaunchRequest; proposal: LaunchProposal }, optional?: CallOptions): Promise<Outcome<LaunchReceipt | null>> {
  const found = await readJob({ jobs: required.dependencies.jobs, context: required.context, operationId: required.request.operationId }, optional);
  if (!found.ok) return found;
  if (!found.value) return success({ value: null });
  const expected = { kind: "launch", request: required.request, proposal: required.proposal };
  if (digest({ value: found.value.intent }) !== digest({ value: expected })) return fail({ code: "conflict", message: "Queued exact operation differs" });
  if (found.value.status === "queued") return success({ value: null });
  return success({ value: jobReceipt({ job: found.value }) });
}
/** Current creative/account/paused state is checked before approval becomes queued intent. */
async function launchReady(required: { dependencies: CampaignDependencies; context: CallContext; proposal: LaunchProposal }, optional?: CallOptions): Promise<Outcome<void>> {
  const { dependencies: ports, context, proposal } = required;
  const record = await readCampaign({ repo: ports.repo, context, campaignId: proposal.campaignId }, optional);
  if (!record.ok) return record;
  const valid = proposalForRecord({ record: record.value, proposal });
  if (!valid.ok) return valid;
  if (!record.value) return fail({ code: "forbidden", message: "Campaign unavailable in scope" });
  const creation = await pausedCreationReady({ jobs: ports.jobs, context, record: record.value }, optional);
  if (!creation.ok) return creation;
  if (proposal.arguments.flight.window.end <= ports.clock.now({})) return fail({ code: "expired", message: "Flight ended" });
  return checkCreativeSet({ assets: ports.assets, context, creativeIds: record.value.draft.creativeIds, creativeDigest: proposal.creativeDigest }, optional);
}

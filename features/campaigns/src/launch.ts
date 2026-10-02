import type { CallContext, CallOptions, Outcome } from "@open-marketing/contracts";
import type { ApprovedLaunchRequest, FlightProposal, LaunchProposal, LaunchReceipt } from "./types.js";
import type { CampaignDependencies } from "./dependencies.js";
import { proposalForRecord } from "./repo-rules.js";
import { assetResultSchema, digest, exactMatch, fail, jobReceipt, launchInputSchema, parseBoundary, proposeInputSchema, success } from "./rules.js";

/** One exact launch call per proposal. Injected ID/clock and persisted arguments survive restart. */
export async function proposeLaunch(required: { dependencies: CampaignDependencies; input: { context: CallContext; campaignId: string; flight: FlightProposal } }, optional?: CallOptions): Promise<Outcome<LaunchProposal>> {
  const parsed = parseBoundary({ schema: proposeInputSchema, input: required.input });
  if (!parsed.ok) return parsed;
  const { context, campaignId, flight } = parsed.value;
  const ports = required.dependencies;
  if (flight.window.end <= ports.clock.now({})) return fail({ code: "expired", message: "Flight ended" });
  const record = await ports.repo.get({ context, campaignId }, optional);
  if (!record.ok) return record;
  if (!record.value) return fail({ code: "forbidden", message: "Campaign unavailable in scope" });
  const { draft, receipt } = record.value;
  if (receipt.observedState !== "paused") return fail({ code: "conflict", message: "Paused creation has not been verified" });
  const authority = await ports.safety.authorizeCreation({ context, draft }, optional);
  if (!authority.ok) return authority;
  const assets = await ports.assets.resolve({ context, creativeIds: draft.creativeIds }, optional);
  if (!assets.ok) return assets;
  const validated = parseBoundary({ schema: assetResultSchema, input: assets.value });
  if (!validated.ok) return validated;
  if (validated.value.creativeDigest !== draft.creativeDigest) return fail({ code: "conflict", message: "Creative set changed" });
  const args = { campaignId, connectionId: draft.connectionId, accountId: draft.accountId, creativeDigest: draft.creativeDigest, flight, action: "launch" as const };
  const proposal: LaunchProposal = { campaignId, creativeDigest: draft.creativeDigest, arguments: args, proposedAt: ports.clock.now({}), operations: [{ operationId: ports.ids.next({}), connectionId: draft.connectionId, accountId: draft.accountId, effects: ["ad_spend"], argumentsDigest: digest({ value: args }), moneyExposure: { amount: flight.expectedExposure, window: flight.window }, requiredLimit: null }] };
  return ports.repo.saveProposal({ context, proposal }, optional);
}

/** Validates approval before enqueue; enqueue stores the exact request+arguments atomically. */
export async function queueLaunch(required: { dependencies: CampaignDependencies; input: { context: CallContext; request: ApprovedLaunchRequest } }, optional?: CallOptions): Promise<Outcome<LaunchReceipt>> {
  const parsed = parseBoundary({ schema: launchInputSchema, input: required.input });
  if (!parsed.ok) return parsed;
  const { context, request } = parsed.value;
  const ports = required.dependencies;
  const proposal = await ports.repo.getProposal({ context, operationId: request.operationId }, optional);
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
  const job = await ports.jobs.get({ context, operationId: request.operationId }, optional);
  if (!job.ok) return job;
  if (!job.value) return fail({ code: "unavailable", message: "Enqueued intent missing" });
  return success({ value: jobReceipt({ job: job.value }) });
}
async function existingLaunch(required: { dependencies: CampaignDependencies; context: CallContext; request: ApprovedLaunchRequest; proposal: LaunchProposal }, optional?: CallOptions): Promise<Outcome<LaunchReceipt | null>> {
  const found = await required.dependencies.jobs.get({ context: required.context, operationId: required.request.operationId }, optional);
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
  const record = await ports.repo.get({ context, campaignId: proposal.campaignId }, optional);
  if (!record.ok) return record;
  const valid = proposalForRecord({ record: record.value, proposal });
  if (!valid.ok) return valid;
  if (!record.value || record.value.receipt.observedState !== "paused") return fail({ code: "conflict", message: "Launch requires verified paused state" });
  if (proposal.arguments.flight.window.end <= ports.clock.now({})) return fail({ code: "expired", message: "Flight ended" });
  const assets = await ports.assets.resolve({ context, creativeIds: record.value.draft.creativeIds }, optional);
  if (!assets.ok) return assets;
  const parsed = parseBoundary({ schema: assetResultSchema, input: assets.value });
  if (!parsed.ok) return parsed;
  if (parsed.value.creativeDigest !== proposal.creativeDigest) return fail({ code: "conflict", message: "Creative revisions changed" });
  return success({ value: undefined });
}

import type { CallContext, CallOptions, Outcome } from "@open-marketing/contracts";
import type { CampaignDependencies } from "./dependencies.js";
import type { CampaignJob, CampaignReadback, LaunchReceipt } from "./types.js";
import { assetResultSchema, exactMatch, fail, jobReceipt, launchReceiptSchema, operationInputSchema, parseBoundary, readbackSchema, receiptSchema, success, verifiedState } from "./rules.js";

/** Re-resolves creative revisions before every dispatch, including creation recovery. */
export async function checkIntent(required: { dependencies: CampaignDependencies; context: CallContext; job: CampaignJob }, optional?: CallOptions): Promise<Outcome<void>> {
  const { dependencies: ports, context, job } = required;
  const campaignId = intentCampaignId({ job });
  const record = await ports.repo.get({ context, campaignId }, optional);
  if (!record.ok) return record;
  if (!record.value) return fail({ code: "forbidden", message: "Campaign unavailable in scope" });
  const assets = await ports.assets.resolve({ context, creativeIds: record.value.draft.creativeIds }, optional);
  if (!assets.ok) return assets;
  const parsed = parseBoundary({ schema: assetResultSchema, input: assets.value });
  if (!parsed.ok) return parsed;
  if (parsed.value.creativeDigest !== record.value.draft.creativeDigest) return fail({ code: "conflict", message: "Creative revisions changed" });
  if (job.intent.kind === "create") return success({ value: undefined });
  if (!exactMatch({ request: job.intent.request, proposal: job.intent.proposal })) return fail({ code: "conflict", message: "Queued approval drifted" });
  if (job.intent.proposal.arguments.flight.window.end <= ports.clock.now({})) return fail({ code: "expired", message: "Flight ended before dispatch" });
  return success({ value: undefined });
}
function intentCampaignId(required: { job: CampaignJob }): string {
  if (required.job.intent.kind === "create") return required.job.intent.campaignId;
  return required.job.intent.request.campaignId;
}

/** CAS ownership prevents duplicate writes. No recovery path reclaims an uncertain job. */
export async function dispatchOperation(required: { dependencies: CampaignDependencies; input: { context: CallContext; operationId: string } }, optional?: CallOptions): Promise<Outcome<LaunchReceipt>> {
  const parsed = parseBoundary({ schema: operationInputSchema, input: required.input });
  if (!parsed.ok) return parsed;
  const { context, operationId } = parsed.value;
  const ports = required.dependencies;
  const found = await ports.jobs.get({ context, operationId }, optional);
  if (!found.ok) return found;
  if (!found.value) return fail({ code: "forbidden", message: "Operation unavailable in scope" });
  if (found.value.status !== "queued") return success({ value: jobReceipt({ job: found.value }) });
  const fresh = await checkIntent({ dependencies: ports, context, job: found.value }, optional);
  if (!fresh.ok) return fresh;
  const claim = await ports.jobs.claim({ context, operationId }, optional);
  if (!claim.ok) return claim;
  if (!claim.value) return currentReceipt({ dependencies: ports, context, operationId }, optional);
  return completeDispatch({ dependencies: ports, context, job: claim.value }, optional);
}
async function completeDispatch(required: { dependencies: CampaignDependencies; context: CallContext; job: CampaignJob }, optional?: CallOptions): Promise<Outcome<LaunchReceipt>> {
  const { dependencies: ports, context, job } = required;
  const operationId = job.operationId;
  const dispatched = await performEffect(required, optional);
  let status: "submitted" | "unknown" = "unknown";
  if (dispatched.ok && dispatched.value.status === "submitted") status = "submitted";
  // Persist outcomes even if the request was cancelled after a possible provider effect.
  const finished = await ports.jobs.finish({ context, operationId, status });
  if (!finished.ok) return finished;
  const audited = await ports.audit.record({ context, operationId, outcome: status });
  if (!audited.ok) return audited;
  if (!dispatched.ok) return dispatched;
  return success({ value: { operationId, status } });
}
async function currentReceipt(required: { dependencies: CampaignDependencies; context: CallContext; operationId: string }, optional?: CallOptions): Promise<Outcome<LaunchReceipt>> {
  const found = await required.dependencies.jobs.get({ context: required.context, operationId: required.operationId }, optional);
  if (!found.ok) return found;
  if (!found.value) return fail({ code: "unavailable", message: "Claimed operation disappeared" });
  return success({ value: jobReceipt({ job: found.value }) });
}
async function performEffect(required: { dependencies: CampaignDependencies; context: CallContext; job: CampaignJob }, optional?: CallOptions): Promise<Outcome<LaunchReceipt>> {
  const { dependencies: ports, context, job } = required;
  if (job.intent.kind === "create") return performCreation(required, optional);
  const { request, proposal } = job.intent;
  const result = await ports.safety.dispatchLaunch({ context, request, proposal, execute: permit => ports.capabilities.launch({ context, request, proposal, permitId: permit.permitId }, optional) }, optional);
  if (!result.ok) return result;
  const parsed = parseBoundary({ schema: launchReceiptSchema, input: result.value });
  if (!parsed.ok) return parsed;
  if (parsed.value.operationId !== job.operationId) return fail({ code: "conflict", message: "Provider returned another operation" });
  return parsed;
}
async function performCreation(required: { dependencies: CampaignDependencies; context: CallContext; job: CampaignJob }, optional?: CallOptions): Promise<Outcome<LaunchReceipt>> {
  const { dependencies: ports, context, job } = required;
  if (job.intent.kind !== "create") return fail({ code: "conflict", message: "Creation intent required" });
  const { draft, campaignId } = job.intent;
  const result = await ports.safety.dispatchCreation({ context, draft, execute: permit => ports.capabilities.createPaused({ context, draft, campaignId, permitId: permit.permitId }, optional) }, optional);
  if (!result.ok) return result;
  const parsed = parseBoundary({ schema: receiptSchema, input: result.value });
  if (!parsed.ok) return parsed;
  if (parsed.value.campaignId !== campaignId) return fail({ code: "conflict", message: "Provider returned another campaign" });
  // A provider acknowledgement is insufficient: verify every hierarchy entity by readback.
  return reconcileEvidence({ dependencies: ports, context, job }, optional);
}

/** Reads uncertainty without sending the original mutation again. */
export async function reconcileOperation(required: { dependencies: CampaignDependencies; input: { context: CallContext; operationId: string } }, optional?: CallOptions): Promise<Outcome<LaunchReceipt>> {
  const parsed = parseBoundary({ schema: operationInputSchema, input: required.input });
  if (!parsed.ok) return parsed;
  const { context, operationId } = parsed.value;
  const ports = required.dependencies;
  const found = await ports.jobs.get({ context, operationId }, optional);
  if (!found.ok) return found;
  if (!found.value) return fail({ code: "forbidden", message: "Operation unavailable in scope" });
  if (found.value.status === "queued") return success({ value: jobReceipt({ job: found.value }) });
  const evidence = await reconcileEvidence({ dependencies: ports, context, job: found.value }, optional);
  if (!evidence.ok) return evidence;
  const status = evidence.value.status === "submitted" ? "submitted" : "unknown";
  const saved = await ports.jobs.finish({ context, operationId, status });
  if (!saved.ok) return saved;
  const audited = await ports.audit.record({ context, operationId, outcome: "reconciled:" + status });
  if (!audited.ok) return audited;
  return evidence;
}
async function reconcileEvidence(required: { dependencies: CampaignDependencies; context: CallContext; job: CampaignJob }, optional?: CallOptions): Promise<Outcome<LaunchReceipt>> {
  const { dependencies: ports, context, job } = required;
  const campaignId = intentCampaignId({ job });
  const record = await ports.repo.get({ context, campaignId }, optional);
  if (!record.ok) return record;
  if (!record.value) return fail({ code: "forbidden", message: "Campaign unavailable in scope" });
  const { connectionId, accountId } = record.value.draft;
  const read = await ports.capabilities.readState({ context, campaignId, connectionId, accountId, operationId: job.operationId }, optional);
  if (!read.ok) return read;
  const parsed = parseBoundary({ schema: readbackSchema, input: read.value });
  if (!parsed.ok) return parsed;
  if (parsed.value.state.campaignId !== campaignId) return fail({ code: "conflict", message: "Readback campaign mismatch" });
  return recordEvidence({ dependencies: ports, context, job, readback: parsed.value }, optional);
}
async function recordEvidence(required: { dependencies: CampaignDependencies; context: CallContext; job: CampaignJob; readback: CampaignReadback }, optional?: CallOptions): Promise<Outcome<LaunchReceipt>> {
  const { dependencies: ports, context, job, readback } = required;
  const expected = job.intent.kind === "create" ? "paused" : "active";
  const verified = verifiedState({ readback, expected }) && readback.operationId === job.operationId;
  const state = { ...readback.state, state: "unknown" as "unknown" | "paused" | "active" };
  if (readback.state.state !== "unknown" && verifiedState({ readback, expected: readback.state.state })) state.state = readback.state.state;
  const recorded = await ports.repo.observe({ context, state }, optional);
  if (!recorded.ok) return recorded;
  let status: "submitted" | "unknown" = "unknown";
  if (verified) status = "submitted";
  return success({ value: { operationId: job.operationId, status } });
}

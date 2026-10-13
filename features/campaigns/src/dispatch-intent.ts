import type { CallContext, CallOptions, Outcome } from "@open-marketing/contracts";
import type { CampaignDependencies } from "./dependencies.js";
import type { CampaignJob, CampaignRecord } from "./types.js";
import { checkCreativeSet } from "./creative-rules.js";
import { proposalForRecord, readCampaign } from "./repo-rules.js";
import { digest, fail, success } from "./rules.js";
import { pausedCreationReady } from "./creation-ready.js";

/** Recheck the immutable intent against current campaign and creative evidence.
 * Run before claim and again after claim, before final safety authorization.
 * @complexity At most three bounded port reads, O(n) DTO bytes; no per-item I/O or retries.
 */
export async function checkIntent(required: { dependencies: CampaignDependencies; context: CallContext; job: CampaignJob }, optional?: CallOptions): Promise<Outcome<void>> {
  const { dependencies: ports, context, job } = required;
  const campaignId = intentCampaignId({ job });
  const record = await readCampaign({ repo: ports.repo, context, campaignId }, optional);
  if (!record.ok) return record;
  if (!record.value) return fail({ code: "forbidden", message: "Campaign unavailable in scope" });
  const bound = intentForRecord({ job, record: record.value, now: ports.clock.now({}) });
  if (!bound.ok) return bound;
  const creation = await checkCreationForIntent({ dependencies: ports, context, job, record: record.value }, optional);
  if (!creation.ok) return creation;
  return checkCreativeSet({ assets: ports.assets, context, creativeIds: record.value.draft.creativeIds, creativeDigest: record.value.draft.creativeDigest }, optional);
}
/** Launches also require the matching creation job's verified completion. */
async function checkCreationForIntent(required: { dependencies: CampaignDependencies; context: CallContext; job: CampaignJob; record: CampaignRecord }, optional?: CallOptions): Promise<Outcome<void>> {
  if (required.job.intent.kind === "create") return success({ value: undefined });
  return pausedCreationReady({ jobs: required.dependencies.jobs, context: required.context, record: required.record }, optional);
}

/** Pure record/intent binding: creation cannot substitute a draft; launch requires
 * current paused evidence and a live flight. @complexity O(n) bounded draft bytes.
 */
function intentForRecord(required: { job: CampaignJob; record: CampaignRecord; now: number }): Outcome<void> {
  const { job, record, now } = required;
  if (job.intent.kind === "create") {
    if (digest({ value: job.intent.draft }) !== digest({ value: record.draft })) return fail({ code: "conflict", message: "Queued creation draft changed" });
    return success({ value: undefined });
  }
  const valid = proposalForRecord({ record, proposal: job.intent.proposal });
  if (!valid.ok) return valid;
  if (record.receipt.observedState !== "paused") return fail({ code: "conflict", message: "Launch requires current paused evidence" });
  if (job.intent.proposal.arguments.flight.window.end <= now) return fail({ code: "expired", message: "Flight ended before dispatch" });
  return success({ value: undefined });
}

/** Select the campaign identity from the discriminated immutable intent. */
export function intentCampaignId(required: { job: CampaignJob }): string {
  if (required.job.intent.kind === "create") return required.job.intent.campaignId;
  return required.job.intent.request.campaignId;
}

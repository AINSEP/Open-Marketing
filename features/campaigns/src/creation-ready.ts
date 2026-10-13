import type { CallContext, CallOptions, Outcome } from "@open-marketing/contracts";
import type { CampaignJobPort } from "./ports.js";
import type { CampaignRecord } from "./types.js";
import { readJob } from "./job-rules.js";
import { digest, fail, success } from "./rules.js";

/** Paused evidence from an unrelated operation cannot complete this creation.
 * Requires both verified paused state and matching submitted creation intent.
 * Returns conflict until read-only reconciliation proves completion.
 * @complexity One outbox read and O(n) bounded draft comparison; no effects.
 */
export async function pausedCreationReady(required: { jobs: CampaignJobPort; context: CallContext; record: CampaignRecord }, optional?: CallOptions): Promise<Outcome<void>> {
  const { jobs, context, record } = required;
  if (record.receipt.observedState !== "paused") return fail({ code: "conflict", message: "Paused creation has not been verified" });
  const found = await readJob({ jobs, context, operationId: record.draft.operationId }, optional);
  if (!found.ok) return found;
  const job = found.value;
  if (!job || job.status !== "submitted" || job.intent.kind !== "create") return fail({ code: "conflict", message: "Creation operation has not been verified" });
  if (job.intent.campaignId !== record.receipt.campaignId || digest({ value: job.intent.draft }) !== digest({ value: record.draft })) return fail({ code: "conflict", message: "Creation evidence identity mismatch" });
  return success({ value: undefined });
}

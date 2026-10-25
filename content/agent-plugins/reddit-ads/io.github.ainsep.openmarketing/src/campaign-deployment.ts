import { z } from "zod";
import type { CallContext, CallOptions, Outcome } from "@open-marketing/contracts";
import type { RedditDependencies } from "./ports.js";
import { deploymentUnavailable } from "./campaign-translation.js";

/** No plan can be admitted until the missing official v3 schemas are verified. */
export const campaignDeploymentPlanSchema = z.never();

interface DeploymentInput {
  context: CallContext;
  operationId: string;
  plan: unknown;
  dependencies: RedditDependencies;
  checkpoint: (required: { step: string; phase: "dispatch" | "acknowledged"; references: { campaign?: string; adGroup?: string; ad?: string } }) => Promise<Outcome<void>>;
}

/** Fail closed before checkpoints, credentials or egress; never create from unverified examples.
 * The owning launch job must keep this unavailable result, rather than retrying or acknowledging it.
 * @example await deployCampaignPaused({ context, operationId, plan, dependencies, checkpoint })
 * @complexity O(1) time/space; no side effects or input traversal.
 */
export async function deployCampaignPaused(_required: DeploymentInput, _optional?: CallOptions): Promise<Outcome<never>> {
  return deploymentUnavailable();
}

/** Reconciliation is unavailable until the complete approved configuration can be read back.
 * Caller-owned saved references remain untouched. No GET, create, scan or retry is attempted.
 * @example await readCampaignDeployment({ context, operationId, plan, references, dependencies })
 * @complexity O(1) time/space; no side effects or input traversal.
 */
export async function readCampaignDeployment(_required: Omit<DeploymentInput, "checkpoint"> & { references: unknown }, _optional?: CallOptions): Promise<Outcome<never>> {
  return deploymentUnavailable();
}

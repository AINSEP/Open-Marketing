import { z } from "zod";
import type { CallContext, CallOptions, Outcome } from "@open-marketing/contracts";
import type { VkDependencies } from "./ports.js";

/** No deployable plan exists until operation-specific vendor evidence is complete. */
export const campaignDeploymentPlanSchema = z.never();
interface Input { context: CallContext; operationId: string; plan: unknown; dependencies: VkDependencies }

/** Hold paused creation before credentials, checkpoints or egress; no active-then-pause fallback.
 * @param required - Owning job's input; plan and checkpoint stay opaque and unused.
 * @param optional - Caller cancellation.
 * @returns Cancelled if aborted, otherwise unavailable; never a receipt.
 * @example await deployCampaignPaused({ context, operationId, plan, dependencies, checkpoint })
 * @complexity O(1) time/space; zero I/O and zero retries.
 */
export function deployCampaignPaused(required: Input & { checkpoint: unknown }, optional?: CallOptions): Promise<Outcome<never>> {
  return Promise.resolve(deploymentHold({ dependencies: required.dependencies }, optional));
}

/** Hold readback until scoped hierarchy and non-serving response contracts are verified.
 * @param required - Saved job input; references remain caller-owned and unchanged.
 * @param optional - Caller cancellation.
 * @returns Cancelled or unavailable; no invented verification or read/write dispatch.
 * @example await readCampaignDeployment({ context, operationId, plan, references, dependencies })
 * @complexity O(1) time/space; zero I/O and zero retries.
 */
export function readCampaignDeployment(required: Input & { references: unknown }, optional?: CallOptions): Promise<Outcome<never>> {
  return Promise.resolve(deploymentHold({ dependencies: required.dependencies }, optional));
}

/** Cancellation precedes the operation evidence hold; no input payload is read.
 * @returns A fixed, non-retryable failure without secrets or provider content.
 * @complexity O(1) time/space; no I/O.
 */
function deploymentHold(_required: { dependencies: VkDependencies }, optional?: CallOptions): Outcome<never> {
  const code = optional?.signal?.aborted ? "cancelled" : "unavailable";
  return { ok: false, error: { code, message: "VK request " + code, retryable: false } };
}

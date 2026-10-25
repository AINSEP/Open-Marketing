import type { Outcome } from "@open-marketing/contracts";

/** Reject translation until official v3 create, ownership and money/time contracts are verified.
 * Inputs stay opaque: no partial vendor plan is produced from examples or caller assertions.
 * @example translateCampaign({ campaign, target, resolved }) // unavailable, non-retryable
 * @complexity O(1) time/space; no input traversal, mutation or I/O.
 */
export function translateCampaign(_required: { campaign: unknown; target: unknown; resolved: unknown }): Outcome<never> {
  return deploymentUnavailable();
}

/** Shared evidence denial; no caller data or credentials enter the error. */
export function deploymentUnavailable(): Outcome<never> {
  return { ok: false, error: { code: "unavailable", message: "Reddit PAUSED deployment unavailable: official v3 create, ownership and readback schemas remain unverified", retryable: false } };
}

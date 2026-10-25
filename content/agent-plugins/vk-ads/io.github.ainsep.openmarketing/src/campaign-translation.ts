import type { Outcome } from "@open-marketing/contracts";

/** Opaque neutral intent and account/assets; no VK field contract is verified yet. */
export interface CampaignTranslationInput { campaign: unknown; target: unknown; resolved: unknown }

/** Hold translation until the selected package, budget and schedule contracts are verified.
 * @param _required - Neutral intent, target and resolved metadata; never inspected or mutated.
 * @returns Only a non-retryable unavailable error, with no guessed plan or vendor fields.
 * @example translateCampaign({ campaign, target, resolved })
 * @complexity O(1) time/space; no I/O or input traversal.
 */
export function translateCampaign(_required: CampaignTranslationInput): Outcome<never> {
  return { ok: false, error: { code: "unavailable", message: "VK campaign translation requires verified operation evidence", retryable: false } };
}

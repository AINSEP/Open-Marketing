import type { z } from "zod";
import type { NeutralCampaignLaunch, Outcome } from "@open-marketing/contracts";
import type { draftCampaignCommandSchema, draftCreativeCommandSchema, LinkedInCommand } from "./commands.js";

/** Canonical schema-validated v2 intent; plugins depend only on contracts. */
export interface CampaignTranslationInput {
  campaign: NeutralCampaignLaunch;
  target: Pick<NeutralCampaignLaunch["targets"][number], "accountId" | "dailyBudget">;
  resolved: unknown;
}
/** DRAFT parent/child hierarchy with fixed slots for acknowledged parent IDs. */
export interface LinkedInDraftPlan {
  group: Extract<LinkedInCommand, { kind: "create_campaign_group_draft" }>;
  campaign: Omit<z.infer<typeof draftCampaignCommandSchema>, "campaignGroupId"> & { campaignGroupId: { from: "group" } };
  creative: Omit<z.infer<typeof draftCreativeCommandSchema>, "campaignId"> & { campaignId: { from: "campaign" } };
}

/** Reject v2 intents until existing-post metadata can prove their destination URL (P2).
 * @param required - Parsed intent and selected target; metadata cannot prove the destination.
 * @returns Non-retryable not_implemented, without producing commands or reading metadata.
 * @example translateCampaign({ campaign: parsedLaunch, target, resolved: accountAndPost })
 * @complexity O(1) time/space; pure, with no credentials, I/O or activation.
 */
export function translateCampaign(required: CampaignTranslationInput): Outcome<LinkedInDraftPlan> {
  const { campaign } = required;
  if (campaign.objective !== "traffic" || campaign.ads.length !== 1 || campaign.audience.searchTerms !== undefined || campaign.audience.localTargeting !== undefined) return invalid({ message: "LinkedIn supports country-only traffic with one existing post" });
  return invalid({ message: "LinkedIn existing post metadata cannot verify the requested destination URL" });
}
function invalid(required: { message: string }): Outcome<never> {
  return { ok: false, error: { code: "not_implemented", ...required, retryable: false } };
}

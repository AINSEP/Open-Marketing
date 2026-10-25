import type { NeutralCampaignLaunch, Outcome } from "@open-marketing/contracts";
import type { MetaCommand } from "./commands.js";
import { failure } from "./boundary.js";

/** Canonical schema-validated v2 intent; plugins depend only on contracts. */
export interface CampaignTranslationInput {
  campaign: NeutralCampaignLaunch;
  target: Pick<NeutralCampaignLaunch["targets"][number], "accountId" | "dailyBudget">;
  resolved: unknown;
}
type Campaign = Extract<MetaCommand, { kind: "create-campaign" }>;
type Adset = Omit<Extract<MetaCommand, { kind: "create-adset" }>, "campaignId">;
type Ad = Omit<Extract<MetaCommand, { kind: "create-ad" }>, "adsetId">;
/** Fixed parent slots accept only earlier acknowledged IDs; these are not executable commands. */
export interface MetaPausedPlan {
  campaign: Campaign;
  adset: Adset & { campaignId: { from: "campaign" } };
  ad: Ad & { adsetId: { from: "adset" } };
}

/** Reject v2 intents until existing-creative metadata can prove their destination URL (P2).
 * @param required - Parsed intent and selected target; metadata cannot prove the destination.
 * @returns Non-retryable not_implemented, without producing commands or reading metadata.
 * @example translateCampaign({ campaign: parsedLaunch, target, resolved: accountAndCreative })
 * @complexity O(1) time/space; pure, with no credentials, I/O or activation.
 */
export function translateCampaign(required: CampaignTranslationInput): Outcome<MetaPausedPlan> {
  const { campaign } = required;
  if (campaign.objective !== "traffic" || campaign.ads.length !== 1 || campaign.audience.searchTerms !== undefined || campaign.audience.localTargeting !== undefined) return failure({ code: "not_implemented", message: "Meta supports country-only traffic with one existing creative" });
  return failure({ code: "not_implemented", message: "Meta existing creative metadata cannot verify the requested destination URL" });
}

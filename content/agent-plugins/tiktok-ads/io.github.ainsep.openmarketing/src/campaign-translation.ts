import type { Money, Outcome, TimeWindow } from "@open-marketing/contracts";

/** Minimal canonical subset. No feature dependency or credential/transport access. */
export interface CampaignTranslationInput {
  campaign: { objective: string; schedule: { window: TimeWindow; timezone: string } };
  target: { dailyBudget: Money };
  resolved: unknown;
}

/** Fail closed until manual traffic's daily-budget/finite-end combination is verified.
 * The official SDK lists schedule fields but does not establish their compatibility;
 * Smart+ examples cannot validate this manual-traffic path. Never discard the end time,
 * substitute a lifetime budget or emit the existing encoder's SCHEDULE_FROM_NOW plan.
 * @param required - Parsed neutral intent; deliberately no metadata resolution or effects.
 * @returns A typed non-retryable unsupported result. No executable plan is produced.
 * @example translateCampaign({ campaign: parsedLaunch, target, resolved: null })
 * @complexity O(1) time/space.
 */
export function translateCampaign(required: CampaignTranslationInput): Outcome<never> {
  return { ok: false, error: {
    code: "not_implemented",
    message: required.campaign.objective === "traffic"
      ? "TikTok manual traffic with daily budget and finite end time is not verified"
      : "TikTok neutral translation supports no verified mapping for this objective",
    retryable: false,
  } };
}

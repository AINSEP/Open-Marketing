import { z } from "zod";
import { digestSchema, idSchema } from "@open-marketing/contracts";
import type { Money, Outcome, TimeWindow } from "@open-marketing/contracts";
import { customerIdSchema } from "./commands.js";

const name = z.string().min(1).max(200);
const budget = z.number().int().min(70).max(1000000000);
const bid = z.number().int().min(70).max(100000);
const date = z.iso.datetime().regex(/T15:00:00\.000Z$/);
const channel = z.string().regex(/^bsn-[A-Za-z0-9-]{1,120}$/);
const link = z.strictObject({ final: z.url().max(2048), display: z.url().max(2048) });
const keyword = z.strictObject({ keyword: z.string().min(1).max(80), bidAmt: bid, useGroupBidAmt: z.literal(false), userLock: z.literal(true) });

/** Frozen vendor controls for verifying an existing paused PowerLink hierarchy only.
 * Fixed CPC requires explicit systemBiddingType NONE in both the plan and readback.
 * Dates are already vendor dates, not a conversion from OM's unresolved end boundary.
 * This schema grants no creation authority; deployment remains unavailable.
 */
export const campaignDeploymentPlanSchema = z.strictObject({
  accountId: customerIdSchema, credentialCustomerId: customerIdSchema,
  creativeId: idSchema, creativeDigest: digestSchema, channelId: channel,
  campaign: z.strictObject({ name, campaignTp: z.literal("WEB_SITE"), userLock: z.literal(true), dailyBudget: budget,
    useDailyBudget: z.literal(true), usePeriod: z.literal(true), periodStartDt: date, periodEndDt: date }),
  adgroup: z.strictObject({ name, adgroupType: z.literal("WEB_SITE"), userLock: z.literal(true), dailyBudget: budget,
    useDailyBudget: z.literal(true), bidAmt: bid, systemBiddingType: z.literal("NONE"), useExpSearch: z.literal(false) }),
  ad: z.strictObject({ type: z.literal("TEXT_45"), userLock: z.literal(true),
    ad: z.strictObject({ headline: z.string().min(1).max(200), description: z.string().min(1).max(1000), pc: link, mobile: link }) }),
  keywords: z.array(keyword).min(1).max(20).refine(values => new Set(values.map(value => value.keyword)).size === values.length),
}).refine(value => value.campaign.periodStartDt <= value.campaign.periodEndDt);

/** Saved readback controls; never an executable write plan while prerequisites remain unresolved. */
export type NaverPausedPlan = z.infer<typeof campaignDeploymentPlanSchema>;
/** Structural neutral intent used by the existing server campaign translator call. */
export interface CampaignTranslationInput {
  campaign: { name: string; objective: string; schedule: { window: TimeWindow; timezone: string };
    audience: { countries: readonly string[]; searchTerms?: readonly string[] }; creativeIds: readonly string[]; creativeDigest: string };
  target: { accountId: string; dailyBudget: Money };
  resolved: unknown;
}
/** Launch prerequisites cannot be overridden by tool arguments or fixture metadata. */
export const pausedLaunchUnavailableReason = "Naver paused launch unavailable: verify OM end-date mapping, paused TEXT_45 creation and server binding";

/** Refuse translation before approval, credentials or writes; never round a neutral schedule.
 * Naver's inclusive end date is documented, but OM's TimeWindow end semantics and paused
 * TEXT_45 creation are not verified. No caller-supplied override can enable deployment.
 * @complexity O(1) time/space; no I/O or partial executable plan.
 */
export function translateCampaign(_required: CampaignTranslationInput): Outcome<NaverPausedPlan> {
  return { ok: false, error: { code: "not_implemented", message: pausedLaunchUnavailableReason, retryable: false } };
}

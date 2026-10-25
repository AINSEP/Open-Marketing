/** Pure, fixed traffic mapping; the server resolves account/funding/post/country eligibility. */
import { z } from "zod";
import { digestSchema, idSchema, moneySchema, epochSchema } from "@open-marketing/contracts";
import type { Money, Outcome, TimeWindow } from "@open-marketing/contracts";
import { campaignDeploymentPlanSchema } from "./campaign-deployment.js";
import type { XPausedPlan } from "./campaign-deployment.js";
import { vendorId } from "./commands.js";
import { boundedJson, failure } from "./transport.js";

/** Structural neutral intent subset; unrelated target/launch fields stay with the caller. */
export interface CampaignTranslationInput {
  campaign: { name: string; objective: string; schedule: { window: TimeWindow; timezone: string }; audience: { countries: readonly string[]; searchTerms?: readonly string[] }; creativeIds: readonly string[]; creativeDigest: string };
  target: { accountId: string; dailyBudget: Money };
  resolved: unknown;
}
const resolvedSchema = z.strictObject({
  accountId: vendorId, currency: z.string().regex(/^[A-Z]{3}$/), currencyExponent: z.number().int().min(0).max(3), timezone: idSchema,
  fundingInstrumentId: vendorId, creativeId: idSchema, creativeDigest: digestSchema, tweetId: z.string().regex(/^[1-9][0-9]{0,19}$/), eligible: z.literal(true),
  country: z.string().regex(/^[A-Z]{2}$/), countryId: vendorId, unitCost: moneySchema,
});
const intentSchema = z.object({ name: z.string().min(1).max(255), objective: z.literal("traffic"),
  schedule: z.strictObject({ window: z.strictObject({ start: epochSchema.max(253402300799000), end: epochSchema.max(253402300799000) }), timezone: idSchema }),
  audience: z.strictObject({ countries: z.array(z.string().regex(/^[A-Z]{2}$/)).length(1) }),
  creativeIds: z.array(idSchema).length(1), creativeDigest: digestSchema,
});

/** Translate one eligible existing post/country into four fixed paused requests and parent slots.
 * Unsupported intent/missing evidence returns before approval; never infer funding, bid or country.
 * @example translateCampaign({ campaign, target, resolved: verifiedAccountPostCountry })
 * @complexity O(b) time/space, b<=64KiB; pure, no credentials or I/O.
 */
export function translateCampaign(required: CampaignTranslationInput): Outcome<XPausedPlan> {
  const bounded = boundedJson({ input: { campaign: required.campaign, target: { accountId: required.target.accountId, dailyBudget: required.target.dailyBudget }, resolved: required.resolved } });
  if (!bounded.ok) return bounded;
  const parsed = z.strictObject({ campaign: intentSchema, target: z.strictObject({ accountId: vendorId, dailyBudget: moneySchema }), resolved: resolvedSchema }).safeParse(bounded.value);
  if (!parsed.success) return failure({ code: "not_implemented" });
  const { campaign, target, resolved } = parsed.data;
  if (!bindingsMatch({ ...parsed.data })) return failure({ code: "conflict" });
  const daily = micros({ money: target.dailyBudget, exponent: resolved.currencyExponent });
  const bid = micros({ money: resolved.unitCost, exponent: resolved.currencyExponent });
  if (!daily.ok) return daily;
  if (!bid.ok) return bid;
  const plan = campaignDeploymentPlanSchema.safeParse({ accountId: resolved.accountId, currency: resolved.currency,
    campaign: { name: campaign.name, funding_instrument_id: resolved.fundingInstrumentId, entity_status: "PAUSED", budget_optimization: "LINE_ITEM", daily_budget_amount_local_micro: daily.value },
    lineItem: { name: campaign.name, campaign_id: { from: "campaign" }, entity_status: "PAUSED", objective: "WEBSITE_CLICKS", product_type: "PROMOTED_TWEETS", placements: "ALL_ON_TWITTER", bid_strategy: "MAX", goal: "LINK_CLICKS", bid_amount_local_micro: bid.value, daily_budget_amount_local_micro: daily.value, standard_delivery: true,
      start_time: new Date(campaign.schedule.window.start).toISOString(), end_time: new Date(campaign.schedule.window.end).toISOString() },
    targeting: { line_item_id: { from: "lineItem" }, targeting_type: "LOCATION", operator_type: "EQ", targeting_value: resolved.countryId },
    promotedTweet: { line_item_id: { from: "lineItem" }, tweet_ids: resolved.tweetId },
  });
  return plan.success ? { ok: true, value: plan.data } : failure({ code: "not_implemented" });
}

/** Exact resolved evidence/intent match. Unknown currency exponents fail closed. O(1), pure. */
function bindingsMatch(required: { campaign: z.infer<typeof intentSchema>; target: { accountId: string; dailyBudget: Money }; resolved: z.infer<typeof resolvedSchema> }): boolean {
  const { campaign, target, resolved } = required;
  const currencyMatches = target.dailyBudget.currency === resolved.currency && resolved.unitCost.currency === resolved.currency;
  return currencyMatches && target.accountId === resolved.accountId && campaign.schedule.timezone === resolved.timezone
    && campaign.creativeIds[0] === resolved.creativeId && campaign.creativeDigest === resolved.creativeDigest && campaign.audience.countries[0] === resolved.country
    && new Intl.NumberFormat("en", { style: "currency", currency: resolved.currency }).resolvedOptions().maximumFractionDigits === resolved.currencyExponent;
}
/** Exact integer conversion; unsafe money never reaches a request or approval card. O(1). */
function micros(required: { money: Money; exponent: number }): Outcome<number> {
  const value = BigInt(required.money.minorUnits) * (10n ** BigInt(6 - required.exponent));
  if (value <= 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) return failure({ code: "invalid_input" });
  return { ok: true, value: Number(value) };
}

/** Pure, finite website-traffic plan. Vendor payloads never enter core/server composition. */
import { z } from "zod";
import { digestSchema, idSchema, moneySchema, timeWindowSchema } from "@open-marketing/contracts";
import type { Outcome } from "@open-marketing/contracts";
import { failure, timestamp, vendorId } from "./commands.js";
import { boundInput } from "./transport.js";

const micros = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const name = z.string().trim().min(1).max(375);
const schedule = { start_time: timestamp, end_time: timestamp };
const paused = z.literal("PAUSED");
const inputSchema = z.object({
  campaign: z.object({ name, objective: z.string(), schedule: z.strictObject({ window: timeWindowSchema, timezone: idSchema }),
    audience: z.strictObject({ countries: z.array(z.string().regex(/^[A-Z]{2}$/)).min(1).max(20), searchTerms: z.array(z.string()).optional() }),
    creativeIds: z.array(idSchema).length(1), creativeDigest: digestSchema }),
  target: z.object({ accountId: vendorId, dailyBudget: moneySchema }),
  resolved: z.strictObject({ accountId: vendorId, currency: z.string().regex(/^[A-Z]{3}$/), currencyExponent: z.number().int().min(0).max(3), timezone: idSchema,
    creativeId: idSchema, creativeDigest: digestSchema, providerCreativeId: vendorId, creativeAccountId: vendorId, creativeType: z.literal("WEB_VIEW"), bid: moneySchema }),
});
/** Structural neutral intent accepted from the existing preparation seam; resolved is server-owned. */
export type CampaignTranslationInput = z.input<typeof inputSchema>;
// Official ad-squad currency table. Unknown currencies have no verified bid bounds.
const bidMaximum: Readonly<Record<string, number>> = { AED: 500000000, AUD: 100000000, BAM: 100000000, CAD: 100000000,
  CHF: 100000000, CNY: 500000000, DKK: 500000000, EUR: 100000000, GBP: 100000000, HKD: 500000000, ILS: 500000000,
  INR: 500000000, KWD: 100000000, NOK: 500000000, QAR: 500000000, SAR: 500000000, SEK: 500000000, USD: 500000000 };
/** Host freezes this entire schema in the ONE grouped card before dispatch.
 * Daily-budget squads require explicit DAILY_BUDGET per Snap's attribute table; no inferred default. */
export const campaignDeploymentPlanSchema = z.strictObject({
  currency: z.string().regex(/^[A-Z]{3}$/), timezone: idSchema, creativeDigest: digestSchema,
  campaign: z.strictObject({ ad_account_id: vendorId, name, status: paused, ...schedule, daily_budget_micro: micros.min(5000000),
    objective_v2_properties: z.strictObject({ objective_v2_type: z.literal("TRAFFIC") }) }),
  squad: z.strictObject({ campaign_id: z.strictObject({ from: z.literal("campaign") }), name, status: paused, ...schedule,
    type: z.literal("SNAP_ADS"), billing_event: z.literal("IMPRESSION"), placement_v2: z.strictObject({ config: z.literal("AUTOMATIC") }),
    optimization_goal: z.literal("SWIPES"), bid_strategy: z.literal("LOWEST_COST_WITH_MAX_BID"), bid_micro: micros,
    daily_budget_micro: micros.min(5000000), delivery_constraint: z.literal("DAILY_BUDGET"), targeting: z.strictObject({ geos: z.array(z.strictObject({ country_code: z.string().regex(/^[a-z]{2}$/) })).min(1).max(20) }) }),
  ad: z.strictObject({ ad_squad_id: z.strictObject({ from: z.literal("squad") }), name, status: paused, type: z.literal("REMOTE_WEBPAGE"), creative_id: vendorId }),
}).refine(validPlan);
/** Reviewable values, including asset digest, exact micro amounts and fixed parent substitution slots. */
export type SnapchatPausedPlan = z.infer<typeof campaignDeploymentPlanSchema>;

/** Validate cross-level schedule, budget, countries and documented currency bounds; pure O(c), c<=20. */
function validPlan(plan: { currency: string; campaign: { daily_budget_micro: number; start_time: string; end_time: string };
  squad: { bid_micro: number; daily_budget_micro: number; start_time: string; end_time: string; targeting: { geos: { country_code: string }[] } } }): boolean {
  const { campaign, squad } = plan;
  const maximum = bidMaximum[plan.currency];
  const countries = squad.targeting.geos.map(geo => geo.country_code);
  return maximum !== undefined && squad.bid_micro >= 10000 && squad.bid_micro <= maximum
    && campaign.daily_budget_micro === squad.daily_budget_micro && campaign.start_time === squad.start_time
    && campaign.end_time === squad.end_time && Date.parse(campaign.start_time) < Date.parse(campaign.end_time)
    && new Set(countries).size === countries.length;
}

/** Translate one country-only traffic intent and existing WEB_VIEW creative, without I/O.
 * @param required - Neutral intent/target plus verified account, creative and explicit bid metadata.
 * @returns A frozen-by-host PAUSED plan, or typed unsupported/conflict/invalid input before egress.
 * @example translateCampaign({ campaign, target, resolved: accountAndCreative })
 * @complexity O(c) time/space, c<=20; lossless integer money conversion, no service construction.
 */
export function translateCampaign(required: CampaignTranslationInput): Outcome<SnapchatPausedPlan> {
  const bounded = boundInput({ input: required });
  if (!bounded.ok) return bounded;
  const parsed = inputSchema.safeParse(bounded.value);
  if (!parsed.success) return failure({ code: "not_implemented" });
  const { campaign, target, resolved } = parsed.data;
  if (campaign.objective !== "traffic" || campaign.audience.searchTerms !== undefined) return failure({ code: "not_implemented" });
  if (!bindingMatches(parsed.data)) return failure({ code: "conflict" });
  const amounts = convertMoney({ daily: target.dailyBudget.minorUnits, bid: resolved.bid.minorUnits, currency: resolved.currency, exponent: resolved.currencyExponent });
  if (!amounts.ok) return amounts;
  const window = campaign.schedule.window;
  if (window.end > 8640000000000000) return failure({ code: "invalid_input" });
  const times = { start_time: new Date(window.start).toISOString(), end_time: new Date(window.end).toISOString() };
  const plan = campaignDeploymentPlanSchema.safeParse({ currency: resolved.currency, timezone: resolved.timezone, creativeDigest: resolved.creativeDigest,
    campaign: { ad_account_id: resolved.accountId, name: campaign.name, status: "PAUSED", ...times, daily_budget_micro: amounts.value.daily,
      objective_v2_properties: { objective_v2_type: "TRAFFIC" } },
    squad: { campaign_id: { from: "campaign" }, name: campaign.name, status: "PAUSED", ...times, type: "SNAP_ADS", billing_event: "IMPRESSION",
      placement_v2: { config: "AUTOMATIC" }, optimization_goal: "SWIPES", bid_strategy: "LOWEST_COST_WITH_MAX_BID", bid_micro: amounts.value.bid,
      daily_budget_micro: amounts.value.daily, delivery_constraint: "DAILY_BUDGET", targeting: { geos: campaign.audience.countries.map(country => ({ country_code: country.toLowerCase() })) } },
    ad: { ad_squad_id: { from: "squad" }, name: campaign.name, status: "PAUSED", type: "REMOTE_WEBPAGE", creative_id: resolved.providerCreativeId } });
  return plan.success ? { ok: true, value: plan.data } : failure({ code: "not_implemented" });
}
/** Cross-bind the chosen account, currency, timezone and exact asset identity; O(1), no I/O. */
function bindingMatches(required: z.infer<typeof inputSchema>): boolean {
  const { campaign, target, resolved } = required;
  return target.accountId === resolved.accountId && resolved.creativeAccountId === resolved.accountId
    && target.dailyBudget.currency === resolved.currency && resolved.bid.currency === resolved.currency
    && campaign.schedule.timezone === resolved.timezone && campaign.creativeIds[0] === resolved.creativeId && campaign.creativeDigest === resolved.creativeDigest;
}
/** BigInt multiplication prevents rounded micro amounts; unsupported currency/exponent denies. O(1). */
function convertMoney(required: { daily: number; bid: number; currency: string; exponent: number }): Outcome<{ daily: number; bid: number }> {
  if (!Object.hasOwn(bidMaximum, required.currency)) return failure({ code: "not_implemented" });
  const exponent = new Intl.NumberFormat("en", { style: "currency", currency: required.currency }).resolvedOptions().maximumFractionDigits;
  if (exponent !== required.exponent) return failure({ code: "invalid_input" });
  const scale = 10n ** BigInt(6 - required.exponent);
  const daily = BigInt(required.daily) * scale, bid = BigInt(required.bid) * scale;
  if (daily > BigInt(Number.MAX_SAFE_INTEGER) || bid > BigInt(Number.MAX_SAFE_INTEGER)) return failure({ code: "limit_exceeded" });
  return { ok: true, value: { daily: Number(daily), bid: Number(bid) } };
}

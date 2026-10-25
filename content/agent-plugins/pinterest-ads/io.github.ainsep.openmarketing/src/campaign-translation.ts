import { z } from "zod";
import { digestSchema, epochSchema, idSchema, moneySchema, parseBoundary, timeWindowSchema } from "@open-marketing/contracts";
import type { Money, Outcome, TimeWindow } from "@open-marketing/contracts";
import { vendorId } from "./commands.js";
import { failure } from "./ports.js";
import { boundInput } from "./transport.js";

const name = z.string().min(1).max(255);
const micros = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const countries = z.array(z.string().regex(/^[A-Z]{2}$/)).min(1).max(20).refine(values => new Set(values).size === values.length);
/** Complete frozen traffic plan; literal flags exclude activation, automatic targeting and Performance+.
 * Parent slots are the only fields replaced at dispatch. @example campaignDeploymentPlanSchema.safeParse(plan)
 */
export const campaignDeploymentPlanSchema = z.strictObject({
  accountId: vendorId, currency: z.string().regex(/^[A-Z]{3}$/), timezone: idSchema,
  campaign: z.strictObject({ name, status: z.literal("PAUSED"), objective_type: z.literal("CONSIDERATION"), daily_spend_cap: micros,
    start_time: epochSchema, end_time: epochSchema, is_campaign_budget_optimization: z.literal(true), is_flexible_daily_budgets: z.literal(false), is_automated_campaign: z.literal(false), is_performance_plus: z.literal(false) }),
  adGroup: z.strictObject({ name, status: z.literal("PAUSED"), campaign_id: z.strictObject({ from: z.literal("campaign") }),
    billable_event: z.literal("CLICKTHROUGH"), bid_strategy_type: z.literal("MAX_BID"), bid_in_micro_currency: micros,
    auto_targeting_enabled: z.literal(false), is_creative_optimization: z.literal(false), targeting_spec: z.strictObject({ LOCATION: countries }) }),
  ad: z.strictObject({ name, status: z.literal("PAUSED"), ad_group_id: z.strictObject({ from: z.literal("adGroup") }), creative_type: z.literal("REGULAR"), pin_id: vendorId }),
}).refine(value => value.campaign.start_time < value.campaign.end_time);
/** One campaign, one manual-CPC country-targeted group, one existing-Pin ad. */
export type PinterestPausedPlan = z.infer<typeof campaignDeploymentPlanSchema>;
/** Structural neutral intent; caller resolves scoped account/Pin evidence before freezing the plan. */
export interface CampaignTranslationInput {
  campaign: { name: string; objective: string; schedule: { window: TimeWindow; timezone: string }; audience: { countries: readonly string[]; searchTerms?: readonly string[] }; creativeIds: readonly string[]; creativeDigest: string };
  target: { accountId: string; dailyBudget: Money };
  resolved: unknown;
}
const inputSchema = z.strictObject({
  campaign: z.strictObject({ name, objective: idSchema, schedule: z.strictObject({ window: timeWindowSchema, timezone: idSchema }), audience: z.strictObject({ countries, searchTerms: z.array(idSchema).max(100).optional() }), creativeIds: z.array(idSchema).min(1).max(20), creativeDigest: digestSchema }),
  target: z.strictObject({ accountId: vendorId, dailyBudget: moneySchema }), resolved: z.unknown(),
});
const resolvedSchema = z.strictObject({ accountId: vendorId, currency: z.string().regex(/^[A-Z]{3}$/), currencyExponent: z.number().int().min(0).max(3), timezone: idSchema, creativeId: idSchema, creativeDigest: digestSchema, pinId: vendorId, unitCost: moneySchema });

/** Pure translation; unsupported/unverified evidence returns a typed denial before any I/O.
 * @param required - Neutral traffic intent, selected budget, account/creative binding and manual bid.
 * @returns Exact PAUSED plan or invalid_input/conflict/not_implemented; never rounds money/time.
 * @example translateCampaign({ campaign: parsedLaunch, target, resolved: accountAndPin })
 * @complexity O(c) time/space, c<=20 countries; JSON boundary <=64KiB.
 */
export function translateCampaign(required: CampaignTranslationInput): Outcome<PinterestPausedPlan> {
  const bounded = boundInput({ input: required });
  if (!bounded.ok) return bounded;
  const parsed = parseBoundary({ schema: inputSchema, input: bounded.value });
  if (!parsed.ok) return parsed;
  const { campaign, target } = parsed.value;
  if (campaign.objective !== "traffic" || campaign.creativeIds.length !== 1 || campaign.audience.searchTerms !== undefined) return failure({ code: "not_implemented" });
  const metadata = resolvedSchema.safeParse(parsed.value.resolved);
  if (!metadata.success) return failure({ code: "not_implemented" });
  const resolved = metadata.data;
  if (!bindingMatches({ campaign, target, resolved })) return failure({ code: "conflict" });
  return pausedPlan({ campaign, target, resolved });
}
/** Binding decisions only; account, currency, timezone, creative and bid must be consistent. O(1). */
function bindingMatches(required: { campaign: CampaignTranslationInput["campaign"]; target: CampaignTranslationInput["target"]; resolved: z.infer<typeof resolvedSchema> }): boolean {
  const { campaign, target, resolved } = required;
  return target.accountId === resolved.accountId && target.dailyBudget.currency === resolved.currency && resolved.unitCost.currency === resolved.currency
    && campaign.schedule.timezone === resolved.timezone && campaign.creativeIds[0] === resolved.creativeId && campaign.creativeDigest === resolved.creativeDigest;
}
/** Integer money conversion rejects overflow; timestamps must already be exact Unix seconds. O(c). */
function pausedPlan(required: { campaign: CampaignTranslationInput["campaign"]; target: CampaignTranslationInput["target"]; resolved: z.infer<typeof resolvedSchema> }): Outcome<PinterestPausedPlan> {
  const { campaign, target, resolved } = required;
  const times = campaign.schedule.window;
  if (times.start % 1000 !== 0 || times.end % 1000 !== 0) return failure({ code: "not_implemented" });
  if (new Intl.NumberFormat("en", { style: "currency", currency: resolved.currency }).resolvedOptions().maximumFractionDigits !== resolved.currencyExponent) return failure({ code: "not_implemented" });
  const multiplier = 10n ** BigInt(6 - resolved.currencyExponent);
  const budget = Number(BigInt(target.dailyBudget.minorUnits) * multiplier);
  const bid = Number(BigInt(resolved.unitCost.minorUnits) * multiplier);
  return parseBoundary({ schema: campaignDeploymentPlanSchema, input: {
    accountId: resolved.accountId, currency: resolved.currency, timezone: resolved.timezone,
    campaign: { name: campaign.name, status: "PAUSED", objective_type: "CONSIDERATION", daily_spend_cap: budget, start_time: times.start / 1000, end_time: times.end / 1000,
      is_campaign_budget_optimization: true, is_flexible_daily_budgets: false, is_automated_campaign: false, is_performance_plus: false },
    adGroup: { name: campaign.name, status: "PAUSED", campaign_id: { from: "campaign" }, billable_event: "CLICKTHROUGH", bid_strategy_type: "MAX_BID", bid_in_micro_currency: bid,
      auto_targeting_enabled: false, is_creative_optimization: false, targeting_spec: { LOCATION: campaign.audience.countries } },
    ad: { name: campaign.name, status: "PAUSED", ad_group_id: { from: "adGroup" }, creative_type: "REGULAR", pin_id: resolved.pinId },
  } });
}

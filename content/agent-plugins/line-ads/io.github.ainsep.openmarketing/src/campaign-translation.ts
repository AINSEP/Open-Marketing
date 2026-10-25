import { z } from "zod";
import { moneySchema } from "@open-marketing/contracts";
import type { Money, Outcome, TimeWindow } from "@open-marketing/contracts";
import { campaignDeploymentPlanSchema, deploymentMetadataSchema, imageCreativeSchema } from "./commands.js";
import type { LineAdsPausedPlan } from "./commands.js";
import { failure } from "./transport.js";

/** Canonical parsed neutral subset; account/asset/declaration resolution belongs to the host. */
export interface CampaignTranslationInput {
  campaign: { name: string; objective: string; schedule: { window: TimeWindow; timezone: string }; audience: { countries: readonly string[]; searchTerms?: readonly string[] }; creativeIds: readonly string[]; creativeDigest: string };
  target: { accountId: string; dailyBudget: Money };
  resolved: unknown;
}
const resolvedSchema = deploymentMetadataSchema.extend({ bid: moneySchema, creative: imageCreativeSchema, generatedByAi: z.boolean().optional() });

/** Translate one country-only traffic campaign and existing image without I/O or activation.
 * @param required - Parsed neutral intent, target and host-resolved account/image/bid/declaration.
 * @returns A frozen-shape PAUSED plan or typed unsupported/conflict/invalid_input failure.
 * @example translateCampaign({ campaign, target, resolved: accountAndImage })
 * @complexity O(b) bounded metadata validation and constant-size currency/date conversion.
 */
export function translateCampaign(required: CampaignTranslationInput): Outcome<LineAdsPausedPlan> {
  const { campaign, target } = required;
  if (campaign.objective !== "traffic" || campaign.creativeIds.length !== 1 || campaign.audience.countries.length !== 1 || campaign.audience.searchTerms !== undefined) return failure({ code: "not_implemented" });
  const parsed = resolvedSchema.safeParse(required.resolved);
  if (!parsed.success) return failure({ code: "not_implemented" });
  const { bid, creative, generatedByAi, ...metadata } = parsed.data;
  if (!bindingsMatch({ campaign, target, resolved: parsed.data })) return failure({ code: "conflict" });
  const dates = schedule({ window: campaign.schedule.window, timezone: metadata.timezone });
  if (!dates.ok) return dates;
  const dailyBudgetMicro = micros({ money: target.dailyBudget, exponent: metadata.currencyExponent });
  const bidAmountMicro = micros({ money: bid, exponent: metadata.currencyExponent });
  if (!dailyBudgetMicro.ok) return dailyBudgetMicro;
  if (!bidAmountMicro.ok) return bidAmountMicro;
  const plan = campaignDeploymentPlanSchema.safeParse({ metadata,
    campaign: { name: campaign.name, campaignObjective: "VISIT_MY_WEBSITE", configuredStatus: "PAUSED", spendingLimitType: "NONE", activeCbo: false, ...dates.value },
    adgroup: { name: campaign.name, campaignId: { from: "campaign" }, configuredStatus: "PAUSED", bidType: "CPC", autoBidType: "MANUAL", dailyBudgetMicro: dailyBudgetMicro.value, bidAmountMicro: bidAmountMicro.value, targeting: { country: metadata.country, targetingMode: "MANUAL" } },
    ad: { name: campaign.name, adgroupId: { from: "adgroup" }, configuredStatus: "PAUSED", creative, ...(generatedByAi !== undefined ? { generatedByAi } : {}) },
  });
  return plan.success ? { ok: true, value: plan.data } : failure({ code: "invalid_input" });
}
/** Pure account/country/creative and monetary binding; rejects widening before plan construction. */
function bindingsMatch(required: { campaign: CampaignTranslationInput["campaign"]; target: CampaignTranslationInput["target"]; resolved: z.infer<typeof resolvedSchema> }): boolean {
  const { campaign, target, resolved } = required;
  return target.accountId === resolved.accountId && target.dailyBudget.currency === resolved.currency && campaign.schedule.timezone === resolved.timezone && campaign.audience.countries[0] === resolved.country
    && campaign.creativeIds[0] === resolved.creativeId && campaign.creativeDigest === resolved.creativeDigest && resolved.bid.currency === resolved.currency;
}
/** Reject invalid money, exponent mismatch and overflow instead of rounding micros. O(1), pure. */
function micros(required: { money: Money; exponent: number }): Outcome<number> {
  const parsed = moneySchema.safeParse(required.money);
  if (!parsed.success) return failure({ code: "invalid_input" });
  const exponent = new Intl.NumberFormat("en", { style: "currency", currency: parsed.data.currency }).resolvedOptions().maximumFractionDigits;
  const value = parsed.data.minorUnits * 10 ** (6 - required.exponent);
  if (exponent !== required.exponent || value <= 0 || !Number.isSafeInteger(value)) return failure({ code: "invalid_input" });
  return { ok: true, value };
}
/** Account-local ISO seconds with explicit offset; no hidden time read or precision loss. O(1). */
function schedule(required: { window: TimeWindow; timezone: string }): Outcome<{ startDate: string; endDate: string }> {
  const times = [required.window.start, required.window.end];
  if (!times.every(time => Number.isSafeInteger(time) && time % 1000 === 0 && time >= 946684800000 && time < 4102444800000)) return failure({ code: "not_implemented" });
  const offsetHours = required.timezone === "Asia/Taipei" ? 8 : 7;
  const dates = times.map(time => new Date(time + offsetHours * 3600000).toISOString().slice(0, 19) + "+0" + offsetHours + ":00");
  return { ok: true, value: { startDate: dates[0], endDate: dates[1] } };
}

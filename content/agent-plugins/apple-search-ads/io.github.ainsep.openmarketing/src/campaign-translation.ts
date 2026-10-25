import { z } from "zod";
import { digestSchema, idSchema, moneySchema as minorMoney, timeWindowSchema } from "@open-marketing/contracts";
import type { Money, Outcome } from "@open-marketing/contracts";
import { failure, moneySchema, vendorIdSchema } from "./commands.js";

const numericId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const resolvedId = vendorIdSchema.refine(value => Number.isSafeInteger(Number(value)));
const name = z.string().trim().min(1).max(200);
const countries = z.array(z.string().regex(/^[A-Z]{2}$/)).min(1).max(20).refine(values => new Set(values).size === values.length);
const positiveMoney = minorMoney.refine(value => value.minorUnits > 0);
const decimalMoney = z.strictObject(moneySchema.shape).refine(value => /[1-9]/.test(value.amount));
const schedule = { startTime: z.iso.datetime({ precision: 3 }), endTime: z.iso.datetime({ precision: 3 }) };
const paused = { status: z.literal("PAUSED") };
/** Fixed search-results/manual-CPT payloads; only the two named parent slots are substituted. */
export const campaignBodySchema = z.strictObject({ name, adAccountId: numericId, promotedObjectType: z.literal("APPSTORE_APP"), promotedObjectId: resolvedId,
  dailyBudget: z.strictObject({ value: decimalMoney }), ...schedule, ...paused, billingEvent: z.literal("TAPS"),
  targeting: z.strictObject({ countryOrRegion: z.strictObject({ include: countries }), supplySource: z.strictObject({ include: z.tuple([z.literal("APPSTORE")]) }),
    supplyPlacement: z.strictObject({ include: z.tuple([z.literal("APPSTORE_SEARCH_RESULTS")]) }) }),
  bidStrategy: z.strictObject({ bidStrategyType: z.literal("MANUAL_CPT"), bidStrategyGoal: z.literal("TAP") }) });
export const adgroupBodySchema = z.strictObject({ name, ...schedule, ...paused, automatedKeywordsOptIn: z.literal(true), pricingModel: z.literal("CPT"),
  bidStrategy: z.strictObject({ bidStrategyType: z.literal("MANUAL_CPT"), bidStrategyGoal: z.literal("TAP"), bid: decimalMoney }) });
export const adBodySchema = z.strictObject({ name, creativeId: numericId, ...paused });
/** Frozen approval data includes OM creative provenance and every Apple creation field. */
export const campaignDeploymentPlanSchema = z.strictObject({ creative: z.strictObject({ id: idSchema, digest: digestSchema }),
  campaign: campaignBodySchema, adgroup: adgroupBodySchema.extend({ campaignId: z.strictObject({ from: z.literal("campaign") }) }),
  ad: adBodySchema.extend({ adgroupId: z.strictObject({ from: z.literal("adgroup") }) }),
}).refine(validPlan);
export type AppleSearchAdsPlan = z.infer<typeof campaignDeploymentPlanSchema>;
const campaignInput = z.object({ name, objective: z.string(), schedule: z.strictObject({ window: timeWindowSchema.refine(value => value.end <= 8640000000000000), timezone: z.string() }),
  audience: z.strictObject({ countries, searchTerms: z.array(z.string()).optional() }), creativeIds: z.array(idSchema).length(1), creativeDigest: digestSchema });
const targetInput = z.object({ pluginId: z.literal("apple-search-ads"), accountId: vendorIdSchema, dailyBudget: positiveMoney });
const resolvedSchema = z.strictObject({ accountId: resolvedId, adamId: resolvedId, appleCreativeId: resolvedId, creativeId: idSchema,
  creativeDigest: digestSchema, currency: z.string().regex(/^[A-Z]{3}$/), currencyExponent: z.number().int().min(0).max(3), timezone: z.literal("UTC"), bid: positiveMoney });
/** Existing install subset only; launch-objective integration remains outside this plugin. */
export interface AppleSearchAdsTranslationInput { campaign: z.input<typeof campaignInput>; target: z.input<typeof targetInput>; resolved: unknown }

/** Translate one App Store install intent without I/O; traffic/search terms are unsupported.
 * @param required - Neutral intent, selected account budget and strictly resolved app/creative/bid.
 * @returns Frozen PAUSED plan or typed unsupported/conflict/invalid input, with no partial plan.
 * @example translateCampaign({ campaign, target, resolved: { accountId, adamId, appleCreativeId, creativeId, creativeDigest, currency, currencyExponent, timezone: "UTC", bid } })
 * @complexity O(b+c) time/space, b<=64KiB and c<=20 countries. No clock or effects.
 */
export function translateCampaign(required: AppleSearchAdsTranslationInput): Outcome<AppleSearchAdsPlan> {
  const frozen = snapshot({ input: required });
  if (!frozen.ok) return frozen;
  const parsed = z.strictObject({ campaign: campaignInput, target: targetInput, resolved: resolvedSchema }).safeParse(frozen.value);
  if (!parsed.success) return failure({ code: "not_implemented" });
  const { campaign, target, resolved } = parsed.data;
  if (campaign.objective !== "app_install" || campaign.audience.searchTerms !== undefined) return failure({ code: "not_implemented" });
  if (target.accountId !== resolved.accountId || target.dailyBudget.currency !== resolved.currency || resolved.bid.currency !== resolved.currency) return failure({ code: "conflict" });
  if (campaign.schedule.timezone !== resolved.timezone || campaign.creativeIds[0] !== resolved.creativeId || campaign.creativeDigest !== resolved.creativeDigest) return failure({ code: "conflict" });
  if (new Intl.NumberFormat("en", { style: "currency", currency: resolved.currency }).resolvedOptions().maximumFractionDigits !== resolved.currencyExponent) return failure({ code: "invalid_input" });
  const times = { startTime: new Date(campaign.schedule.window.start).toISOString(), endTime: new Date(campaign.schedule.window.end).toISOString() };
  const plan = campaignDeploymentPlanSchema.safeParse({ creative: { id: resolved.creativeId, digest: resolved.creativeDigest },
    campaign: { name: campaign.name, adAccountId: Number(resolved.accountId), promotedObjectType: "APPSTORE_APP", promotedObjectId: resolved.adamId,
      dailyBudget: { value: formatMoney({ money: target.dailyBudget, exponent: resolved.currencyExponent }) }, ...times, status: "PAUSED", billingEvent: "TAPS",
      targeting: { countryOrRegion: { include: campaign.audience.countries }, supplySource: { include: ["APPSTORE"] }, supplyPlacement: { include: ["APPSTORE_SEARCH_RESULTS"] } },
      bidStrategy: { bidStrategyType: "MANUAL_CPT", bidStrategyGoal: "TAP" } },
    adgroup: { name: campaign.name, ...times, status: "PAUSED", automatedKeywordsOptIn: true, pricingModel: "CPT",
      bidStrategy: { bidStrategyType: "MANUAL_CPT", bidStrategyGoal: "TAP", bid: formatMoney({ money: resolved.bid, exponent: resolved.currencyExponent }) }, campaignId: { from: "campaign" } },
    ad: { name: campaign.name, creativeId: Number(resolved.appleCreativeId), status: "PAUSED", adgroupId: { from: "adgroup" } },
  });
  return plan.success ? { ok: true, value: plan.data } : failure({ code: "not_implemented" });
}

/** Snapshot before awaits or parsing; cyclic/oversized input rejects without effects. O(b), b<=64KiB. */
export function snapshot(required: { input: unknown }): Outcome<unknown> {
  try {
    const json = JSON.stringify(required.input);
    if (Buffer.byteLength(json) > 65536) return failure({ code: "limit_exceeded" });
    return { ok: true, value: JSON.parse(json) as unknown };
  } catch { return failure({ code: "invalid_input" }); }
}

/** Align bounded decimals to a common scale; malformed refinement input yields -1, never throws. O(64). */
export function decimalUnits(required: { amount: string }): bigint {
  if (required.amount.length > 64 || !/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(required.amount)) return -1n;
  const [whole, fraction = ""] = required.amount.split(".");
  return BigInt(whole + fraction.padEnd(64, "0"));
}

/** Cross-parent budget, currency and UTC schedule invariants precede any dispatch. O(1). */
function validPlan(value: { campaign: z.infer<typeof campaignBodySchema>; adgroup: z.infer<typeof adgroupBodySchema> }): boolean {
  const { campaign, adgroup } = value;
  if (campaign.dailyBudget.value.currency !== adgroup.bidStrategy.bid.currency) return false;
  if (campaign.startTime >= campaign.endTime || campaign.startTime !== adgroup.startTime || campaign.endTime !== adgroup.endTime) return false;
  return decimalUnits({ amount: campaign.dailyBudget.value.amount }) >= decimalUnits({ amount: adgroup.bidStrategy.bid.amount });
}

/** Exact minor-unit formatting, including exponent zero. O(d), d<=16 digits. */
function formatMoney(required: { money: Money; exponent: number }): { amount: string; currency: string } {
  const digits = String(required.money.minorUnits).padStart(required.exponent + 1, "0");
  return { amount: required.exponent === 0 ? digits : digits.slice(0, -required.exponent) + "." + digits.slice(-required.exponent), currency: required.money.currency };
}

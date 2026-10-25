import { z } from "zod";
import { digestSchema, idSchema, moneySchema, timeWindowSchema } from "@open-marketing/contracts";
import type { Outcome } from "@open-marketing/contracts";
import { failure, loginSchema, vendorId } from "./commands.js";

const name = z.string().min(1).max(255).refine(value => value === value.trim());
const date = z.iso.date();
const regions = z.array(z.number().int().positive().max(Number.MAX_SAFE_INTEGER)).min(1).max(20).refine(items => new Set(items).size === items.length);
const copy = (required: { length: number; word: number }) => z.string().min(1).max(required.length).refine(value => value === value.trim() && value.split(/\s+/).every(word => word.length <= required.word) && !/[#\r\n]/.test(value));
const responsive = z.strictObject({ Titles: z.tuple([copy({ length: 56, word: 22 })]), Texts: z.tuple([copy({ length: 81, word: 23 })]), Href: z.url({ protocol: /^https?$/ }).max(1024).refine(value => {
  // Zod can continue refinements after URL validation fails.
  if (!URL.canParse(value) || /[{}#]/.test(value)) return false;
  const url = new URL(value);
  return !url.username && !url.password;
}) });
const campaign = z.strictObject({ Name: name, StartDate: date, EndDate: date, TimeZone: z.literal("Europe/Moscow"), UnifiedCampaign: z.strictObject({ BiddingStrategy: z.strictObject({
  Search: z.strictObject({ BiddingStrategyType: z.literal("WB_MAXIMUM_CLICKS"), WbMaximumClicks: z.strictObject({ WeeklySpendLimit: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }) }),
  Network: z.strictObject({ BiddingStrategyType: z.literal("SERVING_OFF") }),
}) }) }).refine(value => value.StartDate < value.EndDate);
/** Exact card payload: one DRAFT hierarchy, bound identity/currency and fixed parent slots.
 * Status is read-only in Yandex.add; never send a fabricated Status field or moderate/resume.
 * Dates here follow Campaigns.add's UTC+3 midnight API boundaries, not the UI date picker. */
export const campaignDeploymentPlanSchema = z.strictObject({
  accountId: vendorId, clientLogin: loginSchema, currency: z.string().regex(/^[A-Z]{3}$/), desiredStatus: z.literal("DRAFT"),
  campaign, group: z.strictObject({ Name: name, CampaignId: z.strictObject({ from: z.literal("campaign") }), RegionIds: regions, UnifiedAdGroup: z.strictObject({ OfferRetargeting: z.literal("NO") }) }),
  ad: z.strictObject({ AdGroupId: z.strictObject({ from: z.literal("group") }), ResponsiveAd: responsive }),
});
/** Frozen, bounded provider plan; host owns approval and durable operation identity. */
export type YandexDraftPlan = z.infer<typeof campaignDeploymentPlanSchema>;
const inputSchema = z.strictObject({
  campaign: z.object({ name, objective: z.literal("traffic"), schedule: z.strictObject({ window: timeWindowSchema, timezone: z.literal("Europe/Moscow") }),
    audience: z.strictObject({ countries: z.array(z.string().regex(/^[A-Z]{2}$/)).min(1).max(20) }), creativeIds: z.tuple([idSchema]), creativeDigest: digestSchema }),
  target: z.strictObject({ accountId: vendorId, weeklyBudget: moneySchema.refine(value => value.minorUnits > 0) }),
  resolved: z.strictObject({ accountId: vendorId, clientLogin: loginSchema, currency: z.string().regex(/^[A-Z]{3}$/), currencyExponent: z.number().int().min(0).max(3),
    creativeId: idSchema, creativeDigest: digestSchema, responsiveAd: responsive,
    locations: z.array(z.strictObject({ country: z.string().regex(/^[A-Z]{2}$/), regionId: regions.element })).min(1).max(20) }),
});
/** Structural neutral intent input; weekly cadence is mandatory, daily input is unsupported. */
export type CampaignTranslationInput = { campaign: unknown; target: unknown; resolved: unknown };

/** Pure translation; unsupported intent, cadence or schedule returns no partial plan.
 * @param required - Neutral traffic intent plus scoped, resolved login/currency/creative/regions.
 * @returns Exact bounded card plan or typed failure; no credentials or network.
 * @complexity O(c log c) time/O(c) space, c<=20 countries; integer micros only.
 */
export function translateCampaign(required: CampaignTranslationInput): Outcome<YandexDraftPlan> {
  const parsed = inputSchema.safeParse(required);
  if (!parsed.success) return failure({ code: "not_implemented" });
  const { campaign: intent, target, resolved } = parsed.data;
  const binding = checkBinding(parsed.data);
  if (!binding.ok) return binding;
  const { start, end } = intent.schedule.window;
  if (!midnight({ epoch: start }) || !midnight({ epoch: end })) return failure({ code: "not_implemented" });
  const micros = BigInt(target.weeklyBudget.minorUnits) * 10n ** BigInt(6 - resolved.currencyExponent);
  if (micros > BigInt(Number.MAX_SAFE_INTEGER)) return failure({ code: "limit_exceeded" });
  const plan = campaignDeploymentPlanSchema.safeParse({ accountId: resolved.accountId, clientLogin: resolved.clientLogin, currency: resolved.currency, desiredStatus: "DRAFT",
    campaign: { Name: intent.name, StartDate: calendarDate({ epoch: start }), EndDate: calendarDate({ epoch: end }), TimeZone: intent.schedule.timezone,
      UnifiedCampaign: { BiddingStrategy: { Search: { BiddingStrategyType: "WB_MAXIMUM_CLICKS", WbMaximumClicks: { WeeklySpendLimit: Number(micros) } }, Network: { BiddingStrategyType: "SERVING_OFF" } } } },
    group: { Name: intent.name, CampaignId: { from: "campaign" }, RegionIds: resolved.locations.map(item => item.regionId).sort((a, b) => a - b), UnifiedAdGroup: { OfferRetargeting: "NO" } },
    ad: { AdGroupId: { from: "group" }, ResponsiveAd: resolved.responsiveAd },
  });
  return plan.success ? { ok: true, value: plan.data } : failure({ code: "invalid_input" });
}
/** Reject duplicate/extra country mappings and cross-account/creative/currency substitutions. O(c log c). */
function checkBinding(required: z.infer<typeof inputSchema>): Outcome<void> {
  const { campaign: intent, target, resolved } = required;
  if (target.accountId !== resolved.accountId || target.weeklyBudget.currency !== resolved.currency) return failure({ code: "conflict" });
  if (intent.creativeIds[0] !== resolved.creativeId || intent.creativeDigest !== resolved.creativeDigest) return failure({ code: "conflict" });
  const countries = intent.audience.countries.slice().sort();
  if (new Set(countries).size !== countries.length || JSON.stringify(countries) !== JSON.stringify(resolved.locations.map(item => item.country).sort())) return failure({ code: "invalid_input" });
  const exponent = new Intl.NumberFormat("en", { style: "currency", currency: resolved.currency }).resolvedOptions().maximumFractionDigits;
  return resolved.currencyExponent === exponent ? { ok: true, value: undefined } : failure({ code: "invalid_input" });
}
function midnight(required: { epoch: number }): boolean { return required.epoch < 253402290000000 && (required.epoch + 10800000) % 86400000 === 0; }
function calendarDate(required: { epoch: number }): string { return new Date(required.epoch + 10800000).toISOString().slice(0, 10); }

/** Pure translation of one traffic intent into the complete, reviewable paused Search plan. */
import { z } from "zod";
import { digestSchema, idSchema, moneySchema, timeWindowSchema } from "@open-marketing/contracts";
import type { Outcome } from "@open-marketing/contracts";
import { vendorIdSchema } from "./commands.js";
import { failure } from "./ports.js";

const name = z.string().trim().min(1).max(128);
const amount = z.number().positive().finite().max(1000000000);
const date = z.strictObject({ Year: z.number().int().min(2020).max(2049), Month: z.number().int().min(1).max(12), Day: z.number().int().min(1).max(31) });
const language = z.enum(["Danish", "Dutch", "English", "Finnish", "French", "German", "Italian", "Norwegian", "Portuguese", "Spanish", "Swedish"]);
// Only these documented city/timezone pairs are resolved in v1; other mappings stay unsupported.
const zones = { "America/Los_Angeles": "PacificTimeUSCanadaTijuana", "America/New_York": "EasternTimeUSCanada", "Europe/London": "GreenwichMeanTimeDublinEdinburghLisbonLondon", "Asia/Tokyo": "OsakaSapporoTokyo" } as const;
const timezone = z.enum(["America/Los_Angeles", "America/New_York", "Europe/London", "Asia/Tokyo"]);
const text = z.string().trim().min(1).regex(/^[\x20-\x7e]+$/).refine(value => !/[{}]/.test(value));
const asset = z.strictObject({ Asset: z.strictObject({ Type: z.literal("TextAsset"), Text: text.max(90) }) });
const ad = z.strictObject({ Type: z.literal("ResponsiveSearch"), Status: z.literal("Paused"), FinalUrls: z.array(z.url().max(2048).refine(value => { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password; })).length(1),
  Headlines: z.array(asset.extend({ Asset: asset.shape.Asset.extend({ Text: text.max(30) }) })).min(3).max(15).refine(items => new Set(items.map(item => item.Asset.Text)).size === items.length), Descriptions: z.array(asset).min(2).max(4) });
const campaign = z.strictObject({ Name: name, CampaignType: z.literal("Search"), Status: z.literal("Paused"), BudgetType: z.literal("DailyBudgetStandard"), DailyBudget: amount,
  TimeZone: z.enum(Object.values(zones)), BiddingScheme: z.strictObject({ Type: z.literal("MaxClicks"), MaxCpc: z.strictObject({ Amount: amount }) }) });
const group = z.strictObject({ Name: name, Status: z.literal("Paused"), AdGroupType: z.literal("SearchStandard"), Language: language, Network: z.literal("OwnedAndOperatedOnly"), StartDate: date, EndDate: date });
const keyword = z.strictObject({ Text: text.max(80).refine(value => value.split(/\s+/).length <= 10), MatchType: z.literal("Exact"), Status: z.literal("Paused") });
/** Closed finite plan: parent IDs are substituted only from saved acknowledgements. */
export const campaignDeploymentPlanSchema = z.strictObject({ accountId: vendorIdSchema, currency: z.string().regex(/^[A-Z]{3}$/), timezone,
  campaign, locationIntent: z.literal("PeopleIn"), locations: z.array(z.strictObject({ country: z.string().regex(/^[A-Z]{2}$/), id: vendorIdSchema })).min(1).max(20),
  adGroup: group, keywords: z.array(keyword).min(1).max(100), ad,
}).refine(value => value.campaign.TimeZone === zones[value.timezone])
  .refine(value => validDates({ start: value.adGroup.StartDate, end: value.adGroup.EndDate }))
  .refine(value => new Set(value.locations.map(item => item.country)).size === value.locations.length && new Set(value.locations.map(item => item.id)).size === value.locations.length)
  .refine(value => new Set(value.keywords.map(item => item.Text.toLowerCase())).size === value.keywords.length);
export type MicrosoftPausedPlan = z.infer<typeof campaignDeploymentPlanSchema>;
const inputSchema = z.object({ campaign: z.object({ name, objective: z.literal("traffic"), schedule: z.object({ window: timeWindowSchema.refine(value => value.start >= Date.UTC(2020, 0) && value.end < Date.UTC(2050, 0)), timezone }), audience: z.strictObject({ countries: z.array(z.string().regex(/^[A-Z]{2}$/)).min(1).max(20).refine(values => new Set(values).size === values.length), searchTerms: z.array(keyword.shape.Text).min(1).max(100) }), creativeIds: z.array(idSchema).length(1), creativeDigest: digestSchema }),
  target: z.object({ accountId: vendorIdSchema, dailyBudget: moneySchema }), resolved: z.strictObject({ accountId: vendorIdSchema, currency: z.string().regex(/^[A-Z]{3}$/), currencyExponent: z.number().int().min(0).max(3), timezone,
    creativeId: idSchema, creativeDigest: digestSchema, language, maxCpc: moneySchema, locations: campaignDeploymentPlanSchema.shape.locations, ad: ad.omit({ Status: true, Type: true }) }) });
export type CampaignTranslationInput = z.input<typeof inputSchema>;

/** Freeze every mutation's fields before the host's ONE grouped approval card.
 * @param required - Neutral intent, target and server-resolved account, country and creative evidence.
 * @returns Complete paused plan or unsupported/conflict; no effects. @complexity O(n), <=100 keywords/20 countries.
 * @example translateCampaign({ campaign: intent, target, resolved: metadata })
 */
export function translateCampaign(required: CampaignTranslationInput): Outcome<MicrosoftPausedPlan> {
  const bounded = boundInput({ input: required });
  if (!bounded.ok) return bounded;
  const parsed = inputSchema.safeParse(bounded.value);
  if (!parsed.success) return failure({ code: "not_implemented" });
  const { campaign: intent, target, resolved } = parsed.data;
  const binding = translationBinding({ input: parsed.data });
  if (!binding.ok) return binding;
  const start = localDate({ epoch: intent.schedule.window.start, timezone: resolved.timezone });
  const end = localDate({ epoch: intent.schedule.window.end, timezone: resolved.timezone });
  if (start.hour !== "00" || end.hour !== "00" || intent.schedule.window.start % 60000 !== 0 || intent.schedule.window.end % 60000 !== 0) return failure({ code: "not_implemented" });
  const locations = resolved.locations.filter(item => intent.audience.countries.includes(item.country));
  if (locations.length !== intent.audience.countries.length) return failure({ code: "not_implemented" });
  const plan = campaignDeploymentPlanSchema.safeParse({ accountId: target.accountId, currency: resolved.currency, timezone: resolved.timezone,
    campaign: { Name: intent.name, CampaignType: "Search", Status: "Paused", BudgetType: "DailyBudgetStandard", DailyBudget: target.dailyBudget.minorUnits / 10 ** resolved.currencyExponent, TimeZone: zones[resolved.timezone], BiddingScheme: { Type: "MaxClicks", MaxCpc: { Amount: resolved.maxCpc.minorUnits / 10 ** resolved.currencyExponent } } },
    locations, locationIntent: "PeopleIn", adGroup: { Name: intent.name, Status: "Paused", AdGroupType: "SearchStandard", Language: resolved.language, Network: "OwnedAndOperatedOnly", StartDate: start.date, EndDate: localDate({ epoch: intent.schedule.window.end - 1, timezone: resolved.timezone }).date },
    keywords: intent.audience.searchTerms.map(Text => ({ Text, MatchType: "Exact", Status: "Paused" })), ad: { ...resolved.ad, Status: "Paused", Type: "ResponsiveSearch" } });
  return plan.success ? { ok: true, value: plan.data } : failure({ code: "not_implemented" });
}
/** Compare account/asset identity and currencies before formatting any vendor fields. */
function translationBinding(required: { input: z.infer<typeof inputSchema> }): Outcome<void> {
  const { campaign: intent, target, resolved } = required.input;
  if (target.accountId !== resolved.accountId || target.dailyBudget.currency !== resolved.currency || intent.schedule.timezone !== resolved.timezone) return failure({ code: "conflict" });
  if (intent.creativeIds[0] !== resolved.creativeId || intent.creativeDigest !== resolved.creativeDigest || resolved.maxCpc.currency !== resolved.currency) return failure({ code: "conflict" });
  if (new Intl.NumberFormat("en", { style: "currency", currency: resolved.currency }).resolvedOptions().maximumFractionDigits !== resolved.currencyExponent) return failure({ code: "not_implemented" });
  return { ok: true, value: undefined };
}
/** Snapshot bounded JSON before schema validation/awaits; shared by the three plugin boundaries. */
export function boundInput(required: { input: unknown }): Outcome<unknown> {
  try { const json = JSON.stringify(required.input); if (Buffer.byteLength(json) > 65536) return failure({ code: "limit_exceeded" }); return { ok: true, value: JSON.parse(json) as unknown }; }
  catch { return failure({ code: "invalid_input" }); }
}
/** Intl handles DST; an exclusive midnight end maps to the preceding local calendar date. */
function localDate(required: { epoch: number; timezone: string }): { date: z.infer<typeof date>; hour: string } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: required.timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(required.epoch).map(part => [part.type, part.value]));
  return { date: { Year: Number(parts.year), Month: Number(parts.month), Day: Number(parts.day) }, hour: parts.hour + (parts.minute === "00" ? "" : ":" + parts.minute) };
}
/** Reject normalized impossible dates and reversed windows; supported vendor years end at 2049. */
function validDates(required: { start: z.infer<typeof date>; end: z.infer<typeof date> }): boolean {
  const stamps = [required.start, required.end].map(item => Date.UTC(item.Year, item.Month - 1, item.Day));
  const valid = [required.start, required.end].every((item, index) => new Date(stamps[index]).getUTCMonth() === item.Month - 1);
  return valid && stamps[0] <= stamps[1];
}

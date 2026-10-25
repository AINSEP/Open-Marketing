import { z } from "zod";
import { digestSchema, idSchema, moneySchema, timeWindowSchema } from "@open-marketing/contracts";
import type { Money, Outcome, TimeWindow } from "@open-marketing/contracts";
import { dateSchema } from "./reporting.js";
import { vendorIdSchema } from "./commands.js";
import { failure } from "./ports.js";

const name = z.string().trim().min(1).max(200);
const amount = z.number().positive().max(1000000); // OM payload bound, not a vendor budget/bid limit.
const product = z.discriminatedUnion("type", [z.strictObject({ type: z.literal("seller"), sku: z.string().min(1).max(256) }), z.strictObject({ type: z.literal("vendor"), asin: z.string().regex(/^[A-Z0-9]{10}$/) })]);
/** Explicit vendor calendar dates only. This schema is not an epoch-to-calendar converter.
 * One profile, one product and fixed bids; all mutable fields are frozen in the grouped card.
 */
export const campaignDeploymentPlanSchema = z.strictObject({
  profile: z.strictObject({ accountId: vendorIdSchema, country: z.string().regex(/^[A-Z]{2}$/), currency: z.string().regex(/^[A-Z]{3}$/), timezone: z.string().min(1).max(128) }),
  campaign: z.strictObject({ name, state: z.literal("PAUSED"), targetingType: z.literal("AUTO"), budget: z.strictObject({ budget: amount, budgetType: z.literal("DAILY") }), startDate: dateSchema, endDate: dateSchema, dynamicBidding: z.strictObject({ strategy: z.literal("MANUAL") }) }),
  group: z.strictObject({ name, state: z.literal("PAUSED"), defaultBid: amount, campaignId: z.strictObject({ from: z.literal("campaign") }) }),
  ad: z.strictObject({ state: z.literal("PAUSED"), product, campaignId: z.strictObject({ from: z.literal("campaign") }), adGroupId: z.strictObject({ from: z.literal("group") }) }),
}).refine(validPlan);
export type AmazonDeploymentPlan = z.infer<typeof campaignDeploymentPlanSchema>;
/** Structural subset of the host's neutral intent; no feature-to-feature dependency. */
export interface CampaignTranslationInput {
  campaign: { name: string; objective: string; schedule: { window: TimeWindow; timezone: string }; audience: { countries: readonly string[]; searchTerms?: readonly string[] }; creativeIds: readonly string[]; creativeDigest: string };
  target: { accountId: string; dailyBudget: Money }; resolved: unknown;
}
const resolvedSchema = z.strictObject({ accountId: vendorIdSchema, country: z.string().regex(/^[A-Z]{2}$/), currency: z.string().regex(/^[A-Z]{3}$/), timezone: idSchema, creativeId: idSchema, creativeDigest: digestSchema, product, defaultBid: moneySchema });
const intentSchema = z.object({ name, objective: z.literal("traffic"), schedule: z.strictObject({ window: timeWindowSchema, timezone: idSchema }), audience: z.strictObject({ countries: z.array(z.string().regex(/^[A-Z]{2}$/)).length(1) }), creativeIds: z.array(idSchema).length(1), creativeDigest: digestSchema });

/** Reject invalid timezone/precision rather than round a bid or daily amount. O(1), pure. */
function validPlan(value: { profile: { currency: string; timezone: string }; campaign: { startDate: string; endDate: string; budget: { budget: number } }; group: { defaultBid: number } }): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value.profile.timezone });
    const exponent = new Intl.NumberFormat("en", { style: "currency", currency: value.profile.currency }).resolvedOptions().maximumFractionDigits!;
    return value.campaign.startDate <= value.campaign.endDate && [value.campaign.budget.budget, value.group.defaultBid].every(amount => Number(amount.toFixed(exponent)) === amount);
  } catch { return false; }
}

/** Validate the exact marketplace/product/bid binding without inventing calendar semantics.
 * @returns Typed unavailable until official epoch/calendar boundary evidence is supplied; zero I/O.
 * @example translateCampaign({ campaign, target, resolved })
 * @complexity O(b) time/space, <=64KiB; no credentials or network.
 */
export function translateCampaign(required: CampaignTranslationInput): Outcome<AmazonDeploymentPlan> {
  try {
    if (Buffer.byteLength(JSON.stringify(required)) > 65536) return failure({ code: "limit_exceeded" });
    const campaign = intentSchema.safeParse(required.campaign);
    const resolved = resolvedSchema.safeParse(required.resolved);
    const target = z.object({ accountId: vendorIdSchema, dailyBudget: moneySchema }).safeParse(required.target);
    if (!campaign.success || !resolved.success || !target.success) return failure({ code: "not_implemented" });
    const intent = campaign.data; const metadata = resolved.data;
    const expected = [metadata.accountId, metadata.currency, metadata.timezone, metadata.country, metadata.creativeId, metadata.creativeDigest];
    const actual = [target.data.accountId, target.data.dailyBudget.currency, intent.schedule.timezone, intent.audience.countries[0], intent.creativeIds[0], intent.creativeDigest];
    if (!expected.every((value, index) => value === actual[index])) return failure({ code: "conflict" });
    if (metadata.defaultBid.currency !== metadata.currency || metadata.defaultBid.minorUnits <= 0 || target.data.dailyBudget.minorUnits <= 0) return failure({ code: "invalid_input" });
    return { ok: false, error: { code: "unavailable", message: "Amazon profile timezone and inclusive/exclusive campaign date boundaries are unverified; neutral launch unavailable", retryable: false } };
  } catch { return failure({ code: "invalid_input" }); }
}

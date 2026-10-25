import { z } from "zod";
import { digestSchema, idSchema } from "@open-marketing/contracts";
import type { LineAdsWireRequest } from "./ports.js";

/** Vendor IDs remain exact strings; unsafe numeric response IDs are rejected, never rounded. */
export const vendorIdSchema = z.string().regex(/^[1-9][0-9]{0,18}$/);
const date = z.iso.date().refine(value => value >= "2000-01-01" && value <= "2100-01-01");
const pageFields = { page: z.number().int().min(1).max(10000).default(1), size: z.number().int().min(1).max(100).default(100) };
/** Vendor calendar dates, preserved without claiming UTC or inclusive/exclusive end semantics. */
export const reportCommandSchema = z.strictObject({ kind: z.literal("report"), since: date, until: date, ...pageFields })
  .refine(value => value.until >= value.since && Date.parse(value.until) - Date.parse(value.since) <= 366 * 86400000);
/** Only the three approved reads. Account/group binding belongs to server configuration. */
export const commandSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("list_accounts"), ...pageFields }),
  z.strictObject({ kind: z.literal("list_campaigns"), ...pageFields }),
  reportCommandSchema,
]);
/** Callers may omit pagination; validation supplies one page of at most 100 rows. */
export type LineAdsCommand = z.input<typeof commandSchema>;
/** Parsed command for the private transport; only index.ts is public. */
export type ParsedCommand = z.infer<typeof commandSchema>;
/** Catalog data only; the server routes these through its ONE external-tool policy. */
export const lineAdsTools = commandSchema.options.map(schema => ({ name: schema.shape.kind.value, inputSchema: schema, effect: "read" as const }));

/** Encode only fixed LINE v3 paths; validation and authenticated group resolution precede this.
 * @returns A GET without a body; O(1) bounded string construction, no effects.
 */
export function encodeCommand(required: { command: ParsedCommand; accountId: string | null; groupId: string }): LineAdsWireRequest {
  const { command } = required;
  const suffix = command.kind === "report" ? "/reports/online/campaign" : "/campaigns";
  const path = command.kind === "list_accounts" ? `/groups/${required.groupId}/adaccounts` : `/adaccounts/${required.accountId}${suffix}`;
  const query = new URLSearchParams({ page: String(command.page), size: String(command.size) });
  if (command.kind === "report") { query.set("since", command.since); query.set("until", command.until); }
  return { url: "https://ads.line.me/api/v3" + path + "?" + query.toString(), method: "GET" };
}

/** No regional Management entitlement is verified. Admission cannot override this evidence gap.
 * Fixture tests replace this immutable evidence constant; production has no override option.
 */
export const verifiedDeploymentCountries: readonly string[] = Object.freeze([]);
/** JSON numbers must remain exact on both POST and readback; strings never rescue rounded IDs. */
export const exactInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const deploymentId = vendorIdSchema.refine(value => Number.isSafeInteger(Number(value)));
const name = z.string().min(1).max(120);
const timestamp = z.iso.datetime({ offset: true, precision: 0 }).refine(value => value >= "2000" && value < "2100");
/** Small consumed IMAGE subset; no tracking URL, upload, action-code lookup or other format. */
export const imageCreativeSchema = z.strictObject({ creativeFormat: z.literal("IMAGE"), title: z.string().min(1).max(20), description: z.string().min(1).max(75),
  imageHash: z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/), callToAction: z.strictObject({ landingPageUrl: z.url({ protocol: /^https?$/ }).max(2048) }) });
/** Frozen resolved account/asset metadata participates in the owning grouped card's digest. */
export const deploymentMetadataSchema = z.strictObject({ accountId: deploymentId, country: z.enum(["TW", "TH"]), currency: z.string().regex(/^[A-Z]{3}$/),
  currencyExponent: z.number().int().min(0).max(3), timezone: z.enum(["Asia/Taipei", "Asia/Bangkok"]), creativeId: idSchema, creativeDigest: digestSchema, imageAccountId: deploymentId });
/** Complete fixed POST schemas; only the two acknowledged parent slots are substituted. */
export const pausedCampaignSchema = z.strictObject({ name, campaignObjective: z.literal("VISIT_MY_WEBSITE"), configuredStatus: z.literal("PAUSED"),
  spendingLimitType: z.literal("NONE"), activeCbo: z.literal(false), startDate: timestamp, endDate: timestamp });
export const pausedAdgroupSchema = z.strictObject({ name, campaignId: exactInteger, configuredStatus: z.literal("PAUSED"), bidType: z.literal("CPC"),
  autoBidType: z.literal("MANUAL"), bidAmountMicro: exactInteger, dailyBudgetMicro: exactInteger, targeting: z.strictObject({ country: z.enum(["TW", "TH"]), targetingMode: z.literal("MANUAL") }) });
export const pausedAdSchema = z.strictObject({ name, adgroupId: exactInteger, configuredStatus: z.literal("PAUSED"), creative: imageCreativeSchema, generatedByAi: z.boolean().optional() });
/** One finite daily traffic plan; daily budget is not a guaranteed billing ceiling. */
export const campaignDeploymentPlanSchema = z.strictObject({ metadata: deploymentMetadataSchema, campaign: pausedCampaignSchema,
  adgroup: pausedAdgroupSchema.extend({ campaignId: z.strictObject({ from: z.literal("campaign") }) }),
  ad: pausedAdSchema.extend({ adgroupId: z.strictObject({ from: z.literal("adgroup") }) }),
}).refine(value => value.metadata.accountId === value.metadata.imageAccountId && value.metadata.country === value.adgroup.targeting.country)
  .refine(value => value.metadata.currency === (value.metadata.country === "TW" ? "TWD" : "THB") && value.metadata.currencyExponent === 2)
  .refine(value => value.metadata.timezone === (value.metadata.country === "TW" ? "Asia/Taipei" : "Asia/Bangkok"))
  .refine(value => [value.campaign.startDate, value.campaign.endDate].every(date => date.endsWith(value.metadata.country === "TW" ? "+08:00" : "+07:00")))
  .refine(value => value.metadata.country !== "TW" || value.ad.generatedByAi !== undefined)
  .refine(value => value.campaign.name === value.adgroup.name && value.campaign.name === value.ad.name)
  .refine(value => Date.parse(value.campaign.startDate) < Date.parse(value.campaign.endDate));
/** Fixed PAUSED deployment plan; consumers import it through index.ts. */
export type LineAdsPausedPlan = z.infer<typeof campaignDeploymentPlanSchema>;

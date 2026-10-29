import { z } from "zod";
import { decimalToMicros, metricMappingSchema } from "@open-marketing/contracts";
import type { CampaignStatusOutput, MetricBatch, Outcome, ReportMetricsInput } from "@open-marketing/contracts";
import { campaignIdSchema } from "./commands.js";
import type { ParsedCommand } from "./commands.js";

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
// SummaryStatResponse / SummaryStatMap, selected by ids + allDays. Strip unconsumed fields.
const responseSchema = z.object({ data: z.array(z.object({ id: campaignIdSchema, impCnt: count, clkCnt: count, salesAmt: count })).max(1) });
/** Source-labelled, unsummed KRW stats. Dates retain the vendor's KST labels without schedule conversion. */
export interface NaverReport {
  readonly source: "naver_search_ads_stats";
  readonly accountId: string;
  readonly currency: "KRW";
  readonly timezone: "Asia/Seoul";
  readonly vatIncluded: true;
  readonly since: string;
  readonly until: string;
  readonly retrievedAt: number;
  readonly availability: "reported" | "no_data_access_unconfirmed";
  readonly rows: readonly { campaignId: string; impressions: number; clicks: number; spend: number }[];
}
/** Validate the complete documented summary before returning any metric; foreign/duplicate IDs reject.
 * @param required - Bounded tainted response, validated command, server customer and injected retrieval time.
 * @returns Report or protocol_mismatch; no I/O, summation, FX or invented zero rows.
 * @example decodeReport({ input: { data: [] }, command, accountId: "123", retrievedAt: 1791849600000 })
 * @complexity O(b) time/space for b<=1MiB; at most one campaign row.
 */
export function decodeReport(required: { input: unknown; command: Extract<ParsedCommand, { kind: "report" }>; accountId: string; retrievedAt: number }): Outcome<NaverReport> {
  const parsed = responseSchema.safeParse(required.input);
  if (!parsed.success || !Number.isSafeInteger(required.retrievedAt) || required.retrievedAt < 0) return invalid();
  if (parsed.data.data.some(row => row.id !== required.command.campaignId)) return invalid();
  const rows = parsed.data.data.map(row => ({ campaignId: row.id, impressions: row.impCnt, clicks: row.clkCnt, spend: row.salesAmt }));
  return { ok: true, value: { source: "naver_search_ads_stats", accountId: required.accountId, currency: "KRW", timezone: "Asia/Seoul", vatIncluded: true, since: required.command.since, until: required.command.until, retrievedAt: required.retrievedAt, availability: rows.length ? "reported" : "no_data_access_unconfirmed", rows } };
}
function invalid(): Outcome<never> { return { ok: false, error: { code: "protocol_mismatch", message: "Naver stats response invalid", retryable: false } }; }

const mappedMetrics = {
  spend: { vendorField: "salesAmt", meaning: "VAT-inclusive cost in KRW major units, converted exactly to micros (1 won = 1,000,000 micros)." },
  impressions: { vendorField: "impCnt", meaning: "Vendor impression count." },
  clicks: { vendorField: "clkCnt", meaning: "Vendor click count, not unique visitors." },
  vendorConversions: { vendorField: "ccnt", meaning: "Vendor Conversion Count, expressed in millionths. Uses the account's Naver conversion configuration; attribution windows and cross-device treatment are unverified. Not OM verified leads or purchase-only conversions." },
};
/** Only documented entity grains; no account summation or purchase-only conversion-value proxy. */
export const metricMapping = metricMappingSchema.parse({ pluginId: "naver-ads", version: "20261026-daily-1", grains: { campaign: mappedMetrics, ad_group: mappedMetrics, ad: mappedMetrics } });
const integerText = z.string().regex(/^(0|[1-9]\d{0,37})$/);
const entityId = z.string().regex(/^(?:cmp|grp|nad)-[A-Za-z0-9-]{1,120}$/);
const customer = z.union([z.number().int().positive().max(Number.MAX_SAFE_INTEGER).transform(String), z.string().regex(/^[1-9]\d{0,18}$/)]);
const observationSchema = z.object({ customerId: customer, nccCampaignId: campaignIdSchema.optional(),
  nccAdgroupId: z.string().regex(/^grp-[A-Za-z0-9-]{1,120}$/).optional(), nccAdId: z.string().regex(/^nad-[A-Za-z0-9-]{1,120}$/).optional(),
  status: z.string().min(1).max(100).optional(), statusReason: z.string().min(1).max(100).optional(),
  inspectStatus: z.string().min(1).max(100).optional(), userLock: z.boolean().optional() });
type Entity = MetricBatch["rows"][number]["entity"];
/** Internal projection retains only validated identity and status evidence. */
export type EntityObservation = { entity: Entity; id: string; wire: z.infer<typeof observationSchema> };

/** Parse whole entity pages and verify customer/parent identity before releasing any row.
 * O(n) time/space, at most 100 campaigns/groups or 5,000 ads; no effects.
 */
export function decodeEntities(required: { input: unknown; grain: "campaign" | "ad_group" | "ad"; accountId: string; parent?: Entity }): Outcome<EntityObservation[]> {
  const parsed = z.array(observationSchema).max(required.grain === "ad" ? 5000 : 100).safeParse(required.input);
  if (!parsed.success) return invalid();
  const rows: EntityObservation[] = [];
  for (const wire of parsed.data) {
    if (wire.customerId !== required.accountId) return invalid();
    const entity = entityIdentity({ wire, grain: required.grain, parent: required.parent });
    if (!entity.ok) return entity;
    rows.push({ entity: entity.value.entity, id: entity.value.id, wire });
  }
  if (new Set(rows.map(row => row.id)).size !== rows.length) return invalid();
  return { ok: true, value: rows };
}
/** Parent IDs come from exhausted, customer-scoped discovery, never from the metric response. */
function entityIdentity(required: { wire: z.infer<typeof observationSchema>; grain: "campaign" | "ad_group" | "ad"; parent?: Entity }): Outcome<{ id: string; entity: Entity }> {
  const { wire, parent } = required;
  switch (required.grain) {
    case "campaign":
      if (!wire.nccCampaignId) return invalid();
      return { ok: true, value: { id: wire.nccCampaignId, entity: { grain: "campaign", vendorCampaignId: wire.nccCampaignId } } };
    case "ad_group":
      if (parent?.grain !== "campaign" || wire.nccCampaignId !== parent.vendorCampaignId || !wire.nccAdgroupId) return invalid();
      return { ok: true, value: { id: wire.nccAdgroupId, entity: { grain: "ad_group", vendorCampaignId: parent.vendorCampaignId, vendorAdGroupId: wire.nccAdgroupId } } };
    case "ad":
      return adIdentity({ wire, parent });
    default: { const exhaustive: never = required.grain; return exhaustive; }
  }
}
function adIdentity({ wire, parent }: { wire: z.infer<typeof observationSchema>; parent?: Entity }): Outcome<{ id: string; entity: Entity }> {
  if (parent?.grain !== "ad_group" || wire.nccAdgroupId !== parent.vendorAdGroupId || !wire.nccAdId) return invalid();
  if (wire.nccCampaignId !== undefined && wire.nccCampaignId !== parent.vendorCampaignId) return invalid();
  return { ok: true, value: { id: wire.nccAdId, entity: { ...parent, grain: "ad", vendorAdId: wire.nccAdId } } };
}

const dailyRow = z.object({ id: entityId.optional(), dateStart: z.iso.date(), dateEnd: z.iso.date(),
  salesAmt: integerText.nullish(), impCnt: integerText.nullish(), clkCnt: integerText.nullish(), ccnt: integerText.nullish() });
const dailyResponse = z.object({ data: z.array(dailyRow).max(366), summary: z.object({ dateStart: z.iso.date(), dateEnd: z.iso.date() }), cycleBaseTm: z.string().max(32).optional() });
/** Decode the selected DailyStatResponse (not the Swagger union wrapper). Date labels are KST.
 * Exact text tokens must come from parseExactIntegerJson. Reject duplicates, foreign IDs and
 * summary/out-of-window mismatches atomically; absent supported metrics become null, never zero.
 * O(n) time/space for <=366 daily rows. No I/O or summation.
 */
export function decodeDailyMetrics(required: { input: unknown; observation: EntityObservation; days: ReportMetricsInput["days"] }): Outcome<MetricBatch["rows"]> {
  const parsed = dailyResponse.safeParse(required.input);
  if (!parsed.success) return invalid();
  const summary = parsed.data.summary;
  if (summary.dateStart !== required.days.start || summary.dateEnd !== inclusiveEnd({ days: required.days })) return invalid();
  const rows: MetricBatch["rows"] = [];
  for (const item of parsed.data.data) {
    const decoded = dailyMetricRow({ item, observation: required.observation, days: required.days });
    if (!decoded.ok) return decoded;
    rows.push(decoded.value);
  }
  if (new Set(rows.map(row => row.day)).size !== rows.length) return invalid();
  return { ok: true, value: rows };
}
/** Translate OM's exclusive end to the vendor's inclusive calendar end, without timezone shifting. */
export function inclusiveEnd({ days }: { days: ReportMetricsInput["days"] }): string { return new Date(Date.parse(days.end) - 86400000).toISOString().slice(0, 10); }
function dailyMetricRow(required: { item: z.infer<typeof dailyRow>; observation: EntityObservation; days: ReportMetricsInput["days"] }): Outcome<MetricBatch["rows"][number]> {
  const { item, observation, days } = required;
  if (item.id !== undefined && item.id !== observation.id) return invalid();
  if (item.dateStart !== item.dateEnd || item.dateStart < days.start || item.dateStart >= days.end) return invalid();
  const spend = micros({ value: item.salesAmt });
  const conversions = micros({ value: item.ccnt });
  if (!spend.ok) return spend;
  if (!conversions.ok) return conversions;
  return { ok: true, value: { day: item.dateStart, entity: observation.entity, metrics: { spend: spend.value, impressions: item.impCnt ?? null, clicks: item.clkCnt ?? null, vendorConversions: conversions.value } } };
}
function micros({ value }: { value: string | null | undefined }): Outcome<string | null> {
  if (value == null) return { ok: true, value: null };
  const scaled = decimalToMicros({ value, rounding: "reject" });
  return scaled.ok ? scaled : invalid();
}
const rejectionCodes = new Set(["BUSINESS_CHANNEL_DISAPPROVED", "PC_BUSINESS_CHANNEL_DISAPPROVED", "MOBILE_BUSINESS_CHANNEL_DISAPPROVED", "KEYWORD_DISAPPROVED", "KEYWORD_DENIED", "AD_DISAPPROVED", "AD_EXTENSION_DISAPPROVED", "ASSET_DISAPPROVED"]);
/** Bounded documented codes retain child identity. Unknown vendor codes are not reviewer prose. */
export function disapprovalDescriptions({ observations }: { observations: EntityObservation[] }): string[] {
  const descriptions = observations.flatMap(item => {
    const codes: string[] = [];
    if (item.wire.statusReason && rejectionCodes.has(item.wire.statusReason)) codes.push(item.wire.statusReason);
    if (item.wire.inspectStatus === "DENIED") codes.push("DENIED");
    return codes.map(code => item.id + ": " + code);
  });
  return [...new Set(descriptions)].slice(0, 20);
}
/** Campaign eligibility alone is not creative approval. Positive delivery needs complete child
 * review evidence; partial/missing review remains unknown. Pause/end remain direct observations.
 */
export function projectCampaignStatus(required: { campaign: EntityObservation; children: EntityObservation[]; complete: boolean }): CampaignStatusOutput["campaigns"][number] {
  const campaign = required.campaign;
  const descriptions = disapprovalDescriptions({ observations: [campaign, ...required.children] });
  return { vendorCampaignId: campaign.id, status: naverCampaignState({ ...required, descriptions }), disapprovalDescriptions: descriptions };
}
function naverCampaignState(required: { campaign: EntityObservation; children: EntityObservation[]; complete: boolean; descriptions: string[] }): CampaignStatusOutput["campaigns"][number]["status"] {
  const wire = required.campaign.wire;
  if (wire.status === "DELETED" || wire.statusReason === "CAMPAIGN_ENDED") return "ended";
  if (required.descriptions.length > 0) return "disapproved";
  if (wire.statusReason === "CAMPAIGN_PENDING") return "pending";
  if (wire.status === "PAUSED" || wire.userLock === true) return "paused";
  if (!required.complete || wire.status !== "ELIGIBLE" || wire.statusReason !== undefined) return "unknown";
  return reviewedDeliveryState({ children: required.children });
}
function reviewedDeliveryState(required: { children: EntityObservation[] }): CampaignStatusOutput["campaigns"][number]["status"] {
  const ads = required.children.filter(item => item.entity.grain === "ad");
  if (ads.length === 0) return "unknown";
  if (ads.some(item => item.wire.inspectStatus === "UNDER_REVIEW" || item.wire.inspectStatus === "PENDING")) return "pending";
  if (!required.children.every(item => deliverableChild({ item }))) return "unknown";
  return ads.every(item => ["APPROVED", "ELIGIBLE"].includes(item.wire.inspectStatus ?? "")) ? "active" : "unknown";
}
function deliverableChild({ item }: { item: EntityObservation }): boolean {
  return item.wire.status === "ELIGIBLE" && (item.wire.statusReason === undefined || item.wire.statusReason === "ELIGIBLE");
}

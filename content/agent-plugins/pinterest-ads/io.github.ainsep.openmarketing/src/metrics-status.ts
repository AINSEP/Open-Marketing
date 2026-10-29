import { z } from "zod";
import { callContextSchema, serviceContextSchema, idSchema, metricBatchSchema, metricMappingSchema, decimalToMicros } from "@open-marketing/contracts";
import type { CampaignStatusOutput, MetricBatch, Outcome } from "@open-marketing/contracts";
import { vendorId } from "./commands.js";
import { failure } from "./ports.js";

export const context = z.union([callContextSchema, serviceContextSchema]);
export const envelope = z.strictObject({ context, connection: z.strictObject({ connectionId: idSchema, accountId: vendorId }), input: z.unknown() });
const integer = z.string().regex(/^(0|[1-9]\d{0,37})$/);
const conversions = z.string().regex(/^\d{1,30}(\.\d{1,6})?$/);
const row = z.object({ DATE: z.iso.date(), AD_ACCOUNT_ID: vendorId, SPEND_IN_MICRO_DOLLAR: integer.nullish(), TOTAL_IMPRESSION: integer.nullish(), TOTAL_CLICKTHROUGH: integer.nullish(), TOTAL_CONVERSIONS: conversions.nullish() });
export const account = z.object({ id: vendorId, currency: z.string().regex(/^[A-Z]{3}$/), time_zone: z.string().max(100) });
export const campaign = z.object({ id: vendorId, ad_account_id: vendorId, status: z.enum(["ACTIVE", "PAUSED", "ARCHIVED", "DRAFT", "DELETED_DRAFT"]), summary_status: z.string().max(100).nullish() });
const ad = z.object({ id: vendorId, ad_account_id: vendorId, campaign_id: vendorId, review_status: z.string().max(100), rejected_reasons: z.array(z.string().min(1).max(400)).max(20).nullish(), rejection_labels: z.array(z.string().min(1).max(400)).max(20).nullish() });
const mapping = metricMappingSchema.parse({ pluginId: "pinterest-ads", version: "pinterest-v5-2026-10-26", grains: { account: {
  spend: { vendorField: "SPEND_IN_MICRO_DOLLAR", meaning: "Advertiser currency micros, including JPY/KRW; no currency exponent conversion" },
  impressions: { vendorField: "TOTAL_IMPRESSION", meaning: "Vendor-reported total impressions" },
  clicks: { vendorField: "TOTAL_CLICKTHROUGH", meaning: "Pin clicks, not outbound destination clicks" },
  vendorConversions: { vendorField: "TOTAL_CONVERSIONS", meaning: "All vendor conversion events; 30-day click/engagement, 1-day view; time of ad action; millionths" },
} } });

/** Whole-batch projection; complete response coverage is distinct from unknown stale/provisional watermark, never retrieval time.
 * End-boundary overfetch is filtered; any other foreign/out-of-window row rejects. O(r), r<=5,000. */
export function projectMetrics(required: { input: unknown; connection: { connectionId: string; accountId: string }; days: MetricBatch["days"]; currency: string; retrievedAt: number }): Outcome<MetricBatch> {
  const parsed = z.array(row).max(5000).safeParse(required.input);
  if (!parsed.success) return failure({ code: "protocol_mismatch" });
  if (parsed.data.some(item => item.AD_ACCOUNT_ID !== required.connection.accountId || item.DATE < required.days.start || item.DATE > required.days.end)) return failure({ code: "protocol_mismatch" });
  const rows: MetricBatch["rows"] = [];
  for (const item of parsed.data.filter(item => item.DATE < required.days.end)) {
    const converted = item.TOTAL_CONVERSIONS == null ? { ok: true as const, value: null } : decimalToMicros({ value: item.TOTAL_CONVERSIONS, rounding: "reject" });
    if (!converted.ok) return failure({ code: "protocol_mismatch" });
    rows.push({ day: item.DATE, entity: { grain: "account" }, metrics: {
      spend: item.SPEND_IN_MICRO_DOLLAR ?? null, impressions: item.TOTAL_IMPRESSION ?? null, clicks: item.TOTAL_CLICKTHROUGH ?? null, vendorConversions: converted.value,
    } });
  }
  const output = metricBatchSchema.safeParse({ schema: "report.metrics.v1", pluginId: "pinterest-ads", ...required.connection, currency: required.currency, timezone: "UTC", grain: "account", days: required.days, mapping,
    retrievedAt: required.retrievedAt, dataThrough: 0, complete: true, freshness: "stale", finality: "provisional", restated: false, rows });
  return output.success ? { ok: true, value: output.data } : failure({ code: "protocol_mismatch" });
}
/** Validate the owned child page and bounded reasons atomically. O(a), a<=100 ads. */
export function projectStatus(required: { input: unknown; item: z.infer<typeof campaign>; accountId: string; id: string }): Outcome<{ campaign: CampaignStatusOutput["campaigns"][number]; complete: boolean }> {
  const page = z.object({ items: z.array(ad).max(100), bookmark: z.string().min(1).max(2048).nullish() }).safeParse(required.input);
  if (!page.success) return failure({ code: "protocol_mismatch" });
  const items = page.data.items;
  if (items.some(item => item.ad_account_id !== required.accountId || item.campaign_id !== required.id)) return failure({ code: "forbidden" });
  if (new Set(items.map(item => item.id)).size !== items.length) return failure({ code: "protocol_mismatch" });
  const reasons = items.filter(item => item.review_status === "REJECTED").flatMap(item => [...(item.rejected_reasons ?? []), ...(item.rejection_labels ?? [])].map(reason => "Ad " + item.id + ": " + reason));
  if (reasons.length > 20) return failure({ code: "limit_exceeded" });
  return { ok: true, value: { campaign: { vendorCampaignId: required.id, status: effectiveStatus({ item: required.item }), disapprovalDescriptions: reasons }, complete: !page.data.bookmark } };
}

/** Effective summary wins; future/disabled states stay unknown instead of inferring serving. */
function effectiveStatus(required: { item: z.infer<typeof campaign> }): CampaignStatusOutput["campaigns"][number]["status"] {
  const summary: Record<string, CampaignStatusOutput["campaigns"][number]["status"]> = { RUNNING: "active", PAUSED: "paused", NOT_STARTED: "pending", DRAFT: "pending", COMPLETED: "ended", ARCHIVED: "ended", DELETED_DRAFT: "ended" };
  if (required.item.summary_status != null) return Object.hasOwn(summary, required.item.summary_status) ? summary[required.item.summary_status] : "unknown";
  const configured = { ACTIVE: "unknown", PAUSED: "paused", ARCHIVED: "ended", DRAFT: "pending", DELETED_DRAFT: "ended" } as const;
  return configured[required.item.status];
}

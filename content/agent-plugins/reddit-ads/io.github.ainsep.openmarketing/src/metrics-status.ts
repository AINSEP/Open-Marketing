import { z } from "zod";
import { callContextSchema, serviceContextSchema, idSchema, metricBatchSchema, metricMappingSchema } from "@open-marketing/contracts";
import type { AppError, CampaignStatusOutput, MetricBatch, Outcome } from "@open-marketing/contracts";
import { accountIdSchema } from "./commands.js";

export const context = z.union([callContextSchema, serviceContextSchema]);
export const envelope = z.strictObject({ context, connection: z.strictObject({ connectionId: idSchema, accountId: accountIdSchema }), input: z.unknown() });
export const vendorId = z.string().regex(/^\d{1,128}$/);
const campaign = z.object({ id: vendorId, account_id: accountIdSchema, configured_status: z.string().max(100).nullish(), effective_status: z.string().max(100).nullish() });
const statuses: Record<string, CampaignStatusOutput["campaigns"][number]["status"]> = { ACTIVE: "active", PAUSED: "paused", CAMPAIGN_PAUSED: "paused", ARCHIVED: "ended", COMPLETED: "ended", DELETED: "ended", PENDING_APPROVAL: "pending", REJECTED: "disapproved" };

function failure(required: { code: AppError["code"] }): Outcome<never> {
  return { ok: false, error: { code: required.code, message: "Reddit capability " + required.code, retryable: false } };
}

/** Pure v3 effective-state projection, rejecting foreign account/campaign IDs. O(1). */
export function projectStatus(required: { input: unknown; id: string; accountId: string }): Outcome<CampaignStatusOutput["campaigns"][number]> {
  const parsed = z.object({ data: campaign }).safeParse(required.input);
  if (!parsed.success) return failure({ code: "protocol_mismatch" });
  if (parsed.data.data.id !== required.id || parsed.data.data.account_id !== required.accountId) return failure({ code: "forbidden" });
  return { ok: true, value: { vendorCampaignId: required.id, status: Object.hasOwn(statuses, parsed.data.data.effective_status ?? "") ? statuses[parsed.data.data.effective_status!] : "unknown", disapprovalDescriptions: [] } };
}

const integer = z.string().regex(/^(0|[1-9]\d{0,37})$/).nullish();
const dailyRow = z.object({
  account_id: accountIdSchema.nullish(), campaign_id: vendorId.nullish(),
  date: z.string().min(10).max(100).transform(value => value.slice(0, 10)).pipe(z.iso.date()),
  currency: z.string().regex(/^[A-Z]{3}$/).nullish(), spend: integer, impressions: integer, clicks: integer,
});
const dailyReport = z.object({ metrics: z.array(dailyRow).max(5000) });
const fields = {
  spend: { vendorField: "spend", meaning: "Account-currency micros" },
  impressions: { vendorField: "impressions", meaning: "Vendor-reported impressions" },
  clicks: { vendorField: "clicks", meaning: "Vendor-reported clicks" },
};
const mapping = metricMappingSchema.parse({ pluginId: "reddit-ads", version: "reddit-v3-daily-2026-10-26", grains: { account: fields, campaign: fields } });

/** Validate the entire bounded report before projecting UTC days. End-boundary overfetch is
 * discarded; foreign, duplicate or malformed rows fail atomically. O(r), r<=5,000; no effects.
 * Coverage watermarks remain unknown even for an unpaged response. */
export function projectMetrics(required: { input: unknown; connection: { connectionId: string; accountId: string }; grain: "account" | "campaign"; days: MetricBatch["days"]; currency: string; retrievedAt: number; complete: boolean }): Outcome<MetricBatch> {
  const parsed = dailyReport.safeParse(required.input);
  if (!parsed.success) return failure({ code: "protocol_mismatch" });
  const rows: MetricBatch["rows"] = [];
  const identities = new Set<string>();
  for (const item of parsed.data.metrics) {
    const projected = projectDailyRow({ item, ...required });
    if (!projected.ok) return projected;
    const key = JSON.stringify([item.date, projected.value.entity]);
    if (identities.has(key)) return failure({ code: "protocol_mismatch" });
    identities.add(key);
    if (item.date < required.days.end) rows.push(projected.value);
  }
  const output = metricBatchSchema.safeParse({ schema: "report.metrics.v1", pluginId: "reddit-ads", ...required.connection,
    currency: required.currency, timezone: "UTC", grain: required.grain, days: required.days, mapping,
    retrievedAt: required.retrievedAt, dataThrough: 0, complete: required.complete, freshness: "stale", finality: "provisional", restated: false, rows });
  return output.success ? { ok: true, value: output.data } : failure({ code: "protocol_mismatch" });
}

/** Endpoint-scoped report rows may omit account_id; explicit identities must agree.
 * Validate even the exclusive-end overfetch before dropping it. O(1), no effects. */
function projectDailyRow(required: { item: z.infer<typeof dailyRow>; connection: { accountId: string }; grain: "account" | "campaign"; days: MetricBatch["days"]; currency: string }): Outcome<MetricBatch["rows"][number]> {
  const { item } = required;
  const identity = validateDailyIdentity(required);
  if (!identity.ok) return identity;
  if (item.date < required.days.start || item.date > required.days.end) return failure({ code: "protocol_mismatch" });
  return { ok: true, value: { day: item.date,
    entity: required.grain === "account" ? { grain: "account" } : { grain: "campaign", vendorCampaignId: item.campaign_id! },
    metrics: { spend: item.spend ?? null, impressions: item.impressions ?? null, clicks: item.clicks ?? null } } };
}

/** Validate optional report account facts and the requested grain. O(1), no effects. */
function validateDailyIdentity(required: { item: z.infer<typeof dailyRow>; connection: { accountId: string }; grain: "account" | "campaign"; currency: string }): Outcome<void> {
  const { item } = required;
  if (item.account_id != null && item.account_id !== required.connection.accountId) return failure({ code: "forbidden" });
  if (item.currency != null && item.currency !== required.currency) return failure({ code: "protocol_mismatch" });
  if (required.grain === "campaign" && item.campaign_id == null) return failure({ code: "protocol_mismatch" });
  return { ok: true, value: undefined };
}

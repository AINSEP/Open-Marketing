import { z } from "zod";
import { idSchema, parseBoundary } from "@open-marketing/contracts";
import { serviceContextSchema, failure, sameScope } from "../src/rules.js";
import type { CallContext, IdPort, ServiceContext } from "@open-marketing/contracts";
import type { ConversionIdentifiersPort, LeadOutcomeInput, MeasureGrant, ResolvedConversionInput, CacQuery, ConversionInput, PlatformMetricSnapshot, VerifiedConversionSource } from "../index.js";
import type { MemoryConsentEvidence } from "../index.js";
import type { MetricBatch } from "@open-marketing/contracts";
import type { MetricSyncRequest, VerifiedLeadCountsPort } from "../index.js";
export const scope = { ownerId: "owner", workspaceId: "workspace" };
export const context: CallContext = { scope, principal: { kind: "service", serviceId: "measure" }, correlationId: "correlation", traceId: "trace" };
export const serviceContext: ServiceContext = { scope, serviceId: "measure-worker", correlationId: "correlation", traceId: "trace" };
export const source: VerifiedConversionSource = { sourceId: "signup-api", scope, authenticationRevision: 1, context };
export const event: ConversionInput = { eventId: "signup-1", definitionId: "signup", subjectId: "subject-1", occurredAt: 100, destination: "account:google", purpose: "conversion_measurement", identifierDigests: { click_id: "a".repeat(64) } };
export const query: CacQuery = { definitionId: "signup", accountId: "account-1", attributionWindow: "30d_click", window: { start: 100, end: 200 }, currency: "USD", timezone: "America/Los_Angeles", attributionModel: "last_touch_v1" };
export const snapshot: PlatformMetricSnapshot = { snapshotId: "snapshot-1", accountId: "account-1", window: query.window, spend: { minorUnits: 600, currency: "USD" }, timezone: query.timezone, attributionWindow: "30d_click", retrievedAt: 300 };
export const grant: MeasureGrant = { kind: "measurement", grantId: "grant-1", scope, connectionId: "connection-1", accountId: "account-1", definitionIds: ["signup", "trial"], destination: event.destination, purpose: event.purpose, payloadSchema: "om.conversion", payloadVersion: 1, expiresAt: 1000, revoked: false };
export const leadOutcomes: readonly (LeadOutcomeInput["event"] & Pick<ConversionInput, "eventId">)[] = [
  { ...event, eventId: "lead-1:qualified", definitionId: "qualified" },
  { ...event, eventId: "lead-1:won", definitionId: "won", occurredAt: 200 },
];
export const leadOutcomeGrant: MeasureGrant = { ...grant, definitionIds: ["qualified", "won"] };
export const consent: MemoryConsentEvidence = { scope, subjectId: event.subjectId, destination: event.destination, purpose: event.purpose, identifierKeys: ["click_id"], expiresAt: 1000, withdrawn: false };
/** IDs are injected and deterministic; no system clock or randomness in fixtures. */
export function createIds(required: { prefix?: string }): IdPort {
  let sequence = 0;
  return { next() { return (required.prefix ?? "id") + "-" + ++sequence; } };
}

export const resolvedEvent: ResolvedConversionInput = { ...event, identifiers: { click_id: "click-1" } };
const lookupInputSchema = z.strictObject({ context: serviceContextSchema, subjectId: idSchema, destination: idSchema, purpose: idSchema });
/** Scoped contacts lookup double; replace(null) models erasure without changing evidence.
 * Contacts' normalization/hash behavior is deliberately outside this fixture. */
export function createIdentifiers(required: { event?: ResolvedConversionInput }): ConversionIdentifiersPort & { replace(required: { event: ResolvedConversionInput | null }): void } {
  let current: ResolvedConversionInput | null = structuredClone(required.event ?? resolvedEvent);
  return {
    replace(input) { current = structuredClone(input.event); },
    async identifiersFor(input) {
      const parsed = parseBoundary({ schema: lookupInputSchema, input });
      if (!parsed.ok) return parsed;
      const value = parsed.value;
      if (!current || !sameScope({ left: scope, right: value.context.scope }) || current.subjectId !== value.subjectId || current.destination !== value.destination || current.purpose !== value.purpose) return failure({ code: "forbidden", message: "Current identifiers unavailable" });
      return { ok: true, value: structuredClone({ subjectId: current.subjectId, identifiers: current.identifiers, identifierDigests: current.identifierDigests }) };
    },
  };
}

/** Fixed account-day evidence; micros deliberately exceed Number.MAX_SAFE_INTEGER. */
export const metricsNow = Date.parse("2026-10-04T00:00:00Z");
export const metricsBatch: MetricBatch = {
  schema: "report.metrics.v1", pluginId: "ads", connectionId: "connection-1", accountId: "account-1", currency: "USD", timezone: "America/Los_Angeles", grain: "campaign",
  days: { start: "2026-10-01", end: "2026-10-03" }, retrievedAt: metricsNow - 1000, dataThrough: metricsNow - 2000, complete: true, freshness: "fresh", finality: "provisional", restated: false,
  mapping: { pluginId: "ads", version: "v1", grains: { campaign: { spend: { vendorField: "cost", meaning: "account currency micros" }, impressions: { vendorField: "impressions", meaning: "served impressions" }, clicks: { vendorField: "clicks", meaning: "all clicks" }, vendorConversions: { vendorField: "conversions", meaning: "30d click conversion millionths" }, vendorConversionValue: { vendorField: "value", meaning: "30d click value micros" } } }, reach: { campaign: { vendorField: "reach", meaning: "unique accounts over the requested period" } } },
  rows: [
    { day: "2026-10-01", entity: { grain: "campaign", vendorCampaignId: "campaign-1" }, metrics: { spend: "9007199254740993", impressions: "10", clicks: "2", vendorConversions: "1000000", vendorConversionValue: "0" } },
    { day: "2026-10-02", entity: { grain: "campaign", vendorCampaignId: "campaign-1" }, metrics: { spend: "7", impressions: "20", clicks: "3", vendorConversions: "0", vendorConversionValue: "0" } },
  ], reach: [{ entity: { grain: "campaign", vendorCampaignId: "campaign-1" }, reach: "9" }],
};
export const metricsQuery = { pluginId: metricsBatch.pluginId, connectionId: metricsBatch.connectionId, accountId: metricsBatch.accountId, days: metricsBatch.days };
export const metricsClock = { now: () => metricsNow };
export const metricsLeads: VerifiedLeadCountsPort = { async cohort() { return { ok: true, value: { counts: [{ campaign: { pluginId: "ads", accountId: "account-1", vendorCampaignId: "campaign-1" }, count: 3 }], unattributed: 2 } }; } };
/** Build the exact sync arguments from one fixture observation. */
export function metricsRequest({ batch = metricsBatch, syncId = "sync-1" }: { batch?: MetricBatch; syncId?: string }): MetricSyncRequest {
  return { syncId, pluginId: batch.pluginId, connectionId: batch.connectionId, accountId: batch.accountId, input: { grain: batch.grain, days: batch.days } };
}

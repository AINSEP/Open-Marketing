import { parseBoundary } from "@open-marketing/contracts";
import type { CallContext, CallOptions, ClockPort, Outcome } from "@open-marketing/contracts";
import type { MeasureRepoPort, PlatformReportingPort } from "../ports.js";
import type { CacQuery, CacReport, PlatformMetricSnapshot } from "../types.js";
import { failure, querySchema, snapshotSchema, summarySchema, validTimezone } from "../rules.js";

/** CAC = one platform spend snapshot / verified OM attribution, never provider totals.
 * Persist snapshots before returning success. Zero denominator is null (undefined CAC).
 * @complexity Adapter-dependent read; O(1) core arithmetic. */
export async function reportCac(required: { context: CallContext; query: CacQuery; repo: MeasureRepoPort; reports: PlatformReportingPort; clock: ClockPort }, optional?: CallOptions): Promise<Outcome<CacReport>> {
  const query = parseBoundary({ schema: querySchema, input: required.query });
  if (!query.ok) return query;
  if (!validTimezone({ timezone: query.value.timezone })) return failure({ code: "invalid_input", message: "Invalid reporting timezone" });
  if (!required.repo.readAttribution) return failure({ code: "not_implemented", message: "OM attribution reader is required" });
  const observation = await required.reports.snapshot({ context: required.context, query: query.value }, optional);
  if (!observation.ok) return observation;
  const snapshot = validateSnapshot({ snapshot: observation.value, query: query.value, now: required.clock.now({}) });
  if (!snapshot.ok) return snapshot;
  const attributed = await required.repo.readAttribution({ context: required.context, query: query.value }, optional);
  if (!attributed.ok) return attributed;
  const summary = parseBoundary({ schema: summarySchema, input: attributed.value });
  if (!summary.ok) return summary;
  if (summary.value.modelVersion !== query.value.attributionModel) return failure({ code: "conflict", message: "Attribution model mismatch" });
  if (summary.value.watermark > query.value.window.end) return failure({ code: "invalid_input", message: "Invalid attribution watermark" });
  const persisted = await required.repo.appendSnapshot({ context: required.context, snapshot: snapshot.value }, optional);
  if (!persisted.ok) return persisted;
  const conversions = summary.value.conversions;
  return { ok: true, value: { spendSource: "platform_report", conversionSource: "om_attribution", spend: snapshot.value.spend, conversions, cacMinorUnits: conversions === 0 ? null : snapshot.value.spend.minorUnits / conversions, modelVersion: summary.value.modelVersion, retrievedAt: snapshot.value.retrievedAt, watermark: summary.value.watermark } };
}
/** Exact boundaries avoid silently dividing different currency/timezone/windows. */
function validateSnapshot(required: { snapshot: PlatformMetricSnapshot; query: CacQuery; now: number }): Outcome<PlatformMetricSnapshot> {
  const parsed = parseBoundary({ schema: snapshotSchema, input: required.snapshot });
  if (!parsed.ok) return parsed;
  const snapshot = parsed.value;
  const query = required.query;
  if (snapshot.spend.currency !== query.currency || snapshot.timezone !== query.timezone) return failure({ code: "conflict", message: "Snapshot currency or timezone mismatch" });
  if (snapshot.window.start !== query.window.start || snapshot.window.end !== query.window.end) return failure({ code: "conflict", message: "Snapshot period mismatch" });
  if (snapshot.retrievedAt > required.now) return failure({ code: "invalid_input", message: "Snapshot retrieval is in the future" });
  return parsed;
}

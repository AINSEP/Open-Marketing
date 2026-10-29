/** Scoped native reads, metric mapping and host-approved organic publishing; no approval authority. */
import { metricBatchSchema, parseBoundary } from "@open-marketing/contracts";
import type { CallOptions, ClockPort, MetricBatch, Outcome, PluginCapability, PluginCapabilityDependencies, PluginCapabilitiesFactory } from "@open-marketing/contracts";
import { bindingSchema, dailyMetrics, googleDay, googlePerformanceSchema, locationInputSchema, locationPageSchema, performanceInputSchema, performanceSchema, pluginId, reportInputSchema, reportingContextSchema } from "./schemas.ts";
import type { Binding, BusinessProfilePerformance, Days, GooglePerformance, LocationInput, LocationPage, PerformanceInput, ReportInput, ReportingContext } from "./schemas.ts";
import { failure, readGoogleJson, sameScope } from "./transport.ts";
import type { TransportDependencies } from "./transport.ts";
import { createPublishPost } from "./posts.ts";

export interface GoogleBusinessProfilePlugin {
  /** One account-scoped page, at most 100 locations; typed validation/auth/transport failures. */
  listLocations(required: LocationInput, optional?: CallOptions): Promise<Outcome<LocationPage>>;
  /** One location, <=366 days; missing values are null. Typed boundary failures, no writes. */
  readPerformance(required: PerformanceInput, optional?: CallOptions): Promise<Outcome<BusinessProfilePerformance>>;
  /** Account-grain count report for the selected location; requires its verified timezone. */
  reportMetrics: PluginCapability<"report.metrics.v1">;
}
export type GoogleBusinessProfileDependencies = TransportDependencies & { binding: Binding; clock: ClockPort };

/** Organic publishing only; canonical reporting awaits verified timezone metadata. No I/O.
 * @example createCapabilities({ fetch, credentials, clock, observer, wait, configuration })
 */
export const createCapabilities = ((required: PluginCapabilityDependencies) => ({ "organic.publish.v1": createPublishPost(required) })) satisfies PluginCapabilitiesFactory;

/** Build an inert host-bound plugin. Invalid bindings return typed errors on use.
 * Required dependencies own all I/O; optional call signals can only shorten reads.
 * @complexity O(1) construction; reads are bounded to 100 locations or 366 days.
 * @example const plugin = createGoogleBusinessProfilePlugin({ binding, fetch, credentials, clock, observer, deadline });
 */
export function createGoogleBusinessProfilePlugin(required: GoogleBusinessProfileDependencies): GoogleBusinessProfilePlugin {
  const binding = parseBoundary({ schema: bindingSchema, input: required.binding });
  /** One native read; all report calls use this closure even when invoked detached. */
  async function readPerformance(input: PerformanceInput, optional: CallOptions = {}): Promise<Outcome<BusinessProfilePerformance>> {
    const parsed = parseBoundary({ schema: performanceInputSchema, input });
    if (!parsed.ok) return parsed;
    if (!binding.ok) return binding;
    const raw = await readGoogleJson({ ...required, binding: binding.value, context: parsed.value.context, request: { kind: "performance", days: parsed.value.days } }, optional);
    if (!raw.ok) return raw;
    return normalizePerformance({ raw: raw.value, binding: binding.value, days: parsed.value.days, retrievedAt: required.clock.now({}) });
  }
  return {
    async listLocations(input, optional = {}) {
      const parsed = parseBoundary({ schema: locationInputSchema, input });
      if (!parsed.ok) return parsed;
      if (!binding.ok) return binding;
      const raw = await readGoogleJson({ ...required, binding: binding.value, context: parsed.value.context, request: { kind: "locations", pageToken: parsed.value.pageToken } }, optional);
      if (!raw.ok) return raw;
      return parseBoundary({ schema: locationPageSchema, input: raw.value });
    },
    readPerformance,
    async reportMetrics(input, optional = {}) {
      const parsed = parseBoundary({ schema: reportInputSchema, input });
      if (!parsed.ok) return parsed;
      if (!binding.ok) return binding;
      if (!sameScope({ binding: binding.value, context: parsed.value.context })) return failure({ code: "forbidden", message: "GBP binding scope mismatch" });
      if (!matchesConnection({ binding: binding.value, connection: parsed.value.connection })) return failure({ code: "forbidden", message: "GBP report connection/location mismatch" });
      if (parsed.value.input.grain !== "account") return failure({ code: "invalid_input", message: "GBP supports account grain for one bound location only" });
      if (!binding.value.reportingContext) return failure({ code: "unavailable", message: "Verified GBP timezone is required" });
      const native = await readPerformance({ context: parsed.value.context, days: parsed.value.input.days }, optional);
      if (!native.ok) return native;
      return mapPerformanceToReport({ performance: native.value, reportingContext: binding.value.reportingContext });
    },
  };
}
/** Reject alternate connections/locations before credential access. Constant time/space. */
function matchesConnection({ binding, connection }: { binding: Binding; connection: ReportInput["connection"] }): boolean {
  return connection.connectionId === binding.connectionId && connection.accountId === binding.locationName;
}
type Metric = typeof dailyMetrics[number];
type Series = GooglePerformance["multiDailyMetricTimeSeries"][number]["dailyMetricTimeSeries"][number];
type SeriesIndex = Map<Metric, Map<string, string>>;

/** Parse all vendor data before mapping; duplicate series/points and out-of-window dates fail.
 * O(s*d) time/space, s<=7 and d<=366; no I/O or input mutation.
 */
function normalizePerformance(required: { raw: unknown; binding: Binding; days: Days; retrievedAt: number }): Outcome<BusinessProfilePerformance> {
  const parsed = parseBoundary({ schema: googlePerformanceSchema, input: required.raw });
  if (!parsed.ok) return parsed;
  const index = indexSeries({ response: parsed.value, days: required.days });
  if (!index.ok) return index;
  const dayCount = (Date.parse(required.days.end) - Date.parse(required.days.start)) / 86400000;
  const rows = Array.from({ length: dayCount }, (_, offset) => {
    const day = new Date(Date.parse(required.days.start) + offset * 86400000).toISOString().slice(0, 10);
    return { day, callClicks: index.value.get("CALL_CLICKS")?.get(day) ?? null, websiteClicks: index.value.get("WEBSITE_CLICKS")?.get(day) ?? null, directionRequests: index.value.get("BUSINESS_DIRECTION_REQUESTS")?.get(day) ?? null, views: sumViews({ index: index.value, day }) };
  });
  return parseBoundary({ schema: performanceSchema, input: { connectionId: required.binding.connectionId, locationName: required.binding.locationName, days: required.days, retrievedAt: required.retrievedAt, rows } });
}
/** Index each requested metric once. Reject duplicates instead of merging/double-counting. */
function indexSeries({ response, days }: { response: GooglePerformance; days: Days }): Outcome<SeriesIndex> {
  const index: SeriesIndex = new Map();
  const series = response.multiDailyMetricTimeSeries.flatMap(group => group.dailyMetricTimeSeries);
  for (const item of series) {
    if (index.has(item.dailyMetric)) return failure({ code: "invalid_input", message: "Duplicate GBP metric series" });
    const points = indexPoints({ series: item, days });
    if (!points.ok) return points;
    index.set(item.dailyMetric, points.value);
  }
  return { ok: true, value: index };
}
/** An existing point without value is zero; absent points remain absent. O(d) time/space. */
function indexPoints({ series, days }: { series: Series; days: Days }): Outcome<Map<string, string>> {
  const points = new Map<string, string>();
  for (const point of series.timeSeries.datedValues) {
    const day = googleDay({ date: point.date });
    if (day < days.start || day >= days.end || points.has(day)) return failure({ code: "invalid_input", message: "Duplicate or out-of-window GBP datapoint" });
    points.set(day, point.value ?? "0");
  }
  return { ok: true, value: points };
}
/** Only a full set of four device/surface counts can produce total views. Constant work. */
function sumViews({ index, day }: { index: SeriesIndex; day: string }): string | null {
  const values = dailyMetrics.slice(3).map(metric => index.get(metric)?.get(day));
  if (values.some(value => value === undefined)) return null;
  return values.reduce((sum, value) => sum + BigInt(value!), 0n).toString();
}

/** Pure account-grain projection; the accountId is explicitly the bound location resource.
 * Missing verified metadata fails; absent data remains null, unsupported metrics stay absent.
 * Finality/coverage lag is unverified, so batches are provisional, stale and incomplete.
 * @complexity O(d) time/space, d<=366. No I/O or clock reads.
 * @example mapPerformanceToReport({ performance, reportingContext: { timezone: "UTC" } })
 */
export function mapPerformanceToReport({ performance, reportingContext }: { performance: BusinessProfilePerformance; reportingContext: ReportingContext }): Outcome<MetricBatch> {
  const parsed = parseBoundary({ schema: performanceSchema, input: performance });
  if (!parsed.ok) return parsed;
  const metadata = parseBoundary({ schema: reportingContextSchema, input: reportingContext });
  if (!metadata.ok) return metadata;
  return parseBoundary({ schema: metricBatchSchema, input: {
    schema: "report.metrics.v1", pluginId, connectionId: parsed.value.connectionId, accountId: parsed.value.locationName,
    ...metadata.value, currency: "XXX", dataThrough: 0, grain: "account", days: parsed.value.days, retrievedAt: parsed.value.retrievedAt,
    complete: false, freshness: "stale", finality: "provisional", restated: false,
    mapping: { pluginId, version: "gbp.performance.v1", grains: { account: {
      clicks: { vendorField: "WEBSITE_CLICKS", meaning: "Clicks on the profile's website link; not all profile interactions" },
      impressions: { vendorField: "SUM(BUSINESS_IMPRESSIONS_{DESKTOP,MOBILE}_{MAPS,SEARCH})", meaning: "Profile impressions across four device/surface categories; not deduplicated reach" },
    } } },
    rows: parsed.value.rows.map(row => ({ day: row.day, entity: { grain: "account" }, metrics: { clicks: row.websiteClicks, impressions: row.views } })),
  } });
}

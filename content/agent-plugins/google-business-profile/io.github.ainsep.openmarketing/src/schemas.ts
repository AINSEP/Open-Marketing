/** Bounded GBP wire/native schemas. Data types derive from these schemas. */
import { z } from "zod";
import { callContextSchema, epochSchema, idSchema, reportMetricsInputSchema, scopeSchema, serviceContextSchema } from "@open-marketing/contracts";

export const pluginId = "google-business-profile";
export const dailyMetrics = ["CALL_CLICKS", "WEBSITE_CLICKS", "BUSINESS_DIRECTION_REQUESTS", "BUSINESS_IMPRESSIONS_DESKTOP_MAPS", "BUSINESS_IMPRESSIONS_MOBILE_MAPS", "BUSINESS_IMPRESSIONS_DESKTOP_SEARCH", "BUSINESS_IMPRESSIONS_MOBILE_SEARCH"] as const;
const locationName = z.string().regex(/^locations\/[0-9]{1,30}$/);
const count = z.string().regex(/^(0|[1-9][0-9]{0,18})$/).refine(value => value.length < 19 || value <= "9223372036854775807");
const aggregateCount = z.string().regex(/^(0|[1-9][0-9]{0,20})$/);
export const contextSchema = z.union([callContextSchema, serviceContextSchema]);
/** Half-open calendar dates; OM accepts at most 366 days, subject to vendor availability. */
export const daysSchema = reportMetricsInputSchema.shape.days;
/** Host-verified timezone; count-only reporting has no currency or verified coverage timestamp. */
export const reportingContextSchema = z.strictObject({ timezone: z.string().min(1).max(100).refine(value => validTimezone({ value })) });
export const bindingSchema = z.strictObject({ scope: scopeSchema, connectionId: idSchema, accountName: z.string().regex(/^accounts\/[0-9]{1,30}$/), locationName, reportingContext: reportingContextSchema.optional() });
export const locationInputSchema = z.strictObject({ context: contextSchema, pageToken: z.string().min(1).max(2048).optional() });
export const performanceInputSchema = z.strictObject({ context: contextSchema, days: daysSchema });
export const reportInputSchema = z.strictObject({ context: contextSchema, connection: z.strictObject({ connectionId: idSchema, accountId: locationName }), input: reportMetricsInputSchema });
export const locationPageSchema = z.strictObject({ locations: z.array(z.strictObject({ name: locationName, title: z.string().min(1).max(512) })).max(100).default([]), nextPageToken: z.string().max(2048).optional(), totalSize: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional() });
const rawDateSchema = z.strictObject({ year: z.number().int().min(1).max(9999), month: z.number().int().min(1).max(12), day: z.number().int().min(1).max(31) });
const dateSchema = rawDateSchema.refine(value => z.iso.date().safeParse(googleDay({ date: value })).success);
const seriesSchema = z.strictObject({ dailyMetric: z.enum(dailyMetrics), timeSeries: z.strictObject({ datedValues: z.array(z.strictObject({ date: dateSchema, value: count.optional() })).max(366).default([]) }).default({ datedValues: [] }) });
/** No sub-entity breakdown was requested; unexpected breakdowns/fields fail validation. */
export const googlePerformanceSchema = z.strictObject({ multiDailyMetricTimeSeries: z.array(z.strictObject({ dailyMetricTimeSeries: z.array(seriesSchema).max(7).default([]) })).max(1).default([]) });
export const performanceSchema = z.strictObject({ connectionId: idSchema, locationName, days: daysSchema, retrievedAt: epochSchema, rows: z.array(z.strictObject({ day: z.iso.date(), callClicks: count.nullable(), websiteClicks: count.nullable(), directionRequests: count.nullable(), views: aggregateCount.nullable() })).min(1).max(366) })
  .refine(value => value.rows.length === (Date.parse(value.days.end) - Date.parse(value.days.start)) / 86400000 && new Set(value.rows.map(row => row.day)).size === value.rows.length && value.rows.every(row => row.day >= value.days.start && row.day < value.days.end));
export const requestSchema = z.discriminatedUnion("kind", [z.strictObject({ kind: z.literal("locations"), pageToken: locationInputSchema.shape.pageToken }), z.strictObject({ kind: z.literal("performance"), days: daysSchema })]);
export const credentialSchema = z.strictObject({ accessToken: z.string().min(1).max(8192).regex(/^[\x21-\x7e]+$/) });
export type Binding = z.infer<typeof bindingSchema>;
export type ReportingContext = z.infer<typeof reportingContextSchema>;
export type LocationPage = z.infer<typeof locationPageSchema>;
export type BusinessProfilePerformance = z.infer<typeof performanceSchema>;
export type GooglePerformance = z.infer<typeof googlePerformanceSchema>;
export type GoogleRequest = z.infer<typeof requestSchema>;
export type Context = z.infer<typeof contextSchema>;
export type Days = z.infer<typeof daysSchema>;
export type LocationInput = z.infer<typeof locationInputSchema>;
export type PerformanceInput = z.infer<typeof performanceInputSchema>;
export type ReportInput = z.infer<typeof reportInputSchema>;
export type Credential = z.infer<typeof credentialSchema>;

/** Format an already validated Google calendar date; no clock read. O(1) time/space. */
export function googleDay({ date }: { date: z.infer<typeof rawDateSchema> }): string {
  return `${String(date.year).padStart(4, "0")}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
}
/** Validate host timezone metadata without reading time. Constant bounded work, no effects. */
function validTimezone({ value }: { value: string }): boolean {
  try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; }
  catch { return false; }
}

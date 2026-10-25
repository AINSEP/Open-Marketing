import { z } from "zod";
import { epochSchema, idSchema, moneySchema, parseBoundary } from "../values/index.js";
import type { Outcome } from "../values/index.js";

/** JSON integers: currency micros, conversion millionths, or whole counts; never JS numbers. */
const integer = z.string().regex(/^(0|[1-9]\d{0,37})$/);
const metricName = z.enum(["spend", "impressions", "clicks", "vendorConversions", "vendorConversionValue"]);
export const metricGrainSchema = z.enum(["account", "campaign", "ad_group", "ad"]);
export type MetricGrain = z.infer<typeof metricGrainSchema>;
export const metricValuesSchema = z.strictObject({
  spend: integer.nullable().optional(), impressions: integer.nullable().optional(), clicks: integer.nullable().optional(),
  vendorConversions: integer.nullable().optional(), vendorConversionValue: integer.nullable().optional(),
});
export type MetricValues = z.infer<typeof metricValuesSchema>;
/** Vendor meanings describe click/conversion definitions, including conversion attribution/window. */
const meaning = z.strictObject({ vendorField: z.string().min(1).max(200), meaning: z.string().min(1).max(500) });
export const metricMappingSchema = z.strictObject({
  pluginId: idSchema, version: idSchema,
  grains: z.partialRecord(metricGrainSchema, z.partialRecord(metricName, meaning)).refine(value => Object.keys(value).length > 0),
  reach: z.partialRecord(metricGrainSchema, meaning).optional(),
});
export type MetricMapping = z.infer<typeof metricMappingSchema>;
/** Half-open calendar-day window, at most 366 days. */
export const metricDaysSchema = z.strictObject({ start: z.iso.date(), end: z.iso.date() })
  .refine(value => value.start < value.end && Date.parse(value.end) - Date.parse(value.start) <= 366 * 86400000);
const entity = z.discriminatedUnion("grain", [
  z.strictObject({ grain: z.literal("account") }),
  z.strictObject({ grain: z.literal("campaign"), vendorCampaignId: idSchema }),
  z.strictObject({ grain: z.literal("ad_group"), vendorCampaignId: idSchema, vendorAdGroupId: idSchema }),
  z.strictObject({ grain: z.literal("ad"), vendorCampaignId: idSchema, vendorAdGroupId: idSchema, vendorAdId: idSchema }),
]);
/** One account/grain/period; reach covers this whole period, never individual days. */
const batchShape = z.strictObject({
  schema: z.literal("report.metrics.v1"), pluginId: idSchema, connectionId: idSchema, accountId: idSchema,
  currency: moneySchema.shape.currency, timezone: z.string().min(1).max(100).refine(value => validTimezone({ value })),
  grain: metricGrainSchema, days: metricDaysSchema, mapping: metricMappingSchema,
  retrievedAt: epochSchema, dataThrough: epochSchema, complete: z.boolean(), freshness: z.enum(["fresh", "stale"]),
  finality: z.enum(["provisional", "final"]), restated: z.boolean(),
  rows: z.array(z.strictObject({ day: z.iso.date(), entity, metrics: metricValuesSchema })).max(5000),
  reach: z.array(z.strictObject({ entity, reach: integer.nullable() })).max(5000).optional(),
});
export type MetricBatch = z.infer<typeof batchShape>;
export const metricBatchSchema = batchShape.refine(value => value.pluginId === value.mapping.pluginId && value.dataThrough <= value.retrievedAt)
  .refine(value => validRows({ batch: value }), "Rows must match the declared grain, support and window")
  .refine(value => validReach({ batch: value }), "Reach requires period support and unique entities");

/** Pure batch check; O(n) time/space for at most 5,000 rows, with five metrics per row. */
function validRows({ batch }: { batch: MetricBatch }): boolean {
  const support = batch.mapping.grains[batch.grain];
  if (support === undefined) return false;
  const identities = batch.rows.map(row => JSON.stringify([row.day, row.entity]));
  return new Set(identities).size === identities.length && batch.rows.every(row =>
    row.entity.grain === batch.grain && row.day >= batch.days.start && row.day < batch.days.end &&
    metricName.options.every(key => support[key] === undefined ? !Object.hasOwn(row.metrics, key) : row.metrics[key] !== undefined));
}
/** Pure period check, O(n) time/space; an absent series is allowed even when supported. */
function validReach({ batch }: { batch: MetricBatch }): boolean {
  if (batch.reach === undefined) return true;
  const identities = batch.reach.map(row => JSON.stringify(row.entity));
  return batch.mapping.reach?.[batch.grain] !== undefined && new Set(identities).size === identities.length &&
    batch.reach.every(row => row.entity.grain === batch.grain);
}
/** Validate an IANA timezone without reading the clock. Constant bounded work, no effects. */
function validTimezone({ value }: { value: string }): boolean {
  try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; }
  catch { return false; }
}

export const ratioResultSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("exact"), numerator: z.string().regex(/^(0|[1-9]\d{0,43})$/), denominator: z.string().regex(/^[1-9]\d{0,43}$/) }),
  z.strictObject({ status: z.enum(["unsupported", "unavailable", "zero_denominator"]) }),
]);
export type RatioResult = z.infer<typeof ratioResultSchema>;
const metricRatiosSchema = z.strictObject({
  ctr: ratioResultSchema, cpcMicros: ratioResultSchema, cpmMicros: ratioResultSchema,
  vendorCpaMicros: ratioResultSchema, vendorRoas: ratioResultSchema,
});
export type MetricRatios = z.infer<typeof metricRatiosSchema>;
/** Exact fractions; CTR and ROAS are unit ratios. No rounding or percent conversion.
 * Returns invalid_input for malformed metrics; no effects. @complexity Constant bounded work.
 * @example deriveMetricRatios({ metrics: { clicks: "1", impressions: "4" } })
 */
export function deriveMetricRatios({ metrics }: { metrics: MetricValues }): Outcome<MetricRatios> {
  const parsed = parseBoundary({ schema: metricValuesSchema, input: metrics });
  if (!parsed.ok) return parsed;
  const values = parsed.value;
  return { ok: true, value: {
    ctr: ratio({ numerator: values.clicks, denominator: values.impressions }),
    cpcMicros: ratio({ numerator: values.spend, denominator: values.clicks }),
    cpmMicros: ratio({ numerator: values.spend, denominator: values.impressions, scale: 1000n }),
    vendorCpaMicros: ratio({ numerator: values.spend, denominator: values.vendorConversions, scale: 1000000n }),
    vendorRoas: ratio({ numerator: values.vendorConversionValue, denominator: values.spend }),
  } };
}
/** Pure arithmetic on bounded integers, constant work; missing inputs precede a zero denominator. */
function ratio(required: { numerator: string | null | undefined; denominator: string | null | undefined; scale?: bigint }): RatioResult {
  if (required.numerator === undefined || required.denominator === undefined) return { status: "unsupported" };
  if (required.numerator === null || required.denominator === null) return { status: "unavailable" };
  if (required.denominator === "0") return { status: "zero_denominator" };
  return { status: "exact", numerator: (BigInt(required.numerator) * (required.scale ?? 1n)).toString(), denominator: required.denominator };
}

import { expect, it } from "vitest";
import { decimalToMicros, deriveMetricRatios, metricBatchSchema, metricMappingSchema, metricValuesSchema, ratioResultSchema } from "../src/index.js";
import type { MetricBatch, MetricGrain } from "../src/index.js";

const meaning = { vendorField: "cost_micros", meaning: "Billed account currency micros" };
it.each([
  ["0", "0"], ["1", "1000000"], ["123.45", "123450000"],
  ["9007199254740993.123456", "9007199254740993123456"], ["1e-6", "1"], ["1.23000000e2", "123000000"],
  ["0e999", "0"], ["1e31", "1" + "0".repeat(37)],
])("scales exact major units %s to micros without currency-specific minor units", (value, expected) => {
  expect(decimalToMicros({ value, rounding: "reject" })).toEqual({ ok: true, value: expected });
});
it.each([
  ["0.0000005", "0"], ["0.0000015", "2"], ["1.2345665", "1234566"], ["1.2345675", "1234568"],
  ["1.2345674", "1234567"], ["1.2345676", "1234568"], ["0.9999995", "1000000"], ["1e-999", "0"],
])("rounds %s half-even with exact ties and carry", (value, expected) => {
  expect(decimalToMicros({ value, rounding: "half_even" })).toEqual({ ok: true, value: expected });
  expect(decimalToMicros({ value, rounding: "reject" })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
});
it("rejects malformed/negative/oversized values, overflow including rounding carry, and invalid rounding", () => {
  for (const value of ["", "-1", "+1", "01", ".5", "1.", "NaN", " 1", "1e1000", "1".repeat(101), "1e32", "9".repeat(32) + ".9999995"])
    expect(decimalToMicros({ value, rounding: "half_even" })).toMatchObject({ ok: false });
  expect(decimalToMicros({ value: "1", rounding: "up" as "reject" })).toMatchObject({ ok: false });
});
it("accepts complete empty coverage with an unknown cutoff without asserting vendor finality", () => {
  expect(metricBatchSchema.parse({ ...batch(), rows: [], complete: true, dataThrough: 0, finality: "provisional" })).toMatchObject({ rows: [], complete: true, dataThrough: 0 });
});
function batch(): MetricBatch {
  return { schema: "report.metrics.v1", pluginId: "ads", connectionId: "c", accountId: "a", currency: "USD", timezone: "America/Los_Angeles",
    grain: "campaign", days: { start: "2026-10-01", end: "2026-10-03" }, mapping: { pluginId: "ads", version: "1", grains: { campaign: { spend: meaning } } },
    retrievedAt: 10, dataThrough: 9, complete: true, freshness: "fresh", finality: "provisional", restated: false,
    rows: [{ day: "2026-10-01", entity: { grain: "campaign", vendorCampaignId: "1" }, metrics: { spend: "9007199254740993" } }] };
}
it("preserves integers beyond safe-number precision and distinguishes unsupported/null/zero", () => {
  expect(metricBatchSchema.parse(batch()).rows[0].metrics.spend).toBe("9007199254740993");
  for (const value of [null, "0"]) {
    const input = batch(); input.rows[0].metrics.spend = value;
    expect(metricBatchSchema.parse(input).rows[0].metrics.spend).toBe(value);
  }
  const input = batch(); delete input.rows[0].metrics.spend;
  expect(metricBatchSchema.safeParse(input).success).toBe(false);
  input.rows[0].metrics = { spend: "0", clicks: "0" };
  expect(metricBatchSchema.safeParse(input).success).toBe(false);
  input.rows[0].metrics = { spend: "0", clicks: undefined };
  expect(metricBatchSchema.safeParse(input).success).toBe(false);
  for (const invalid of [0, 9007199254740992, 1n, "01", "-1", "1.5", "1e6", "9".repeat(39)])
    expect(metricValuesSchema.safeParse({ spend: invalid }).success).toBe(false);
  expect(metricValuesSchema.safeParse({ spend: "9".repeat(38) }).success).toBe(true);
  expect(metricValuesSchema.safeParse({ ctr: "0.1" }).success).toBe(false);
});
it("requires hierarchy identifiers and a declaration for each of the four daily grains", () => {
  const entities = [{ grain: "account" }, { grain: "campaign", vendorCampaignId: "c" },
    { grain: "ad_group", vendorCampaignId: "c", vendorAdGroupId: "g" },
    { grain: "ad", vendorCampaignId: "c", vendorAdGroupId: "g", vendorAdId: "a" }] as const;
  for (const entity of entities) {
    const input = { ...batch(), grain: entity.grain, mapping: { ...batch().mapping, grains: { [entity.grain]: { spend: meaning } } }, rows: [{ ...batch().rows[0], entity }] };
    expect(metricBatchSchema.safeParse(input).success).toBe(true);
    expect(metricBatchSchema.safeParse({ ...input, mapping: { ...input.mapping, grains: {} } }).success).toBe(false);
  }
  const input = batch(); input.rows[0].entity = { grain: "ad" } as MetricBatch["rows"][number]["entity"];
  expect(metricBatchSchema.safeParse(input).success).toBe(false);
  expect(metricMappingSchema.safeParse({ ...batch().mapping, grains: { campaign: { spend: { vendorField: "cost", meaning: "" } } } }).success).toBe(false);
  const all = batch(); all.mapping.grains.campaign = { spend: meaning, impressions: meaning, clicks: meaning, vendorConversions: meaning, vendorConversionValue: meaning };
  all.rows[0].metrics = { spend: "1", impressions: "2", clicks: "0", vendorConversions: "500000", vendorConversionValue: null };
  expect(metricBatchSchema.safeParse(all).success).toBe(true);
});
it("rejects duplicate/mixed/out-of-period observations and malformed metadata", () => {
  const input = batch(); input.rows.push({ ...input.rows[0] });
  expect(metricBatchSchema.safeParse(input).success).toBe(false);
  for (const day of ["2026-02-30", "2026-09-30", "2026-10-03"]) expect(metricBatchSchema.safeParse({ ...batch(), rows: [{ ...batch().rows[0], day }] }).success).toBe(false);
  for (const change of [{ timezone: "invalid/timezone" }, { currency: "usd" }, { dataThrough: 11 }, { pluginId: "other" }, { grain: "account" as MetricGrain },
    { days: { start: "2026-10-01", end: "2026-10-01" } }, { days: { start: "2024-01-01", end: "2025-01-02" } }, { rows: Array(5001).fill(batch().rows[0]) }])
    expect(metricBatchSchema.safeParse({ ...batch(), ...change }).success).toBe(false);
  const window = { start: "2024-01-01", end: "2025-01-01" };
  expect(metricBatchSchema.safeParse({ ...batch(), days: window, rows: [] }).success).toBe(true);
  expect(metricBatchSchema.safeParse({ ...batch(), restated: true, complete: false, freshness: "stale", finality: "final" }).success).toBe(true);
});
it("keeps optional reach at period grain and rejects undeclared, duplicate or daily reach", () => {
  const reach = [{ entity: batch().rows[0].entity, reach: null }];
  expect(metricBatchSchema.safeParse({ ...batch(), reach }).success).toBe(false);
  const input = { ...batch(), mapping: { ...batch().mapping, reach: { campaign: meaning } }, reach };
  expect(metricBatchSchema.parse(input).reach?.[0].reach).toBeNull();
  expect(metricBatchSchema.safeParse({ ...input, reach: [{ ...reach[0], reach: "0" }] }).success).toBe(true);
  expect(metricBatchSchema.safeParse({ ...input, reach: [...reach, ...reach] }).success).toBe(false);
  expect(metricBatchSchema.safeParse({ ...input, reach: [{ ...reach[0], day: "2026-10-01" }] }).success).toBe(false);
  expect(metricBatchSchema.safeParse({ ...input, reach: [{ entity: { grain: "account" }, reach: "1" }] }).success).toBe(false);
  expect(metricValuesSchema.safeParse({ reach: "1" }).success).toBe(false);
});
it("derives exact CTR/CPC/CPM/CPA/ROAS, accounting for fractional conversion millionths", () => {
  const result = deriveMetricRatios({ metrics: { spend: "9007199254740993", impressions: "10", clicks: "2", vendorConversions: "500000", vendorConversionValue: "20" } });
  expect(result).toEqual({ ok: true, value: {
    ctr: { status: "exact", numerator: "2", denominator: "10" }, cpcMicros: { status: "exact", numerator: "9007199254740993", denominator: "2" },
    cpmMicros: { status: "exact", numerator: "9007199254740993000", denominator: "10" },
    vendorCpaMicros: { status: "exact", numerator: "9007199254740993000000", denominator: "500000" },
    vendorRoas: { status: "exact", numerator: "20", denominator: "9007199254740993" },
  } });
  const largest = deriveMetricRatios({ metrics: { spend: "9".repeat(38), vendorConversions: "1" } });
  if (!largest.ok) throw new Error("Expected exact ratio");
  expect(ratioResultSchema.safeParse(largest.value.vendorCpaMicros).success).toBe(true);
  expect(largest.value.vendorCpaMicros).toEqual({ status: "exact", numerator: "9".repeat(38) + "000000", denominator: "1" });
});
it("returns explicit missing and zero-denominator states without throwing or inventing zero", () => {
  for (const [metrics, status] of [[{}, "unsupported"], [{ clicks: null, impressions: "0" }, "unavailable"], [{ clicks: "0", impressions: "0" }, "zero_denominator"]] as const) {
    const result = deriveMetricRatios({ metrics });
    expect(result.ok && result.value.ctr).toEqual({ status });
  }
  expect(deriveMetricRatios({ metrics: { spend: "NaN" } })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
});

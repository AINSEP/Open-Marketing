/** Reference arithmetic and evidence guards; written only for W18 B1. */
import { describe, expect, it } from "vitest";
import { abReadoutInputSchema, calculateCreativeFatigue, calculateExperimentSampleSize, creativeFatigueInputSchema, readExperiment, sampleSizeInputSchema } from "../index.js";
import type { AbReadoutInput, CreativeFatigueInput, Outcome, SampleSizeInput } from "../index.js";

function value<T>(required: { result: Outcome<T> }): T {
  if (!required.result.ok) throw new Error(required.result.error.message);
  return required.result.value;
}
function experiment(): AbReadoutInput {
  return { baseline: 0.1, absoluteLift: 0.02, currency: "USD", targetCplMicros: "10000000",
    control: { assignedUnits: 10000, qualifiedLeads: 1000, spend: "10000000000" },
    treatment: { assignedUnits: 10000, qualifiedLeads: 1250, spend: "10000000000" },
    observationComplete: true, randomizedAssignment: true, guardrailsPassed: true };
}
function fatigue(): CreativeFatigueInput {
  return { currency: "USD", targetCplMicros: "10000000", unchangedSetup: true,
    previous: { days: { start: "2026-01-01", end: "2026-01-08" }, metrics: { spend: "100000000", impressions: "10000", clicks: "200" }, reach: "5000", qualifiedLeads: 10, complete: true },
    current: { days: { start: "2026-01-08", end: "2026-01-15" }, metrics: { spend: "120000000", impressions: "20000", clicks: "200" }, reach: "5000", qualifiedLeads: 10, complete: true } };
}

describe("planned experiment sample size", () => {
  it("matches the Fleiss 10% baseline, 2 percentage point lift reference", () => {
    const result = value({ result: calculateExperimentSampleSize({ baseline: 0.1, absoluteLift: 0.02 }) });
    expect(result).toEqual({ status: "sized", sampleSizePerArm: 3841,
      method: "two_proportions_normal_approximation_equal_allocation_alpha_0.05_two_sided_power_0.80_no_continuity_correction" });
  });
  it("accepts a 0.5 absolute lift with a treatment probability near one", () => {
    expect(calculateExperimentSampleSize({ baseline: 0.49, absoluteLift: 0.5 })).toMatchObject({ ok: true, value: { status: "sized", sampleSizePerArm: 11 } });
  });
  it("withholds impractically large samples, including unrepresentably small lifts", () => {
    for (const absoluteLift of [1e-5, Number.MIN_VALUE]) {
      expect(calculateExperimentSampleSize({ baseline: 0.5, absoluteLift })).toMatchObject({ ok: true,
        value: { status: "insufficient_data", reasons: ["required_sample_too_large"] } });
    }
  });
  it.each([
    { baseline: 0, absoluteLift: 0.02 }, { baseline: 1, absoluteLift: 0.02 }, { baseline: -0.1, absoluteLift: 0.02 },
    { baseline: 0.1, absoluteLift: 0 }, { baseline: 0.1, absoluteLift: -0.01 }, { baseline: 0.5, absoluteLift: 0.5 },
    { baseline: NaN, absoluteLift: 0.02 }, { baseline: 0.1, absoluteLift: Infinity }, { baseline: 0.1, absoluteLift: 0.02, unexpected: true },
  ])("rejects invalid probabilities or extra fields: %j", input => {
    expect(sampleSizeInputSchema.safeParse(input).success).toBe(false);
    expect(calculateExperimentSampleSize(input as SampleSizeInput)).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });
});

describe("experiment readout", () => {
  it("reports a treatment win, exact rates, planned sample and a separate owner goal", () => {
    const result = value({ result: readExperiment(experiment()) });
    expect(result).toMatchObject({ status: "treatment_better", plannedSamplePerArm: 3841, reasons: [], currency: "USD",
      control: { rate: { status: "exact", numerator: "1000", denominator: "10000" }, cost: { goal: "meets" } },
      treatment: { rate: { status: "exact", numerator: "1250", denominator: "10000" },
        cost: { spend: "10000000000", cplMicros: { status: "exact", numerator: "10000000000", denominator: "1250" }, goal: "meets" } } });
    expect(result.absoluteDifference).toBe(0.025);
    expect(result.z).toBeCloseTo(5.5945, 3);
  });
  it("accepts a meaningful lift exactly at the threshold without cancellation", () => {
    const input = experiment(); input.treatment.qualifiedLeads = 1200;
    expect(readExperiment(input)).toMatchObject({ ok: true, value: { status: "treatment_better", absoluteDifference: 0.02 } });
  });
  it("reports significant harm even when smaller than the planned meaningful improvement", () => {
    const input = experiment(); input.control.assignedUnits = 100000; input.treatment.assignedUnits = 100000;
    input.control.qualifiedLeads = 11000; input.treatment.qualifiedLeads = 10000;
    const result = value({ result: readExperiment(input) });
    expect(result.status).toBe("control_better"); expect(result.absoluteDifference).toBe(-0.01); expect(result.z).toBeLessThan(-1.959963984540054);
  });
  it("keeps statistically significant improvements below the MDE inconclusive", () => {
    const input = experiment(); input.control.assignedUnits = 100000; input.treatment.assignedUnits = 100000;
    input.control.qualifiedLeads = 10000; input.treatment.qualifiedLeads = 11000;
    const result = value({ result: readExperiment(input) });
    expect(result.status).toBe("inconclusive"); expect(result.z).toBeGreaterThan(1.959963984540054);
    expect(result.interpretation).toContain("does not establish equivalence");
  });
  it("reports a tie as inconclusive, not equivalence", () => {
    const input = experiment(); input.treatment.qualifiedLeads = input.control.qualifiedLeads;
    expect(readExperiment(input)).toMatchObject({ ok: true, value: { status: "inconclusive", z: 0, absoluteDifference: 0 } });
  });
  it.each([0, 9, 9991, 10000])("guards sparse successes/failures (%i leads) before computing z", leads => {
    const input = experiment(); input.control.qualifiedLeads = leads; input.treatment.qualifiedLeads = leads;
    const result = value({ result: readExperiment(input) });
    expect(result.status).toBe("insufficient_data"); expect(result.reasons).toContain("success_failure_condition");
    expect(result.z).toBeNull(); expect(result.absoluteDifference).toBeNull(); expect(JSON.stringify(result)).not.toContain("NaN");
  });
  it("withholds a 70/30 split and a zero-unit split instead of dividing by zero", () => {
    const input = experiment(); input.control.assignedUnits = 7000; input.treatment.assignedUnits = 3000;
    const result = value({ result: readExperiment(input) });
    expect(result.reasons).toEqual(expect.arrayContaining(["sample_ratio_mismatch", "below_planned_sample"])); expect(result.z).toBeNull();
    input.control = { assignedUnits: 0, qualifiedLeads: 0, spend: "1" }; input.treatment = { ...input.control };
    expect(readExperiment(input)).toMatchObject({ ok: true, value: { status: "insufficient_data", z: null,
      control: { rate: { status: "zero_denominator" }, cost: { spend: "1", cplMicros: { status: "zero_denominator" }, goal: "insufficient_data" } } } });
  });
  it.each([
    ["observationComplete", "observation_incomplete"], ["randomizedAssignment", "assignment_not_randomized"], ["guardrailsPassed", "guardrail_failed"],
  ] as const)("withholds conclusions when %s is false", (field, reason) => {
    const input = experiment(); input[field] = false;
    expect(readExperiment(input)).toMatchObject({ ok: true, value: { status: "insufficient_data", reasons: [reason], z: null } });
  });
  it("keeps the planned design independent of observed performance and requires both arm samples", () => {
    const input = experiment(); input.control.assignedUnits = 3840; input.treatment.assignedUnits = 3841;
    expect(readExperiment(input)).toMatchObject({ ok: true, value: { status: "insufficient_data", plannedSamplePerArm: 3841, reasons: ["below_planned_sample"] } });
    input.absoluteLift = 1e-5;
    expect(readExperiment(input)).toMatchObject({ ok: true, value: { status: "insufficient_data", plannedSamplePerArm: null, reasons: ["planned_sample_unavailable"] } });
  });
  it("rejects counts over the bound, fractional counts and outcomes exceeding assignment", () => {
    for (const control of [{ assignedUnits: 1e9 + 1, qualifiedLeads: 1000, spend: "1" },
      { assignedUnits: 10000, qualifiedLeads: 1.5, spend: "1" }, { assignedUnits: 10, qualifiedLeads: 11, spend: "1" }]) {
      const input = { ...experiment(), control };
      expect(abReadoutInputSchema.safeParse(input).success).toBe(false);
      expect(readExperiment(input)).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    }
  });
  it("accepts exactly one billion units per arm and preserves the exact meaningful lift", () => {
    const input = experiment(); input.control.assignedUnits = 1e9; input.treatment.assignedUnits = 1e9;
    input.control.qualifiedLeads = 100000000; input.treatment.qualifiedLeads = 120000000;
    expect(readExperiment(input)).toMatchObject({ ok: true, value: { status: "treatment_better", absoluteDifference: 0.02,
      treatment: { rate: { status: "exact", numerator: "120000000", denominator: "1000000000" } } } });
  });
  it("compares 38-digit spend to target times leads exactly, including a one-micro excess", () => {
    const input = experiment(), spend = "1" + "0".repeat(37), target = "1" + "0".repeat(34);
    input.targetCplMicros = target; input.control.spend = spend; input.treatment.qualifiedLeads = 1000;
    input.treatment.spend = "1" + "0".repeat(36) + "1";
    expect(readExperiment(input)).toMatchObject({ ok: true, value: {
      control: { cost: { spend, goal: "meets", cplMicros: { status: "exact", numerator: spend, denominator: "1000" } } },
      treatment: { cost: { goal: "exceeds" } } } });
  });
  it("keeps missing spend or target unknown, and zero leads insufficient even with spend", () => {
    const input = experiment(); input.control.spend = null; input.targetCplMicros = null;
    expect(readExperiment(input)).toMatchObject({ ok: true, value: { control: { cost: { goal: "unknown", cplMicros: { status: "unavailable" } } },
      treatment: { cost: { goal: "unknown", cplMicros: { status: "exact" } } } } });
    input.control.qualifiedLeads = 0; input.control.spend = "9000000";
    expect(readExperiment(input)).toMatchObject({ ok: true, value: { control: { cost: { spend: "9000000", goal: "insufficient_data", cplMicros: { status: "zero_denominator" } } } } });
  });
});

describe("descriptive creative fatigue", () => {
  it("derives exact CTR/CPM/frequency/CPL, their directions and a non-causal pattern", () => {
    const result = value({ result: calculateCreativeFatigue(fatigue()) });
    expect(result).toMatchObject({ status: "descriptive", reasons: [], ctrDownFrequencyUp: true,
      previous: { ctr: { status: "exact", numerator: "200", denominator: "10000" }, frequency: { status: "exact", numerator: "10000", denominator: "5000" }, cost: { goal: "meets" } },
      current: { cpmMicros: { status: "exact", numerator: "120000000000", denominator: "20000" }, cost: { goal: "exceeds" } },
      directions: { ctr: "down", cpmMicros: "down", frequency: "up", cplMicros: "up" } });
    expect(result.interpretation).toContain("does not establish creative fatigue");
    expect(result).not.toHaveProperty("significant"); expect(result).not.toHaveProperty("z");
  });
  it("reports equal fractions with different counts and reverses directions without thresholds", () => {
    const input = fatigue(); input.current.metrics = { spend: "200000000", impressions: "20000", clicks: "400" };
    input.current.reach = "10000"; input.current.qualifiedLeads = 20;
    expect(calculateCreativeFatigue(input)).toMatchObject({ ok: true, value: { ctrDownFrequencyUp: false,
      directions: { ctr: "equal", cpmMicros: "equal", frequency: "equal", cplMicros: "equal" } } });
    const reverse = fatigue(); const previous = reverse.previous;
    reverse.previous = { ...reverse.current, days: reverse.previous.days }; reverse.current = { ...previous, days: reverse.current.days };
    expect(calculateCreativeFatigue(reverse)).toMatchObject({ ok: true, value: { ctrDownFrequencyUp: false,
      directions: { ctr: "up", cpmMicros: "up", frequency: "down", cplMicros: "down" } } });
  });
  it.each([
    { start: "2026-01-07", end: "2026-01-14" }, { start: "2026-01-08", end: "2026-01-16" },
  ])("withholds the pattern for overlapping or unequal windows: %j", days => {
    const input = fatigue(); input.current.days = days;
    expect(calculateCreativeFatigue(input)).toMatchObject({ ok: true, value: { status: "insufficient_data",
      reasons: ["windows_unequal_or_overlapping"], ctrDownFrequencyUp: false, directions: { ctr: "down" } } });
  });
  it("retains metrics but suppresses the pattern for changed setup, incomplete periods or sparse clicks", () => {
    const input = fatigue(); input.unchangedSetup = false; input.previous.complete = false; input.current.metrics.clicks = "9";
    expect(calculateCreativeFatigue(input)).toMatchObject({ ok: true, value: { status: "insufficient_data", ctrDownFrequencyUp: false,
      reasons: ["setup_changed", "incomplete_period", "too_few_clicks"], previous: { ctr: { status: "exact" } } } });
  });
  it("requires whole-period reach and keeps absent/null/zero metric meanings distinct", () => {
    const input = fatigue(); input.previous.reach = null; input.current.reach = "0";
    const result = value({ result: calculateCreativeFatigue(input) });
    expect(result).toMatchObject({ status: "insufficient_data", reasons: ["reach_unavailable"], ctrDownFrequencyUp: false,
      previous: { frequency: { status: "unavailable" } }, current: { frequency: { status: "zero_denominator" } }, directions: { frequency: "unavailable" } });
    input.previous.metrics = {}; input.current.metrics = { impressions: "0", clicks: null, spend: null }; input.current.reach = "100";
    expect(calculateCreativeFatigue(input)).toMatchObject({ ok: true, value: { previous: { ctr: { status: "unsupported" }, cost: { goal: "unknown" } },
      current: { ctr: { status: "unavailable" }, frequency: { status: "exact", numerator: "0", denominator: "100" } }, directions: { ctr: "unavailable", cpmMicros: "unavailable" } } });
  });
  it("keeps zero-lead CPL undefined and unknown lead/target evidence unknown per period", () => {
    const input = fatigue(); input.previous.qualifiedLeads = 0; input.current.qualifiedLeads = null;
    expect(calculateCreativeFatigue(input)).toMatchObject({ ok: true, value: {
      previous: { cost: { spend: "100000000", goal: "insufficient_data", cplMicros: { status: "zero_denominator" } } },
      current: { cost: { goal: "unknown", cplMicros: { status: "unavailable" } } }, directions: { cplMicros: "unavailable" } } });
    input.targetCplMicros = null; input.current.qualifiedLeads = 10;
    expect(calculateCreativeFatigue(input)).toMatchObject({ ok: true, value: { current: { cost: { goal: "unknown", cplMicros: { status: "exact" } } } } });
  });
  it("uses exact cross-products for directions even when 38-digit metrics differ by one", () => {
    const input = fatigue(), impressions = "1" + "0".repeat(37);
    input.previous.metrics.impressions = impressions; input.current.metrics.impressions = "1" + "0".repeat(36) + "1";
    expect(calculateCreativeFatigue(input)).toMatchObject({ ok: true, value: { ctrDownFrequencyUp: true, directions: { ctr: "down", frequency: "up" } } });
  });
  it("rejects invalid windows, currency, micros, fractional reach and unknown fields", () => {
    const input = fatigue(); input.previous.days.end = input.previous.days.start;
    expect(calculateCreativeFatigue(input)).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    for (const invalid of [{ ...fatigue(), currency: "usd" }, { ...fatigue(), targetCplMicros: "1.5" },
      { ...fatigue(), unexpected: true }, { ...fatigue(), current: { ...fatigue().current, reach: "0.5" } }]) {
      expect(creativeFatigueInputSchema.safeParse(invalid).success).toBe(false);
      expect(calculateCreativeFatigue(invalid as CreativeFatigueInput)).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    }
  });
});

/** Pure calculators for caller-supplied aggregate evidence; no platform execution. */
import { z } from "zod";
import { deriveMetricRatios, epochSchema, metricValuesSchema, moneySchema, parseBoundary, ratioResultSchema, reportMetricsInputSchema } from "@open-marketing/contracts";
import type { Outcome, RatioResult } from "@open-marketing/contracts";
import { metricsFailure } from "./metrics.js";

const Z_A = 1.959963984540054;
const Z_B = 0.8416212335729143;
const count = epochSchema.max(1e9);
const metricDaysSchema = reportMetricsInputSchema.shape.days;
const integer = metricValuesSchema.shape.spend.unwrap().unwrap();
const method = z.literal("two_proportions_normal_approximation_equal_allocation_alpha_0.05_two_sided_power_0.80_no_continuity_correction");

/** Planned qualified-lead probability and minimum meaningful absolute increase, not relative lift. */
export const sampleSizeInputSchema = z.strictObject({ baseline: z.number().gt(0).lt(1).describe("Planned qualified-lead probability, between zero and one."),
  absoluteLift: z.number().gt(0).describe("Minimum meaningful absolute increase in probability; 0.02 means two percentage points.") })
  .refine(value => value.baseline + value.absoluteLift < 1);
export type SampleSizeInput = z.infer<typeof sampleSizeInputSchema>;
const sampleSizeResultSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("sized"), method, sampleSizePerArm: count.min(1) }),
  z.strictObject({ status: z.literal("insufficient_data"), method, reasons: z.tuple([z.literal("required_sample_too_large")]) }),
]);
type SampleSizeResult = z.infer<typeof sampleSizeResultSchema>;

const armSchema = z.strictObject({ assignedUnits: count, qualifiedLeads: count, spend: integer.nullable().describe("Exact account-currency micros, or null when unavailable.") })
  .refine(value => value.qualifiedLeads <= value.assignedUnits);
/** Each unit has one binary outcome. observationComplete includes the outcome-lag window;
 * randomizedAssignment asserts independent randomized units. All evidence is caller-supplied. */
export const abReadoutInputSchema = z.strictObject({
  baseline: sampleSizeInputSchema.shape.baseline, absoluteLift: sampleSizeInputSchema.shape.absoluteLift,
  control: armSchema, treatment: armSchema, currency: moneySchema.shape.currency, targetCplMicros: integer.nullable().describe("Owner's acceptable cost per qualified lead in account-currency micros; null means unknown."),
  observationComplete: z.boolean().describe("Both the planned observation and outcome-lag windows are complete."),
  randomizedAssignment: z.boolean().describe("Units were assigned independently and randomly to the planned equal-allocation arms."), guardrailsPassed: z.boolean(),
}).refine(value => value.baseline + value.absoluteLift < 1);
export type AbReadoutInput = z.infer<typeof abReadoutInputSchema>;
const costGoalSchema = z.strictObject({ spend: integer.nullable(), cplMicros: ratioResultSchema,
  goal: z.enum(["meets", "exceeds", "unknown", "insufficient_data"]) });
const armResultSchema = z.strictObject({ rate: ratioResultSchema, cost: costGoalSchema });
const readoutReasonSchema = z.enum(["below_planned_sample", "success_failure_condition", "sample_ratio_mismatch",
  "observation_incomplete", "assignment_not_randomized", "guardrail_failed", "planned_sample_unavailable"]);
const abReadoutSchema = z.strictObject({
  status: z.enum(["treatment_better", "control_better", "inconclusive", "insufficient_data"]),
  method, currency: moneySchema.shape.currency, plannedSamplePerArm: count.min(1).nullable(),
  control: armResultSchema, treatment: armResultSchema, reasons: readoutReasonSchema.array().max(7),
  z: z.number().nullable(), absoluteDifference: z.number().nullable().describe("Signed treatment minus control probability, not relative lift; null when evidence is insufficient."),
  interpretation: z.literal("Inconclusive does not establish equivalence. Caller-supplied assignment and observation evidence is not independently verified."),
});
type AbReadout = z.infer<typeof abReadoutSchema>;

const periodSchema = z.strictObject({ days: metricDaysSchema,
  metrics: metricValuesSchema.pick({ spend: true, impressions: true, clicks: true }),
  reach: integer.nullable().describe("Deduplicated reach for this whole period, never summed daily reach."), qualifiedLeads: count.nullable(), complete: z.boolean() });
/** Period reach is deduplicated over each whole window. unchangedSetup asserts the same
 * creative, audience, placement, objective and account timezone in both periods. */
export const creativeFatigueInputSchema = z.strictObject({ previous: periodSchema, current: periodSchema,
  unchangedSetup: z.boolean().describe("Same creative, audience, placement, objective and account timezone across both periods."),
  currency: moneySchema.shape.currency, targetCplMicros: abReadoutInputSchema.shape.targetCplMicros });
export type CreativeFatigueInput = z.infer<typeof creativeFatigueInputSchema>;
const periodResultSchema = z.strictObject({ days: metricDaysSchema, ctr: ratioResultSchema, cpmMicros: ratioResultSchema,
  frequency: ratioResultSchema, cost: costGoalSchema });
const directionSchema = z.enum(["up", "down", "equal", "unavailable"]);
const fatigueReasonSchema = z.enum(["windows_unequal_or_overlapping", "setup_changed", "incomplete_period", "reach_unavailable", "too_few_clicks"]);
const creativeFatigueReadoutSchema = z.strictObject({ status: z.enum(["descriptive", "insufficient_data"]),
  currency: moneySchema.shape.currency, previous: periodResultSchema, current: periodResultSchema,
  directions: z.strictObject({ ctr: directionSchema, cpmMicros: directionSchema, frequency: directionSchema, cplMicros: directionSchema }),
  reasons: fatigueReasonSchema.array().max(5), ctrDownFrequencyUp: z.boolean(),
  interpretation: z.literal("Descriptive trends only; this pattern does not establish creative fatigue or its cause."),
});
type CreativeFatigueReadout = z.infer<typeof creativeFatigueReadoutSchema>;

/** Fixed two-proportion normal approximation (Fleiss, Levin & Paik, 2003, §4.2).
 * Invalid probabilities return invalid_input; samples above 1e9 return insufficient_data.
 * No effects. @complexity O(1) time/space, fixed arithmetic.
 * @example calculateExperimentSampleSize({ baseline: 0.1, absoluteLift: 0.02 }) // 3841 per arm
 */
export function calculateExperimentSampleSize(required: SampleSizeInput): Outcome<SampleSizeResult> {
  const parsed = parseBoundary({ schema: sampleSizeInputSchema, input: required });
  if (!parsed.ok) return metricsFailure({ code: "invalid_input", message: "Invalid experiment sizing input" });
  const p1 = parsed.value.baseline, p2 = p1 + parsed.value.absoluteLift, mean = (p1 + p2) / 2;
  const numerator = Z_A * Math.sqrt(2 * mean * (1 - mean)) + Z_B * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2));
  const n = Math.ceil(numerator ** 2 / (p2 - p1) ** 2);
  if (n > 1e9) return { ok: true, value: { status: "insufficient_data", method: method.value, reasons: ["required_sample_too_large"] } };
  return parseBoundary({ schema: sampleSizeResultSchema, input: { status: "sized", method: method.value, sampleSizePerArm: n } });
}

/** Evaluate a completed fixed-horizon experiment using the preplanned baseline/lift.
 * Guards precede z arithmetic: sparse outcomes, SRM (chi-square >10.828) and compromised
 * evidence withhold conclusions. NIST pooled two-proportion z, no p-value or equivalence claim.
 * Returns invalid_input for malformed aggregates. Pure O(1) time/space, two bounded arms.
 * @example readExperiment({ ...plan, control, treatment, currency: "USD", targetCplMicros: null,
 *   observationComplete: true, randomizedAssignment: true, guardrailsPassed: true })
 */
export function readExperiment(required: AbReadoutInput): Outcome<AbReadout> {
  const parsed = parseBoundary({ schema: abReadoutInputSchema, input: required });
  if (!parsed.ok) return parsed;
  const input = parsed.value, { control, treatment } = input;
  const sample = calculateExperimentSampleSize({ baseline: input.baseline, absoluteLift: input.absoluteLift });
  if (!sample.ok) return sample;
  const plannedSamplePerArm = sample.value.status === "sized" ? sample.value.sampleSizePerArm : null;
  const arms = [control, treatment];
  const rules: [boolean, z.infer<typeof readoutReasonSchema>][] = [
    [plannedSamplePerArm !== null && arms.some(arm => arm.assignedUnits < plannedSamplePerArm), "below_planned_sample"],
    [arms.some(arm => arm.qualifiedLeads < 10 || arm.assignedUnits - arm.qualifiedLeads < 10), "success_failure_condition"],
    [(control.assignedUnits - treatment.assignedUnits) ** 2 > 10.828 * (control.assignedUnits + treatment.assignedUnits), "sample_ratio_mismatch"],
    [!input.observationComplete, "observation_incomplete"], [!input.randomizedAssignment, "assignment_not_randomized"],
    [!input.guardrailsPassed, "guardrail_failed"], [plannedSamplePerArm === null, "planned_sample_unavailable"],
  ];
  const reasons = rules.filter(([fails]) => fails).map(([, reason]) => reason);
  const summaries = arms.map(arm => ({
    rate: arm.assignedUnits === 0 ? { status: "zero_denominator" as const } :
      { status: "exact" as const, numerator: String(arm.qualifiedLeads), denominator: String(arm.assignedUnits) },
    cost: costGoal({ spend: arm.spend, leads: arm.qualifiedLeads, target: input.targetCplMicros }),
  }));
  const base = { method: method.value, currency: input.currency, plannedSamplePerArm, control: summaries[0], treatment: summaries[1], reasons,
    interpretation: "Inconclusive does not establish equivalence. Caller-supplied assignment and observation evidence is not independently verified." as const };
  if (reasons.length > 0) return parseBoundary({ schema: abReadoutSchema, input: { ...base, status: "insufficient_data", z: null, absoluteDifference: null } });
  // Subtract exact count products first so a lift exactly at the MDE survives cancellation.
  const differenceNumerator = BigInt(treatment.qualifiedLeads) * BigInt(control.assignedUnits) - BigInt(control.qualifiedLeads) * BigInt(treatment.assignedUnits);
  const absoluteDifference = Number(differenceNumerator) / Number(BigInt(control.assignedUnits) * BigInt(treatment.assignedUnits));
  const pooled = (control.qualifiedLeads + treatment.qualifiedLeads) / (control.assignedUnits + treatment.assignedUnits);
  const zStatistic = absoluteDifference / Math.sqrt(pooled * (1 - pooled) * (1 / control.assignedUnits + 1 / treatment.assignedUnits));
  const status = zStatistic <= -Z_A ? "control_better" : zStatistic >= Z_A && absoluteDifference >= input.absoluteLift ? "treatment_better" : "inconclusive";
  return parseBoundary({ schema: abReadoutSchema, input: { ...base, status, z: zStatistic, absoluteDifference } });
}

/** Exact CPL and owner goal, shared by experiment arms and fatigue periods.
 * Zero leads never mean free acquisition; null evidence stays unknown. Pure constant work
 * on <=38-digit micros and <=1e9 leads; BigInt comparisons never round money.
 */
function costGoal(required: { spend: string | null; leads: number | null; target: string | null }): z.infer<typeof costGoalSchema> {
  const { spend, leads, target } = required;
  if (leads === 0) return { spend, cplMicros: { status: "zero_denominator" }, goal: "insufficient_data" };
  if (spend === null || leads === null) return { spend, cplMicros: { status: "unavailable" }, goal: "unknown" };
  const cplMicros = { status: "exact" as const, numerator: spend, denominator: String(leads) };
  const goal = target === null ? "unknown" : BigInt(spend) <= BigInt(target) * BigInt(leads) ? "meets" : "exceeds";
  return { spend, cplMicros, goal };
}

/** Compare exact CTR, CPM, frequency or CPL fractions without floating-point conversion.
 * Pure O(1) bounded BigInt work; a missing/zero denominator cannot supply a direction.
 */
function compareRatios(required: { previous: RatioResult; current: RatioResult }): z.infer<typeof directionSchema> {
  if (required.previous.status !== "exact" || required.current.status !== "exact") return "unavailable";
  const previous = BigInt(required.previous.numerator) * BigInt(required.current.denominator);
  const current = BigInt(required.current.numerator) * BigInt(required.previous.denominator);
  if (current === previous) return "equal";
  return current > previous ? "up" : "down";
}

/** Compare two whole-period summaries, retaining descriptive metrics even when evidence is
 * insufficient. No significance test on impressions, fatigue score or causal verdict.
 * Malformed input returns invalid_input. Pure O(1) time/space for two <=366-day windows.
 * @example calculateCreativeFatigue({ previous, current, unchangedSetup: true, currency: "USD", targetCplMicros: null })
 */
export function calculateCreativeFatigue(required: CreativeFatigueInput): Outcome<CreativeFatigueReadout> {
  const parsed = parseBoundary({ schema: creativeFatigueInputSchema, input: required });
  if (!parsed.ok) return parsed;
  const input = parsed.value, { previous, current } = input;
  const previousRatios = deriveMetricRatios({ metrics: previous.metrics });
  if (!previousRatios.ok) return previousRatios;
  const currentRatios = deriveMetricRatios({ metrics: current.metrics });
  if (!currentRatios.ok) return currentRatios;
  const periods = [{ period: previous, ratios: previousRatios.value }, { period: current, ratios: currentRatios.value }].map(({ period, ratios }) => {
    const impressions = period.metrics.impressions ?? null;
    const frequency: RatioResult = impressions === null || period.reach === null ? { status: "unavailable" } :
      period.reach === "0" ? { status: "zero_denominator" } : { status: "exact", numerator: impressions, denominator: period.reach };
    return { days: period.days, ctr: ratios.ctr, cpmMicros: ratios.cpmMicros, frequency,
      cost: costGoal({ spend: period.metrics.spend ?? null, leads: period.qualifiedLeads, target: input.targetCplMicros }) };
  });
  const equalDuration = Date.parse(previous.days.end) - Date.parse(previous.days.start) === Date.parse(current.days.end) - Date.parse(current.days.start);
  const nonOverlapping = previous.days.end <= current.days.start;
  const rules: [boolean, z.infer<typeof fatigueReasonSchema>][] = [
    [!equalDuration || !nonOverlapping, "windows_unequal_or_overlapping"], [!input.unchangedSetup, "setup_changed"],
    [!previous.complete || !current.complete, "incomplete_period"],
    [periods.some(period => period.frequency.status !== "exact"), "reach_unavailable"],
    [[previous, current].some(period => BigInt(period.metrics.clicks ?? "0") < 10n), "too_few_clicks"],
  ];
  const reasons = rules.filter(([fails]) => fails).map(([, reason]) => reason);
  const directions = {
    ctr: compareRatios({ previous: periods[0].ctr, current: periods[1].ctr }),
    cpmMicros: compareRatios({ previous: periods[0].cpmMicros, current: periods[1].cpmMicros }),
    frequency: compareRatios({ previous: periods[0].frequency, current: periods[1].frequency }),
    cplMicros: compareRatios({ previous: periods[0].cost.cplMicros, current: periods[1].cost.cplMicros }),
  };
  return parseBoundary({ schema: creativeFatigueReadoutSchema, input: { status: reasons.length === 0 ? "descriptive" : "insufficient_data",
    currency: input.currency, previous: periods[0], current: periods[1], directions, reasons,
    ctrDownFrequencyUp: reasons.length === 0 && directions.ctr === "down" && directions.frequency === "up",
    interpretation: "Descriptive trends only; this pattern does not establish creative fatigue or its cause." } });
}

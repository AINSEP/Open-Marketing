import { createHash } from "node:crypto";
import type { EffectEnvelope, Money, Outcome } from "@open-marketing/contracts";
import { failure, parse, success } from "./schema.ts";
import { billingSchema, campaignDeploymentPlanSchema } from "./schemas.ts";
import type { AccountBinding, BillingEvidence, Hierarchy, SearchPlan, ToolCall } from "./types.ts";

/** Supported website objectives share one bidding/goal definition for writes and readback. */
export const objectiveGoal = {
  leads: { category: "SUBMIT_LEAD_FORM", origin: "WEBSITE", strategy: "MAXIMIZE_CONVERSIONS", field: "maximizeConversions" },
  sales: { category: "PURCHASE", origin: "WEBSITE", strategy: "MAXIMIZE_CONVERSION_VALUE", field: "maximizeConversionValue" },
} as const;

/** Canonical digest is key-order independent; callers pass schema-parsed bounded JSON.
 * @complexity O(n log n) for sorted object keys, O(n) space.
 * @example digest({ value: { operationId: "op-1", campaignId: "42" } }) */
export function digest(required: { value: unknown }): string {
  return createHash("sha256").update(canonical({ value: required.value })).digest("hex");
}
function canonical(required: { value: unknown }): string {
  const value = required.value;
  if (Array.isArray(value)) return "[" + value.map(entry => canonical({ value: entry })).join(",") + "]";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  const fields = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  return "{" + fields.map(([key, entry]) => JSON.stringify(key) + ":" + canonical({ value: entry })).join(",") + "}";
}
/** Resolve stable operation names and keys from trusted account scope. No credential data. */
export function operationIdentity(required: { binding: AccountBinding; operationId: string }): { key: string; marker: string } {
  const key = digest({ value: { scope: required.binding.scope, connectionId: required.binding.connectionId, customerId: required.binding.customerId, operationId: required.operationId } });
  return { key, marker: "om-" + key };
}
/** Validate finite Search-only intent before any vendor request. @complexity O(n), n<=200. */
export function validatePlan(required: { plan: SearchPlan; binding: AccountBinding }): Outcome<SearchPlan> {
  const { plan, binding } = required;
  if (!validPlanControls({ plan })) return failure({ code: "invalid_input", message: "Plan requires exclusive geography and objective or manual CPC" });
  if (plan.currency !== binding.currency) return failure({ code: "conflict", message: "Plan currency differs from account currency" });
  if (plan.startsAt >= plan.endsAt || plan.endsAt - plan.startsAt > 90 * 86400000) return failure({ code: "invalid_input", message: "Flight must be finite and at most 90 days" });
  if (plan.startsAt % 1000 || plan.endsAt % 1000) return failure({ code: "invalid_input", message: "Google flight timestamps require whole seconds" });
  const ads = [plan, ...(plan.additionalAds ?? [])];
  const collections = [...ads.flatMap(ad => [ad.headlines, ad.descriptions]), plan.geoTargetIds, plan.keywords.map(keyword => keyword.matchType + ":" + keyword.text.toLowerCase())];
  if (collections.some(values => new Set(values).size !== values.length)) return failure({ code: "invalid_input", message: "Duplicate plan entries" });
  try {
    const urls = ads.map(ad => new URL(ad.finalUrl));
    if (urls.some(url => url.username || url.password || !url.hostname)) return failure({ code: "invalid_input", message: "Invalid final URL" });
    new Intl.DateTimeFormat("en", { timeZone: binding.timezone });
  } catch { return failure({ code: "invalid_input", message: "Invalid URL or account timezone" }); }
  return success({ value: plan });
}
/** Recheck the canonical Zod shape at the plan boundary.
 * Exactly one positive geography is required, including for legacy create_paused. O(1).
 */
function validGeography(required: { plan: SearchPlan }): boolean {
  const { plan } = required;
  if ((plan.geoTargetIds.length > 0) === (plan.proximity !== undefined)) return false;
  return campaignDeploymentPlanSchema.shape.proximity.safeParse(plan.proximity).success;
}
/** Exclusive geography and bidding guard legacy calls too; optimized bidding forbids CPC. Pure O(1). */
function validPlanControls(required: { plan: SearchPlan }): boolean {
  return validGeography(required) && (required.plan.objective !== undefined) === (required.plan.cpcBidMicros === undefined);
}
/** Scope and controlled hierarchy readback, including children; PAUSED is never inferred.
 * @complexity O(n), n<=100. */
export function validateHierarchy(required: { binding: AccountBinding; hierarchy: Hierarchy; desired?: "PAUSED" | "ENABLED" }): Outcome<Hierarchy> {
  const { binding, hierarchy, desired } = required;
  if (hierarchy.customerId !== binding.customerId || hierarchy.currency !== binding.currency || hierarchy.timezone !== binding.timezone) return failure({ code: "forbidden", message: "Account readback does not match scoped binding" });
  if (hierarchy.sharedBudget || hierarchy.searchPartners || hierarchy.displayNetwork) return failure({ code: "unavailable", message: "Hierarchy is outside supported Search controls" });
  if (hierarchy.childIds.length !== hierarchy.childStatuses.length || new Set(hierarchy.childIds).size !== hierarchy.childIds.length) return failure({ code: "conflict", message: "Hierarchy evidence is incomplete" });
  if (binding.mode === "sandbox" && !hierarchy.testAccount) return failure({ code: "forbidden", message: "Sandbox writes require a Google test account" });
  if (desired && (hierarchy.status !== desired || hierarchy.childStatuses.some(status => status !== desired))) return failure({ code: "conflict", message: "Hierarchy status is not confirmed" });
  return success({ value: hierarchy });
}
/** Conservative Google billing evidence. The daily limit uses the day's highest budget;
 * a changed monthly limit is billed-to-date plus new budget * remaining calendar days.
 * Result is billed exposure, never served-cost cutoff. @complexity O(1).
 * @example billingExposure({ hierarchy, evidence, candidateMicros: "10000000", now }) */
export function billingExposure(required: { hierarchy: Hierarchy; evidence: BillingEvidence; candidateMicros: string; now: number }): Outcome<{ dailyMicros: string; unchangedMonthlyMicros: string; changedMonthlyMicros: string; flightMicros: string }> {
  const parsed = parse<BillingEvidence>({ schema: billingSchema, input: required.evidence });
  if (!parsed.ok) return parsed;
  const { hierarchy, evidence, now } = required;
  if (!evidence.historyComplete || now - evidence.observedAt > 30000 || evidence.observedAt > now) return failure({ code: "expired", message: "Complete fresh budget history is required" });
  if (evidence.localDate !== localDate({ epoch: now, timezone: hierarchy.timezone })) return failure({ code: "expired", message: "Budget history is from a different account day" });
  const candidate = BigInt(required.candidateMicros);
  const highest = [candidate, BigInt(hierarchy.averageDailyBudgetMicros), BigInt(evidence.highestBudgetTodayMicros)].reduce((left, right) => left > right ? left : right);
  const daily = highest * 2n;
  if (now >= hierarchy.endsAt) return failure({ code: "expired", message: "Campaign flight has ended" });
  const days = BigInt(Math.ceil((hierarchy.endsAt - hierarchy.startsAt) / 86400000) + 1);
  if (days <= 0n || days > 91n) return failure({ code: "expired", message: "Campaign flight has ended or is unsupported" });
  return success({ value: {
    dailyMicros: daily.toString(), unchangedMonthlyMicros: (candidate * 304n / 10n).toString(),
    changedMonthlyMicros: (BigInt(evidence.monthToDateBilledMicros) + candidate * BigInt(evidence.remainingDaysIncludingToday)).toString(),
    flightMicros: (daily * days).toString(),
  } });
}
/** Currency rounding belongs to host configuration; unsupported exponents fail closed. */
export function microsToMoney(required: { micros: string; currency: string }): Outcome<Money> {
  const exponent = new Intl.NumberFormat("en", { style: "currency", currency: required.currency }).resolvedOptions().maximumFractionDigits;
  if (exponent === undefined || exponent > 3) return failure({ code: "unavailable", message: "Unsupported currency exponent" });
  const divisor = 10n ** BigInt(6 - exponent);
  const rounded = (BigInt(required.micros) + divisor - 1n) / divisor;
  if (rounded > BigInt(Number.MAX_SAFE_INTEGER)) return failure({ code: "limit_exceeded", message: "Money exposure exceeds safe range" });
  return success({ value: { minorUnits: Number(rounded), currency: required.currency } });
}
/** Construct exact host envelope from parsed arguments and independently obtained evidence. */
export function effectFor(required: { binding: AccountBinding; call: ToolCall; hierarchy?: Hierarchy; evidence?: BillingEvidence; now: number }): Outcome<EffectEnvelope> {
  const { binding, call, hierarchy, evidence, now } = required;
  const base: EffectEnvelope = {
    operationId: call.arguments.operationId, connectionId: binding.connectionId, accountId: binding.customerId,
    argumentsDigest: digest({ value: call }), effects: ["write"], moneyExposure: null, requiredLimit: null,
  };
  if (call.name !== "activate" && call.name !== "set_budget") return success({ value: base });
  return spendEffect({ ...required, base });
}
function spendEffect(required: { binding: AccountBinding; call: ToolCall; hierarchy?: Hierarchy; evidence?: BillingEvidence; now: number; base: EffectEnvelope }): Outcome<EffectEnvelope> {
  const { binding, call, hierarchy, evidence, now, base } = required;
  if (!hierarchy || !evidence) return failure({ code: "unavailable", message: "Spend evidence is unavailable" });
  if (now - hierarchy.observedAt > 30000 || hierarchy.observedAt > now) return failure({ code: "expired", message: "Fresh hierarchy evidence is required" });
  const candidateMicros = "averageDailyBudgetMicros" in call.arguments ? call.arguments.averageDailyBudgetMicros : hierarchy.averageDailyBudgetMicros;
  const exposure = billingExposure({ hierarchy, evidence, candidateMicros, now });
  if (!exposure.ok) return exposure;
  const daily = microsToMoney({ micros: exposure.value.dailyMicros, currency: binding.currency });
  const flight = microsToMoney({ micros: exposure.value.flightMicros, currency: binding.currency });
  if (!daily.ok) return daily;
  if (!flight.ok) return flight;
  if (binding.mode === "production" && !evidence.productionVerified) return failure({ code: "unavailable", message: "Production bounded-control evidence is not verified" });
  return success({ value: { ...base, argumentsDigest: digest({ value: { call, planDigest: hierarchy.planDigest, childIds: [...hierarchy.childIds].sort(), budgetId: hierarchy.budgetId, highestBudgetTodayMicros: evidence.highestBudgetTodayMicros, evidenceId: evidence.evidenceId } }), effects: ["write", "ad_spend"],
    moneyExposure: { amount: flight.value, window: { start: hierarchy.startsAt, end: hierarchy.endsAt } },
    requiredLimit: { amount: daily.value, timezone: binding.timezone, semantics: "maximum_billed", evidenceId: evidence.evidenceId },
  } });
}
/** Account-local dates use supplied instants, never a hidden clock. */
export function localDate(required: { epoch: number; timezone: string }): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: required.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(required.epoch);
  const fields = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return fields.year + "-" + fields.month + "-" + fields.day;
}
/** Google v25 campaign datetimes are expressed in the account timezone. */
export function googleDateTime(required: { epoch: number; timezone: string }): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: required.timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(required.epoch);
  const fields = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${fields.year}-${fields.month}-${fields.day} ${fields.hour}:${fields.minute}:${fields.second}`;
}

import type { CallContext, ClockPort, IdPort, Money, Outcome, GenerationAllowanceSettings, GenerationApprovalRequirement, GenerationCostQuote } from "@open-marketing/contracts";
import type { DispatchPermit, FrozenDispatchRequest, HaltReceipt, GenerationReservation, GenerationSettlement, FrozenGenerationRequest } from "./types.js";
import { failure, success, sameValue } from "./rules.js";
export type ReservationRecord = { request: FrozenDispatchRequest; permit: DispatchPermit; amount: Money | null; window: { start: number; end: number } | null };
export type GenerationRecord = { request: FrozenGenerationRequest; quote: GenerationCostQuote; reservation: GenerationReservation; latestObservation: string | null; actual: number | null };
export type JournalEntry = { kind: string; operationId: string; at: number; correlationId: string; traceId: string; runId?: string; value: unknown };
export type SafetyState = {
 revision: number; halts: Record<string, HaltReceipt>; reservations: Record<string, ReservationRecord>;
 settings: GenerationAllowanceSettings; cycle: { day: string; timezone: string; end: number } | null;
 generations: Record<string, GenerationRecord>; observations: Record<string, GenerationSettlement>; discrepancy: boolean; journal: JournalEntry[];
};
export type StateChange<T> = (required: { state: SafetyState }) => Outcome<T>;
/** Internal atomic aggregate store; storage implementations serialize every change for the entire scope. */
export interface StateStore {
 /** Evaluate on an isolated snapshot without persisting state or a financial journal. */
 read<T>(required: { context: CallContext; change: StateChange<T> }): Promise<Outcome<T>>;
 transact<T>(required: { context: CallContext; change: StateChange<T> }): Promise<Outcome<T>>;
}
export type RepositoryDependencies = { clock: ClockPort; ids: IdPort; ownerTimezone: string };
/** Default is USD $10 in the explicitly injected owner's timezone. @complexity O(1). */
export function initialState(required: { ownerTimezone: string }): SafetyState {
 return { revision: 0, halts: {}, reservations: {}, settings: { amount: { currency: "USD", minorUnits: 1000 }, dayTimezone: required.ownerTimezone, revision: 0 }, cycle: null, generations: {}, observations: {}, discrepancy: false, journal: [] };
}
/** Safe record identifiers cannot reach Object.prototype. @complexity O(1). */
export function recordKey(required: { id: string }): string { return JSON.stringify(required.id); }
/** Append context and evidence in the same transaction as state. @complexity O(1); store bounds journal at 10,000 entries. */
export function appendJournal(required: { state: SafetyState; context: CallContext; clock: ClockPort; kind: string; operationId: string; value: unknown }): void {
 required.state.revision++;
 required.state.journal.push({ kind: required.kind, operationId: required.operationId, at: required.clock.now({}), correlationId: required.context.correlationId, traceId: required.context.traceId, runId: required.context.runId, value: structuredClone(required.value) });
}
/** Validate an IANA timezone through Intl, never the process default. @complexity O(1). */
export function validTimezone(required: { timezone: string }): boolean {
 try { new Intl.DateTimeFormat("en-CA", { timeZone: required.timezone }).format(0); return true; } catch { return false; }
}
/** Explicit local calendar day including timezone; DST does not use a fixed 24-hour day. @complexity O(1). */
export function localDay(required: { now: number; timezone: string }): string {
 const parts = new Intl.DateTimeFormat("en-CA", { timeZone: required.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(required.now);
 const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
 return `${required.timezone}:${values.year}-${values.month}-${values.day}`;
}
/** Locate the next local calendar transition to the millisecond, including DST. @complexity O(log 48h), O(1) space. */
export function nextRollover(required: { now: number; timezone: string }): number {
 const day = localDay(required);
 let low = required.now;
 let high = required.now + 48 * 60 * 60 * 1000;
 while (high - low > 1) {
  const middle = Math.floor((low + high) / 2);
  if (localDay({ now: middle, timezone: required.timezone }) === day) low = middle;
  else high = middle;
 }
 return high;
}
/** Timezone edits wait for the prior zone's rollover; unresolved reservations never expire here. @complexity O(log 48h), O(1). */
export function activeCycle(required: { state: SafetyState; now: number }): NonNullable<SafetyState["cycle"]> {
 if (required.state.cycle && required.now < required.state.cycle.end) return required.state.cycle;
 const timezone = required.state.settings.dayTimezone;
 const cycle = { day: localDay({ now: required.now, timezone }), timezone, end: nextRollover({ now: required.now, timezone }) };
 required.state.cycle = cycle;
 return cycle;
}
/** Outstanding exposure counts across days; observed charges belong to their dispatch day. @complexity O(g), O(g) scan, bounded g <=10,000. */
export function generationUsage(required: { state: SafetyState; day: string; excludingOperationId?: string }): number {
 return Object.values(required.state.generations).reduce((total, record) => {
  if (record.request.operationId === required.excludingOperationId) return total;
  const amount = generationExposure({ record, day: required.day });
  const next = total + amount;
  return Number.isSafeInteger(next) ? next : Infinity;
 }, 0);
}
/** A pending generation contributes its bound on every day; a charge contributes only on the dispatch day. @complexity O(1). */
function generationExposure(required: { record: GenerationRecord; day: string }): number {
 if (required.record.actual === null) return required.record.reservation.amount.minorUnits;
 return required.record.reservation.dispatchDay === required.day ? required.record.actual : 0;
}
/** Quote/configuration binding and conservative USD bounds. Unknown pricing never becomes zero. @complexity O(1). */
export function quoteIsCurrent(required: { request: FrozenGenerationRequest; quote: GenerationCostQuote; now: number }): boolean {
 const quote = required.quote;
 return quote.status === "known" && quote.expiresAt > required.now && quote.argumentsDigest === required.request.argumentsDigest && quote.modelConfigurationDigest === required.request.configurationDigest && quote.upperBound !== null && quote.upperBound.currency === "USD" && quote.estimated !== null && quote.estimated.currency === "USD" && quote.upperBound.minorUnits >= quote.estimated.minorUnits;
}
/** Every quote, including explicit-spend quotes, must bind this configuration and contain a consistent maximum. @complexity O(1). */
function validQuoteBinding(required: { request: FrozenGenerationRequest; quote: GenerationCostQuote }): boolean {
 if (required.quote.argumentsDigest !== required.request.argumentsDigest || required.quote.modelConfigurationDigest !== required.request.configurationDigest) return false;
 const bound = required.quote.upperBound;
 const estimate = required.quote.estimated;
 if (!bound || !estimate || bound.currency !== estimate.currency) return true;
 return estimate.minorUnits <= bound.minorUnits;
}
/** Assessment excludes a retry's own reservation but never excludes another operation. @complexity O(g), O(g) scan. */
export function assessInState(required: { state: SafetyState; request: FrozenGenerationRequest; quote: GenerationCostQuote; now: number }): GenerationApprovalRequirement {
 const cycle = activeCycle(required);
 const common = { quoteId: required.quote.quoteId, allowanceRevision: required.state.settings.revision, dispatchDay: cycle.day };
 if (!validQuoteBinding(required)) return { ...common, kind: "denied", reason: "invalid_quote_binding_or_bound" };
 if (required.state.discrepancy) return { ...common, kind: "denied", reason: "cost_discrepancy_requires_reconciliation" };
 if (!quoteIsCurrent(required)) return { ...common, kind: "exact_spend", reason: "unknown_stale_or_incomparable_quote" };
 const existing = required.state.generations[recordKey({ id: required.request.operationId })];
 const excludingOperationId = existing?.actual === null ? required.request.operationId : undefined;
 const remaining = required.state.settings.amount.minorUnits - generationUsage({ state: required.state, day: cycle.day, excludingOperationId });
 if (required.quote.upperBound!.minorUnits > remaining) return { ...common, kind: "exact_spend", reason: "above_remaining_allowance" };
 return { ...common, kind: "normal_write", reason: "within_daily_allowance" };
}
/** Retry equality includes quote provenance and original configuration, not only a quote ID. @complexity O(n log n), bounded DTOs. */
export function sameGeneration(required: { existing: GenerationRecord; request: FrozenGenerationRequest; quote: GenerationCostQuote }): boolean {
 return sameValue({ left: required.existing.request, right: required.request }) && sameValue({ left: required.existing.quote, right: required.quote });
}
/** Settlements deduplicate by evidence ID and corrections require the current predecessor. @complexity O(g), O(g) scan. */
export function settleInState(required: { state: SafetyState; settlement: GenerationSettlement }): Outcome<void> {
 const settlement = required.settlement;
 const prior = required.state.observations[recordKey({ id: settlement.observationId })];
 if (prior) return sameValue({ left: prior, right: settlement }) ? success({ value: undefined }) : failure({ code: "conflict", message: "Observation ID reused with different cost" });
 const record = Object.values(required.state.generations).find(value => value.reservation.reservationId === settlement.reservationId);
 if (!record) return failure({ message: "Reservation not found in scope" });
 if (settlement.actual.currency !== record.reservation.amount.currency) return failure({ message: "Settlement currency differs" });
 if ((settlement.correctsObservationId ?? null) !== record.latestObservation) return failure({ code: "conflict", message: "Correction must name the current observation" });
 record.actual = settlement.actual.minorUnits;
 record.latestObservation = settlement.observationId;
 required.state.observations[recordKey({ id: settlement.observationId })] = structuredClone(settlement);
 if (settlement.actual.minorUnits > record.reservation.amount.minorUnits) required.state.discrepancy = true;
 return success({ value: undefined });
}

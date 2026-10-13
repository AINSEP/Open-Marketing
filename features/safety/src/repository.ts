import type { CallContext, Outcome, Money } from "@open-marketing/contracts";
import type { SafetyRepoPort } from "./ports.js";
import type { DispatchPermit, DispatchAdmission, FrozenDispatchRequest, FrozenGenerationRequest, GenerationReservation, SafetySnapshot } from "./types.js";
import type { RepositoryDependencies, SafetyState, StateStore } from "./state.js";
import { activeCycle, appendJournal, assessInState, generationUsage, recordKey, sameGeneration, settleInState, validTimezone } from "./state.js";
import { allowanceEditSchema, dispatchRequestSchema, failure, generationAssessmentSchema, sameValue, settlementSchema, success, validContext } from "./rules.js";
type RepoDependencies = RepositoryDependencies & { store: StateStore };
/** Sum unresolved account exposure only across overlapping approved windows. @complexity O(r), O(r) scan, r <=10,000. */
function accountReserved(required: { state: SafetyState; accountId: string; amount: Money; window: { start: number; end: number } }): number {
 return Object.values(required.state.reservations).reduce((total, record) => {
  if (record.request.envelope.accountId !== required.accountId || record.amount?.currency !== required.amount.currency || !record.window) return total;
  if (record.window.start >= required.window.end || record.window.end <= required.window.start) return total;
  const next = total + record.amount.minorUnits;
  return Number.isSafeInteger(next) ? next : Infinity;
 }, 0);
}
/** Validate independent cap and reservation evidence inside the atomic mutation. @complexity O(r), O(r) scan. */
function fitsAdmission(required: { state: SafetyState; request: FrozenDispatchRequest; admission: DispatchAdmission }): boolean {
 const exposure = required.request.envelope.moneyExposure;
 if (!exposure) return !required.request.envelope.effects.includes("ad_spend");
 const maximum = required.admission.maximum;
 const window = required.admission.window;
 if (!maximum || !window || !required.request.envelope.accountId) return false;
 if (exposure.amount.currency !== maximum.currency || exposure.window.start < window.start || exposure.window.end > window.end) return false;
 const used = accountReserved({ state: required.state, accountId: required.request.envelope.accountId, amount: exposure.amount, window });
 return used + exposure.amount.minorUnits <= maximum.minorUnits;
}
/** Idempotent exact reservation. Halt and duplicate operations are checked before writing any state. @complexity O(r), O(r) scan. */
function reserveInState(required: { state: SafetyState; request: FrozenDispatchRequest; admission: DispatchAdmission; dependencies: RepoDependencies }): Outcome<DispatchPermit> {
 const request = required.request;
 const accountId = request.envelope.accountId;
 if (accountId && required.state.halts[recordKey({ id: accountId })] && request.envelope.effects.some(effect => effect !== "read")) return failure({ message: "Account is halted" });
 if (required.admission.expiresAt <= required.dependencies.clock.now({})) return failure({ code: "expired", message: "Admission expired" });
 const key = recordKey({ id: request.envelope.operationId });
 const existing = required.state.reservations[key];
 if (existing) return existingPermit({ existing, request, now: required.dependencies.clock.now({}) });
 if (!fitsAdmission(required)) return failure({ code: "limit_exceeded", message: "Reserved exposure exceeds verified authority" });
 const permit: DispatchPermit = { operationId: request.envelope.operationId, argumentsDigest: request.envelope.argumentsDigest, approvalId: request.approvalId, expiresAt: required.admission.expiresAt, reservationId: required.dependencies.ids.next({}) };
 required.state.reservations[key] = { request: structuredClone(request), permit, amount: request.envelope.moneyExposure?.amount ?? null, window: request.envelope.moneyExposure?.window ?? null };
 return success({ value: permit });
}
/** An expired permit is not silently renewed; outcome must be reconciled. @complexity O(n log n), bounded DTO. */
function existingPermit(required: { existing: SafetyState["reservations"][string]; request: FrozenDispatchRequest; now: number }): Outcome<DispatchPermit> {
 if (!sameValue({ left: required.existing.request, right: required.request })) return failure({ code: "conflict", message: "Operation key has different frozen arguments" });
 if (required.existing.permit.expiresAt <= required.now) return failure({ code: "expired", message: "Reservation expired; reconcile outcome" });
 return success({ value: required.existing.permit });
}
/** Recheck allowance atomically at reservation, including settings and quote changes. @complexity O(g), O(g) scan. */
function reserveGenerationInState(required: { state: SafetyState; request: FrozenGenerationRequest; quote: Parameters<SafetyRepoPort["reserveGeneration"]>[0]["quote"]; expectedKind: "normal_write" | "exact_spend"; expectedRevision: number; dependencies: RepoDependencies }): Outcome<GenerationReservation> {
 if (required.quote.expiresAt <= required.dependencies.clock.now({})) return failure({ code: "expired", message: "Pricing evidence expired before dispatch" });
 const assessment = assessInState({ ...required, now: required.dependencies.clock.now({}) });
 if (assessment.kind === "denied" || assessment.kind !== required.expectedKind || assessment.allowanceRevision !== required.expectedRevision) return failure({ code: "conflict", message: "Allowance authority changed before reservation" });
 if (!required.quote.upperBound || required.quote.upperBound.currency !== "USD") return failure({ message: "No enforceable USD upper bound" });
 const key = recordKey({ id: required.request.operationId });
 const existing = required.state.generations[key];
 if (existing) return generationRetry({ ...required, existing });
 const reservation: GenerationReservation = { reservationId: required.dependencies.ids.next({}), operationId: required.request.operationId, quoteId: required.quote.quoteId, dispatchDay: assessment.dispatchDay, allowanceRevision: assessment.allowanceRevision, amount: required.quote.upperBound, kind: required.expectedKind };
 required.state.generations[key] = { request: structuredClone(required.request), quote: structuredClone(required.quote), reservation, latestObservation: null, actual: null };
 return success({ value: reservation });
}
/** A settlement prevents duplicate provider execution; changed quotes require a new exact operation. @complexity O(n log n), bounded DTO. */
function generationRetry(required: { existing: SafetyState["generations"][string]; request: FrozenGenerationRequest; quote: Parameters<SafetyRepoPort["reserveGeneration"]>[0]["quote"] }): Outcome<GenerationReservation> {
 if (!sameGeneration(required)) return failure({ code: "conflict", message: "Generation operation has different quote or configuration" });
 if (required.existing.actual !== null) return failure({ code: "conflict", message: "Generation already settled" });
 return success({ value: required.existing.reservation });
}
/** Driver-independent repository. Mutations journal atomically; no external transport is constructed. @example createMemorySafetyRepo({ clock, ids, ownerTimezone: "America/Los_Angeles" }) @complexity O(r+g) per mutation, bounded state <=10,000 records. */
export function createSafetyRepository(required: RepoDependencies): SafetyRepoPort {
 return {
  async getGenerationAllowanceView(input, options) {
   if (!validContext(input)) return failure({ code: "invalid_input", message: "Invalid context" });
   if (options?.signal?.aborted) return failure({ code: "cancelled", message: "Allowance read cancelled" });
   return required.store.read({ context: input.context, change: ({ state }) => allowanceView({ state, now: required.clock.now({}) }) });
  },
  async snapshot(input) {
   if (!validContext(input)) return failure({ code: "invalid_input", message: "Invalid context" });
   return required.store.transact({ context: input.context, change: ({ state }) => snapshotInState({ state, context: input.context, accountId: input.accountId }) });
  },
  async reserve(input) {
   if (!validContext(input) || !dispatchRequestSchema.safeParse(input.request).success || !input.admission) return failure({ code: "invalid_input", message: "Verified admission required" });
   return required.store.transact({ context: input.context, change: ({ state }) => {
    const existing = state.reservations[recordKey({ id: input.request.envelope.operationId })];
    const outcome = reserveInState({ state, request: input.request, admission: input.admission!, dependencies: required });
    if (outcome.ok && !existing) appendJournal({ state, context: input.context, clock: required.clock, kind: "dispatch_reserved", operationId: input.request.envelope.operationId, value: outcome.value });
    return outcome;
   } });
  },
  async halt(input) {
   if (!validContext(input)) return failure({ code: "invalid_input", message: "Invalid context" });
   return required.store.transact({ context: input.context, change: ({ state }) => {
    const key = recordKey({ id: input.adAccountId });
    if (state.halts[key]) return success({ value: state.halts[key] });
    const receipt = { haltId: required.ids.next({}), adAccountId: input.adAccountId, epoch: state.revision + 1, remoteStatus: "pending" as const };
    state.halts[key] = receipt;
    appendJournal({ state, context: input.context, clock: required.clock, kind: "account_halted", operationId: receipt.haltId, value: receipt });
    return success({ value: receipt });
   } });
  },
  async getHalt(input) {
   if (!validContext(input)) return failure({ code: "invalid_input", message: "Invalid context" });
   return required.store.transact({ context: input.context, change: ({ state }) => {
    const halt = state.halts[recordKey({ id: input.accountId })];
    return halt ? success({ value: halt }) : failure({ message: "No local halt in scope" });
   } });
  },
  async getGenerationAllowance(input) {
   if (!validContext(input)) return failure({ code: "invalid_input", message: "Invalid context" });
   return required.store.transact({ context: input.context, change: ({ state }) => success({ value: state.settings }) });
  },
  async setGenerationAllowance(input) { return editAllowance({ input, dependencies: required }); },
  async assessGeneration(input) {
   if (!generationAssessmentSchema.safeParse(input).success || !validContext(input)) return failure({ code: "invalid_input", message: "Invalid generation request" });
   return required.store.transact({ context: input.context, change: ({ state }) => success({ value: assessInState({ ...input, state, now: required.clock.now({}) }) }) });
  },
  async reserveGeneration(input) {
   if (!validContext(input) || !generationAssessmentSchema.safeParse({ context: input.context, request: input.request, quote: input.quote }).success) return failure({ code: "invalid_input", message: "Invalid reservation" });
   return required.store.transact({ context: input.context, change: ({ state }) => {
    const existing = state.generations[recordKey({ id: input.request.operationId })];
    const outcome = reserveGenerationInState({ ...input, state, dependencies: required });
    if (outcome.ok && !existing) appendJournal({ state, context: input.context, clock: required.clock, kind: "generation_reserved", operationId: input.request.operationId, value: outcome.value });
    return outcome;
   } });
  },
  async getGenerationReservation(input) {
   if (!validContext(input)) return failure({ code: "invalid_input", message: "Invalid context" });
   return required.store.transact({ context: input.context, change: ({ state }) => {
    const record = Object.values(state.generations).find(value => value.reservation.reservationId === input.reservationId);
    return record ? success({ value: record.reservation }) : failure({ message: "No generation reservation in scope" });
   } });
  },
  async settleGeneration(input) {
   if (!validContext(input) || !settlementSchema.safeParse(input.settlement).success) return failure({ code: "invalid_input", message: "Invalid settlement" });
   return required.store.transact({ context: input.context, change: ({ state }) => {
    const observed = state.observations[recordKey({ id: input.settlement.observationId })];
    const outcome = settleInState({ state, settlement: input.settlement });
    if (outcome.ok && !observed) appendJournal({ state, context: input.context, clock: required.clock, kind: "generation_cost_observed", operationId: input.settlement.observationId, value: input.settlement });
    return outcome;
   } });
  },
 };
}
/** Reuse dispatch accounting on a private read snapshot. Pending bounds survive expiry/midnight;
 * incomparable totals or disputed charges fail closed rather than display a fictional balance.
 * @complexity O(g) scan, g <=10,000; local rollover is O(log 48h), no writes.
 */
function allowanceView(required: { state: SafetyState; now: number }): Outcome<{ daily: Money; remaining: Money; timezone: string }> {
 const cycle = activeCycle(required);
 const usage = generationUsage({ state: required.state, day: cycle.day });
 if (required.state.discrepancy || !Number.isSafeInteger(usage)) return failure({ code: "unavailable", message: "Allowance requires cost reconciliation" });
 return success({ value: { daily: required.state.settings.amount,
  remaining: { currency: required.state.settings.amount.currency, minorUnits: Math.max(0, required.state.settings.amount.minorUnits - usage) }, timezone: cycle.timezone } });
}
/** Owner-only compare-and-swap edits keep all incurred accounting. @complexity O(log 48h), O(1). */
async function editAllowance(required: { input: Parameters<SafetyRepoPort["setGenerationAllowance"]>[0]; dependencies: RepoDependencies }): Promise<Outcome<Parameters<SafetyRepoPort["setGenerationAllowance"]>[0]["settings"]>> {
 const input = required.input;
 if (!allowanceEditSchema.safeParse(input).success || !validContext({ context: input.context, ownerOnly: true })) return failure({ code: "forbidden", message: "Allowance setting requires scoped owner" });
 if (input.settings.amount.currency !== "USD" || !validTimezone({ timezone: input.settings.dayTimezone })) return failure({ code: "invalid_input", message: "USD and a valid owner timezone are required" });
 return required.dependencies.store.transact({ context: input.context, change: ({ state }) => {
  if (input.settings.revision !== state.settings.revision) return failure({ code: "conflict", message: "Stale allowance setting revision" });
  activeCycle({ state, now: required.dependencies.clock.now({}) });
  const before = structuredClone(state.settings);
  state.settings = { ...structuredClone(input.settings), revision: state.settings.revision + 1 };
  appendJournal({ state, context: input.context, clock: required.dependencies.clock, kind: "allowance_setting_changed", operationId: `allowance:${state.settings.revision}`, value: { before, after: state.settings } });
  return success({ value: state.settings });
 } });
}
/** Snapshot distinguishes unresolved commitments from charges; approval is never a charge. @complexity O(r+g), O(r+g) space. */
function snapshotInState(required: { state: SafetyState; context: CallContext; accountId: string }): Outcome<SafetySnapshot> {
 const records = Object.values(required.state.reservations).filter(record => record.request.envelope.accountId === required.accountId);
 const reserved = records.reduce((sum, record) => sum + (record.amount?.minorUnits ?? 0), 0);
 const currencies = new Set(records.map(record => record.amount?.currency).filter(Boolean));
 if (currencies.size > 1 || !Number.isSafeInteger(reserved)) return failure({ message: "Snapshot currency or total is incomparable" });
 const currency = records.find(record => record.amount)?.amount?.currency ?? "USD";
 return success({ value: { scope: required.context.scope, revision: required.state.revision, halted: !!required.state.halts[recordKey({ id: required.accountId })], reserved: { minorUnits: reserved, currency }, settled: { minorUnits: 0, currency } } });
}

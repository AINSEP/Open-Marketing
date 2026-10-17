/** Paid sending accounting is independent of generation and grants no dispatch authority. */
import { z } from "zod";
import { callContextSchema, moneySchema, epochSchema, idSchema, digestSchema, generationCostQuoteSchema, parseBoundary } from "@open-marketing/contracts";
import type { CallContext, CallOptions, ClockPort, ObserverPort, Outcome } from "@open-marketing/contracts";
import type { SafetySqlDatabase } from "./sql.js";
import { failure, success, sameValue, settlementSchema } from "./rules.js";
import { localDay, nextRollover, validTimezone } from "./state.js";

/** Versioned USD daily setting; revision is a compare-and-swap token, not a grant. */
export const paidSendingAllowanceSchema = z.strictObject({ dailyLimit: moneySchema, timezone: z.string().min(1).max(100), revision: epochSchema });
export type PaidSendingAllowance = z.infer<typeof paidSendingAllowanceSchema>;
const quoteSchema = generationCostQuoteSchema.pick({ quoteId: true, argumentsDigest: true, estimated: true, upperBound: true, pricingEvidenceId: true, expiresAt: true, status: true });
const reservationSchema = z.strictObject({ reservationId: idSchema, operationId: idSchema, dispatchDay: z.string().max(120), amount: moneySchema });
const reserveSchema = z.strictObject({ context: callContextSchema, operationId: idSchema, argumentsDigest: digestSchema, quote: quoteSchema });
const settleSchema = z.strictObject({ context: callContextSchema, settlement: settlementSchema });
const stateSchema = paidSendingAllowanceSchema.extend({ cycle: z.strictObject({ day: z.string().max(120), end: epochSchema }).nullable().default(null),
    reservations: z.array(z.strictObject({ quote: quoteSchema, reservation: reservationSchema, actual: moneySchema.nullable(), latestObservation: idSchema.nullable() })).max(1000).default([]),
    observations: z.array(settlementSchema).max(1000).default([]) });
type State = z.infer<typeof stateSchema>;
type Change<T> = (required: { current: State }) => Outcome<T>;
type Access<T> = { context: CallContext; operation: string; operationId: string; write: boolean; evidence: unknown; change: Change<T> };
type Store = { access<T>(required: Access<T>): Promise<Outcome<T>> };
/** Accounting only; callers must still obtain current policy/grant authority before sending.
 * Settlements append evidence; corrections must name their current predecessor.
 * @example await allowances.reserve({ context, operationId, argumentsDigest, quote }); */
export interface PaidSendingAllowances {
    get(required: { context: CallContext }, optional?: CallOptions): Promise<Outcome<PaidSendingAllowance>>;
    set(required: { context: CallContext; settings: PaidSendingAllowance }, optional?: CallOptions): Promise<Outcome<PaidSendingAllowance>>;
    reserve(required: z.infer<typeof reserveSchema>, optional?: CallOptions): Promise<Outcome<z.infer<typeof reservationSchema>>>;
    settle(required: z.infer<typeof settleSchema>, optional?: CallOptions): Promise<Outcome<void>>;
}
function settings(required: { current: State }): PaidSendingAllowance {
    const { dailyLimit, timezone, revision } = required.current;
    return { dailyLimit, timezone, revision };
}
/** Legacy settings acquire empty accounting, never a reset financial limit. */
function defaults(required: { timezone: string }): State {
    if (!validTimezone(required)) throw new Error("Paid sending timezone required");
    return stateSchema.parse({ dailyLimit: { currency: "USD", minorUnits: 500 }, timezone: required.timezone, revision: 0 });
}
function key(required: { context: CallContext }): string {
    return JSON.stringify(["paid-sending", required.context.scope.ownerId, required.context.scope.workspaceId]);
}
/** All four methods use the same serialized store and typed/observed boundary. */
function service(required: { store: Store; observer: ObserverPort; clock: ClockPort }): PaidSendingAllowances {
    async function access<T>(input: Access<T>): Promise<Outcome<T>> {
        let result: Outcome<T>;
        try { result = await required.store.access(input); }
        catch { result = failure({ code: "unavailable", message: "Paid sending accounting unavailable" }); }
        try { required.observer.observe({ operation: "safety.paidSending." + input.operation, outcome: result.ok ? "ok" : result.error.code,
            correlationId: input.context.correlationId, traceId: input.context.traceId, runId: input.context.runId }); } catch { /* Diagnostics cannot change committed accounting. */ }
        return structuredClone(result);
    }
    async function run<I extends { context: CallContext }, T>(input: { schema: z.ZodType<I>; value: I; operation: string; operationId: string; write: boolean; change(value: I): Change<T> }, optional?: CallOptions): Promise<Outcome<T>> {
        const parsed = parseBoundary({ schema: input.schema, input: input.value });
        if (!parsed.ok) return parsed;
        if (optional?.signal?.aborted) return failure({ code: "cancelled", message: "Paid sending cancelled" });
        const context = parsed.value.context;
        if (context.principal.kind !== "owner" || context.principal.ownerId !== context.scope.ownerId) return failure({ code: "forbidden", message: "Paid sending accounting requires owner scope" });
        return access({ context, operation: input.operation, operationId: input.operationId, write: input.write, evidence: parsed.value, change: input.change(parsed.value) });
    }
    return {
        get: (input, options) => run({ schema: z.strictObject({ context: callContextSchema }), value: input, operation: "get", operationId: "settings", write: false, change: () => current => success({ value: settings(current) }) }, options),
        set: (input, options) => run({ schema: z.strictObject({ context: callContextSchema, settings: paidSendingAllowanceSchema }), value: input, operation: "set", operationId: "settings", write: true, change: value => current => update({ ...current, settings: value.settings }) }, options),
        reserve: (input, options) => run({ schema: reserveSchema, value: input, operation: "reserve", operationId: input.operationId, write: true, change: value => current => reserve({ ...current, input: value, now: required.clock.now({}) }) }, options),
        settle: (input, options) => run({ schema: settleSchema, value: input, operation: "settle", operationId: input.settlement?.reservationId, write: true, change: value => current => settle({ ...current, settlement: value.settlement }) }, options),
    };
}
/** CAS protects settings; timezone edits take effect only at the active zone's next midnight. */
function update(required: { current: State; settings: PaidSendingAllowance }): Outcome<PaidSendingAllowance> {
    if (!validTimezone({ timezone: required.settings.timezone }) || required.settings.dailyLimit.currency !== "USD") return failure({ code: "invalid_input", message: "Paid sending requires USD and a valid timezone" });
    if (required.settings.revision !== required.current.revision) return failure({ code: "conflict", message: "Stale paid sending revision" });
    const parsed = parseBoundary({ schema: paidSendingAllowanceSchema, input: { ...required.settings, revision: required.current.revision + 1 } });
    if (!parsed.ok) return parsed;
    Object.assign(required.current, required.settings);
    return parsed;
}
/** Reserve conservatively: unresolved bounds count every day, settled charges on dispatch day.
 * A repeated operation never changes its frozen quote/day. @complexity O(r), r <=1,000. */
function reserve(required: { current: State; input: z.infer<typeof reserveSchema>; now: number }): Outcome<z.infer<typeof reservationSchema>> {
    const { current, input, now } = required;
    const quote = input.quote;
    if (quote.status !== "known" || quote.expiresAt <= now || quote.argumentsDigest !== input.argumentsDigest) return failure({ code: "forbidden", message: "exact_spend_required" });
    if (!quote.upperBound || !quote.estimated || quote.upperBound.currency !== "USD" || quote.estimated.currency !== "USD" || quote.upperBound.minorUnits < quote.estimated.minorUnits) return failure({ code: "forbidden", message: "exact_spend_required" });
    const prior = current.reservations.find(record => record.reservation.operationId === input.operationId);
    if (prior) return sameValue({ left: prior.quote, right: quote }) ? success({ value: prior.reservation }) : failure({ code: "conflict", message: "Paid sending operation changed" });
    if (current.reservations.length >= 1000) return failure({ code: "limit_exceeded", message: "Paid sending reservation capacity reached" });
    if (!current.cycle || now >= current.cycle.end) current.cycle = { day: localDay({ now, timezone: current.timezone }), end: nextRollover({ now, timezone: current.timezone }) };
    const day = current.cycle.day;
    const used = current.reservations.reduce((total, record) => total + exposure({ record, day }), 0);
    if (quote.upperBound.minorUnits > current.dailyLimit.minorUnits - used) return failure({ code: "forbidden", message: "exact_spend_required" });
    const reservation = { reservationId: input.operationId, operationId: input.operationId, dispatchDay: day, amount: quote.upperBound };
    current.reservations.push({ quote, reservation, actual: null, latestObservation: null });
    return success({ value: reservation });
}
function exposure(required: { record: State["reservations"][number]; day: string }): number {
    if (required.record.actual === null) return required.record.reservation.amount.minorUnits;
    return required.record.reservation.dispatchDay === required.day ? required.record.actual.minorUnits : 0;
}
/** Evidence deduplicates and corrections link; no existing journal row is overwritten.
 * @complexity O(r+o), both reservations and retained observations <=1,000. */
function settle(required: { current: State; settlement: z.infer<typeof settlementSchema> }): Outcome<void> {
    const { current, settlement } = required;
    const prior = current.observations.find(item => item.observationId === settlement.observationId);
    if (prior) return sameValue({ left: prior, right: settlement }) ? success({ value: undefined }) : failure({ code: "conflict", message: "Paid sending observation changed" });
    const record = current.reservations.find(item => item.reservation.reservationId === settlement.reservationId);
    if (!record || settlement.actual.currency !== "USD") return failure({ code: "invalid_input", message: "Paid sending reservation/currency mismatch" });
    if ((settlement.correctsObservationId ?? null) !== record.latestObservation) return failure({ code: "conflict", message: "Correction must name current observation" });
    if (current.observations.length >= 1000) return failure({ code: "limit_exceeded", message: "Paid sending observation capacity reached" });
    record.actual = settlement.actual;
    record.latestObservation = settlement.observationId;
    current.observations.push(settlement);
    return success({ value: undefined });
}
/** Atomic state + append-only journal over existing tables; <=4 MiB snapshot, 1,000 reservations.
 * Revision tracks every accounting write. Corrupt/oversized storage fails closed.
 * @example createSqlPaidSendingAllowances({ db, clock, observer, timezone: "America/Los_Angeles" })
 * @complexity O(r+o) bounded serialization and constant SQL queries per operation. */
export function createSqlPaidSendingAllowances(required: { db: SafetySqlDatabase; clock: ClockPort; observer: ObserverPort; timezone: string }): PaidSendingAllowances {
    const initial = defaults(required);
    return service({ ...required, store: { access: input => required.db.transaction({ context: input.context, execute: async ({ session }) => {
        const scopeKey = key(input);
        const rows = await session.query({ sql: "SELECT payload FROM safety_state WHERE scope_key=$1", parameters: [scopeKey] });
        const row = z.array(z.object({ payload: z.string().max(4_194_304) })).max(1).parse(rows.rows)[0];
        const current = stateSchema.parse(row ? JSON.parse(row.payload) : initial);
        const revision = current.revision;
        const before = settings({ current });
        const result = input.change({ current });
        if (!result.ok || !input.write) return result;
        current.revision++;
        const payload = JSON.stringify(current);
        if (payload.length > 4_194_304) return failure({ code: "limit_exceeded", message: "Paid sending storage bound exceeded" });
        await session.query({ sql: "INSERT INTO safety_state (scope_key, version, payload) VALUES ($1,0,$2) ON CONFLICT (scope_key) DO NOTHING", parameters: [scopeKey, JSON.stringify(initial)] });
        const saved = await session.query({ sql: "UPDATE safety_state SET version=$1, payload=$2 WHERE scope_key=$3 AND version=$4 RETURNING version", parameters: [current.revision, payload, scopeKey, revision] });
        if (saved.rows.length !== 1) throw new Error("Paid sending CAS lost");
        const kind = input.operation === "set" ? "paid_sending_setting_changed" : "paid_sending_" + input.operation;
        await session.query({ sql: "INSERT INTO safety_journal (scope_key, sequence, kind, operation_id, payload) VALUES ($1,$2,$3,$4,$5)", parameters: [scopeKey, current.revision, kind, input.operationId,
            JSON.stringify({ before, after: settings({ current }), evidence: input.evidence, recordedAt: required.clock.now({}), context: input.context })] });
        return result;
    } }) } });
}
/** Synchronous scoped mutation is the SQL adapter double; failed changes never leak state.
 * @example createMemoryPaidSendingAllowances({ timezone: "UTC", clock, observer })
 * @complexity O(r+o) bounded snapshot copies; no I/O or hidden clock. */
export function createMemoryPaidSendingAllowances(required: { timezone: string; observer: ObserverPort; clock: ClockPort }): PaidSendingAllowances {
    const initial = defaults(required);
    const states = new Map<string, State>();
    return service({ ...required, store: { async access(input) {
        const current = structuredClone(states.get(key(input)) ?? initial);
        const result = input.change({ current });
        if (result.ok && input.write) { current.revision++; states.set(key(input), current); }
        return result;
    } } });
}

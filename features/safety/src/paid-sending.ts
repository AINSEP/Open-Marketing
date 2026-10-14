/** Paid sending settings belong to safety, independently of the generation allowance. */
import { z } from "zod";
import { callContextSchema, moneySchema, epochSchema, parseBoundary } from "@open-marketing/contracts";
import type { CallContext, CallOptions, ClockPort, ObserverPort, Outcome } from "@open-marketing/contracts";
import type { SafetySqlDatabase } from "./sql.js";
import { failure, success } from "./rules.js";
import { validTimezone } from "./state.js";

/** Settings only; these values grant no ad spend or sending authority. */
export const paidSendingAllowanceSchema = z.strictObject({ dailyLimit: moneySchema, timezone: z.string().min(1).max(100), revision: epochSchema });
/** Versioned USD daily setting; revision is a compare-and-swap token, not a grant. */
export type PaidSendingAllowance = z.infer<typeof paidSendingAllowanceSchema>;
/** Scoped settings API; writes require the authenticated owner and current revision. */
export interface PaidSendingAllowances {
    get(required: { context: CallContext }, optional?: CallOptions): Promise<Outcome<PaidSendingAllowance>>;
    set(required: { context: CallContext; settings: PaidSendingAllowance }, optional?: CallOptions): Promise<Outcome<PaidSendingAllowance>>;
}
const inputSchema = z.strictObject({ context: callContextSchema, settings: paidSendingAllowanceSchema.optional() });
type Change = (required: { current: PaidSendingAllowance }) => Outcome<PaidSendingAllowance>;
type Store = { access(required: { context: CallContext; change?: Change }): Promise<Outcome<PaidSendingAllowance>> };
/** Default is $5/day, scoped to the authenticated workspace; never generation's $10 setting. */
function defaults(required: { timezone: string }): PaidSendingAllowance {
    if (!validTimezone(required)) throw new Error("Paid sending timezone required");
    return { dailyLimit: { currency: "USD", minorUnits: 500 }, timezone: required.timezone, revision: 0 };
}
/** Full owner/workspace key is namespaced inside the existing safety tables, with its own
 * schema/version. No migration or modification to generation accounting is needed. */
function key(required: { context: CallContext }): string {
    return JSON.stringify(["paid-sending", required.context.scope.ownerId, required.context.scope.workspaceId]);
}
/** Validate authority and revision before a settings write. Effects are delegated to a serialized
 * owning store; cancellation and driver errors fail explicitly. @complexity O(1) per setting. */
function service(required: { store: Store; observer: ObserverPort }): PaidSendingAllowances {
    async function access(input: { context: CallContext; settings?: PaidSendingAllowance }, optional?: CallOptions): Promise<Outcome<PaidSendingAllowance>> {
        const parsed = parseBoundary({ schema: inputSchema, input });
        if (!parsed.ok) return parsed;
        if (optional?.signal?.aborted) return failure({ code: "cancelled", message: "Paid sending settings cancelled" });
        const { context, settings } = parsed.value;
        const authority = validateEdit({ context, settings });
        if (!authority.ok) return authority;
        let result: Outcome<PaidSendingAllowance>;
        try { result = await required.store.access({ context, change: settings ? ({ current }) => update({ current, settings }) : undefined }); }
        catch { result = failure({ code: "unavailable", message: "Paid sending settings unavailable" }); }
        observeAccess({ observer: required.observer, context, write: !!settings, result });
        return result;
    }
    return { get: access, set: access };
}
function observeAccess(required: { observer: ObserverPort; context: CallContext; write: boolean; result: Outcome<PaidSendingAllowance> }): void {
    const { context, result } = required;
    try { required.observer.observe({ operation: required.write ? "safety.paidSending.set" : "safety.paidSending.get", outcome: result.ok ? "ok" : result.error.code,
        correlationId: context.correlationId, traceId: context.traceId, runId: context.runId }); } catch { /* Diagnostics do not change committed settings. */ }
}
/** Settings edits are owner-only and use the one supported USD day boundary. */
function validateEdit(required: { context: CallContext; settings?: PaidSendingAllowance }): Outcome<void> {
    const { context, settings } = required;
    if (context.principal.kind !== "owner" || context.principal.ownerId !== context.scope.ownerId) return failure({ code: "forbidden", message: "Paid sending settings require owner scope" });
    if (settings && (!validTimezone({ timezone: settings.timezone }) || settings.dailyLimit.currency !== "USD")) return failure({ code: "invalid_input", message: "Paid sending settings require USD and a valid timezone" });
    return success({ value: undefined });
}
/** CAS at the owning store prevents concurrent stale edits from silently overwriting settings. */
function update(required: { current: PaidSendingAllowance; settings: PaidSendingAllowance }): Outcome<PaidSendingAllowance> {
    if (required.settings.revision !== required.current.revision) return failure({ code: "conflict", message: "Stale paid sending revision" });
    return parseBoundary({ schema: paidSendingAllowanceSchema, input: { ...required.settings, revision: required.current.revision + 1 } });
}
/** SQL settings and their append-only correction history commit together in the existing safety
 * schema. Storage corruption never resets financial settings. @complexity Indexed, constant queries. */
export function createSqlPaidSendingAllowances(required: { db: SafetySqlDatabase; clock: ClockPort; observer: ObserverPort; timezone: string }): PaidSendingAllowances {
    const initial = defaults(required);
    return service({ observer: required.observer, store: { access: input => required.db.transaction({ context: input.context, execute: async ({ session }) => {
        const scopeKey = key(input);
        const rows = await session.query({ sql: "SELECT payload FROM safety_state WHERE scope_key=$1", parameters: [scopeKey] });
        const row = z.array(z.object({ payload: z.string().max(4096) })).max(1).parse(rows.rows)[0];
        const current = row ? paidSendingAllowanceSchema.parse(JSON.parse(row.payload)) : initial;
        if (!input.change) return success({ value: current });
        const changed = input.change({ current });
        if (!changed.ok) return changed;
        await session.query({ sql: "INSERT INTO safety_state (scope_key, version, payload) VALUES ($1,0,$2) ON CONFLICT DO NOTHING", parameters: [scopeKey, JSON.stringify(initial)] });
        const saved = await session.query({ sql: "UPDATE safety_state SET version=$1, payload=$2 WHERE scope_key=$3 AND version=$4 RETURNING version", parameters: [changed.value.revision, JSON.stringify(changed.value), scopeKey, current.revision] });
        if (saved.rows.length !== 1) throw new Error("Paid sending CAS lost");
        await session.query({ sql: "INSERT INTO safety_journal (scope_key, sequence, kind, operation_id, payload) VALUES ($1,$2,$3,$4,$5)", parameters: [scopeKey, changed.value.revision, "paid_sending_setting_changed", "paid-sending:" + changed.value.revision,
            JSON.stringify({ before: current, after: changed.value, recordedAt: required.clock.now({}), context: input.context })] });
        return changed;
    } }) } });
}
/** Synchronous scope mutation is the SQL settings adapter double; no hidden singleton. */
export function createMemoryPaidSendingAllowances(required: { timezone: string; observer: ObserverPort }): PaidSendingAllowances {
    const initial = defaults(required);
    const settings = new Map<string, PaidSendingAllowance>();
    return service({ observer: required.observer, store: { async access(input) {
        const current = settings.get(key(input)) ?? initial;
        if (!input.change) return success({ value: structuredClone(current) });
        const changed = input.change({ current });
        if (changed.ok) settings.set(key(input), structuredClone(changed.value));
        return changed;
    } } });
}

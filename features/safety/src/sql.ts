import type { CallContext, ClockPort, IdPort, ObserverPort, Outcome } from "@open-marketing/contracts";
import type { SafetyRepoPort } from "./ports.js";
import type { SafetyState, StateStore, StateChange } from "./state.js";
import { initialState, validTimezone } from "./state.js";
import { failure, scopeKey } from "./rules.js";
import { safetyStateSchema } from "./state-schema.js";
import { createSafetyRepository } from "./repository.js";
/** Removable db-shaped compatibility seam until jini-compat/db lands. Queries use portable SQL and bound $n parameters. */
export interface SafetySqlSession {
 query(required: { sql: string; parameters: readonly unknown[] }): Promise<{ rows: readonly Readonly<Record<string, unknown>>[] }>;
}
/** The server adapter MUST serialize a scope across connections with a transaction (SQLite BEGIN IMMEDIATE, Postgres serializable/CAS). */
export interface SafetySqlDatabase {
 transaction<T>(required: { context: CallContext; execute: (required: { session: SafetySqlSession }) => Promise<T> }): Promise<T>;
}
/** Validate durable snapshots before use. JSON corruption cannot silently restore default financial authority. @complexity O(s), s <=4MiB. */
function readState(required: { rows: readonly Readonly<Record<string, unknown>>[]; ownerTimezone: string }): { state: SafetyState; version: number } {
 if (required.rows.length === 0) return { state: initialState(required), version: 0 };
 const row = required.rows[0];
 if (typeof row.payload !== "string" || row.payload.length > 4_194_304 || !Number.isSafeInteger(row.version)) throw new Error("Invalid safety state");
 const state = safetyStateSchema.parse(JSON.parse(row.payload));
 return { state, version: row.version as number };
}
/** One aggregate mutation and append-only journal commit together; CAS detects deficient transaction isolation. @complexity O(s), two reads + one update + up to one appended event per operation. */
async function sqlChange<T>(required: { context: CallContext; change: StateChange<T>; session: SafetySqlSession; ownerTimezone: string }): Promise<Outcome<T>> {
 const key = scopeKey(required);
 const result = await required.session.query({ sql: "SELECT version, payload FROM safety_state WHERE scope_key = $1", parameters: [key] });
 const loaded = readState({ rows: result.rows, ownerTimezone: required.ownerTimezone });
 const priorJournal = loaded.state.journal.length;
 const outcome = required.change({ state: loaded.state });
 if (!outcome.ok) return outcome;
 if (loaded.state.journal.length > 10_000) return failure({ code: "limit_exceeded", message: "Safety accounting capacity reached; archive required" });
 const payload = JSON.stringify(loaded.state);
 if (payload.length > 4_194_304) return failure({ code: "limit_exceeded", message: "Safety aggregate storage bound exceeded" });
 await required.session.query({ sql: "INSERT INTO safety_state (scope_key, version, payload) VALUES ($1, 0, $2) ON CONFLICT (scope_key) DO NOTHING", parameters: [key, JSON.stringify(initialState(required))] });
 const update = await required.session.query({ sql: "UPDATE safety_state SET version = version + 1, payload = $1 WHERE scope_key = $2 AND version = $3 RETURNING version", parameters: [payload, key, loaded.version] });
 if (update.rows.length !== 1) throw new Error("Safety compare-and-swap lost race");
 await appendSqlJournal({ context: required.context, session: required.session, state: loaded.state, priorJournal, key });
 return outcome;
}
/** Ledger events append; neither corrections nor settings replace prior evidence. @complexity O(k), k <=1 in current repo operations. */
async function appendSqlJournal(required: { context: CallContext; session: SafetySqlSession; state: SafetyState; priorJournal: number; key: string }): Promise<void> {
 for (const [index, entry] of required.state.journal.slice(required.priorJournal).entries()) {
  await required.session.query({ sql: "INSERT INTO safety_journal (scope_key, sequence, kind, operation_id, payload) VALUES ($1, $2, $3, $4, $5)", parameters: [required.key, required.priorJournal + index + 1, entry.kind, entry.operationId, JSON.stringify(entry)] });
 }
}
/** SQL repo uses an injected db port only; no driver or connection construction. State and financial journal rollback on errors. @example createSqlSafetyRepo({ db: serverDb, clock, ids, ownerTimezone, observer }) @complexity O(s) per transaction, <=4MiB aggregate; serializes one scope. */
export function createSqlSafetyRepo(required: { db: SafetySqlDatabase; clock: ClockPort; ids: IdPort; ownerTimezone: string; observer: ObserverPort }): SafetyRepoPort {
 if (!validTimezone({ timezone: required.ownerTimezone })) throw new Error("Owner timezone is required");
 const store: StateStore = {
  async transact(input) {
   try {
    const outcome = await required.db.transaction({ context: input.context, execute: ({ session }) => sqlChange({ ...input, session, ownerTimezone: required.ownerTimezone }) });
    required.observer.observe({ operation: "safety.sql.transaction", outcome: outcome.ok ? "ok" : outcome.error.code, correlationId: input.context.correlationId, traceId: input.context.traceId, runId: input.context.runId });
    return structuredClone(outcome);
   } catch {
    observeFailure({ observer: required.observer, context: input.context });
    return failure({ code: "unavailable", message: "Safety SQL transaction failed; no authority granted" });
   }
  },
 };
 return createSafetyRepository({ ...required, store });
}

/** Observe an already-failed transaction without allowing a second telemetry exception to escape the typed boundary. @complexity O(1). */
function observeFailure(required: { observer: ObserverPort; context: CallContext }): void {
 try { required.observer.observe({ operation: "safety.sql.transaction", outcome: "unavailable", correlationId: required.context.correlationId, traceId: required.context.traceId, runId: required.context.runId }); }
 catch { /* Failure is already returned as unavailable; telemetry cannot replace it with a throw. */ }
}

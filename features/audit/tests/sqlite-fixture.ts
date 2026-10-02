import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import type { CallContext, CallOptions } from "@open-marketing/contracts";
import type { AuditSqlDatabase, AuditSqlSession } from "../index.js";

/** Real SQLite fixture only: migration execution is confined to disposable databases created by tests. */
export function sqliteHarness(required: { filename?: string; migrate?: boolean } = {}): {
  native: Database.Database; db: AuditSqlDatabase; session: AuditSqlSession;
} {
  const native = new Database(required.filename ?? ":memory:");
  native.pragma("foreign_keys = ON");
  if (required.migrate !== false) {
    native.exec(readFileSync(new URL("../migrations/0001_audit.sql", import.meta.url), "utf8"));
    native.exec(readFileSync(new URL("../migrations/0002_audit_sqlite_immutability.sql", import.meta.url), "utf8"));
  }
  const session: AuditSqlSession = {
    async query(input) {
      const statement = native.prepare(input.text);
      const parameters = Object.fromEntries(input.values.map((item, index) => [String(index + 1), item]));
      if (statement.reader) return { rows: statement.all(parameters) as Record<string, unknown>[] };
      statement.run(parameters);
      return { rows: [] };
    },
  };
  let pending: Promise<unknown> = Promise.resolve();
  const db: AuditSqlDatabase = {
    transaction<T>(input: { context: CallContext; execute(required: { session: AuditSqlSession }): Promise<T> }, optional?: CallOptions): Promise<T> {
      const task = pending.then(() => runTransaction({ native, session, input }, optional));
      pending = task.catch(() => undefined);
      return task;
    },
  };
  return { native, db, session };
}

/** Foreign SQLite transaction ABI is kept in tests; no feature runtime imports a driver. */
async function runTransaction<T>(required: {
  native: Database.Database; session: AuditSqlSession;
  input: { context: CallContext; execute(required: { session: AuditSqlSession }): Promise<T> };
}, optional?: CallOptions): Promise<T> {
  if (optional?.signal?.aborted) throw new Error("Cancelled acquisition");
  required.native.exec("BEGIN IMMEDIATE");
  try {
    const result = await required.input.execute({ session: required.session });
    required.native.exec("COMMIT");
    return result;
  } catch (cause) {
    required.native.exec("ROLLBACK");
    throw cause;
  }
}

/** Scripted in-memory SQL seam double for tainted-output/failure probes, not a SQL engine emulator.
 * Query scripts are explicit and transaction rollback discards recorded work.
 */
export function memorySqlHarness(required: {
  respond(required: { text: string; values: unknown[] }): { rows: readonly Readonly<Record<string, unknown>>[] };
}): { db: AuditSqlDatabase; session: AuditSqlSession; committed(required: Record<string, never>): readonly string[] } {
  const committed: string[] = [];
  let current: string[] = [];
  const session: AuditSqlSession = {
    async query(input) {
      const result = required.respond(structuredClone(input));
      current.push(input.text);
      return structuredClone(result);
    },
  };
  const db: AuditSqlDatabase = {
    async transaction(input) {
      current = [];
      const result = await input.execute({ session });
      committed.push(...current);
      return result;
    },
  };
  return { db, session, committed() { return [...committed]; } };
}

import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
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
    transaction: ({ work }) => work({ session }),
    async query<Row extends Record<string, unknown>>(input: { text: string; values?: unknown[] }) {
      const statement = native.prepare(input.text);
      const parameters = Object.fromEntries((input.values ?? []).map((item, index) => [String(index + 1), item]));
      if (statement.reader) return { rows: statement.all(parameters) as Row[], rowCount: null };
      return { rows: [] as Row[], rowCount: statement.run(parameters).changes };
    },
  };
  let pending: Promise<unknown> = Promise.resolve();
  const db: AuditSqlDatabase = {
    transaction<T>(input: { work(required: { session: AuditSqlSession }): Promise<T> }): Promise<T> {
      const task = pending.then(() => runTransaction({ native, session, input }));
      pending = task.catch(() => undefined);
      return task;
    },
  };
  return { native, db, session };
}

/** Foreign SQLite transaction ABI is kept in tests; no feature runtime imports a driver. */
async function runTransaction<T>(required: {
  native: Database.Database; session: AuditSqlSession;
  input: { work(required: { session: AuditSqlSession }): Promise<T> };
}): Promise<T> {
  required.native.exec("BEGIN IMMEDIATE");
  try {
    const result = await required.input.work({ session: required.session });
    required.native.exec(typeof result === "object" && result !== null && "ok" in result && result.ok === false ? "ROLLBACK" : "COMMIT");
    return result;
  } catch (cause) {
    required.native.exec("ROLLBACK");
    throw cause;
  }
}

/** Scripted in-memory SQL seam double for tainted-output/failure probes, not a SQL engine emulator.
 * Query scripts are explicit; writers serialize and failed callbacks discard recorded work.
 */
export function memorySqlHarness(required: {
  respond(required: { text: string; values: unknown[] }): { rows: readonly Readonly<Record<string, unknown>>[] };
}): { db: AuditSqlDatabase; session: AuditSqlSession; committed(required: Record<string, never>): readonly string[] } {
  const committed: string[] = [];
  let current: string[] = [];
  let pending: Promise<unknown> = Promise.resolve();
  const session: AuditSqlSession = {
    transaction: ({ work }) => work({ session }),
    async query<Row extends Record<string, unknown>>(input: { text: string; values?: unknown[] }) {
      const result = required.respond(structuredClone({ ...input, values: input.values ?? [] }));
      current.push(input.text);
      return structuredClone({ ...result, rowCount: null }) as { rows: Row[]; rowCount: number | null };
    },
  };
  const db: AuditSqlDatabase = {
    transaction(input) {
      const task = pending.then(async () => {
        current = [];
        const result = await input.work({ session });
        if (!(typeof result === "object" && result !== null && "ok" in result && result.ok === false)) committed.push(...current);
        return result;
      });
      pending = task.catch(() => undefined);
      return task;
    },
  };
  return { db, session, committed() { return [...committed]; } };
}

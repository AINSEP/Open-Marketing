import { createSqliteFixture } from "@open-marketing/om-db/testing";
import { readFileSync } from "node:fs";
import type { AuditSqlDatabase, AuditSqlSession } from "../index.js";

/** Real SQLite fixture only: migration execution is confined to disposable databases created by tests. */
export function sqliteHarness(required: { filename?: string; migrate?: boolean } = {}) {
  const migrations = required.migrate === false ? [] : [
    readFileSync(new URL("../migrations/0001_audit.sql", import.meta.url), "utf8"),
    readFileSync(new URL("../migrations/0002_audit_sqlite_immutability.sql", import.meta.url), "utf8"),
  ];
  const fixture = createSqliteFixture({ migrations }, { filename: required.filename });
  return { native: fixture.native, db: fixture.database, session: fixture.database };
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

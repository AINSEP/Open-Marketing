import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import type { PolicySqlPool, PolicySqlClient } from "../index.js";
import { subject } from "./fixtures.js";

/** Test-only SQLite binding to the structural server DB port, with serialized leases.
 * Positional SQLite driver ABI is isolated here; production code imports no driver.
 * Each fixture owns an in-memory database and never touches a live migration.
 */
export function sqliteFixture(): { pool: PolicySqlPool; db: Database.Database; close: () => void } {
  const db = new Database(":memory:");
  db.exec(readFileSync(new URL("../migrations/0001_policy.sql", import.meta.url), "utf8"));
  db.prepare("INSERT INTO policy_subject_identifier VALUES (?, ?, ?, ?)").run(subject.scope.ownerId, subject.scope.workspaceId, "email:subject", subject.subjectId);
  let leased = false;
  const pool: PolicySqlPool = {
    dialect: "sqlite",
    async connect() {
      await acquireLease({ tryAcquire: () => {
        if (leased) return false;
        leased = true;
        return true;
      } });
      const client: PolicySqlClient = {
        async query<Row extends Record<string, unknown>>(required: { text: string; values?: unknown[] }) {
          const sql = required.text.replace(/\$\d+/g, "?");
          const statement = db.prepare(sql);
          if (statement.reader) return { rows: statement.all(...(required.values ?? [])) as Row[], rowCount: null };
          const result = statement.run(...(required.values ?? []));
          return { rows: [] as Row[], rowCount: result.changes };
        },
        release() { leased = false; },
      };
      return client;
    },
  };
  return { pool, db, close: () => db.close() };
}

/** Yield a bounded number of microtasks for the two-call concurrency fixture.
 * This avoids timers/global clock reads; leaking a lease fails the test explicitly.
 */
async function acquireLease(required: { tryAcquire: () => boolean }): Promise<void> {
  for (let turn = 0; turn < 1000; turn++) {
    if (required.tryAcquire()) return;
    await Promise.resolve();
  }
  throw new Error("SQLite fixture lease was not released");
}

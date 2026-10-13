import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import type { PolicySqlPool, PolicySqlClient } from "../index.js";
import { subject } from "./fixtures.js";

/** Test-only transaction owner over SQLite. Bound sessions join; root Outcomes decide rollback.
 * Each fixture owns an in-memory database and never touches a live migration.
 */
export function sqliteFixture(): { pool: PolicySqlPool; db: Database.Database; close: () => void } {
  const db = new Database(":memory:");
  db.exec(readFileSync(new URL("../migrations/0001_policy.sql", import.meta.url), "utf8"));
  db.prepare("INSERT INTO policy_subject_identifier VALUES (?, ?, ?, ?)").run(subject.scope.ownerId, subject.scope.workspaceId, "email:subject", subject.subjectId);
  let tail: Promise<unknown> = Promise.resolve();
  const pool: PolicySqlPool = {
    async transaction({ work }) {
      const result = tail.then(async () => {
        db.exec("BEGIN IMMEDIATE");
        const lifetime = { active: true };
        const session = createSession({ db, lifetime });
        try {
          const value = await work({ session });
          const denied = typeof value === "object" && value !== null && "ok" in value && value.ok === false;
          db.exec(denied ? "ROLLBACK" : "COMMIT");
          return value;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        } finally { lifetime.active = false; }
      });
      tail = result.catch(() => undefined);
      return result;
    },
  };
  return { pool, db, close: () => db.close() };
}

/** Foreign SQLite ABI is isolated in this bound query/session fixture. */
function createSession(required: { db: Database.Database; lifetime: { active: boolean } }): PolicySqlClient {
  return {
    async query<Row extends Record<string, unknown>>(input: { text: string; values?: unknown[] }) {
      assertActive(required);
      const statement = required.db.prepare(input.text.replace(/\$\d+/g, "?"));
      if (statement.reader) return { rows: statement.all(...(input.values ?? [])) as Row[], rowCount: null };
      return { rows: [] as Row[], rowCount: statement.run(...(input.values ?? [])).changes };
    },
    async transaction({ work }) {
      assertActive(required);
      return work({ session: this });
    },
  };
}
/** A fixture session may not leak into another request. */
function assertActive(required: { lifetime: { active: boolean } }): void {
  if (!required.lifetime.active) throw new Error("Session released");
}

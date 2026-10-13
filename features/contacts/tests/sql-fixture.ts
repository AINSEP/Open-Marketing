import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import type { SqlSession, UnitOfWork } from "@open-marketing/contracts";

/** Real isolated SQLite, with one transaction owner and request-bound nested sessions.
 * Migration SQL runs only on this disposable :memory: handle. No live DB is opened.
 * @example createSqlFixture({}) */
export function createSqlFixture(_required: Record<string, never>): { uow: UnitOfWork; db: Database.Database; close: () => void } {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(readFileSync(new URL("../migrations/0001_contacts.sql", import.meta.url), "utf8"));
  let tail: Promise<unknown> = Promise.resolve();
  const uow: UnitOfWork = {
    async transaction({ work }) {
      const result = tail.then(async () => {
        db.exec("BEGIN IMMEDIATE");
        const lifetime = { active: true };
        const session = createSession({ db, lifetime });
        try {
          const value = await work({ session });
          const failed = typeof value === "object" && value !== null && "ok" in value && value.ok === false;
          db.exec(failed ? "ROLLBACK" : "COMMIT");
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
  return { uow, db, close: () => db.close() };
}

/** Foreign better-sqlite3 binding ABI is confined to this test wrapper.
 * Named bindings preserve repeated parameter indexes in recursive CTEs. */
function createSession(required: { db: Database.Database; lifetime: { active: boolean } }): SqlSession {
  return {
    async query<Row extends Record<string, unknown>>(input: { text: string; values?: unknown[] }) {
      assertActive(required);
      const statement = required.db.prepare(input.text.replace(/\$(\d+)/g, "@p$1"));
      const bindings = Object.fromEntries((input.values ?? []).map((value, index) => [`p${index + 1}`, value]));
      if (statement.reader) return { rows: statement.all(bindings) as Row[], rowCount: null };
      return { rows: [] as Row[], rowCount: statement.run(bindings).changes };
    },
    async transaction({ work }) {
      assertActive(required);
      return work({ session: this });
    },
  };
}
function assertActive(required: { lifetime: { active: boolean } }): void {
  if (!required.lifetime.active) throw new Error("Session released");
}

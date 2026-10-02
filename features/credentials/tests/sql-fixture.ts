import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import type { CredentialSqlPort } from "../index.js";

/** Native in-memory SQL double for the structural query port. Only tests open/close handles.
 * Parameter binding matches the server SQLite shim's public PgQueryable shape.
 */
export function createSqlFixture(required: Record<string, never>): { db: CredentialSqlPort; database: Database.Database; dispose: () => void } {
  const database = new Database(":memory:");
  database.exec(readFileSync(new URL("../migrations/0001_credentials.sql", import.meta.url), "utf8"));
  const db: CredentialSqlPort = {
    async query<Row extends Record<string, unknown>>(input: { text: string; values?: unknown[] }) {
      const statement = database.prepare(input.text);
      const parameters = Object.fromEntries((input.values ?? []).map((entry, index) => [String(index + 1), entry]));
      if (statement.reader) {
        statement.safeIntegers(true);
        const rows = statement.all(parameters) as Row[];
        return { rows, rowCount: rows.length };
      }
      return { rows: [], rowCount: statement.run(parameters).changes };
    },
  };
  return { db, database, dispose() { database.close(); } };
}

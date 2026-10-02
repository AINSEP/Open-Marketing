import Database from 'better-sqlite3';
import { readFile } from 'node:fs/promises';
import type { MediaSqlPort } from '../index.js';

/** Foreign SQLite driver ABI stays in test composition; production SQL adapter only receives the structural query port. */
export function sqliteQuery(required: { database: Database.Database }): MediaSqlPort {
  return {
    async query<Row extends Record<string, unknown>>(input: { text: string; values?: unknown[] }) {
      const statement = required.database.prepare(input.text);
      const values = Object.fromEntries((input.values ?? []).map((value, index) => [String(index + 1), value]));
      if (statement.reader) {
        const rows = statement.all(values) as Row[];
        return { rows, rowCount: rows.length };
      }
      const result = statement.run(values);
      return { rows: [] as Row[], rowCount: result.changes };
    },
  };
}
/** Test-only isolated database and additive migration; never connects to or migrates a live store. */
export async function sqlFixture(): Promise<{ db: MediaSqlPort; database: Database.Database; dispose: () => Promise<void> }> {
  const database = new Database(':memory:');
  database.exec(await readFile(new URL('../migrations/0001_media_evidence.sql', import.meta.url), 'utf8'));
  const db = sqliteQuery({ database });
  return { db, database, dispose: async () => { database.close(); } };
}

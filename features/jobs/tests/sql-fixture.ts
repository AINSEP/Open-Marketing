import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import type { JobsSqlDatabase, JobsSqlSession } from "../index.js";
/** Foreign SQLite ABI isolated here; feature production code imports only its injected db-shaped port.
 * Serialized BEGIN IMMEDIATE spans awaited callbacks; no blocking native transaction callback can commit early.
 */
export function sqliteFixture(required: { path?: string }): { database: JobsSqlDatabase; native: Database.Database; close: () => void } {
    const native = new Database(required.path ?? ":memory:");
    native.pragma("foreign_keys = ON");
    native.exec(readFileSync(new URL("../migrations/0001_jobs.sql", import.meta.url), "utf8"));
    let tail: Promise<void> = Promise.resolve();
    const session: JobsSqlSession = {
        async query(input) {
            const statement = native.prepare(input.sql);
            const parameters = Object.fromEntries(input.parameters.map((value, index) => [String(index + 1), value]));
            if (statement.reader) return { rows: statement.all(parameters) as Record<string, unknown>[] };
            statement.run(parameters);
            return { rows: [] };
        },
    };
    const database: JobsSqlDatabase = {
        transaction(input) {
            const result = tail.then(async () => {
                native.exec("BEGIN IMMEDIATE");
                try {
                    const value = await input.execute({ session });
                    native.exec("COMMIT");
                    return value;
                } catch (error) {
                    native.exec("ROLLBACK");
                    throw error;
                }
            });
            tail = result.then(() => undefined, () => undefined);
            return result;
        },
    };
    return { database, native, close() { native.close(); } };
}

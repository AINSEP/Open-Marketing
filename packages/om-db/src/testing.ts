import Database from 'better-sqlite3';
import { sqliteKernel, type SqliteKernel } from '@jini-ai/db/kernel/sqlite';
import type { SqlSession } from '@open-marketing/contracts';
import { createCheckedSqliteClient, createSqlitePool } from './index.js';

/** Test-only owned handle, checked kernel and serialized root session. Close after awaiting work. */
export interface SqliteFixture {
    native: Database.Database;
    kernel: SqliteKernel<unknown>;
    database: SqlSession;
    close(): void;
}
type BeforeQuery = (required: Parameters<SqlSession['query']>[0]) => void;

/** Open an isolated test database and apply caller-supplied trusted SQL; setup failure closes it.
 * Reopening an existing file requires migrations: []. The throwing hook observes queries without
 * replacing results. Root work serializes; borrowed sessions join directly and expire with the root.
 * @returns The one checked kernel shared by OM and Jini repositories, plus an idempotent close.
 * @throws Native setup errors or checked bridge errors; failed Outcomes roll back unchanged.
 * @example const fixture = createSqliteFixture({ migrations: [sql] });
 * @complexity O(m) setup for m migration bytes; O(1) queue overhead per root, excluding SQL/results.
 */
export function createSqliteFixture(required: { migrations: readonly string[] }, optional: {
    filename?: string;
    beforeQuery?: BeforeQuery;
} = {}): SqliteFixture {
    const native = new Database(optional.filename ?? ':memory:');
    try {
        native.pragma('foreign_keys = ON');
        for (const sql of required.migrations) native.exec(sql);
        const kernel = sqliteKernel(createCheckedSqliteClient({ database: native }));
        const pool = createSqlitePool({ database: native, kernel });
        let tail: Promise<unknown> = Promise.resolve();
        const database: SqlSession = {
            transaction(input) {
                const result = tail.then(() => pool.transaction({
                    work: ({ session }) => input.work({ session: observeSession({ session, beforeQuery: optional.beforeQuery }) }),
                }));
                tail = result.catch(() => undefined);
                return result;
            },
            query: input => database.transaction({ work: ({ session }) => session.query(input) }),
        };
        return { native, kernel, database, close() { if (native.open) native.close(); } };
    } catch (cause) {
        native.close();
        throw cause;
    }
}

/** Preserve checked session lifetime and joining while injecting query faults. No SQL control here.
 * @complexity O(1) wrapper overhead per query/join, excluding the caller's hook and SQL.
 */
function observeSession(required: { session: SqlSession; beforeQuery?: BeforeQuery }): SqlSession {
    const session: SqlSession = {
        async query(input) {
            required.beforeQuery?.(input);
            return required.session.query(input);
        },
        transaction: ({ work }) => required.session.transaction({ work: () => work({ session }) }),
    };
    return session;
}

import type Database from 'better-sqlite3';
import { PgFoundationError, type PgClient, type PgPool, type QueryResult } from './ports.js';

/** An injected native handle; the server composition root opens and closes it explicitly. */
export interface SqlitePool extends PgPool {
    readonly dialect: 'sqlite';
}

/** Bind PostgreSQL-shaped $n parameters by name without rewriting SQL or string literals.
 * @throws PgFoundationError when a value is not a portable SQL scalar.
 * @complexity O(n) time/space for n parameters.
 */
function bindings(required: { values: unknown[] }): Record<string, string | number | bigint | Uint8Array | null> {
    return Object.fromEntries(required.values.map((value, index) => {
        if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint' || value instanceof Uint8Array) return [String(index + 1), value];
        throw new PgFoundationError({ code: 'invalid_parameter', message: 'SQL parameters must be portable scalar values' });
    }));
}

/** Executes trusted SQL on the injected connection. DDL scripts contain no bound values.
 * @throws PgFoundationError; native causes are retained only at the trusted server boundary.
 * @complexity O(p + r) wrapper time/space for p parameters and r returned rows; engine cost depends on SQL.
 */
async function query<Row extends Record<string, unknown>>(required: { database: Database.Database; text: string; values?: unknown[] }): Promise<QueryResult<Row>> {
    const { database, text, values = [] } = required;
    try {
        if (values.length === 0 && /^\s*(?:CREATE|ALTER|DROP|BEGIN|COMMIT|ROLLBACK)\b/i.test(text)) {
            database.exec(text);
            return { rows: [], rowCount: null };
        }
        const statement = database.prepare(text);
        const parameters = bindings({ values });
        if (statement.reader) {
            statement.safeIntegers(true);
            const rows = statement.all(parameters) as Row[];
            return { rows, rowCount: rows.length };
        }
        return { rows: [], rowCount: statement.run(parameters).changes };
    } catch (cause) {
        throw new PgFoundationError({ code: 'query_failed', message: 'SQLite query failed', options: { cause } });
    }
}

/** Adapt one server-owned better-sqlite3 handle to the preserved query/pool port, without opening it.
 * A connection is exclusively leased across awaited transaction bodies. Contention fails explicitly
 * instead of allowing another body to share a transaction; j01 owns scheduling/backpressure.
 * release(destroy) quarantines an uncertain connection. Neither release nor import closes the handle.
 * @returns An inert pool; callers own lifecycle and native busy_timeout configuration.
 * @example const pool = createSqlitePool({ database: serverOwnedHandle });
 * @throws PgFoundationError on a closed, busy or quarantined connection.
 * @complexity O(1) factory/lease space; query costs are documented above.
 */
export function createSqlitePool(required: { database: Database.Database }): SqlitePool {
    let leased = false;
    let quarantined = false;
    return {
        dialect: 'sqlite',
        async connect(): Promise<PgClient> {
            if (!required.database.open || quarantined) throw new PgFoundationError({ code: 'connection_unavailable', message: 'SQLite handle is closed or quarantined' });
            if (leased) throw new PgFoundationError({ code: 'connection_busy', message: 'SQLite handle already has a transaction; schedule work sequentially' });
            leased = true;
            let released = false;
            return {
                async query<Row extends Record<string, unknown>>(input: { text: string; values?: unknown[] }): Promise<QueryResult<Row>> {
                    if (released) throw new PgFoundationError({ code: 'connection_released', message: 'SQLite lease has ended' });
                    return query<Row>({ database: required.database, ...input });
                },
                release(input: { destroy?: boolean }): void {
                    if (released) return;
                    released = true;
                    quarantined = input.destroy === true;
                    leased = false;
                },
            };
        },
    };
}

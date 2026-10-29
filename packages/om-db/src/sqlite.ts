import type { UnitOfWork } from '@open-marketing/contracts';
import type { SqliteClient, SqliteStatement } from '@jini-ai/db/sqlite';
import type { SqliteKernel } from '@jini-ai/db/kernel/sqlite';
import { withTransaction } from './transaction.js';
import type Database from 'better-sqlite3';
import { PgFoundationError, type PgClient, type PgPool, type QueryResult } from './ports.js';

/** An injected native handle; the server composition root opens and closes it explicitly. */
export interface SqlitePool extends PgPool, UnitOfWork {
    readonly dialect: 'sqlite';
    readonly kernel: SqliteKernel<unknown>;
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
 * @complexity O(p + c) wrapper time/space for p parameters and c returned cells; engine cost depends on SQL.
 */
async function query<Row extends Record<string, unknown>>(required: { database: Database.Database; text: string; values?: unknown[]; script?: true }): Promise<QueryResult<Row>> {
    const { database, text, values = [] } = required;
    try {
        if (required.script) {
            if (values.length) throw new PgFoundationError({ code: 'invalid_parameter', message: 'Trusted SQL scripts cannot bind values' });
            database.exec(text);
            return { rows: [], rowCount: null };
        }
        const statement = database.prepare(text);
        const parameters = bindings({ values });
        if (statement.reader) {
            statement.safeIntegers(true);
            const rows = (statement.all(parameters) as Record<string, unknown>[]).map(row => decodeRow({ row })) as Row[];
            return { rows, rowCount: rows.length };
        }
        return { rows: [], rowCount: statement.run(parameters).changes };
    } catch (cause) {
        if (cause instanceof PgFoundationError) throw cause;
        throw new PgFoundationError({ code: 'query_failed', message: 'SQLite query failed', options: { cause } });
    }
}

/** Decode native integers once, preserving other SQLite values.
 * @throws PgFoundationError for integers outside JavaScript's exact range.
 * @complexity O(c) time/space for c columns.
 */
function decodeRow(required: { row: Record<string, unknown> }): Record<string, unknown> {
    return Object.fromEntries(Object.entries(required.row).map(([name, value]) => [name, decodeInteger({ value })]));
}

/** Preserve exact integers, rejecting overflow before conversion. @complexity O(1). */
function decodeInteger(required: { value: unknown }): unknown {
    const { value } = required;
    if (typeof value !== 'bigint') return value;
    if (value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new PgFoundationError({ code: 'unsafe_integer', message: 'SQLite integer exceeds the JavaScript safe range' });
    }
    return Number(value);
}

/** Decode streamed native rows without buffering the iterator. @complexity O(c) per row, c columns. */
function* checkedRows(required: { rows: IterableIterator<unknown> }): IterableIterator<unknown> {
    for (const row of required.rows) yield decodeRow({ row: row as Record<string, unknown> });
}

/** Checked native statement ABI for Kysely; positional callbacks follow the foreign SqliteStatement port.
 * @complexity O(c) per returned row, c columns; all() buffers only its result set.
 */
function checkedStatement(required: { statement: Database.Statement }): SqliteStatement {
    const { statement } = required;
    statement.safeIntegers(true);
    return {
        reader: statement.reader,
        all: (...parameters: unknown[]) => (statement.all(...parameters) as Record<string, unknown>[]).map(row => decodeRow({ row })),
        iterate: (...parameters: unknown[]) => checkedRows({ rows: statement.iterate(...parameters) }),
        run: (...parameters: unknown[]) => {
            const result = statement.run(...parameters);
            return { changes: decodeInteger({ value: result.changes }) as number, lastInsertRowid: decodeInteger({ value: result.lastInsertRowid }) as number };
        },
    };
}

/** Wrap a server-owned handle for Jini without opening/closing it. OM and Kysely share checked integers.
 * exec/prepare/pragma/backup implement the foreign SqliteClient ABI. Transaction control stays in Jini.
 * @example const kernel = sqliteKernel(createCheckedSqliteClient({ database }));
 * @returns An inert native-client adapter; close is a no-op because composition owns the handle.
 * @throws PgFoundationError for unsafe integers or failed transaction control, preserving native causes.
 * @complexity O(1) factory space; statement decoding is proportional to returned cells.
 */
export function createCheckedSqliteClient({ database }: { database: Database.Database }): SqliteClient {
    let controlFailure: unknown;
    return {
        get memory() { return database.memory; },
        get name() { return database.name; },
        get inTransaction() { return database.inTransaction; },
        exec(source: string) {
            if (source === 'BEGIN IMMEDIATE') controlFailure = undefined;
            try { return database.exec(source); }
            catch (cause) {
                const failure = controlError({ source, cause, previous: controlFailure });
                controlFailure = failure;
                throw failure;
            }
        },
        prepare: (source: string) => checkedStatement({ statement: database.prepare(source) }),
        pragma: (source: string) => database.pragma(source),
        backup: (destination: string) => database.backup(destination),
        close() {},
    };
}

/** Jini may roll back after COMMIT throws; preserve both failures if that cleanup also throws. */
function controlError(required: { source: string; cause: unknown; previous: unknown }): PgFoundationError {
    const { source, cause, previous } = required;
    if (source === 'COMMIT') return new PgFoundationError({ code: 'commit_failed', message: 'Commit outcome is uncertain; reconcile before retry', options: { cause } });
    if (source === 'ROLLBACK') return new PgFoundationError({ code: 'rollback_failed', message: 'Kernel rollback failed', options: { cause: previous ? new AggregateError([previous, cause]) : cause } });
    return new PgFoundationError({ code: 'query_failed', message: 'SQLite execution failed', options: { cause } });
}

/** Adapt one server-owned better-sqlite3 handle to the preserved query/pool port, without opening it.
 * A connection is exclusively leased across awaited transaction bodies. Contending roots wait in FIFO
 * order for the lease instead of sharing a transaction; a root opened from inside the leased kernel
 * transaction fails fast (it would wait on itself). Waiters re-check closed/quarantined state.
 * release(destroy) quarantines an uncertain connection. Neither release nor import closes the handle.
 * @returns An inert pool; callers own lifecycle and native busy_timeout configuration.
 * @example const pool = createSqlitePool({ database: serverOwnedHandle, kernel });
 * @throws PgFoundationError on a closed, busy or quarantined connection.
 * @complexity O(1) factory/lease space; query costs are documented above.
 */
export function createSqlitePool(required: { database: Database.Database; kernel: SqliteKernel<unknown> }): SqlitePool {
    let leased = false;
    let quarantined = false;
    const waiting: (() => void)[] = [];
    /** Hand the lease directly to the next FIFO waiter, or free it. @complexity O(1) amortized. */
    const handOff = (): void => {
        const next = waiting.shift();
        if (next) next();
        else leased = false;
    };
    /** Take the lease now or queue for it; nested roots inside the holder's transaction fail fast. */
    const acquire = async (): Promise<void> => {
        if (!leased) { leased = true; return; }
        if (required.kernel.inTransaction()) throw new PgFoundationError({ code: 'connection_busy', message: 'SQLite handle already has a transaction; use its session or schedule work sequentially' });
        await new Promise<void>(grant => { waiting.push(grant); });
    };
    const pool: SqlitePool = {
        dialect: 'sqlite',
        kernel: required.kernel,
        async transaction({ work }) {
            return withTransaction({ pool, work: session => work({ session }) });
        },
        async connect(): Promise<PgClient> {
            if (!required.database.open || quarantined) throw new PgFoundationError({ code: 'connection_unavailable', message: 'SQLite handle is closed or quarantined' });
            await acquire();
            if (!required.database.open || quarantined || required.database.inTransaction) {
                handOff();
                throw new PgFoundationError(required.database.inTransaction
                    ? { code: 'connection_busy', message: 'SQLite handle already has a foreign transaction; use its session or schedule work sequentially' }
                    : { code: 'connection_unavailable', message: 'SQLite handle is closed or quarantined' });
            }
            let released = false;
            return {
                async query<Row extends Record<string, unknown>>(input: { text: string; values?: unknown[]; script?: true }): Promise<QueryResult<Row>> {
                    if (released) throw new PgFoundationError({ code: 'connection_released', message: 'SQLite lease has ended' });
                    return required.kernel.run(() => {
                        if (released) throw new PgFoundationError({ code: 'connection_released', message: 'SQLite lease has ended' });
                        return query<Row>({ database: required.database, ...input });
                    });
                },
                release(input: { destroy?: boolean }): void {
                    if (released) return;
                    released = true;
                    quarantined = input.destroy === true;
                    handOff();
                },
            };
        },
    };
    return pool;
}

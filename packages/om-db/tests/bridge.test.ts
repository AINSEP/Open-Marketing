import { sqliteKernel } from '@jini-ai/db/kernel/sqlite';
import Database from 'better-sqlite3';
import type { SqlSession, UnitOfWork } from '@open-marketing/contracts';
import { sql } from 'kysely';
import { describe, expect, it, vi } from 'vitest';
import { createCheckedSqliteClient, createSqlitePool } from '../src/sqlite.js';
import { withTransaction } from '../src/transaction.js';
import { PgFoundationError, type PgPool } from '../src/ports.js';

interface Harness { pool: UnitOfWork; rows(): unknown[]; close(): void }
/** A small transactional double; the only query in the shared suite appends a value. */
function memoryHarness(): Harness {
    let rows: unknown[] = [];
    let busy = false;
    const pool: UnitOfWork = {
        async transaction({ work }) {
            if (busy) throw new PgFoundationError({ code: 'connect_failed', message: 'Busy' });
            busy = true;
            const before = [...rows];
            let active = true;
            function check() {
                if (!active) throw new PgFoundationError({ code: 'connection_released', message: 'Released' });
            }
            const session: SqlSession = {
                async query<Row extends Record<string, unknown>>({ values = [] }: { text: string; values?: unknown[] }) {
                    check(); rows.push(values[0]);
                    return { rows: [] as Row[], rowCount: 1 };
                },
                async transaction({ work: joined }) { check(); return joined({ session }); },
            };
            try {
                const result = await work({ session });
                if (typeof result === 'object' && result !== null && 'ok' in result && result.ok === false) rows = before;
                return result;
            } catch (cause) {
                rows = before;
                throw new PgFoundationError({ code: 'transaction_failed', message: 'Rolled back', options: { cause } });
            } finally { active = false; busy = false; }
        },
    };
    return { pool, rows: () => [...rows], close() {} };
}
/** Real temporary SQLite exercises the same contract as the memory double. */
function sqliteHarness(): Harness {
    const database = new Database(':memory:');
    database.exec('CREATE TABLE items (value TEXT)');
    return {
        pool: createSqlitePool({ database, kernel: sqliteKernel(createCheckedSqliteClient({ database })) }),
        rows: () => database.prepare('SELECT value FROM items ORDER BY rowid').all().map(row => (row as { value: string }).value),
        close: () => database.close(),
    };
}
/** One shared UnitOfWork/session suite asserts persisted effects, not just callback calls. */
function transactionSuite(required: { name: string; create: () => Harness }): void {
    describe(required.name + ' UnitOfWork', () => {
        it('commits success and rolls back the original returned Outcome', async () => {
            const fixture = required.create();
            const denied = { ok: false, error: { code: 'denied' } };
            try {
                expect(await fixture.pool.transaction({ work: async ({ session }) => {
                    await session.query({ text: 'INSERT INTO items VALUES ($1)', values: ['kept'] });
                    return { ok: true, value: 'done' };
                } })).toEqual({ ok: true, value: 'done' });
                expect(await fixture.pool.transaction({ work: async ({ session }) => {
                    await session.query({ text: 'INSERT INTO items VALUES ($1)', values: ['discarded'] });
                    return denied;
                } })).toBe(denied);
                expect(fixture.rows()).toEqual(['kept']);
            } finally { fixture.close(); }
        });
        it('rolls back a root throw and leaves the owner usable', async () => {
            const fixture = required.create();
            const cause = new Error('root failure');
            try {
                await expect(fixture.pool.transaction({ work: async ({ session }) => {
                    await session.query({ text: 'INSERT INTO items VALUES ($1)', values: ['discarded'] });
                    throw cause;
                } })).rejects.toMatchObject({ code: 'transaction_failed', cause });
                expect(fixture.rows()).toEqual([]);
                expect(await fixture.pool.transaction({ work: async () => 'available' })).toBe('available');
            } finally { fixture.close(); }
        });
        it('joins the same session; the outer caller can handle a nested denial or throw', async () => {
            const fixture = required.create();
            try {
                await fixture.pool.transaction({ work: async ({ session }) => {
                    expect(await session.transaction({ work: async ({ session: joined }) => {
                        expect(joined).toBe(session);
                        await joined.query({ text: 'INSERT INTO items VALUES ($1)', values: ['nested'] });
                        return { ok: false };
                    } })).toEqual({ ok: false });
                    await expect(session.transaction({ work: async ({ session: joined }) => {
                        await joined.query({ text: 'INSERT INTO items VALUES ($1)', values: ['handled'] });
                        throw new Error('handled');
                    } })).rejects.toThrow('handled');
                    return { ok: true };
                } });
                expect(fixture.rows()).toEqual(['nested', 'handled']);
                await fixture.pool.transaction({ work: ({ session }) => session.transaction({ work: async ({ session: joined }) => {
                    await joined.query({ text: 'INSERT INTO items VALUES ($1)', values: ['denied'] });
                    return { ok: false };
                } }) });
                expect(fixture.rows()).toEqual(['nested', 'handled']);
            } finally { fixture.close(); }
        });
        it('rolls back joined writes when a nested throw reaches the root', async () => {
            const fixture = required.create();
            const cause = new Error('nested failure');
            try {
                await expect(fixture.pool.transaction({ work: ({ session }) => session.transaction({ work: async ({ session: joined }) => {
                    await joined.query({ text: 'INSERT INTO items VALUES ($1)', values: ['discarded'] });
                    throw cause;
                } }) })).rejects.toMatchObject({ code: 'transaction_failed', cause });
                expect(fixture.rows()).toEqual([]);
            } finally { fixture.close(); }
        });
        it('rejects overlap and both retained session entry points', async () => {
            const fixture = required.create();
            let retained: SqlSession | undefined;
            try {
                await fixture.pool.transaction({ work: async ({ session }) => {
                    retained = session;
                    await expect(fixture.pool.transaction({ work: async () => 1 })).rejects.toMatchObject({ code: 'connect_failed' });
                    return 2;
                } });
                expect(retained).toBeDefined();
                await expect(retained!.query({ text: 'INSERT INTO items VALUES ($1)', values: ['late'] })).rejects.toMatchObject({ code: 'connection_released' });
                await expect(retained!.transaction({ work: async () => 3 })).rejects.toMatchObject({ code: 'connection_released' });
                expect(fixture.rows()).toEqual([]);
            } finally { fixture.close(); }
        });
    });
}
transactionSuite({ name: 'memory', create: memoryHarness });
transactionSuite({ name: 'SQLite', create: sqliteHarness });

describe('checked SQLite decoding', () => {
    it('decodes safe integer endpoints and preserves non-integer cells', async () => {
        const database = new Database(':memory:');
        const pool = createSqlitePool({ database, kernel: sqliteKernel(createCheckedSqliteClient({ database })) });
        try {
            const result = await pool.transaction({ work: ({ session }) => session.query({
                text: 'SELECT $1 AS minimum, $2 AS maximum, 42 AS count, 1.5 AS real, $3 AS text, $4 AS blob, NULL AS empty',
                values: [BigInt(Number.MIN_SAFE_INTEGER), BigInt(Number.MAX_SAFE_INTEGER), 'value', Buffer.from([1, 2])],
            }) });
            expect(result.rows).toEqual([{ minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER, count: 42, real: 1.5, text: 'value', blob: Buffer.from([1, 2]), empty: null }]);
        } finally { database.close(); }
    });
    it.each([9007199254740992n, -9007199254740992n])('rejects overflow %s without losing its typed code', async amount => {
        const database = new Database(':memory:');
        const pool = createSqlitePool({ database, kernel: sqliteKernel(createCheckedSqliteClient({ database })) });
        try {
            const client = await pool.connect();
            await expect(client.query({ text: 'SELECT $1 AS amount', values: [amount] })).rejects.toMatchObject({ code: 'unsafe_integer' });
            client.release({});
            await expect(pool.transaction({ work: ({ session }) => session.query({ text: 'SELECT $1 AS amount', values: [amount] }) })).rejects.toMatchObject({ code: 'transaction_failed', cause: { code: 'unsafe_integer' } });
        } finally { database.close(); }
    });
});

describe('kernel ownership and cleanup', () => {
    it('fails closed when a SQLite pool omits its kernel', async () => {
        const pool: PgPool = { dialect: 'sqlite', async connect() { throw new Error('must not connect'); } };
        await expect(withTransaction({ pool, work: async () => 1 })).rejects.toMatchObject({ code: 'kernel_required' });
    });
    it('joins real Jini queries and rolls back both consumers on a root denial', async () => {
        const database = new Database(':memory:');
        const kernel = sqliteKernel(createCheckedSqliteClient({ database }));
        const pool = createSqlitePool({ database, kernel });
        database.exec('CREATE TABLE items (value TEXT)');
        const denied = { ok: false, error: { code: 'denied' } };
        try {
            expect(await pool.transaction({ work: async ({ session }) => {
                await session.query({ text: 'INSERT INTO items VALUES ($1)', values: ['OM'] });
                await kernel.transaction(() => kernel.execute(sql`INSERT INTO items VALUES (${'Jini'})`));
                expect(await kernel.query(sql`SELECT value FROM items ORDER BY rowid`)).toEqual([{ value: 'OM' }, { value: 'Jini' }]);
                return denied;
            } })).toBe(denied);
            expect(database.prepare('SELECT value FROM items').all()).toEqual([]);
            expect(database.inTransaction).toBe(false);
        } finally { database.close(); }
    });
    it('applies the same checked integer rule to actual Kysely reads and native iteration', async () => {
        const database = new Database(':memory:');
        const client = createCheckedSqliteClient({ database });
        const kernel = sqliteKernel(client);
        try {
            expect(await kernel.query(sql`SELECT ${BigInt(Number.MAX_SAFE_INTEGER)} AS maximum, 42 AS count`)).toEqual([{ maximum: Number.MAX_SAFE_INTEGER, count: 42 }]);
            await expect(kernel.query(sql`SELECT ${9007199254740992n} AS overflow`)).rejects.toMatchObject({ code: 'unsafe_integer' });
            expect([...client.prepare('SELECT 42 AS count').iterate()]).toEqual([{ count: 42 }]);
            expect(() => [...client.prepare('SELECT 9007199254740992 AS overflow').iterate()]).toThrow(expect.objectContaining({ code: 'unsafe_integer' }));
            client.exec('CREATE TABLE items (value TEXT)');
            expect(client.prepare('INSERT INTO items VALUES (?)').run('kept')).toEqual({ changes: 1, lastInsertRowid: 1 });
            client.close();
            expect(database.open).toBe(true);
        } finally { database.close(); }
    });
    it.each(['denial', 'throw'])('quarantines a failed kernel rollback after %s and retains both causes', async mode => {
        const database = new Database(':memory:');
        const nativeExec = database.exec.bind(database);
        const rollbackFailure = new Error('rollback failed');
        const original = mode === 'denial' ? { ok: false, error: { code: 'denied' } } : new Error('body failed');
        const pool = createSqlitePool({ database, kernel: sqliteKernel(createCheckedSqliteClient({ database })) });
        const spy = vi.spyOn(database, 'exec').mockImplementation(source => {
            if (source === 'ROLLBACK') throw rollbackFailure;
            return nativeExec(source);
        });
        try {
            await expect(pool.transaction({ work: async () => {
                if (mode === 'throw') throw original;
                return original;
            } })).rejects.toMatchObject({ code: 'rollback_failed', cause: { errors: [original, expect.objectContaining({ code: 'rollback_failed', cause: rollbackFailure })] } });
            await expect(pool.connect()).rejects.toMatchObject({ code: 'connection_unavailable' });
        } finally { spy.mockRestore(); database.close(); }
    });
    it('commits the returned value on one lease and releases it once', async () => {
        const database = new Database(':memory:');
        const base = createSqlitePool({ database, kernel: sqliteKernel(createCheckedSqliteClient({ database })) });
        const release = vi.fn();
        const connect = vi.fn(async () => {
            const client = await base.connect();
            return { ...client, release(input: { destroy?: boolean }) { release(input); client.release(input); } };
        });
        try {
            expect(await withTransaction({ pool: { ...base, connect }, work: async tx => {
                const result = await tx.query({ text: 'SELECT 42 AS value' });
                return result.rows[0].value;
            } })).toBe(42);
            expect(connect).toHaveBeenCalledTimes(1);
            expect(release.mock.calls).toEqual([[{ destroy: undefined }]]);
            expect(database.inTransaction).toBe(false);
            expect(await base.transaction({ work: async () => 'available' })).toBe('available');
        } finally { database.close(); }
    });
    it.each(['denial', 'throw', 'commit'])('preserves %s precedence when release also fails', async mode => {
        const database = new Database(':memory:');
        database.exec('CREATE TABLE items (value TEXT)');
        const base = createSqlitePool({ database, kernel: sqliteKernel(createCheckedSqliteClient({ database })) });
        const original = mode === 'throw' ? new Error('body failed') : { ok: false, error: { code: 'denied' } };
        const cleanup = new Error('release failed');
        const release = vi.fn();
        const pool: PgPool = { ...base, async connect() {
            const client = await base.connect();
            return { ...client, release(input) { release(input); client.release(input); throw cleanup; } };
        } };
        try {
            const result = withTransaction({ pool, work: async tx => {
                await tx.query({ text: 'INSERT INTO items VALUES ($1)', values: ['written'] });
                if (mode === 'throw') throw original;
                return mode === 'commit' ? 42 : original;
            } });
            const primary = mode === 'throw' ? expect.objectContaining({ code: 'transaction_failed', cause: original }) : original;
            await expect(result).rejects.toMatchObject(mode === 'commit'
                ? { code: 'release_after_commit', cause: cleanup }
                : { code: 'release_after_failure', cause: { errors: [primary, cleanup] } });
            expect(database.prepare('SELECT value FROM items').all()).toEqual(mode === 'commit' ? [{ value: 'written' }] : []);
            expect(release.mock.calls).toEqual([[{ destroy: undefined }]]);
            expect(database.inTransaction).toBe(false);
        } finally { database.close(); }
    });
    it('rejects timeout overrides before acquiring a lease', async () => {
        const database = new Database(':memory:');
        const base = createSqlitePool({ database, kernel: sqliteKernel(createCheckedSqliteClient({ database })) });
        const connect = vi.spyOn(base, 'connect');
        const work = vi.fn(async () => 1);
        try {
            for (const options of [{ statementTimeoutMs: 0 }, { statementTimeoutMs: 1 }, { lockTimeoutMs: Infinity }]) {
                await expect(withTransaction({ pool: base, work }, options)).rejects.toMatchObject({ code: 'unsupported_timeout' });
            }
            expect(connect).not.toHaveBeenCalled();
            expect(work).not.toHaveBeenCalled();
        } finally { database.close(); }
    });
    it('preserves committed rows and quarantines an uncertain COMMIT without retry', async () => {
        const database = new Database(':memory:');
        database.exec('CREATE TABLE items (value TEXT)');
        const nativeExec = database.exec.bind(database);
        const pool = createSqlitePool({ database, kernel: sqliteKernel(createCheckedSqliteClient({ database })) });
        const spy = vi.spyOn(database, 'exec').mockImplementation(source => {
            nativeExec(source);
            if (source === 'COMMIT') throw new Error('connection lost after commit');
            return database;
        });
        let bodies = 0;
        try {
            await expect(pool.transaction({ work: async ({ session }) => {
                bodies++;
                await session.query({ text: 'INSERT INTO items VALUES ($1)', values: ['committed'] });
                return { ok: true };
            } })).rejects.toMatchObject({ code: 'commit_failed' });
            expect(bodies).toBe(1);
            expect(database.prepare('SELECT value FROM items').all()).toEqual([{ value: 'committed' }]);
            await expect(pool.connect()).rejects.toMatchObject({ code: 'connection_unavailable' });
        } finally { spy.mockRestore(); database.close(); }
    });
    it('does not run work after the kernel BEGIN fails', async () => {
        const database = new Database(':memory:');
        const nativeExec = database.exec.bind(database);
        const pool = createSqlitePool({ database, kernel: sqliteKernel(createCheckedSqliteClient({ database })) });
        const spy = vi.spyOn(database, 'exec').mockImplementation(source => {
            if (source === 'BEGIN IMMEDIATE') throw new Error('begin failed');
            return nativeExec(source);
        });
        let ran = false;
        try {
            await expect(pool.transaction({ work: async () => { ran = true; } })).rejects.toMatchObject({ code: 'query_failed' });
            expect(ran).toBe(false);
            expect(database.inTransaction).toBe(false);
            await expect(pool.connect()).rejects.toMatchObject({ code: 'connection_unavailable' });
        } finally { spy.mockRestore(); database.close(); }
    });
    it('retains COMMIT failure when the kernel rollback also fails', async () => {
        const database = new Database(':memory:');
        const nativeExec = database.exec.bind(database);
        const commitFailure = new Error('commit failed');
        const rollbackFailure = new Error('rollback failed');
        const pool = createSqlitePool({ database, kernel: sqliteKernel(createCheckedSqliteClient({ database })) });
        const spy = vi.spyOn(database, 'exec').mockImplementation(source => {
            if (source === 'COMMIT') throw commitFailure;
            if (source === 'ROLLBACK') throw rollbackFailure;
            return nativeExec(source);
        });
        try {
            await expect(pool.transaction({ work: async () => 'done' })).rejects.toMatchObject({ code: 'rollback_failed', cause: { errors: [expect.objectContaining({ code: 'commit_failed', cause: commitFailure }), rollbackFailure] } });
            await expect(pool.connect()).rejects.toMatchObject({ code: 'connection_unavailable' });
        } finally { spy.mockRestore(); database.close(); }
    });
    it('rolls back a Kysely write whose result contains an unsafe rowid', async () => {
        const database = new Database(':memory:');
        database.exec('CREATE TABLE items (value TEXT)');
        const kernel = sqliteKernel(createCheckedSqliteClient({ database }));
        const pool = createSqlitePool({ database, kernel });
        try {
            await expect(pool.transaction({ work: () => kernel.execute(sql`INSERT INTO items (rowid, value) VALUES (${9007199254740992n}, ${'discarded'})`) })).rejects.toMatchObject({ code: 'transaction_failed', cause: { code: 'unsafe_integer' } });
            expect(database.prepare('SELECT value FROM items').all()).toEqual([]);
        } finally { database.close(); }
    });
});

describe('single-handle contention (B3 regression)', () => {
    /** Two roots held open by gates; the second must wait its turn, never fail or join the first. */
    it('queues concurrent roots FIFO on one handle, commits each alone, and fails a nested root fast', async () => {
        const database = new Database(':memory:');
        const kernel = sqliteKernel(createCheckedSqliteClient({ database }));
        const pool = createSqlitePool({ database, kernel });
        database.exec('CREATE TABLE items (value TEXT)');
        const entered = Promise.withResolvers<void>();
        const gate = Promise.withResolvers<void>();
        const order: string[] = [];
        let nested: unknown;
        try {
            const first = pool.transaction({ work: async ({ session }) => {
                await session.query({ text: 'INSERT INTO items VALUES ($1)', values: ['first'] });
                nested = await withTransaction({ pool, work: async () => 'nested' }).catch((cause: unknown) => cause);
                entered.resolve();
                await gate.promise;
                order.push('first');
                return { ok: false, error: { code: 'denied' } };
            } });
            await entered.promise;
            const roots = ['second', 'third'].map(value => pool.transaction({ work: async ({ session }) => {
                expect(database.prepare('SELECT value FROM items').all()).not.toContainEqual({ value: 'first' });
                await session.query({ text: 'INSERT INTO items VALUES ($1)', values: [value] });
                order.push(value);
                return value;
            } }));
            expect(nested).toMatchObject({ code: 'connect_failed', cause: { code: 'connection_busy' } });
            expect(database.prepare('SELECT value FROM items').all()).toEqual([{ value: 'first' }]);
            gate.resolve();
            expect(await first).toMatchObject({ ok: false });
            expect(await Promise.all(roots)).toEqual(['second', 'third']);
            expect(order).toEqual(['first', 'second', 'third']);
            expect(database.prepare('SELECT value FROM items ORDER BY rowid').all()).toEqual([{ value: 'second' }, { value: 'third' }]);
            expect(database.inTransaction).toBe(false);
        } finally { gate.resolve(); database.close(); }
    });
    it('drains queued roots with connection_unavailable when the holder quarantines the handle', async () => {
        const database = new Database(':memory:');
        const pool = createSqlitePool({ database, kernel: sqliteKernel(createCheckedSqliteClient({ database })) });
        try {
            const client = await pool.connect();
            const queued = [pool.connect(), withTransaction({ pool, work: async () => 'never' })];
            client.release({ destroy: true });
            await expect(queued[0]).rejects.toMatchObject({ code: 'connection_unavailable' });
            await expect(queued[1]).rejects.toMatchObject({ code: 'connect_failed', cause: { code: 'connection_unavailable' } });
        } finally { database.close(); }
    });
});

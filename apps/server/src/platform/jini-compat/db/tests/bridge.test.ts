import Database from 'better-sqlite3';
import type { SqlSession, UnitOfWork } from '@open-marketing/contracts';
import { describe, expect, it } from 'vitest';
import { createSqlitePool } from '../src/sqlite.js';
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
        pool: createSqlitePool({ database }),
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
        const pool = createSqlitePool({ database });
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
        const pool = createSqlitePool({ database });
        try {
            const client = await pool.connect();
            await expect(client.query({ text: 'SELECT $1 AS amount', values: [amount] })).rejects.toMatchObject({ code: 'unsafe_integer' });
            client.release({});
            await expect(pool.transaction({ work: ({ session }) => session.query({ text: 'SELECT $1 AS amount', values: [amount] }) })).rejects.toMatchObject({ code: 'transaction_failed', cause: { code: 'unsafe_integer' } });
        } finally { database.close(); }
    });
});

describe('failed Outcome cleanup', () => {
    it('quarantines a failed rollback and preserves failed-Outcome release precedence', async () => {
        const denied = { ok: false, error: { code: 'denied' } };
        const released: Array<boolean | undefined> = [];
        const statements: string[] = [];
        let failRollback = true;
        const pool: PgPool = { dialect: 'sqlite', async connect() { return {
            async query<Row extends Record<string, unknown>>({ text }: { text: string }) {
                statements.push(text);
                if (text === 'ROLLBACK' && failRollback) throw new Error('rollback failed');
                return { rows: [] as Row[], rowCount: null };
            },
            release({ destroy }) {
                released.push(destroy);
                if (!failRollback) throw new Error('release failed');
            },
        }; } };
        await expect(withTransaction({ pool, work: async () => denied })).rejects.toMatchObject({ code: 'rollback_failed' });
        expect(statements).toEqual(['BEGIN IMMEDIATE', 'ROLLBACK']);
        expect(released).toEqual([true]);
        failRollback = false;
        await expect(withTransaction({ pool, work: async () => denied })).rejects.toMatchObject({ code: 'release_after_failure', cause: { errors: [denied, expect.any(Error)] } });
        expect(released).toEqual([true, undefined]);
    });
});

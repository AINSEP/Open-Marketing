import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'kysely';
import { describe, expect, it, vi } from 'vitest';
import type { SqlSession } from '@open-marketing/contracts';
import { createSqliteFixture } from '../src/testing.js';

const migrations = ['CREATE TABLE items (value TEXT)'];

describe('shared checked SQLite fixture', () => {
    it('binds repeated parameters without rewriting literals and checks OM/Jini integers', async () => {
        const fixture = createSqliteFixture({ migrations });
        try {
            expect(await fixture.database.query({ text: "SELECT $1 AS value, $1 AS repeated, '$2' AS literal", values: ['bound'] }))
                .toEqual({ rows: [{ value: 'bound', repeated: 'bound', literal: '$2' }], rowCount: 1 });
            const amount = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
            await expect(fixture.database.query({ text: 'SELECT $1 AS value', values: [amount] }))
                .rejects.toMatchObject({ code: 'transaction_failed', cause: { code: 'unsafe_integer' } });
            await expect(fixture.kernel.run(db => sql`SELECT ${amount} AS value`.execute(db)))
                .rejects.toMatchObject({ code: 'unsafe_integer' });
            expect((await fixture.database.query({ text: 'SELECT $1 AS value', values: [Number.MAX_SAFE_INTEGER] })).rows)
                .toEqual([{ value: Number.MAX_SAFE_INTEGER }]);
        } finally { fixture.close(); }
    });
    it('joins OM and Jini writes, rolls back denials, and expires both session entry points', async () => {
        const fixture = createSqliteFixture({ migrations });
        let borrowed: SqlSession | undefined;
        const denied = { ok: false, error: { code: 'forbidden' } };
        try {
            expect(await fixture.database.transaction({ work: async ({ session }) => {
                borrowed = session;
                await session.transaction({ work: ({ session: joined }) => joined.query({ text: 'INSERT INTO items VALUES ($1)', values: ['OM'] }) });
                await fixture.kernel.transaction(() => fixture.kernel.run(db => sql`INSERT INTO items VALUES (${'Jini'})`.execute(db)));
                return denied;
            } })).toBe(denied);
            expect(fixture.native.prepare('SELECT * FROM items').all()).toEqual([]);
            await expect(borrowed!.query({ text: 'SELECT 1' })).rejects.toMatchObject({ code: 'connection_released' });
            await expect(borrowed!.transaction({ work: async () => 1 })).rejects.toMatchObject({ code: 'connection_released' });
        } finally { fixture.close(); }
    });
    it('serializes roots and keeps the query fault hook on joined sessions', async () => {
        let reject = true;
        const fault = new Error('fixture query failure');
        const fixture = createSqliteFixture({ migrations }, { beforeQuery(input) {
            if (reject && input.values?.[0] === 'rejected') throw fault;
        } });
        const entered = Promise.withResolvers<void>();
        const barrier = Promise.withResolvers<void>();
        const started: string[] = [];
        const first = fixture.database.transaction({ work: async ({ session }) => {
            started.push('first'); entered.resolve(); await barrier.promise;
            await session.query({ text: 'INSERT INTO items VALUES ($1)', values: ['discarded'] });
            return session.transaction({ work: ({ session: joined }) => joined.query({ text: 'INSERT INTO items VALUES ($1)', values: ['rejected'] }) });
        } });
        const rejection = expect(first).rejects.toMatchObject({ code: 'transaction_failed', cause: fault });
        const second = fixture.database.transaction({ work: ({ session }) => {
            started.push('second');
            return session.query({ text: 'INSERT INTO items VALUES ($1)', values: ['kept'] });
        } });
        try {
            await entered.promise;
            expect(started).toEqual(['first']);
            barrier.resolve();
            await rejection; await second;
            reject = false;
            await fixture.database.query({ text: 'INSERT INTO items VALUES ($1)', values: ['rejected'] });
            expect(started).toEqual(['first', 'second']);
            expect(fixture.native.prepare('SELECT * FROM items ORDER BY rowid').all()).toEqual([{ value: 'kept' }, { value: 'rejected' }]);
        } finally { barrier.resolve(); await Promise.allSettled([first, second]); fixture.close(); }
    });
    it('closes setup failures and allows repeated close', () => {
        const close = vi.spyOn(Database.prototype, 'close');
        try {
            expect(() => createSqliteFixture({ migrations: [...migrations, 'INVALID SQL'] })).toThrow();
            expect(close).toHaveBeenCalledTimes(1);
            expect((close.mock.contexts[0] as Database.Database).open).toBe(false);
            const fixture = createSqliteFixture({ migrations });
            fixture.close(); fixture.close();
            expect(fixture.native.open).toBe(false);
        } finally { close.mockRestore(); }
    });
    it('reopens a temporary file without replaying migrations', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'om-db-fixture-'));
        const filename = join(directory, 'fixture.sqlite');
        let fixture = createSqliteFixture({ migrations }, { filename });
        try {
            await fixture.database.query({ text: 'INSERT INTO items VALUES ($1)', values: ['durable'] });
            fixture.close();
            fixture = createSqliteFixture({ migrations: [] }, { filename });
            expect((await fixture.database.query({ text: 'SELECT * FROM items' })).rows).toEqual([{ value: 'durable' }]);
        } finally { fixture.close(); rmSync(directory, { recursive: true, force: true }); }
    });
});

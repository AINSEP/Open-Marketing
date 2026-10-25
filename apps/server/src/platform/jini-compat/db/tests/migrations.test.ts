import { sqliteKernel } from '@jini-ai/db/kernel/sqlite';
import Database from 'better-sqlite3';
import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { loadMigrations, migrationManifest } from '../../../../composition/migrations.js';
import { createCheckedSqliteClient, createSqlitePool } from '../src/sqlite.js';
import { prepareMigrations, runMigrations } from '../src/migrations.js';

describe('trusted migration scripts and catalogue', () => {
    it('runs commented multi-statement scripts and replays without duplicate writes', async () => {
        const database = new Database(':memory:');
        const pool = createSqlitePool({ database, kernel: sqliteKernel(createCheckedSqliteClient({ database })) });
        const first = { version: 1, name: 'first', sql: '-- feature migration\nCREATE TABLE items (id TEXT); INSERT INTO items VALUES (\'one\');' };
        const second = { version: 2, name: 'second', sql: 'CREATE TABLE copied AS SELECT * FROM items;' };
        const migrations = [second, first];
        try {
            expect(await runMigrations({ pool, migrations })).toEqual({ appliedVersions: [1, 2] });
            expect(await runMigrations({ pool, migrations })).toEqual({ appliedVersions: [] });
            expect(database.prepare('SELECT * FROM items').all()).toEqual([{ id: 'one' }]);
            expect(database.prepare('SELECT * FROM copied').all()).toEqual([{ id: 'one' }]);
            expect(database.prepare('SELECT version, name, checksum FROM om_schema_migrations ORDER BY version').all()).toEqual(prepareMigrations({ migrations }).map(({ version, name, checksum }) => ({ version, name, checksum })));
            await expect(runMigrations({ pool, migrations: [first, { ...second, sql: second.sql + '\n-- drift' }] })).rejects.toMatchObject({ code: 'transaction_failed', cause: { code: 'migration_drift' } });
        } finally { database.close(); }
    });
    it('rolls back statements and ledger after a failure within one script', async () => {
        const database = new Database(':memory:');
        const pool = createSqlitePool({ database, kernel: sqliteKernel(createCheckedSqliteClient({ database })) });
        try {
            await expect(runMigrations({ pool, migrations: [{ version: 1, name: 'broken', sql: '-- comment\nCREATE TABLE items (id TEXT); INSERT INTO missing VALUES (1);' }] })).rejects.toMatchObject({ code: 'transaction_failed' });
            expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual([]);
            expect(await pool.transaction({ work: async () => 'available' })).toBe('available');
        } finally { database.close(); }
    });
    it.each(['gap', 'name', 'unknown'])('rejects %s history before pending SQL runs', async mode => {
        const database = new Database(':memory:');
        const pool = createSqlitePool({ database, kernel: sqliteKernel(createCheckedSqliteClient({ database })) });
        const first = { version: 1, name: 'first', sql: 'CREATE TABLE first (id TEXT)' };
        const second = { version: 2, name: 'second', sql: 'CREATE TABLE second (id TEXT)' };
        try {
            await runMigrations({ pool, migrations: [second] });
            if (mode === 'name') database.exec("UPDATE om_schema_migrations SET name = 'changed'");
            if (mode === 'unknown') database.exec('UPDATE om_schema_migrations SET version = 3');
            const migrations = mode === 'gap' ? [first, second] : [second, { ...first, version: 4 }];
            await expect(runMigrations({ pool, migrations })).rejects.toMatchObject({ code: 'transaction_failed', cause: { code: 'migration_drift' } });
            expect(database.prepare("SELECT name FROM sqlite_master WHERE name = 'first'").all()).toEqual([]);
            expect(database.prepare('SELECT COUNT(*) AS count FROM om_schema_migrations').get()).toEqual({ count: 1 });
            expect(database.inTransaction).toBe(false);
        } finally { database.close(); }
    });
    it('rejects duplicate and partially invalid batches before connecting', async () => {
        const database = new Database(':memory:');
        const pool = createSqlitePool({ database, kernel: sqliteKernel(createCheckedSqliteClient({ database })) });
        const connect = vi.spyOn(pool, 'connect');
        const first = { version: 1, name: 'first', sql: 'CREATE TABLE first (id TEXT)' };
        try {
            await expect(runMigrations({ pool, migrations: [first, first] })).rejects.toMatchObject({ code: 'duplicate_migration' });
            await expect(runMigrations({ pool, migrations: [first, { version: 2, name: 'second', sql: '' }] })).rejects.toMatchObject({ code: 'invalid_migration' });
            expect(connect).not.toHaveBeenCalled();
            expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual([]);
        } finally { database.close(); }
    });
    it('requires explicit script mode and forbids bound script values', async () => {
        const database = new Database(':memory:');
        const client = await createSqlitePool({ database, kernel: sqliteKernel(createCheckedSqliteClient({ database })) }).connect();
        try {
            await expect(client.query({ text: 'CREATE TABLE a (id TEXT); CREATE TABLE b (id TEXT);' })).rejects.toMatchObject({ code: 'query_failed' });
            await expect(client.query({ text: 'CREATE TABLE a (id TEXT)', script: true, values: ['bound'] })).rejects.toMatchObject({ code: 'invalid_parameter' });
            expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual([]);
        } finally { client.release({}); database.close(); }
    });
    it('fixes all twenty-two identities and global versions, excluding historical spine', async () => {
        const paths: string[] = [];
        const migrations = await loadMigrations({ readSql: async ({ path }) => { paths.push(path); return '-- fixture\nSELECT 1;'; } });
        expect(migrations.map(item => [item.version, item.name])).toEqual([
            [1, 'workspaces-1'], [2, 'policy-1'], [3, 'audit-1'], [4, 'audit-2'],
            [5, 'credentials-1'], [6, 'safety-1'], [7, 'jobs-1'], [8, 'media-library-1'],
            [9, 'creative-1'], [10, 'campaigns-1'], [11, 'measure-1'], [12, 'measure-2'],
            [13, 'forms-1'], [14, 'contacts-1'], [15, 'web-events-1'], [16, 'privacy-1'], [17, 'server-1'], [18, 'server-2'],
            [19, 'safety-2'], [20, 'server-3'], [21, 'server-4'], [22, 'server-5'],
        ]);
        expect(paths).toEqual(migrationManifest.map(item => item.path));
        expect(paths.join(' ')).not.toContain('spine');
        expect(() => prepareMigrations({ migrations: [migrations[0], migrations[0]] })).toThrow('Migration versions must be unique');
        await expect(loadMigrations({ readSql: async () => '' })).rejects.toMatchObject({ code: 'invalid_migration' });
    });
    it('rejects duplicate feature/local identities before reading SQL', async () => {
        const entries = migrationManifest as unknown as Array<typeof migrationManifest[number]>;
        entries.push(entries[0]);
        let reads = 0;
        try {
            await expect(loadMigrations({ readSql: async () => { reads++; return 'SELECT 1'; } })).rejects.toMatchObject({ code: 'duplicate_migration' });
            expect(reads).toBe(0);
        } finally { entries.pop(); }
    });
    it('loads and replays the actual feature catalogue on throwaway SQLite', async () => {
        const database = new Database(':memory:');
        database.pragma('foreign_keys = ON');
        const pool = createSqlitePool({ database, kernel: sqliteKernel(createCheckedSqliteClient({ database })) });
        const root = new URL('../../../../../../../', import.meta.url);
        try {
            const migrations = await loadMigrations({ readSql: ({ path }) => readFile(new URL(path, root), 'utf8') });
            expect(await runMigrations({ pool, migrations })).toEqual({ appliedVersions: migrationManifest.map(item => item.version) });
            expect(await runMigrations({ pool, migrations })).toEqual({ appliedVersions: [] });
            expect(database.prepare('SELECT COUNT(*) AS count FROM om_schema_migrations').get()).toEqual({ count: 22 });
        } finally { database.close(); }
    });
});

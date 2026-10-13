import { sqliteKernel } from '@jini-ai/db/kernel/sqlite';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { createCheckedSqliteClient, createSqlitePool, withTransaction, runMigrations, claimBatch } from '../../src/platform/jini-compat/db/src/index.js';

const handles: Database.Database[] = [];
function fixture() {
    const database = new Database(':memory:');
    handles.push(database);
    return { database, pool: createSqlitePool({ database, kernel: sqliteKernel(createCheckedSqliteClient({ database })) }) };
}
afterEach(() => { for (const database of handles.splice(0)) database.close(); });

describe('server-owned SQLite shim', () => {
    it('factory is inert and binds repeated $n without changing literals', async () => {
        const { pool, database } = fixture();
        expect(database.inTransaction).toBe(false);
        const result = await withTransaction({ pool, work: tx => tx.query({ text: "SELECT $1 AS value, $1 AS repeated, '$2' AS literal", values: ['bound'] }) });
        expect(result.rows).toEqual([{ value: 'bound', repeated: 'bound', literal: '$2' }]);
        expect(database.inTransaction).toBe(false);
    });
    it('commits multi-statement migration scripts and replays their checksummed ledger', async () => {
        const { pool, database } = fixture();
        const migrations = [{ version: 1, name: 'first', sql: 'CREATE TABLE items (id TEXT PRIMARY KEY); INSERT INTO items VALUES (\'one\');' }];
        expect(await runMigrations({ pool, migrations })).toEqual({ appliedVersions: [1] });
        expect(await runMigrations({ pool, migrations })).toEqual({ appliedVersions: [] });
        expect(database.prepare('SELECT id FROM items').all()).toEqual([{ id: 'one' }]);
        await expect(runMigrations({ pool, migrations: [{ ...migrations[0], sql: 'CREATE TABLE other (id TEXT)' }] })).rejects.toMatchObject({ cause: { code: 'migration_drift' } });
        expect(database.prepare('SELECT COUNT(*) AS count FROM om_schema_migrations').get()).toEqual({ count: 1 });
    });
    it('rolls back prior DDL and ledger rows when a later migration fails', async () => {
        const { pool, database } = fixture();
        await expect(runMigrations({ pool, migrations: [
            { version: 1, name: 'valid', sql: 'CREATE TABLE first (id TEXT)' },
            { version: 2, name: 'invalid', sql: 'INSERT INTO absent VALUES (1)' },
        ] })).rejects.toMatchObject({ code: 'transaction_failed' });
        expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual([]);
        expect(await withTransaction({ pool, work: async () => 'available' })).toBe('available');
    });
    it('rollback preserves the original cause and throwing telemetry cannot change a commit', async () => {
        const { pool, database } = fixture();
        database.exec('CREATE TABLE items (id TEXT)');
        const failure = new Error('body failure');
        await expect(withTransaction({ pool, work: async tx => { await tx.query({ text: 'INSERT INTO items VALUES ($1)', values: ['rolled-back'] }); throw failure; } })).rejects.toMatchObject({ code: 'transaction_failed', cause: failure });
        await withTransaction({ pool, work: tx => tx.query({ text: 'INSERT INTO items VALUES ($1)', values: ['committed'] }) }, { observer: () => { throw new Error('telemetry'); } });
        expect(database.prepare('SELECT id FROM items').all()).toEqual([{ id: 'committed' }]);
    });
    it('isolates scoped bounded claims and never reclaims an uncertain processing job', async () => {
        const { pool, database } = fixture();
        database.exec(`CREATE TABLE om_outbox (id TEXT, tenant_id TEXT, workspace_id TEXT, status TEXT,
            available_at TEXT, lease_until TEXT, attempts INTEGER, PRIMARY KEY (tenant_id, workspace_id, id));
            INSERT INTO om_outbox VALUES ('same', 't', 'w', 'pending', '2026-01-01', NULL, 0);
            INSERT INTO om_outbox VALUES ('same', 't', 'other', 'pending', '2026-01-01', NULL, 0);
            INSERT INTO om_outbox VALUES ('unknown', 't', 'w', 'processing', '2026-01-01', '2026-01-01', 1);`);
        const queue = { schema: 'om', table: 'outbox' };
        const input = { pool, queue, allowedTables: [queue], tenantId: 't', workspaceId: 'w', limit: 1,
            now: new Date('2026-01-02T00:00:00Z'), leaseUntil: new Date('2026-01-02T00:01:00Z') };
        expect((await claimBatch(input)).map(row => row.id)).toEqual(['same']);
        expect(await claimBatch(input)).toEqual([]);
        expect(database.prepare("SELECT attempts FROM om_outbox WHERE workspace_id = 'other'").get()).toEqual({ attempts: 0 });
        expect(database.prepare("SELECT attempts FROM om_outbox WHERE id = 'unknown'").get()).toEqual({ attempts: 1 });
    });
    it('rejects overlapping bodies before sharing a transaction and rejects use after release', async () => {
        const { pool } = fixture();
        const client = await pool.connect();
        await expect(withTransaction({ pool, work: async () => 1 })).rejects.toMatchObject({ code: 'connect_failed', cause: { code: 'connection_busy' } });
        client.release({});
        await expect(client.query({ text: 'SELECT 1' })).rejects.toMatchObject({ code: 'connection_released' });
        expect(await withTransaction({ pool, work: async () => 2 })).toBe(2);
    });
    it('quarantines uncertain handles and rejects unsupported bound values', async () => {
        const { pool } = fixture();
        await expect(withTransaction({ pool, work: tx => tx.query({ text: 'SELECT $1', values: [{}] }) })).rejects.toMatchObject({ code: 'transaction_failed' });
        const client = await pool.connect();
        client.release({ destroy: true });
        await expect(pool.connect()).rejects.toMatchObject({ code: 'connection_unavailable' });
    });
    it('rejects integers beyond the JavaScript safe-integer limit', async () => {
        const { pool } = fixture();
        const amount = 9007199254740993n;
        await expect(withTransaction({ pool, work: tx => tx.query({ text: 'SELECT $1 AS amount', values: [amount] }) })).rejects.toMatchObject({ code: 'transaction_failed', cause: { code: 'unsafe_integer' } });
    });
    it('rejects unsupported per-transaction timeout overrides before doing work', async () => {
        const { pool, database } = fixture();
        await expect(withTransaction({ pool, work: async () => 1 }, { statementTimeoutMs: 1 })).rejects.toMatchObject({ code: 'unsupported_timeout' });
        expect(database.inTransaction).toBe(false);
        expect(await withTransaction({ pool, work: async () => 'usable' })).toBe('usable');
    });
});

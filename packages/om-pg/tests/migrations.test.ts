import { describe, expect, it } from 'vitest';
import { prepareMigrations, runMigrations } from '../src/migrations.js';
import { FakeClient } from './fake-client.js';

const first = { version: 1, name: 'first', sql: 'CREATE TABLE first (id int)' };
const second = { version: 2, name: 'second', sql: 'CREATE TABLE second (id int)' };

describe('migration runner', () => {
  it('sorts a complete batch, locks before reading and records each applied SQL', async () => {
    const client = new FakeClient();
    expect(await runMigrations({ pool: client.pool, migrations: [second, first] }))
      .toEqual({ appliedVersions: [1, 2] });
    const sql = client.statements.map((q) => q.text);
    expect(sql.indexOf('SELECT pg_advisory_xact_lock(1879444839, 1)')).toBeLessThan(sql.indexOf('CREATE SCHEMA IF NOT EXISTS om'));
    expect(sql.indexOf(first.sql)).toBeLessThan(sql.indexOf(second.sql));
    expect(client.statements.filter((q) => q.text.startsWith('INSERT INTO')).map((q) => q.values[0])).toEqual(['1', '2']);
    expect(sql.at(-1)).toBe('COMMIT');
  });

  it('skips exactly matching applied migrations on replay', async () => {
    const client = new FakeClient();
    const [prepared] = prepareMigrations({ migrations: [first] });
    client.rows = [{ version: '1', name: first.name, checksum: prepared.checksum }];
    expect(await runMigrations({ pool: client.pool, migrations: [first] })).toEqual({ appliedVersions: [] });
    expect(client.statements.some((q) => q.text === first.sql)).toBe(false);
  });

  it('rejects drift and out-of-order insertion before running any migration SQL', async () => {
    const client = new FakeClient();
    const [prepared] = prepareMigrations({ migrations: [second] });
    client.rows = [{ version: '2', name: second.name, checksum: prepared.checksum }];
    await expect(runMigrations({ pool: client.pool, migrations: [first, second] }))
      .rejects.toMatchObject({ cause: { code: 'migration_drift' } });
    expect(client.statements.some((q) => q.text === first.sql)).toBe(false);
    expect(client.statements.at(-1)?.text).toBe('ROLLBACK');
  });

  it('rejects duplicate and partially invalid input before connecting', async () => {
    const client = new FakeClient();
    await expect(runMigrations({ pool: client.pool, migrations: [first, first] }))
      .rejects.toMatchObject({ code: 'duplicate_migration' });
    await expect(runMigrations({ pool: client.pool, migrations: [first, { ...second, sql: '' }] }))
      .rejects.toMatchObject({ code: 'invalid_migration' });
    expect(client.statements).toEqual([]);
  });

  it('rolls back earlier migrations and ledger inserts on later failure', async () => {
    const client = new FakeClient();
    client.failures.set(second.sql, new Error('DDL rejected'));
    await expect(runMigrations({ pool: client.pool, migrations: [first, second] })).rejects.toThrow();
    expect(client.statements.at(-1)?.text).toBe('ROLLBACK');
    expect(client.statements.some((q) => q.text === 'COMMIT')).toBe(false);
  });
});

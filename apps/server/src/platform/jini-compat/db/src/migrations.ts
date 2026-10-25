import { sourceChecksum } from '@jini-ai/db/migrate';
import { PgFoundationError, type PgPool, type PgQueryable } from './ports.js';
import { withTransaction, type TransactionOptions } from './transaction.js';
/** Trusted, transaction-compatible SQL only: no transaction control, concurrent indexes or external effects. */
export interface Migration {
    version: number;
    name: string;
    sql: string;
}
/** Exact UTF-8 SQL checksum; changing an applied migration is rejected, not silently repaired. */
export interface PreparedMigration extends Migration {
    checksum: string;
}
/** Validate and snapshot the whole batch before opening a connection. No partial-valid batches execute.
 * @example prepareMigrations({ migrations: [{ version: 1, name: 'spine', sql: 'CREATE TABLE ...' }] });
 * @throws PgFoundationError on duplicate, invalid or oversized inputs.
 * @complexity O(n log n + b) time and O(n + b) space, n <= 1000 migrations, b <= 16 MiB SQL.
 *
 */
export function prepareMigrations({ migrations }: {
    migrations: readonly Migration[];
}): PreparedMigration[] {
    if (migrations.length > 1000)
        throw new PgFoundationError({ code: 'invalid_migration', message: 'At most 1000 migrations are supported' });
    const prepared = migrations.map(prepareMigration).sort((a, b) => a.version - b.version);
    const versions = new Set(prepared.map((migration) => migration.version));
    if (versions.size !== prepared.length)
        throw new PgFoundationError({ code: 'duplicate_migration', message: 'Migration versions must be unique' });
    const totalBytes = prepared.reduce((sum, migration) => sum + Buffer.byteLength(migration.sql), 0);
    if (totalBytes > 16 * 1024 * 1024)
        throw new PgFoundationError({ code: 'invalid_migration', message: 'Migration batch exceeds 16 MiB' });
    return prepared;
}
/** Hash a validated migration without trusting caller-provided digests.
 * @complexity O(b) time/space for b <= 1 MiB SQL.
 */
function prepareMigration(migration: Migration): PreparedMigration {
    if (!Number.isSafeInteger(migration.version) || migration.version < 1) {
        throw new PgFoundationError({ code: 'invalid_migration', message: 'Migration version must be a positive safe integer' });
    }
    if (!/^[a-z][a-z0-9_-]{0,99}$/.test(migration.name)) {
        throw new PgFoundationError({ code: 'invalid_migration', message: 'Migration name must be a short lowercase identifier' });
    }
    if (!migration.sql.trim() || Buffer.byteLength(migration.sql) > 1024 * 1024) {
        throw new PgFoundationError({ code: 'invalid_migration', message: 'Migration SQL must contain 1 byte to 1 MiB' });
    }
    return { ...migration, checksum: sourceChecksum(migration.sql) };
}
interface AppliedMigration extends Record<string, unknown> {
    version: string;
    name: string;
    checksum: string;
}
/** Require applied history to be an exact prefix of this release's ordered migration set.
 * @complexity O(n), O(1) auxiliary space; history bounded to 1001 rows.
 */
function verifyHistory({ applied, migrations }: {
    applied: AppliedMigration[];
    migrations: PreparedMigration[];
}): void {
    for (let index = 0; index < applied.length; index++) {
        const expected = migrations[index];
        const actual = applied[index];
        if (!expected || String(expected.version) !== String(actual.version) || expected.name !== actual.name || expected.checksum !== actual.checksum) {
            throw new PgFoundationError({ code: 'migration_drift', message: 'Applied migration history does not match this release' });
        }
    }
}
/** SQLite's BEGIN IMMEDIATE serializes migration runners; future Postgres callers must serialize them too.
 * @complexity O(n) database round trips for n pending migrations, bounded by prepareMigrations.
 *
 *
 */
async function applyMigrations({ tx, migrations }: {
    tx: PgQueryable;
    migrations: PreparedMigration[];
}): Promise<number[]> {
    await tx.query({ text: `CREATE TABLE IF NOT EXISTS om_schema_migrations (
    version bigint PRIMARY KEY CHECK (version > 0), name text NOT NULL,
    checksum text NOT NULL CHECK (length(checksum) = 64),
    applied_at text NOT NULL DEFAULT CURRENT_TIMESTAMP
  )` });
    const { rows } = await tx.query<AppliedMigration>({ text: 'SELECT version, name, checksum FROM om_schema_migrations ORDER BY version LIMIT 1001' });
    verifyHistory({ applied: rows, migrations: migrations });
    const pending = migrations.slice(rows.length);
    for (const migration of pending) {
        await tx.query({ text: migration.sql, script: true });
        await tx.query({ text: 'INSERT INTO om_schema_migrations (version, name, checksum) VALUES ($1, $2, $3)', values: [String(migration.version), migration.name, migration.checksum] });
    }
    return pending.map((migration) => migration.version);
}
/** Atomically apply the full release migration set, recording checksums in the same transaction.
 * Supply ALL historical migrations on every run. Failure rolls back schema and ledger together.
 * @example await runMigrations({ pool, migrations: [{ version: 1, name: 'spine', sql }] });
 * @throws PgFoundationError; a transaction_failed cause may be migration_drift.
 * @complexity O(n log n + b) preprocessing and O(n) queries, bounded at 1000 migrations / 16 MiB.
 *
 *
 */
export async function runMigrations({ pool, migrations }: {
    pool: PgPool;
    migrations: readonly Migration[];
}, options: TransactionOptions = {}): Promise<{
    appliedVersions: number[];
}> {
    const prepared = prepareMigrations({ migrations });
    const appliedVersions = await withTransaction({ pool, work: (tx: PgQueryable) => applyMigrations({ tx: tx, migrations: prepared }) }, options);
    return { appliedVersions };
}

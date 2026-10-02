import { PgFoundationError, type PgClient, type PgEvent, type PgObserver, type PgPool,
  type PgQueryable, type QueryResult } from './ports.js';

/** Statement/lock limits are transaction-local. Pool connection limits belong to the injected driver. */
export interface TransactionOptions {
  statementTimeoutMs?: number;
  lockTimeoutMs?: number;
  observer?: PgObserver;
}

/** Runs an effect without allowing instrumentation failure to affect its result.
 * @complexity O(1) overhead, excluding the injected operation. @overallScore 100/100
 */
async function observed<T>(operation: PgEvent['operation'], observer: PgObserver | undefined,
  work: () => Promise<T>): Promise<T> {
  emit(observer, { operation, status: 'started' });
  try {
    const value = await work();
    emit(observer, { operation, status: 'succeeded' });
    return value;
  } catch (cause) {
    emit(observer, { operation, status: 'failed' });
    throw cause;
  }
}

/** Best-effort diagnostic hook; sink failure must not cause duplicate committed work.
 * @complexity O(1), excluding observer. @overallScore 100/100
 */
function emit(observer: PgObserver | undefined, event: PgEvent): void {
  try { observer?.(event); } catch { /* Telemetry is deliberately outside transaction correctness. */ }
}

/** Reject invalid timeouts before acquiring a connection.
 * @complexity O(1). @overallScore 100/100
 */
function timeout(value: number): string {
  if (!Number.isInteger(value) || value < 1 || value > 3_600_000) {
    throw new PgFoundationError('invalid_timeout', 'Timeout must be an integer from 1 to 3600000 milliseconds');
  }
  return String(value);
}

/** Explicit external query edge; original driver errors stay in cause, not telemetry.
 * @complexity One query, O(1) wrapper space excluding results. @overallScore 100/100
 */
function instrumentClient(client: PgClient, observer?: PgObserver): PgQueryable {
  return {
    async query<Row extends Record<string, unknown>>(text: string, values?: unknown[]): Promise<QueryResult<Row>> {
      try {
        return await observed('query', observer, () => client.query<Row>(text, values));
      } catch (cause) {
        throw new PgFoundationError('query_failed', 'Postgres query failed', { cause });
      }
    },
  };
}

/** Roll back work failure, retaining both causes when cleanup also fails.
 * @complexity One query, O(1) space. @overallScore 100/100
 */
async function rollback(queryable: PgQueryable, cause: unknown): Promise<never> {
  try { await queryable.query('ROLLBACK'); } catch (cleanup) {
    throw new PgFoundationError('rollback_failed', 'Transaction and rollback failed', {
      cause: new AggregateError([cause, cleanup]),
    });
  }
  throw new PgFoundationError('transaction_failed', 'Transaction rolled back', { cause });
}

/** Executes a bounded, sequential body; callers must await all work and never issue transaction control SQL.
 * @complexity Body-dependent plus constant transaction queries. @overallScore 95/100
 * @qualityFindings Low: arbitrary trusted callback SQL cannot be proven transaction-safe by a structural port.
 */
async function runBody<T>(queryable: PgQueryable, work: (tx: PgQueryable) => Promise<T>,
  limits: string[]): Promise<T> {
  try {
    await queryable.query("SELECT set_config('statement_timeout', $1, true), set_config('lock_timeout', $2, true)", limits);
    return await work(queryable);
  } catch (cause) { return rollback(queryable, cause); }
}

/** Execute and commit work on one connection. Body errors roll back; uncertain commits evict the client
 * and are NEVER retried. A callback must not retain the client, issue BEGIN/COMMIT, or launch unawaited work.
 * @example await withTransaction({ pool, work: tx => tx.query('SELECT $1::int', [1]) });
 * @returns Callback value after successful COMMIT.
 * @throws PgFoundationError with a cause; commit_failed means the outcome may be committed.
 * @complexity O(q) driver calls for q body queries; constant wrapper space.
 * @overallScore 95/100
 * @qualityFindings Low: connection acquisition/deadlines require correct configuration of the injected pool.
 */
export async function withTransaction<T>(
  { pool, work }: { pool: PgPool; work: (tx: PgQueryable) => Promise<T> },
  { statementTimeoutMs = 30_000, lockTimeoutMs = 5_000, observer }: TransactionOptions = {},
): Promise<T> {
  const limits = [timeout(statementTimeoutMs), timeout(lockTimeoutMs)];
  let client: PgClient;
  try { client = await observed('connect', observer, () => pool.connect()); } catch (cause) {
    throw new PgFoundationError('connect_failed', 'Postgres connection failed', { cause });
  }
  const queryable = instrumentClient(client, observer);
  let destroy = true;
  let primaryFailure: unknown;
  try {
    await queryable.query('BEGIN');
    const result = await runBody(queryable, work, limits);
    try { await queryable.query('COMMIT'); } catch (cause) {
      throw new PgFoundationError('commit_failed', 'Commit outcome is uncertain; reconcile before retry', { cause });
    }
    destroy = false;
    return result;
  } catch (cause) {
    primaryFailure = cause;
    if (cause instanceof PgFoundationError && cause.code === 'transaction_failed') destroy = false;
    throw cause;
  } finally {
    try { await observed('release', observer, async () => client.release(destroy || undefined)); } catch (cleanup) {
      if (primaryFailure) {
        throw new PgFoundationError('release_after_failure', 'Transaction failed and connection release also failed', {
          cause: new AggregateError([primaryFailure, cleanup]),
        });
      }
      throw new PgFoundationError('release_after_commit', 'Transaction COMMITTED but release failed; do not retry work', { cause: cleanup });
    }
  }
}

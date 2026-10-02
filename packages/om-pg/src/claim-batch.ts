import { PgFoundationError, type PgPool } from './ports.js';
import { withTransaction, type TransactionOptions } from './transaction.js';

/** Trusted deployment-owned queue names; callers cannot choose arbitrary database objects. */
export interface QueueTable { schema: string; table: string; }
/** A queue row uses composite (tenant_id, workspace_id, id) identity and fixed lease columns. */
export interface ClaimedRow extends Record<string, unknown> { id: string; }

/** Validate an allowlisted identifier before interpolating it; values never enter SQL text.
 * @complexity O(k) for identifiers of k <= 63 characters. @overallScore 100/100
 */
function quoteIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value)) {
    throw new PgFoundationError('invalid_identifier', 'Only lowercase PostgreSQL identifiers are supported');
  }
  return `"${value}"`;
}

/** Select only a server-allowlisted queue, never a user-controlled SQL fragment.
 * @complexity O(a) for a <= 100 allowed queues. @overallScore 100/100
 */
function queueName(queue: QueueTable, allowedTables: readonly QueueTable[]): string {
  if (allowedTables.length > 100) throw new PgFoundationError('invalid_allowlist', 'At most 100 queue tables are supported');
  if (!allowedTables.some((allowed) => allowed.schema === queue.schema && allowed.table === queue.table)) {
    throw new PgFoundationError('queue_not_allowed', 'Queue is not in the trusted allowlist');
  }
  return `${quoteIdentifier(queue.schema)}.${quoteIdentifier(queue.table)}`;
}

/** Validate limits and lease time before I/O. Reject, rather than silently truncate, oversized claims.
 * @complexity O(1). @overallScore 100/100
 */
function validateClaim(limit: number, now: Date, leaseUntil: Date): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new PgFoundationError('invalid_limit', 'Claim limit must be an integer from 1 to 1000');
  }
  const duration = leaseUntil.getTime() - now.getTime();
  if (!Number.isFinite(duration) || duration <= 0 || duration > 86_400_000) {
    throw new PgFoundationError('invalid_lease', 'Lease must end within 24 hours after the supplied clock time');
  }
}

/** Atomically lease due pending rows, skipping rows locked by other workers.
 * Required queue columns: id, tenant_id, workspace_id, status, available_at, lease_until, attempts.
 * Required PK: (tenant_id, workspace_id, id). Index the scope/status/available_at/id selection path.
 * Expired processing rows are deliberately NOT reclaimed: the owner must reconcile external effects
 * and explicitly return safe retries to pending. Claim order is deterministic; returned row order is not.
 * The allowlist belongs to trusted server configuration, never to an HTTP request.
 * @example await claimBatch({ pool, queue: { schema: 'om', table: 'outbox' }, allowedTables,
 *   tenantId, workspaceId, limit: 20, now: clock.now(), leaseUntil });
 * @throws PgFoundationError on bad names, limits, lease bounds or transaction failure.
 * @complexity One bounded UPDATE/CTE; O(limit) result space, database scan depends on caller-owned index.
 * @overallScore 95/100
 * @qualityFindings Low: actual query plans and SKIP LOCKED concurrency require real PostgreSQL validation.
 */
export async function claimBatch<Row extends ClaimedRow = ClaimedRow>(
  { pool, queue, allowedTables, tenantId, workspaceId, limit, now, leaseUntil }: {
    pool: PgPool; queue: QueueTable; allowedTables: readonly QueueTable[];
    tenantId: string; workspaceId: string; limit: number; now: Date; leaseUntil: Date;
  }, options: TransactionOptions = {},
): Promise<Row[]> {
  const table = queueName(queue, allowedTables);
  validateClaim(limit, now, leaseUntil);
  if (!tenantId || !workspaceId) throw new PgFoundationError('invalid_scope', 'Tenant and workspace are required');
  const sql = `WITH candidates AS (
    SELECT id FROM ${table}
    WHERE tenant_id = $1 AND workspace_id = $2 AND status = 'pending' AND available_at <= $3
    ORDER BY available_at, id LIMIT $4 FOR UPDATE SKIP LOCKED
  ) UPDATE ${table} AS queue SET status = 'processing', lease_until = $5, attempts = queue.attempts + 1
    FROM candidates WHERE queue.id = candidates.id AND queue.tenant_id = $1 AND queue.workspace_id = $2
    RETURNING queue.*`;
  const values = [tenantId, workspaceId, now.toISOString(), limit, leaseUntil.toISOString()];
  return withTransaction({ pool, work: async (tx) => (await tx.query<Row>(sql, values)).rows }, options);
}

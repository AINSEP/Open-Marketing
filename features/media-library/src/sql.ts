import { z } from 'zod';
import type { CallContext, Outcome, Scope } from '@open-marketing/contracts';
import type { MediaObserverPort, MediaRepoPort } from './ports.js';
import type { EvidenceRow, EvidenceStore } from './evidence-repo.js';
import { createEvidenceRepo } from './evidence-repo.js';
import { fail, success } from './validation.js';

/** Structural @jini-ai/db-shaped query seam; host owns SQLite client and transactions. */
export interface MediaSqlPort {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(required: { text: string; values?: unknown[] }): Promise<{ rows: Row[]; rowCount: number | null }>;
}
const rowSchema = z.strictObject({ kind: z.enum(['provenance', 'link', 'cost', 'crop']), key: z.string(), operationId: z.string(), payload: z.string().max(100000) });
const selectColumns = 'kind, record_key AS "key", operation_id AS "operationId", payload';
/** Durable OM-only metadata via parameterized portable SQL. Factory never runs DDL or starts services.
 * Apply migrations/0001_media_evidence.sql separately. @complexity O(1) append; O(e) evidence (cap 1,000).
 * @example createSqlMediaRepo({ db, scope: authenticatedScope })
 */
export function createSqlMediaRepo(required: { db: MediaSqlPort; scope: Scope }, optional?: { observer?: MediaObserverPort }): MediaRepoPort {
  const store: EvidenceStore = {
    async append(input) { return appendSql({ ...required, ...input }); },
    async read(input) {
      const result = await required.db.query({ text: `SELECT ${selectColumns} FROM om_media_evidence WHERE owner_id=$1 AND workspace_id=$2 AND operation_id=$3 ORDER BY kind, record_key LIMIT 1001`,
        values: [input.context.scope.ownerId, input.context.scope.workspaceId, input.operationId] });
      if (result.rows.length > 1000) return fail({ code: 'limit_exceeded', message: 'Evidence exceeds read limit' });
      const rows = z.array(rowSchema).safeParse(result.rows);
      if (!rows.success) return fail({ code: 'unavailable', message: 'Invalid database response' });
      return success({ value: rows.data });
    },
  };
  return createEvidenceRepo({ store, scope: required.scope }, optional);
}
/** Atomic insert-if-absent and subsequent comparison detect concurrent conflicting retries without updates. @complexity O(1) indexed SQL. */
async function appendSql(required: { db: MediaSqlPort; context: CallContext; row: EvidenceRow }): Promise<Outcome<void>> {
  const { scope } = required.context;
  const { row } = required;
  await required.db.query({ text: 'INSERT INTO om_media_evidence (owner_id,workspace_id,kind,record_key,operation_id,payload) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (owner_id,workspace_id,kind,record_key) DO NOTHING',
    values: [scope.ownerId, scope.workspaceId, row.kind, row.key, row.operationId, row.payload] });
  const result = await required.db.query({ text: 'SELECT payload, operation_id AS "operationId" FROM om_media_evidence WHERE owner_id=$1 AND workspace_id=$2 AND kind=$3 AND record_key=$4',
    values: [scope.ownerId, scope.workspaceId, row.kind, row.key] });
  const stored = result.rows[0];
  if (!stored) return fail({ code: 'unavailable', message: 'Append could not be verified' });
  if (stored.payload !== row.payload || stored.operationId !== row.operationId) return fail({ code: 'conflict', message: 'Append-only evidence conflict' });
  return success({ value: undefined });
}

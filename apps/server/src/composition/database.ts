/** Concrete adapters over the ONE server-owned native handle and checked Jini kernel. */
import type Database from 'better-sqlite3';
import { sqliteKernel } from '@jini-ai/db/kernel/sqlite';
import type { CallContext, ObserverPort, Scope, SqlSession, UnitOfWork } from '@open-marketing/contracts';
import type { WorkspaceSqlDatabase } from '@open-marketing/workspaces';
import { z } from 'zod';
import { createCheckedSqliteClient, createSqlitePool, withTransaction, type PgObserver } from '@open-marketing/om-db';

/** Bind inert transaction adapters; native lifetime stays with bootServer. Contending roots wait
 * for the om-db pool lease in FIFO order; there is no additional queue, lease manager or transaction control.
 * A supplied session is adapted directly and never opens another root transaction.
 * @example const database = bindServerDatabase({ native, observer, context });
 * @complexity O(1) construction; operation cost is the supplied bounded SQL work.
 */
export function bindServerDatabase(required: { native: Database.Database; observer: ObserverPort; context: CallContext }) {
    const kernel = sqliteKernel(createCheckedSqliteClient({ database: required.native }));
    const pool = createSqlitePool({ database: required.native, kernel });
    const observe: PgObserver = event => required.observer.observe({ operation: `server.db.${event.operation}`, outcome: event.status,
        correlationId: required.context.correlationId, traceId: required.context.traceId });
    const unit: UnitOfWork = {
        transaction: ({ work }) => withTransaction({ pool, work: session => work({ session }) }, { observer: observe }),
    };
    const workspace: SqlSession = { ...unit,
        query: input => unit.transaction({ work: ({ session }) => session.query(input) }),
    };
    /** Autocommit reads for pre-lane hints: the lease waits its turn but issues no BEGIN, so nothing
     * holds SQLite while the caller later waits on a lane. Each statement is its own snapshot; callers
     * MUST recheck inside their real transaction and never write through it. Joins stay on the lease. */
    const reads: UnitOfWork = { async transaction({ work }) {
        const client = await pool.connect();
        const session: SqlSession = { query: input => client.query(input), transaction: ({ work: joined }) => joined({ session }) };
        try { return await work({ session }); } finally { client.release({}); }
    } };
    return { kernel, pool, unit, workspace, reads, observe };
}

/** Persist the trusted local scope using the workspaces adapter, once. A different owner for the
 * same UUID is rejected; a restart cannot silently change workspace ownership.
 * Native/row failures propagate to the typed boot boundary. @complexity O(1) indexed queries.
 */
export async function provisionWorkspace(required: { database: WorkspaceSqlDatabase; scope: Scope }): Promise<void> {
    await required.database.transaction({ work: async ({ session }) => {
        await session.query({ text: 'INSERT INTO workspace (owner_id, workspace_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
            values: [required.scope.ownerId, required.scope.workspaceId] });
        const result = await session.query({ text: 'SELECT owner_id, workspace_id FROM workspace WHERE workspace_id=$1 LIMIT 1', values: [required.scope.workspaceId] });
        z.tuple([z.strictObject({ owner_id: z.literal(required.scope.ownerId), workspace_id: z.literal(required.scope.workspaceId) })]).parse(result.rows);
    } });
}

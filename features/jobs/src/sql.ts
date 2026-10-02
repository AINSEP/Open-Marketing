import type { Completion, EnqueueResult, LeaseFence, OutboxEvent, OutboxJob } from "./types.js";
import type { ManagedOutboxStore } from "./store.js";
import type { JobsSqlDatabase, JobsSqlSession } from "./sql-types.js";
import { validateClaim, validateCompletion, validateTime } from "./store.js";
import { appendTransition, enqueueSqlJob, sqlJob } from "./sql-queries.js";
import { JobStoreError } from "./errors.js";
/** Serialized durable outbox adapter, driver-free and timer-free. Migration application belongs to server composition.
 * @example createSqlOutboxStore({ database })
 * @complexity Indexed transitions/claims plus bounded recovery (<=1000 rows); capacity check O(n), n <=maxJobs.
 */
export function createSqlOutboxStore(required: { database: JobsSqlDatabase; maxJobs?: number; observe?: (event: OutboxEvent) => void }): ManagedOutboxStore {
    const maxJobs = required.maxJobs ?? 10000;
    if (!Number.isSafeInteger(maxJobs) || maxJobs < 1 || maxJobs > 100000) throw new RangeError("Invalid outbox capacity");
    /** Catch opaque driver failures only at the adapter edge; transaction has already rolled back. @complexity Adapter-dependent. */
    async function transact<T>(input: { operation: OutboxEvent["operation"]; execute: (required: { session: JobsSqlSession }) => Promise<T> }): Promise<T> {
        try {
            const result = await required.database.transaction({ execute: input.execute });
            observe({ operation: input.operation, outcome: "ok" });
            return result;
        } catch (error) {
            observe({ operation: input.operation, outcome: "unavailable" });
            if (error instanceof JobStoreError) throw error;
            throw new JobStoreError({ code: "unavailable", message: "Outbox SQL transaction failed" });
        }
    }
    /** SQL telemetry is payload-free and cannot change delivery. @complexity O(1). */
    function observe(event: OutboxEvent): void {
        try { required.observe?.(event); } catch { /* Never retry because telemetry failed. */ }
    }
    return {
        enqueue(job): Promise<EnqueueResult> {
            return transact({ operation: "enqueue", execute: ({ session }) => enqueueSqlJob({ session, job, maxJobs }) });
        },
        recoverExpired(input): Promise<number> {
            validateTime(input);
            if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 1000) throw new JobStoreError({ code: "invalid_input", message: "Invalid recovery limit" });
            return transact({ operation: "recovery", execute: ({ session }) => recover({ session, ...input }) });
        },
        claim(input): Promise<OutboxJob | null> {
            validateClaim(input);
            return transact({ operation: "claim", execute: ({ session }) => claim({ session, ...input }) });
        },
        beginDispatch(fence): Promise<boolean> {
            validateTime(fence);
            return transact({ operation: "dispatch", execute: ({ session }) => fencedUpdate({ session, fence, states: "'leased'", state: "dispatching", event: "dispatch" }) });
        },
        complete(fence: LeaseFence, completion: Completion): Promise<boolean> {
            validateCompletion({ fence, completion });
            return transact({ operation: "complete", execute: ({ session }) => fencedUpdate({ session, fence, states: "'leased','dispatching'", state: completion.state, availableAt: retryAt({ completion }), event: "complete" }) });
        },
        get(input): Promise<OutboxJob | null> {
            return transact({ operation: "claim", execute: async ({ session }) => {
                const result = await session.query({ sql: "SELECT * FROM job WHERE tenant_id = $1 AND id = $2", parameters: [input.tenantId, input.id] });
                if (result.rows.length === 0) return null;
                return sqlJob({ row: result.rows[0] });
            } });
        },
        cancel(input): Promise<boolean> {
            validateTime(input);
            return transact({ operation: "complete", execute: async ({ session }) => {
                const result = await session.query({
                    sql: "UPDATE job SET state = CASE WHEN state IN ('pending','retry') THEN 'cancelled' ELSE 'reconcile' END, lease_token = NULL, lease_expires_at = NULL WHERE tenant_id = $1 AND id = $2 AND state IN ('pending','retry','leased','dispatching') RETURNING *",
                    parameters: [input.tenantId, input.id],
                });
                return recordUpdate({ session, rows: result.rows, event: "cancel", now: input.now });
            } });
        },
        resolve(input): Promise<boolean> {
            validateTime(input);
            if (!input.evidenceId.trim() || input.evidenceId.length > 256) throw new JobStoreError({ code: "invalid_input", message: "Reconciliation requires evidence" });
            return transact({ operation: "complete", execute: async ({ session }) => {
                const result = await session.query({
                    sql: "UPDATE job SET state = $1 WHERE tenant_id = $2 AND id = $3 AND state = 'reconcile' RETURNING *",
                    parameters: [input.state, input.tenantId, input.id],
                });
                return recordUpdate({ session, rows: result.rows, event: "resolve", now: input.now, evidenceId: input.evidenceId });
            } });
        },
    };
}
/** Recovery touches at most limit jobs; uncertainty cannot re-enter the due index. @complexity O(log n + limit) queries/rows. */
async function recover(required: { session: JobsSqlSession; now: number; limit: number }): Promise<number> {
    const result = await required.session.query({
        sql: "UPDATE job SET state = 'reconcile', lease_token = NULL, lease_expires_at = NULL WHERE id IN (SELECT id FROM job WHERE state IN ('leased','dispatching') AND lease_expires_at <= $1 ORDER BY available_at, created_at, id LIMIT $2) RETURNING *",
        parameters: [required.now, required.limit],
    });
    for (const row of result.rows) await appendTransition({ session: required.session, job: sqlJob({ row }), event: "recovery", now: required.now });
    return result.rows.length;
}
/** Serialized selection and update prevent two claimers from seeing the same due job. @complexity Indexed select + update + append. */
async function claim(required: { session: JobsSqlSession; now: number; leaseToken: string; leaseExpiresAt: number; maxAttempts: number }): Promise<OutboxJob | null> {
    const result = await required.session.query({
        sql: "UPDATE job SET state = 'leased', attempts = attempts + 1, lease_token = $1, lease_expires_at = $2 WHERE id = (SELECT id FROM job WHERE state IN ('pending','retry') AND available_at <= $3 AND attempts < $4 ORDER BY available_at, created_at, id LIMIT 1) AND state IN ('pending','retry') RETURNING *",
        parameters: [required.leaseToken, required.leaseExpiresAt, required.now, required.maxAttempts],
    });
    if (result.rows.length === 0) return null;
    const job = sqlJob({ row: result.rows[0] });
    await appendTransition({ session: required.session, job, event: "claim", now: required.now });
    return job;
}
/** All fence predicates are in the UPDATE. State/lease/journal commit together. @complexity Indexed update + append. */
async function fencedUpdate(required: { session: JobsSqlSession; fence: LeaseFence; states: "'leased'" | "'leased','dispatching'"; state: string; event: string; availableAt?: number }): Promise<boolean> {
    const keepLease = required.state === "dispatching";
    const result = await required.session.query({
        sql: "UPDATE job SET state = $1, available_at = COALESCE($2, available_at), lease_token = CASE WHEN $3 = 1 THEN lease_token ELSE NULL END, lease_expires_at = CASE WHEN $3 = 1 THEN lease_expires_at ELSE NULL END WHERE id = $4 AND tenant_id = $5 AND lease_token = $6 AND lease_expires_at > $7 AND state IN (" + required.states + ") RETURNING *",
        parameters: [required.state, required.availableAt ?? null, keepLease ? 1 : 0, required.fence.id, required.fence.tenantId, required.fence.token, required.fence.now],
    });
    return recordUpdate({ session: required.session, rows: result.rows, event: required.event, now: required.fence.now });
}
/** Append only when the transition actually won its CAS/fence. @complexity O(1) rows plus indexed append. */
async function recordUpdate(required: { session: JobsSqlSession; rows: readonly Readonly<Record<string, unknown>>[]; event: string; now: number; evidenceId?: string }): Promise<boolean> {
    if (required.rows.length === 0) return false;
    if (required.rows.length !== 1) throw new JobStoreError({ code: "unavailable", message: "Invalid SQL transition result" });
    await appendTransition({ ...required, job: sqlJob({ row: required.rows[0] }) });
    return true;
}
/** Terminal completions retain their prior scheduling date. @complexity O(1). */
function retryAt(required: { completion: Completion }): number | undefined {
    if (required.completion.state === "retry") return required.completion.availableAt;
    return undefined;
}

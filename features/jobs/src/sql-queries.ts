import type { JobsSqlSession } from "./sql-types.js";
import type { OutboxJob, EnqueueResult } from "./types.js";
import { validateStoredJob } from "./schema.js";
import { sameRequest } from "./store.js";
import { JobStoreError } from "./errors.js";
/** Driver rows are parsed/detached before entering the core. @complexity O(p), p <=256KiB. */
export function sqlJob(required: { row: Readonly<Record<string, unknown>> }): OutboxJob {
    const row = required.row;
    return validateStoredJob({ job: {
        id: row.id, tenantId: row.tenant_id, idempotencyKey: row.idempotency_key,
        requestDigest: row.request_digest, operation: row.operation, payload: row.payload,
        context: readContext({ value: row.context_json }), state: row.state, attempts: row.attempts,
        availableAt: row.available_at, createdAt: row.created_at,
        leaseToken: row.lease_token, leaseExpiresAt: row.lease_expires_at,
    } });
}
/** Context is persisted data, never reparsed without a byte bound. @complexity O(c), c <=8KiB. */
function readContext(required: { value: unknown }): unknown {
    if (required.value === null) return undefined;
    if (typeof required.value !== "string" || required.value.length > 8192) throw new JobStoreError({ code: "unavailable", message: "Invalid persisted job context" });
    return JSON.parse(required.value);
}
/** One append in the same transaction as each state change; host serialization protects sequence allocation. @complexity O(log a), a prior transitions. */
export async function appendTransition(required: { session: JobsSqlSession; job: OutboxJob; event: string; now: number; evidenceId?: string }): Promise<void> {
    await required.session.query({
        text: "INSERT INTO job_attempt (job_id, sequence, tenant_id, attempt, event_type, state, observed_at, evidence_id) SELECT $1, COALESCE(MAX(sequence), 0) + 1, $2, $3, $4, $5, $6, $7 FROM job_attempt WHERE job_id = $1",
        values: [required.job.id, required.job.tenantId, required.job.attempts, required.event, required.job.state, required.now, required.evidenceId ?? null],
    });
}
/** Enqueue may run in an existing domain transaction; uniqueness never overwrites the first intent.
 * @complexity Indexed lookup + bounded capacity count + insert + journal append, O(n) worst-case capacity check.
 */
export async function enqueueSqlJob(required: { session: JobsSqlSession; job: OutboxJob; maxJobs: number }): Promise<EnqueueResult> {
    const job = validateStoredJob({ job: required.job });
    if (job.state !== "pending" || job.attempts !== 0) throw new JobStoreError({ code: "invalid_input", message: "Enqueue requires a new pending job" });
    const prior = await required.session.query({ text: "SELECT * FROM job WHERE tenant_id = $1 AND idempotency_key = $2", values: [job.tenantId, job.idempotencyKey] });
    if (prior.rows.length > 0) {
        const existing = sqlJob({ row: prior.rows[0] });
        return sameRequest({ first: existing, second: job }) ? { kind: "existing", job: existing } : { kind: "conflict" };
    }
    await checkCapacity({ session: required.session, maxJobs: required.maxJobs });
    const inserted = await required.session.query({
        text: "INSERT INTO job (id, tenant_id, idempotency_key, request_digest, operation, payload, context_json, state, attempts, available_at, created_at, lease_token, lease_expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',0,$8,$9,NULL,NULL) ON CONFLICT (id) DO NOTHING RETURNING *",
        values: [job.id, job.tenantId, job.idempotencyKey, job.requestDigest, job.operation, job.payload, job.context === undefined ? null : JSON.stringify(job.context), job.availableAt, job.createdAt],
    });
    if (inserted.rows.length !== 1) throw new JobStoreError({ code: "conflict", message: "Generated job ID already exists" });
    const snapshot = sqlJob({ row: inserted.rows[0] });
    await appendTransition({ session: required.session, job: snapshot, event: "enqueue", now: job.createdAt });
    return { kind: "inserted", job: snapshot };
}
/** Durable storage capacity is explicit; archive only under an independently authorized retention workflow. @complexity O(n) count. */
async function checkCapacity(required: { session: JobsSqlSession; maxJobs: number }): Promise<void> {
    const count = await required.session.query({ text: "SELECT COUNT(*) AS count FROM job", values: [] });
    const value = count.rows[0]?.count;
    if (!Number.isSafeInteger(value)) throw new JobStoreError({ code: "unavailable", message: "Invalid outbox capacity result" });
    if ((value as number) >= required.maxJobs) throw new JobStoreError({ code: "limit_exceeded", message: "Outbox capacity reached" });
}

import type { CallContext, ClockPort, IdPort, Outcome } from "@open-marketing/contracts";
import { idSchema } from "@open-marketing/contracts";
import type { DomainIntentTransactionPort, JobRequest, JobReceipt } from "./types.js";
import type { JobsSqlDatabase, JobsSqlSession } from "./sql-types.js";
import { prepareJob, storeFailure } from "./repository.js";
import { enqueueSqlJob } from "./sql-queries.js";
import { jobFailure } from "./errors.js";
import { decodeJob } from "./schema.js";
/** A feature adapts its domain intent write to this same-session callback. No external effects are permitted here.
 * The callback MUST be idempotent for intentId and verify the domain operation identity on existing receipts.
 */
export interface DomainIntentSqlWriter {
    write(required: { session: JobsSqlSession; context: CallContext; intentId: string; job: JobRequest; receipt: JobReceipt }): Promise<Outcome<void>>;
}
/** Typed callback failure forces rollback even though the injected domain writer returns an Outcome. */
class IntentRollback extends Error {
    readonly outcome: Outcome<JobReceipt>;
    constructor(required: { outcome: Outcome<JobReceipt> }) { super("Domain intent transaction rolled back"); this.outcome = required.outcome; }
}
/** Domain intent and enqueue use one serialized DB transaction/connection. Failed writer/insert/journal rolls both back.
 * @example createDomainIntentTransaction({ database, writer, clock, ids })
 * @complexity Bounded JSON validation plus enqueue SQL and injected domain SQL in one transaction.
 */
export function createDomainIntentTransaction(required: { database: JobsSqlDatabase; writer: DomainIntentSqlWriter; clock: ClockPort; ids: IdPort; maxJobs?: number }): DomainIntentTransactionPort {
    const maxJobs = required.maxJobs ?? 10000;
    if (!Number.isSafeInteger(maxJobs) || maxJobs < 1 || maxJobs > 100000) throw new RangeError("Invalid outbox capacity");
    return {
        async commit(input, optional) {
            if (optional?.signal?.aborted) return jobFailure({ code: "cancelled", message: "Domain intent commit cancelled" });
            if (!idSchema.safeParse(input.intentId).success) return jobFailure({ code: "invalid_input", message: "Invalid intent identity" });
            let pending;
            try { pending = prepareJob({ ...input, ...required }); }
            catch { return jobFailure({ code: "invalid_input", message: "Invalid transactional job request" }); }
            const intentId = input.intentId;
            const job = decodeJob(pending);
            const context = pending.context!;
            try {
                return await required.database.transaction({ context, execute: async ({ session }) => {
                    const result = await enqueueSqlJob({ session, job: pending, maxJobs });
                    if (result.kind === "conflict") throw new IntentRollback({ outcome: jobFailure({ code: "conflict", message: "Idempotency key already binds another intent" }) });
                    const receipt: JobReceipt = { jobId: result.job.id, operationId: job.operationId, status: result.kind === "inserted" ? "enqueued" : "existing" };
                    const persisted = await required.writer.write({ context, intentId, job, session, receipt });
                    if (!persisted.ok) throw new IntentRollback({ outcome: persisted });
                    if (optional?.signal?.aborted) throw new IntentRollback({ outcome: jobFailure({ code: "cancelled", message: "Domain intent commit cancelled" }) });
                    return { ok: true, value: receipt } as const;
                } });
            } catch (error) {
                if (error instanceof IntentRollback) return error.outcome;
                return storeFailure({ error });
            }
        },
    };
}

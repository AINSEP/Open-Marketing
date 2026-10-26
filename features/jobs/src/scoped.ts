/** Owner-facing projections over the existing outbox; no payloads or arbitrary transitions. */
import { z } from "zod";
import { callContextSchema, idSchema, pageQuerySchema, parseBoundary } from "@open-marketing/contracts";
import type { CallContext, CallOptions, ClockPort, ObserverPort, Outcome, Page, PageQuery } from "@open-marketing/contracts";
import type { JobsSqlDatabase } from "./sql-types.js";
import type { OutboxJob } from "./types.js";
import { decodeRequest, jobTenant, storeFailure } from "./repository.js";
import { appendTransition, sqlJob } from "./sql-queries.js";
import { jobFailure } from "./errors.js";

/** Scheduling metadata only: prompts, credentials and plugin payloads never leave this API. */
export type ScopedJob = Pick<OutboxJob, "state" | "attempts" | "availableAt" | "createdAt"> & { readonly jobId: string; readonly operationId: string; readonly handler: string };
export interface ScopedJobs {
    get(required: { context: CallContext; jobId: string }, optional?: CallOptions): Promise<Outcome<ScopedJob | null>>;
    list(required: { context: CallContext; query: PageQuery }, optional?: CallOptions): Promise<Outcome<Page<ScopedJob>>>;
    /** Cancels only pending, never-claimed work. Retry/leased/dispatching/unknown states fail closed. */
    cancel(required: { context: CallContext; jobId: string }, optional?: CallOptions): Promise<Outcome<{ readonly cancelled: boolean }>>;
}
/** Shared get/cancel boundary for both scoped jobs adapters; not a package export. */
export const getSchema = z.strictObject({ context: callContextSchema, jobId: idSchema });
/** Shared bounded pagination boundary for both scoped jobs adapters; not a package export. */
export const listSchema = z.strictObject({ context: callContextSchema, query: pageQuerySchema });
type Access = { context: CallContext; observer: ObserverPort; operation: string; work: () => Promise<Outcome<unknown>> };
/** One typed, observed boundary. Scope is authenticated upstream; mismatched owners fail here.
 * @complexity O(1) plus one bounded injected operation; errors contain no driver output. */
export async function boundary<T>(required: Omit<Access, "work"> & { work: () => Promise<Outcome<T>> }, optional?: CallOptions): Promise<Outcome<T>> {
    const parsed = callContextSchema.safeParse(required.context);
    if (!parsed.success) return jobFailure({ code: "invalid_input", message: "Invalid jobs context" });
    if (optional?.signal?.aborted) return jobFailure({ code: "cancelled", message: "Jobs call cancelled" });
    if (parsed.data.principal.kind === "owner" && parsed.data.principal.ownerId !== parsed.data.scope.ownerId) return jobFailure({ code: "forbidden", message: "Jobs owner mismatch" });
    let result: Outcome<T>;
    try { result = await required.work(); } catch (error) { result = storeFailure({ error }); }
    try { required.observer.observe({ operation: required.operation, outcome: result.ok ? "ok" : result.error.code,
        correlationId: required.context.correlationId, traceId: required.context.traceId, runId: required.context.runId }); } catch { /* Diagnostics never alter scheduling. */ }
    return result;
}
/** Parse the stored envelope before projecting only safe scheduling metadata. @complexity Bounded payload validation. */
export function project(required: { job: OutboxJob }): ScopedJob {
    const job = decodeRequest({ request: required.job }).job;
    return { jobId: required.job.id, operationId: job.operationId, handler: job.handler, state: required.job.state,
        attempts: required.job.attempts, availableAt: required.job.availableAt, createdAt: required.job.createdAt };
}
/** SQL reads and cancellation use the same existing jobs tables. Cancellation is a single CAS
 * and append in one transaction; a concurrent worker claim wins or cancellation wins.
 * @example createSqlScopedJobs({ database, clock, observer });
 * @complexity Indexed get/cancel; list <=101 rows, O(page * bounded payload) validation. */
export function createSqlScopedJobs(required: { database: JobsSqlDatabase; clock: ClockPort; observer: ObserverPort }): ScopedJobs {
    return {
        get(input, optional) { return boundary({ ...required, context: input.context, operation: "jobs.get", work: async () => {
            const parsed = parseBoundary({ schema: getSchema, input });
            if (!parsed.ok) return parsed;
            return required.database.transaction({ work: async ({ session }) => {
                const rows = await session.query({ text: "SELECT * FROM job WHERE tenant_id=$1 AND id=$2", values: [jobTenant(input), input.jobId] });
                return { ok: true, value: rows.rows[0] ? project({ job: sqlJob({ row: rows.rows[0] }) }) : null };
            } });
        } }, optional); },
        list(input, optional) { return boundary({ ...required, context: input.context, operation: "jobs.list", work: async () => {
            const parsed = parseBoundary({ schema: listSchema, input });
            if (!parsed.ok) return parsed;
            return required.database.transaction({ work: async ({ session }) => {
                const rows = await session.query({ text: "SELECT * FROM job WHERE tenant_id=$1 AND id>$2 ORDER BY id LIMIT $3", values: [jobTenant(input), input.query.cursor ?? "", input.query.limit + 1] });
                const items = rows.rows.slice(0, input.query.limit).map(row => project({ job: sqlJob({ row }) }));
                return { ok: true, value: { items, cursor: rows.rows.length > input.query.limit ? items.at(-1)!.jobId : null } };
            } });
        } }, optional); },
        cancel(input, optional) { return boundary<{ readonly cancelled: boolean }>({ ...required, context: input.context, operation: "jobs.cancel", work: async () => {
            const parsed = parseBoundary({ schema: getSchema, input });
            if (!parsed.ok) return parsed;
            return required.database.transaction({ work: async ({ session }) => {
                const rows = await session.query({ text: "UPDATE job SET state='cancelled' WHERE tenant_id=$1 AND id=$2 AND state='pending' AND attempts=0 RETURNING *", values: [jobTenant(input), input.jobId] });
                if (!rows.rows[0]) return { ok: true, value: { cancelled: false } };
                const job = sqlJob({ row: rows.rows[0] });
                await appendTransition({ session, job, event: "cancel", now: required.clock.now({}) });
                return { ok: true, value: { cancelled: true } };
            } });
        } }, optional); },
    };
}

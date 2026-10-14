/** In-memory scoped jobs over the existing outbox; shares validation and safe projection with SQL. */
import { parseBoundary } from "@open-marketing/contracts";
import type { ClockPort, ObserverPort } from "@open-marketing/contracts";
import type { MemoryOutboxStore } from "./memory-store.js";
import type { ScopedJobs } from "../scoped.js";
import { boundary, getSchema, listSchema, project } from "../scoped.js";
import { jobTenant } from "../repository.js";

/** Double shares the real in-memory outbox. Snapshot eligibility and synchronous cancel handoff
 * have no await gap; a worker cannot intervene between the decision and mutation.
 * @example createMemoryScopedJobs({ store, clock, observer });
 * @complexity O(n log n) bounded snapshot, n <= outbox capacity; no additional queue. */
export function createMemoryScopedJobs(required: { store: MemoryOutboxStore; clock: ClockPort; observer: ObserverPort }): ScopedJobs {
    return {
        get(input, optional) { return boundary({ ...required, context: input.context, operation: "jobs.get", work: async () => {
            const parsed = parseBoundary({ schema: getSchema, input });
            if (!parsed.ok) return parsed;
            const job = await required.store.get({ tenantId: jobTenant(input), id: input.jobId });
            return { ok: true, value: job ? project({ job }) : null };
        } }, optional); },
        list(input, optional) { return boundary({ ...required, context: input.context, operation: "jobs.list", work: async () => {
            const parsed = parseBoundary({ schema: listSchema, input });
            if (!parsed.ok) return parsed;
            const jobs = required.store.snapshot({}).filter(job => job.tenantId === jobTenant(input) && Buffer.compare(Buffer.from(job.id), Buffer.from(input.query.cursor ?? "")) > 0)
                .sort((first, second) => Buffer.compare(Buffer.from(first.id), Buffer.from(second.id)));
            const items = jobs.slice(0, input.query.limit).map(job => project({ job }));
            return { ok: true, value: { items, cursor: jobs.length > input.query.limit ? items.at(-1)!.jobId : null } };
        } }, optional); },
        cancel(input, optional) { return boundary<{ readonly cancelled: boolean }>({ ...required, context: input.context, operation: "jobs.cancel", work: async () => {
            const parsed = parseBoundary({ schema: getSchema, input });
            if (!parsed.ok) return parsed;
            const job = required.store.snapshot({}).find(job => job.tenantId === jobTenant(input) && job.id === input.jobId);
            if (!job || job.state !== "pending" || job.attempts !== 0) return { ok: true, value: { cancelled: false } };
            const cancelled = await required.store.cancel({ tenantId: jobTenant(input), id: input.jobId, now: required.clock.now({}) });
            return { ok: true, value: { cancelled } };
        } }, optional); },
    };
}

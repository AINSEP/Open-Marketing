import type { Completion, EnqueueResult, LeaseFence, OutboxJob } from "../types.js";
import type { ManagedOutboxStore } from "../store.js";
import { isDue, isFenced, sameRequest, validateClaim, validateCompletion, validateFence, validateResolution, validateTime } from "../store.js";
import { validateStoredJob } from "../schema.js";
import { JobStoreError } from "../errors.js";
/** Single-process test double. Synchronous mutations are atomic; this is never a production durability adapter.
 * @complexity Enqueue/get/fence O(1) plus payload copying; claim/recovery O(n log n), n <=maxJobs.
 */
export interface MemoryOutboxStore extends ManagedOutboxStore {
    snapshot(required: Record<string, never>): readonly OutboxJob[];
}
export function createMemoryOutboxStore(required: { maxJobs?: number; initialJobs?: readonly OutboxJob[] }): MemoryOutboxStore {
    const maxJobs = required.maxJobs ?? 10000;
    if (!Number.isSafeInteger(maxJobs) || maxJobs < 1 || maxJobs > 100000) throw new RangeError("Invalid outbox capacity");
    const { jobs, keys, leases } = restoreCheckpoint({ initialJobs: required.initialJobs ?? [], maxJobs });
    /** Detached sorted snapshots make claim ordering identical to SQL. @complexity O(n log n). */
    function ordered(): OutboxJob[] {
        return [...jobs.values()].sort((first, second) => first.availableAt - second.availableAt || first.createdAt - second.createdAt || compareIds({ first: first.id, second: second.id }));
    }
    /** Store only data copies; returned snapshots cannot mutate leases/context. @complexity O(p), p <=256KiB. */
    function save(job: OutboxJob): OutboxJob {
        const snapshot = structuredClone(job);
        const prior = jobs.get(job.id);
        if (prior?.leaseToken) leases.delete(prior.leaseToken);
        if (job.leaseToken !== null) leases.set(job.leaseToken, job.id);
        jobs.set(job.id, snapshot);
        return structuredClone(snapshot);
    }
    return {
        snapshot() { return structuredClone([...jobs.values()]); },
        async enqueue(input): Promise<EnqueueResult> {
            const job = validateStoredJob({ job: input });
            if (job.state !== "pending" || job.attempts !== 0) throw new JobStoreError({ code: "invalid_input", message: "Enqueue requires a new pending job" });
            const key = JSON.stringify([job.tenantId, job.idempotencyKey]);
            const existingId = keys.get(key);
            const existing = existingId === undefined ? undefined : jobs.get(existingId);
            if (existing) return sameRequest({ first: existing, second: job }) ? { kind: "existing", job: structuredClone(existing) } : { kind: "conflict" };
            if (jobs.has(job.id)) throw new JobStoreError({ code: "conflict", message: "Generated job ID already exists" });
            if (jobs.size >= maxJobs) throw new JobStoreError({ code: "limit_exceeded", message: "Outbox capacity reached" });
            keys.set(key, job.id);
            return { kind: "inserted", job: save(job) };
        },
        async recoverExpired(input): Promise<number> {
            validateTime(input);
            if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 1000) throw new JobStoreError({ code: "invalid_input", message: "Invalid recovery limit" });
            const expired = ordered().filter(job => isExpired({ job, now: input.now })).slice(0, input.limit);
            for (const job of expired) save({ ...job, state: "reconcile", leaseToken: null, leaseExpiresAt: null });
            return expired.length;
        },
        async claim(input): Promise<OutboxJob | null> {
            validateClaim(input);
            if (leases.has(input.leaseToken)) throw new JobStoreError({ code: "conflict", message: "Lease token already active" });
            const job = ordered().find(job => isDue({ job, ...input }));
            if (!job) return null;
            return save({ ...job, state: "leased", attempts: job.attempts + 1, leaseToken: input.leaseToken, leaseExpiresAt: input.leaseExpiresAt });
        },
        async beginDispatch(fence): Promise<boolean> {
            validateFence(fence);
            const job = jobs.get(fence.id);
            if (!job || job.state !== "leased" || !isFenced({ job, fence })) return false;
            save({ ...job, state: "dispatching" });
            return true;
        },
        async complete(fence: LeaseFence, completion: Completion): Promise<boolean> {
            validateCompletion({ fence, completion });
            const job = jobs.get(fence.id);
            if (!job || !isFenced({ job, fence })) return false;
            save({ ...job, ...completion, leaseToken: null, leaseExpiresAt: null });
            return true;
        },
        async get(input): Promise<OutboxJob | null> {
            const job = jobs.get(input.id);
            if (!job || job.tenantId !== input.tenantId) return null;
            return structuredClone(job);
        },
        async cancel(input): Promise<boolean> {
            validateTime(input);
            const job = jobs.get(input.id);
            if (!job || job.tenantId !== input.tenantId) return false;
            const state = cancellationState({ job });
            if (!state) return false;
            save({ ...job, state, leaseToken: null, leaseExpiresAt: null });
            return true;
        },
        async resolve(input): Promise<boolean> {
            validateResolution(input);
            const job = jobs.get(input.id);
            if (!job || job.tenantId !== input.tenantId || job.state !== "reconcile") return false;
            save({ ...job, state: input.state });
            return true;
        },
    };
}
/** Checkpoint loading enforces the same key/active-lease uniqueness as SQL before exposing a store.
 * @throws JobStoreError for duplicate identities/capacity; schema errors for corrupt records.
 * @complexity O(n+p) time/space, n <=maxJobs, p total bounded payload data.
 */
function restoreCheckpoint(required: { initialJobs: readonly OutboxJob[]; maxJobs: number }) {
    const jobs = new Map<string, OutboxJob>();
    const keys = new Map<string, string>();
    const leases = new Map<string, string>();
    for (const input of required.initialJobs) {
        const job = validateStoredJob({ job: input });
        const key = JSON.stringify([job.tenantId, job.idempotencyKey]);
        if (jobs.has(job.id) || keys.has(key) || jobs.size >= required.maxJobs) throw new JobStoreError({ code: "invalid_input", message: "Invalid memory checkpoint" });
        restoreLease({ job, leases });
        jobs.set(job.id, structuredClone(job));
        keys.set(key, job.id);
    }
    return { jobs, keys, leases };
}
/** A restored token must identify one active claim. @complexity O(1) time/space. */
function restoreLease(required: { job: OutboxJob; leases: Map<string, string> }): void {
    if (required.job.leaseToken === null) return;
    if (required.leases.has(required.job.leaseToken)) throw new JobStoreError({ code: "invalid_input", message: "Duplicate checkpoint lease token" });
    required.leases.set(required.job.leaseToken, required.job.id);
}
/** Lease loss remains uncertain even when transport may not have started. @complexity O(1). */
function isExpired(required: { job: OutboxJob; now: number }): boolean {
    return (required.job.state === "leased" || required.job.state === "dispatching")
        && required.job.leaseExpiresAt !== null && required.job.leaseExpiresAt <= required.now;
}
/** Cancelled queued work is known absent; leased work conservatively requires reconciliation. @complexity O(1). */
function cancellationState(required: { job: OutboxJob }): "cancelled" | "reconcile" | null {
    switch (required.job.state) {
        case "pending": case "retry": return "cancelled";
        case "leased": case "dispatching": return "reconcile";
        default: return null;
    }
}
/** Match SQLite's UTF-8 binary collation rather than JavaScript's UTF-16 ordering.
 * @complexity O(i) time/space, i <=256 characters per ID.
 */
function compareIds(required: { first: string; second: string }): number {
    const first = new TextEncoder().encode(required.first);
    const second = new TextEncoder().encode(required.second);
    for (let index = 0; index < Math.min(first.length, second.length); index++) {
        const difference = first[index] - second[index];
        if (difference !== 0) return difference;
    }
    return first.length - second.length;
}

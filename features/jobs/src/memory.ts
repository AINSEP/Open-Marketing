import type { ClockPort, IdPort, ObserverEvent, Outcome } from "@open-marketing/contracts";
import type { JobRepoPort, JobDispatchPort, JobAuthorizationPort, JobObserverPort } from "./ports.js";
import type { ProcessResult, RetryPolicy } from "./types.js";
import { createJobRepository } from "./repository.js";
import { createMemoryOutboxStore } from "./adapters/memory-store.js";
import { jobFailure } from "./errors.js";
/** In-memory repository double; caller injects time/IDs. Never compose into a production server.
 * @example createMemoryJobRepo({ clock, ids, retryPolicy }) @complexity O(1) construction; operations bounded by maxJobs.
 */
export function createMemoryJobRepo(required: { clock: ClockPort; ids: IdPort; retryPolicy: RetryPolicy; maxJobs?: number }): JobRepoPort {
    return createJobRepository({ ...required, outbox: createMemoryOutboxStore({ maxJobs: required.maxJobs }) });
}
/** Dispatch double defaults to unavailable, requiring explicit test behavior to claim an effect.
 * @complexity O(1), excluding injected dispatch work.
 */
export function createMemoryJobDispatch(required: { result?: Outcome<ProcessResult> }): JobDispatchPort {
    const result = structuredClone(required.result ?? jobFailure<ProcessResult>({ code: "unavailable", message: "No test dispatch behavior configured" }));
    return {
        async dispatch(_input, optional) {
            if (optional?.signal?.aborted) return jobFailure({ code: "cancelled", message: "Dispatch cancelled before effect" });
            return structuredClone(result);
        },
    };
}
/** Authorization double denies by default; allowing is an explicit test fixture decision. @complexity O(1). */
export function createMemoryJobAuthorization(required: { allowed?: boolean }): JobAuthorizationPort {
    const allowed = required.allowed === true;
    return {
        async authorize(_input, optional) {
            if (optional?.signal?.aborted) return jobFailure({ code: "cancelled", message: "Authorization cancelled" });
            return { ok: true, value: { allowed } };
        },
    };
}
/** Observer double returns detached events and supports reset for independent tests. @complexity O(n) snapshot/reset, O(1) append. */
export function createMemoryJobObserver(required: { maxEvents?: number }): JobObserverPort & { snapshot(required: Record<string, never>): readonly ObserverEvent[]; reset(required: Record<string, never>): void } {
    const events: ObserverEvent[] = [];
    const maxEvents = required.maxEvents ?? 10000;
    if (!Number.isSafeInteger(maxEvents) || maxEvents < 1 || maxEvents > 100000) throw new RangeError("Invalid observer capacity");
    return {
        observe(event) { if (events.length < maxEvents) events.push(structuredClone(event)); },
        snapshot() { return structuredClone(events); },
        reset() { events.length = 0; },
    };
}

import { createMemoryOutboxStore } from "../index.js";
import type { Completion, LeaseFence, OutboxJob, OutboxStore } from "../index.js";
/** Characterization compatibility wrapper over the same double exercised by the memory/SQL B1 suite.
 * Test-only construction performs no I/O; it retains the preserved fixture's snapshot ABI.
 */
export class MemoryStore implements OutboxStore {
    private readonly store = createMemoryOutboxStore({});
    snapshot(): readonly OutboxJob[] { return this.store.snapshot({}); }
    enqueue(job: OutboxJob) { return this.store.enqueue(job); }
    recoverExpired(input: Parameters<OutboxStore["recoverExpired"]>[0]) { return this.store.recoverExpired(input); }
    claim(input: Parameters<OutboxStore["claim"]>[0]) { return this.store.claim(input); }
    beginDispatch(fence: LeaseFence) { return this.store.beginDispatch(fence); }
    complete(fence: LeaseFence, completion: Completion) { return this.store.complete(fence, completion); }
}

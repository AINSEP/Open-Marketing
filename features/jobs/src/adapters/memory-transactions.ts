import type { CallContext, ClockPort, IdPort, Outcome } from "@open-marketing/contracts";
import { idSchema } from "@open-marketing/contracts";
import type { JobRepoPort } from "../ports.js";
import type { DomainIntentTransactionPort, JobReceipt, JobRequest, RetryPolicy } from "../types.js";
import type { ManagedOutboxStore } from "../store.js";
import { createMemoryOutboxStore } from "./memory-store.js";
import { createJobRepository, decodeClaim, jobTenant } from "../repository.js";
import { canonicalJson } from "../schema.js";
import { jobFailure } from "../errors.js";
export interface MemoryTransactionalJobs {
    readonly repo: JobRepoPort;
    readonly intents: DomainIntentTransactionPort;
    intent(required: { context: CallContext; intentId: string }): Readonly<{ jobId: string; operationId: string }> | null;
}
/** Transactional test double with one shared queue and draft/commit rollback semantics; never production persistence.
 * @example createMemoryTransactionalJobs({ clock, ids, retryPolicy })
 * @complexity O(n+p) snapshot per transaction, n <=maxJobs, p bounded payload storage; regular operations inherit store costs.
 */
export function createMemoryTransactionalJobs(required: {
    clock: ClockPort; ids: IdPort; retryPolicy: RetryPolicy; maxJobs?: number;
    acceptIntent?: (required: { context: CallContext; intentId: string; job: JobRequest }) => Outcome<void>;
}): MemoryTransactionalJobs {
    let current = createMemoryOutboxStore({ maxJobs: required.maxJobs });
    let intents = new Map<string, { jobId: string; operationId: string; payload: string }>();
    let tail: Promise<void> = Promise.resolve();
    /** Serialize every queue operation with commits to prevent a draft overwriting a concurrent worker update. @complexity O(1) local. */
    function serial<T>(input: { execute: () => Promise<T> }): Promise<T> {
        const operation = tail.then(input.execute);
        tail = operation.then(() => undefined, () => undefined);
        return operation;
    }
    const outbox: ManagedOutboxStore = {
        enqueue(job) { return serial({ execute: () => current.enqueue(job) }); },
        recoverExpired(input) { return serial({ execute: () => current.recoverExpired(input) }); },
        claim(input) { return serial({ execute: () => current.claim(input) }); },
        beginDispatch(fence) { return serial({ execute: () => current.beginDispatch(fence) }); },
        complete(fence, completion) { return serial({ execute: () => current.complete(fence, completion) }); },
        get(input) { return serial({ execute: () => current.get(input) }); },
        cancel(input) { return serial({ execute: () => current.cancel(input) }); },
        cancelBySubject(input) { return serial({ execute: () => current.cancelBySubject(input) }); },
        resolve(input) { return serial({ execute: () => current.resolve(input) }); },
    };
    const repo = createJobRepository({ ...required, outbox });
    return {
        repo,
        intent(input) {
            const value = intents.get(JSON.stringify([jobTenant(input), input.intentId]));
            if (!value) return null;
            return { jobId: value.jobId, operationId: value.operationId };
        },
        intents: {
            commit(input, optional) {
                return serial({ execute: async () => {
                    if (optional?.signal?.aborted) return jobFailure({ code: "cancelled", message: "Domain intent commit cancelled" });
                    if (!idSchema.safeParse(input.intentId).success) return jobFailure({ code: "invalid_input", message: "Invalid intent identity" });
                    const draft = createMemoryOutboxStore({ maxJobs: required.maxJobs, initialJobs: current.snapshot({}) });
                    const stagedRepo = createJobRepository({ ...required, outbox: draft });
                    const result = await stagedRepo.enqueue(input, optional);
                    if (!result.ok) return result;
                    const lease = await draft.get({ tenantId: jobTenant(input), id: result.value.jobId });
                    const snapshot = decodeClaim({ lease: lease! });
                    const intentResult = stageIntent({ context: snapshot.context, job: snapshot.job, intentId: input.intentId, receipt: result.value, intents, acceptIntent: required.acceptIntent });
                    if (!intentResult.ok) return intentResult;
                    if (optional?.signal?.aborted) return jobFailure({ code: "cancelled", message: "Domain intent commit cancelled" });
                    current = draft;
                    intents = intentResult.value;
                    return result;
                } });
            },
        },
    };
}
/** Intent identities cannot silently change their effect; failed acceptance leaves both drafts uncommitted. @complexity O(i+p), i prior intents. */
function stageIntent(required: {
    context: CallContext; intentId: string; job: JobRequest; receipt: JobReceipt;
    intents: Map<string, { jobId: string; operationId: string; payload: string }>;
    acceptIntent?: (required: { context: CallContext; intentId: string; job: JobRequest }) => Outcome<void>;
}): Outcome<Map<string, { jobId: string; operationId: string; payload: string }>> {
    const key = JSON.stringify([jobTenant(required), required.intentId]);
    const payload = canonicalJson({ value: required.job });
    const existing = required.intents.get(key);
    if (existing && existing.payload !== payload) return jobFailure({ code: "conflict", message: "Intent identity already binds another effect" });
    let acceptance: Outcome<void> | undefined;
    try { acceptance = required.acceptIntent?.(required); }
    catch { return jobFailure({ code: "unavailable", message: "Test intent writer unavailable" }); }
    if (acceptance && !acceptance.ok) return acceptance;
    const staged = new Map(required.intents);
    staged.set(key, { jobId: required.receipt.jobId, operationId: required.job.operationId, payload });
    return { ok: true, value: staged };
}

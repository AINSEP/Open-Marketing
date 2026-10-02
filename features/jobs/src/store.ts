import type { Completion, LeaseFence, OutboxJob, OutboxStore } from "./types.js";
import { JobStoreError } from "./errors.js";
/** Operator transitions require externally verified evidence; unknown outcomes are never automatically requeued. */
export interface ManagedOutboxStore extends OutboxStore {
    get(required: { tenantId: string; id: string }): Promise<OutboxJob | null>;
    cancel(required: { tenantId: string; id: string; now: number }): Promise<boolean>;
    resolve(required: { tenantId: string; id: string; state: "succeeded" | "denied" | "failed"; evidenceId: string; now: number }): Promise<boolean>;
}
/** Due eligibility has no side effects. @complexity O(1). */
export function isDue(required: { job: OutboxJob; now: number; maxAttempts: number }): boolean {
    return (required.job.state === "pending" || required.job.state === "retry")
        && required.job.availableAt <= required.now && required.job.attempts < required.maxAttempts;
}
/** Exact lease expiry is stale; tenant and token both participate in the fence. @complexity O(1). */
export function isFenced(required: { job: OutboxJob; fence: LeaseFence }): boolean {
    const { job, fence } = required;
    return job.tenantId === fence.tenantId && job.id === fence.id && job.leaseToken === fence.token
        && job.leaseExpiresAt !== null && job.leaseExpiresAt > fence.now
        && (job.state === "leased" || job.state === "dispatching");
}
/** Exact bytes prevent a forged digest from deduplicating different effects. @complexity O(p), p <=256KiB. */
export function sameRequest(required: { first: OutboxJob; second: OutboxJob }): boolean {
    return required.first.requestDigest === required.second.requestDigest
        && required.first.operation === required.second.operation && required.first.payload === required.second.payload;
}
/** Reject invalid times/tokens at store boundaries. @complexity O(1). */
export function validateClaim(required: { now: number; leaseToken: string; leaseExpiresAt: number; maxAttempts: number }): void {
    validateTime({ now: required.now });
    if (!Number.isSafeInteger(required.leaseExpiresAt) || required.leaseExpiresAt <= required.now) throw invalidStoreInput();
    if (!Number.isSafeInteger(required.maxAttempts) || required.maxAttempts < 1 || required.maxAttempts > 1000) throw invalidStoreInput();
    if (!required.leaseToken.trim() || required.leaseToken.length > 256) throw invalidStoreInput();
}
/** Invalid dates cannot accidentally extend a lease or turn a retry into a hot loop. @complexity O(1). */
export function validateTime(required: { now: number }): void {
    if (!Number.isSafeInteger(required.now) || required.now < 0) throw invalidStoreInput();
}
/** Retry dates are bounded and cannot precede completion. @complexity O(1). */
export function validateCompletion(required: { fence: LeaseFence; completion: Completion }): void {
    validateTime({ now: required.fence.now });
    if (required.completion.state !== "retry") return;
    validateTime({ now: required.completion.availableAt });
    if (required.completion.availableAt < required.fence.now) throw invalidStoreInput();
}
/** Typed validation failure shared by adapters. @complexity O(1). */
function invalidStoreInput(): JobStoreError {
    return new JobStoreError({ code: "invalid_input", message: "Invalid outbox transition" });
}

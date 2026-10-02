import type { Completion, FailureKind, RetryPolicy } from "./types.js";
/** Validate bounded integer retry configuration; throws RangeError for invalid bounds.
 * @complexity O(1) time/space.
 */
export function validateRetryPolicy(policy: RetryPolicy): void {
    if (![policy.maxAttempts, policy.baseDelayMs, policy.maxDelayMs, policy.leaseMs].every(value => Number.isSafeInteger(value) && value > 0)
        || policy.baseDelayMs > policy.maxDelayMs || policy.maxAttempts > 1000) {
        throw new RangeError("Invalid outbox retry policy");
    }
}
/** Calculate bounded backoff without overflow, using the completed attempt number (first = 1).
 * Callers validate retry policy once at construction. @complexity O(1) time/space.
 */
export function retryDelay({ attempt, policy }: {
    attempt: number;
    policy: RetryPolicy;
}): number {
    if (!Number.isSafeInteger(attempt) || attempt < 1)
        throw new RangeError("Invalid attempt number");
    return Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.min(attempt - 1, 53));
}
/** Unknown outcomes reconcile unless destination deduplication makes replay safe.
 * Attempt exhaustion after unknown outcomes also reconciles, preserving uncertainty.
 * @complexity O(1) time/space.
 */
export function failureCompletion({ kind, attempt, now, policy, idempotent }: {
    kind: FailureKind;
    attempt: number;
    now: number;
    policy: RetryPolicy;
    idempotent: boolean;
}): Completion {
    if (kind === "unknown" && (!idempotent || attempt >= policy.maxAttempts))
        return { state: "reconcile" };
    if (kind === "permanent" || attempt >= policy.maxAttempts)
        return { state: "failed" };
    const availableAt = now + retryDelay({ attempt: attempt, policy: policy });
    return Number.isSafeInteger(availableAt) ? { state: "retry", availableAt } : { state: "reconcile" };
}

import type { CallContext, ClockPort, IdPort } from "@open-marketing/contracts";
import type { JobRequest, OutboxJob } from "../index.js";
export const policy = { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 20, leaseMs: 100 };
export const context: CallContext = {
    scope: { ownerId: "owner", workspaceId: "workspace" }, principal: { kind: "service", serviceId: "server-jobs" },
    correlationId: "correlation", traceId: "trace", runId: "run",
};
export const job: JobRequest = { operationId: "operation", idempotencyKey: "key", argumentsDigest: "a".repeat(64), handler: "write", payload: { amount: 10 } };
export function clockFixture(required: Record<string, never>): ClockPort & { advance(required: { milliseconds: number }): void } {
    let time = 0;
    return { now() { return time; }, advance(input) { time += input.milliseconds; } };
}
export function idsFixture(required: { prefix?: string }): IdPort {
    let id = 0;
    return { next() { return (required.prefix ?? "id") + String(++id).padStart(5, "0"); } };
}
export function storedJob(required: Partial<OutboxJob>): OutboxJob {
    return { id: "job-a", tenantId: "tenant", idempotencyKey: "key", requestDigest: "digest", operation: "write", payload: "private",
        state: "pending", attempts: 0, availableAt: 0, createdAt: 0, leaseToken: null, leaseExpiresAt: null, ...required };
}

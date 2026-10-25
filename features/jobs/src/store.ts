import type { Completion, LeaseFence, OutboxJob, OutboxStore } from "./types.js";
import { JobStoreError } from "./errors.js";
import { z } from "zod";
import { epochSchema, idSchema } from "@open-marketing/contracts";
const tenantSchema = z.string().min(1).max(1024);
const nonblankIdSchema = idSchema.refine(value => value.trim().length > 0);
const fenceSchema = z.strictObject({ id: idSchema, tenantId: tenantSchema, token: nonblankIdSchema, now: epochSchema });
const completionSchema = z.discriminatedUnion("state", [
    z.strictObject({ state: z.literal("succeeded") }), z.strictObject({ state: z.literal("denied") }),
    z.strictObject({ state: z.literal("failed") }), z.strictObject({ state: z.literal("reconcile") }),
    z.strictObject({ state: z.literal("cancelled") }),
    z.strictObject({ state: z.literal("retry"), availableAt: epochSchema }),
]);
const resolutionSchema = z.strictObject({ tenantId: tenantSchema, id: idSchema, now: epochSchema,
    state: z.enum(["succeeded", "denied", "failed"]), evidenceId: nonblankIdSchema });
const subjectCancellationSchema = z.strictObject({ tenantId: tenantSchema, subjectIds: z.array(nonblankIdSchema).min(1).max(100).readonly(), now: epochSchema });
/** Operator transitions require externally verified evidence; unknown outcomes are never automatically requeued. */
export interface ManagedOutboxStore extends OutboxStore {
    get(required: { tenantId: string; id: string }): Promise<OutboxJob | null>;
    cancel(required: { tenantId: string; id: string; now: number }): Promise<boolean>;
    /** Cancel queued intent; invalidate leased attempts as uncertain. IDs include the full merge family.
     * @example store.cancelBySubject({ tenantId, subjectIds: [subjectId], now }); */
    cancelBySubject(required: z.infer<typeof subjectCancellationSchema>): Promise<{ cancelled: number; reconcile: number }>;
    resolve(required: { tenantId: string; id: string; state: "succeeded" | "denied" | "failed"; evidenceId: string; now: number }): Promise<boolean>;
}
/** Parse/detach the batch before mutation; invalid input throws JobStoreError. O(s), s<=100 IDs. */
export function validateSubjectCancellation(required: Parameters<ManagedOutboxStore["cancelBySubject"]>[0]) {
    const parsed = subjectCancellationSchema.safeParse(required);
    if (!parsed.success) throw invalidStoreInput();
    return parsed.data;
}
/** Match only JobRequest.payload.subjectId; corrupt JSON throws a storage failure. O(p+s), p<=256KiB. */
export function matchesSubject(required: { payload: string; subjectIds: readonly string[] }): boolean {
    try {
        const parsed = z.object({ payload: z.object({ subjectId: z.string().optional() }).passthrough() }).passthrough().safeParse(JSON.parse(required.payload));
        return parsed.success && required.subjectIds.includes(parsed.data.payload.subjectId ?? "");
    } catch { throw new JobStoreError({ code: "unavailable", message: "Invalid stored job payload" }); }
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
    if (!nonblankIdSchema.safeParse(required.leaseToken).success) throw invalidStoreInput();
}
/** Invalid dates cannot accidentally extend a lease or turn a retry into a hot loop. @complexity O(1). */
export function validateTime(required: { now: number }): void {
    if (!Number.isSafeInteger(required.now) || required.now < 0) throw invalidStoreInput();
}
/** Retry dates are bounded and cannot precede completion. @complexity O(1). */
export function validateCompletion(required: { fence: LeaseFence; completion: Completion }): void {
    validateFence(required.fence);
    if (!completionSchema.safeParse(required.completion).success) throw invalidStoreInput();
    if (required.completion.state !== "retry") return;
    validateTime({ now: required.completion.availableAt });
    if (required.completion.availableAt < required.fence.now) throw invalidStoreInput();
}
/** Fence identity is parsed before either adapter touches state. @throws JobStoreError for invalid input. @complexity O(1). */
export function validateFence(required: LeaseFence): void {
    if (!fenceSchema.safeParse(required).success) throw invalidStoreInput();
}
/** Reconciliation closes uncertainty with evidence; it never authorizes another attempt.
 * @throws JobStoreError for invalid/extra fields. @complexity O(1), bounded identity strings.
 */
export function validateResolution(required: Parameters<ManagedOutboxStore["resolve"]>[0]): void {
    if (!resolutionSchema.safeParse(required).success) throw invalidStoreInput();
}
/** Typed validation failure shared by adapters. @complexity O(1). */
function invalidStoreInput(): JobStoreError {
    return new JobStoreError({ code: "invalid_input", message: "Invalid outbox transition" });
}

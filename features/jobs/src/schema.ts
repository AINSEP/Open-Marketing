import { z } from "zod";
import { callContextSchema, digestSchema, epochSchema, idSchema } from "@open-marketing/contracts";
import type { CallContext, Outcome } from "@open-marketing/contracts";
import type { JobRequest, OutboxJob, TransportResult } from "./types.js";
import { jobFailure } from "./errors.js";
/** Transport classifications are a boundary value, never inferred from an arbitrary retryable flag. */
export const transportResultSchema = z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("success") }),
    z.strictObject({ kind: z.literal("failure"), classification: z.enum(["permanent", "transient", "unknown"]) }),
]);
export const processResultSchema = z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("idle") }),
    z.strictObject({ kind: z.literal("aborted") }),
    z.strictObject({ kind: z.literal("stale") }),
    z.strictObject({ kind: z.literal("completed"), jobId: idSchema,
        state: z.enum(["succeeded", "denied", "failed", "reconcile", "cancelled", "retry"]) }),
]);
/** Invalid adapter output means uncertainty; it cannot manufacture success or safe replay.
 * @returns A detached classification, defaulting to unknown. @complexity O(1) time/space.
 */
export function parseTransportResult(required: { value: unknown }): TransportResult {
    const parsed = transportResultSchema.safeParse(required.value);
    if (!parsed.success) return { kind: "failure", classification: "unknown" };
    return parsed.data;
}
export const jobRequestSchema = z.strictObject({
    operationId: idSchema, idempotencyKey: idSchema, argumentsDigest: digestSchema,
    handler: idSchema, payload: z.record(z.string(), z.json()),
});
export const workerSchema = z.strictObject({ workerId: idSchema });
/** Validate and detach a domain call before handing it to an attempt adapter.
 * @returns Parsed call or invalid_input without leaking payload/schema errors.
 * @complexity O(n log k) time, O(n) space under canonicalJson bounds.
 */
export function parseJobCall(required: { context: CallContext; job: JobRequest }): Outcome<{ context: CallContext; job: JobRequest }> {
    try {
        const context = callContextSchema.parse(required.context);
        const job = jobRequestSchema.parse(JSON.parse(canonicalJson({ value: required.job })));
        return { ok: true, value: { context, job } };
    } catch { return jobFailure({ code: "invalid_input", message: "Invalid handler request" }); }
}
export const outboxJobSchema = z.strictObject({
    tenantId: z.string().min(1).max(1024), idempotencyKey: idSchema, requestDigest: idSchema,
    operation: idSchema, payload: z.string().max(262144), id: idSchema,
    state: z.enum(["pending", "leased", "dispatching", "retry", "succeeded", "denied", "failed", "reconcile", "cancelled"]),
    attempts: z.number().int().min(0).max(1000), availableAt: epochSchema, createdAt: epochSchema,
    leaseToken: idSchema.nullable(), leaseExpiresAt: epochSchema.nullable(), context: callContextSchema.optional(),
});
/** Canonical JSON is bounded before schema traversal. No getters, class instances, cycles, or lossy JSON values.
 * @complexity O(n log k) time, O(n) space; n <=10000 nodes, k <=1024 keys, depth <=16.
 */
export function canonicalJson(required: { value: unknown }): string {
    const budget = { nodes: 0 };
    const normalized = normalize({ value: required.value, depth: 0, budget });
    const result = JSON.stringify(normalized);
    if (result.length > 262144) throw new TypeError("Job payload exceeds limit");
    return result;
}
/** Recursion bounds precede descent; active cycles necessarily hit the depth ceiling. @complexity Inherits canonicalJson bounds. */
function normalize(required: { value: unknown; depth: number; budget: { nodes: number } }): unknown {
    required.budget.nodes++;
    if (required.depth > 16 || required.budget.nodes > 10000) throw new TypeError("Job JSON exceeds traversal limit");
    const value = required.value;
    if (typeof value === "string") return boundedString({ value });
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value !== "object") throw new TypeError("Job JSON contains unsupported value");
    if (Array.isArray(value)) return normalizeArray({ ...required, value });
    return normalizeObject({ ...required, value: value as Record<string, unknown> });
}
/** Reject a single oversized string before JSON allocates its escaped representation. @complexity O(1). */
function boundedString(required: { value: string }): string {
    if (required.value.length > 262144) throw new TypeError("Job string exceeds limit");
    return required.value;
}
/** Reject sparse arrays and accessor elements instead of silently replacing them with null. @complexity O(n) plus recursive children. */
function normalizeArray(required: { value: unknown[]; depth: number; budget: { nodes: number } }): unknown[] {
    if (required.value.length > 10000) throw new TypeError("Job array exceeds limit");
    return Array.from({ length: required.value.length }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(required.value, String(index));
        if (!descriptor || !("value" in descriptor)) throw new TypeError("Job array contains missing/accessor element");
        return normalize({ value: descriptor.value, depth: required.depth + 1, budget: required.budget });
    });
}
/** Sort plain-object keys and read data descriptors only. @complexity O(k log k) plus recursive children. */
function normalizeObject(required: { value: Record<string, unknown>; depth: number; budget: { nodes: number } }): Record<string, unknown> {
    const prototype = Object.getPrototypeOf(required.value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError("Job JSON must be plain data");
    const keys = Object.keys(required.value).sort();
    if (keys.length > 1024 || Object.getOwnPropertySymbols(required.value).length > 0) throw new TypeError("Job object exceeds limit");
    const normalized: Record<string, unknown> = Object.create(null);
    for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(required.value, key)!;
        if (!("value" in descriptor)) throw new TypeError("Job JSON contains accessor");
        normalized[key] = normalize({ value: descriptor.value, depth: required.depth + 1, budget: required.budget });
    }
    return normalized;
}
/** Persisted data is tainted until parsed. @complexity O(n) under the serialization bounds. */
export function decodeJob(required: { payload: string }): JobRequest {
    if (required.payload.length > 262144) throw new TypeError("Job payload exceeds limit");
    const value: unknown = JSON.parse(required.payload);
    canonicalJson({ value });
    return jobRequestSchema.parse(value);
}
/** Validate a detached store snapshot and state/lease consistency. @complexity O(n), context bounded by schema. */
export function validateStoredJob(required: { job: unknown }): OutboxJob {
    const job = outboxJobSchema.parse(required.job);
    const leased = job.state === "leased" || job.state === "dispatching";
    if (leased !== (job.leaseToken !== null && job.leaseExpiresAt !== null)) throw new TypeError("Invalid job lease state");
    if (!leased && (job.leaseToken !== null || job.leaseExpiresAt !== null)) throw new TypeError("Invalid job lease state");
    return job;
}

import type { CallContext, CallOptions, Outcome } from "@open-marketing/contracts";
import type { ClaimedJob, JobDispatchPort } from "./ports.js";
import type { JobRequest, ProcessResult, TransportResult } from "./types.js";
import { parseJobCall, parseTransportResult } from "./schema.js";
import { jobFailure } from "./errors.js";
/** Handler executes exactly one attempt. It owns vendor-specific result validation and the authority/transport barrier. */
export interface JobHandler {
    handle(required: { context: CallContext; job: JobRequest }, optional?: CallOptions): Promise<TransportResult>;
    /** Own dispatch-start and completion on the claimed outbox; result is diagnostic only. */
    handleClaim?(required: ClaimedJob, optional?: CallOptions): Promise<Outcome<unknown>>;
    dispose(required: Record<string, never>): Promise<void>;
}
/** Instances are composed by the server. Removal rejects new attempts and waits for in-flight effects before disposal. */
export interface JobHandlerRegistry extends JobDispatchPort {
    register(required: { name: string; handler: JobHandler }): Outcome<{ readonly registered: true }>;
    unregister(required: { name: string }): Promise<Outcome<{ readonly removed: boolean }>>;
    reset(required: Record<string, never>): Promise<Outcome<{ readonly reset: true }>>;
    dispose(required: Record<string, never>): Promise<Outcome<{ readonly disposed: true }>>;
}
interface Binding { handler: JobHandler; active: Set<Promise<void>> }
/** Instance-scoped bounded registry; no timers, global runtime registry, or feature-specific queue.
 * @example createJobHandlerRegistry({ maxHandlers: 100, maxActive: 128 })
 * @complexity O(1) lookup/register; reset/dispose O(h+a), h <=maxHandlers, a <=maxActive.
 */
export function createJobHandlerRegistry(required: { maxHandlers?: number; maxActive?: number }): JobHandlerRegistry {
    const maxHandlers = required.maxHandlers ?? 100;
    if (!Number.isSafeInteger(maxHandlers) || maxHandlers < 1 || maxHandlers > 1000) throw new RangeError("Invalid handler capacity");
    const maxActive = required.maxActive ?? 128;
    if (!Number.isSafeInteger(maxActive) || maxActive < 1 || maxActive > 10000) throw new RangeError("Invalid active attempt capacity");
    const bindings = new Map<string, Binding>();
    const retiring = new Map<string, Promise<Outcome<{ readonly removed: boolean }>>>();
    let disposed = false;
    let resetting = false;
    let active = 0;
    /** Apply the same admission/draining rules to ordinary and claim-owning attempts.
     * Handler throws become unavailable; no alternative dispatch follows. @complexity O(1) time/space plus work. */
    async function runBinding<T>(input: { binding?: Binding; optional?: CallOptions; work(): Promise<Outcome<T>> }): Promise<Outcome<T>> {
        if (input.optional?.signal?.aborted) return jobFailure({ code: "cancelled", message: "Dispatch cancelled before effect" });
        const binding = input.binding;
        if (!binding || disposed || resetting) return jobFailure({ code: "unavailable", message: "Job handler unavailable" });
        if (active >= maxActive) return jobFailure({ code: "limit_exceeded", message: "Active attempt capacity reached" });
        active++;
        const { promise: attempt, resolve: release } = Promise.withResolvers<void>();
        binding.active.add(attempt);
        try { return await input.work(); }
        catch { return jobFailure({ code: "unavailable", message: "Job handler attempt failed" }); }
        finally { active--; binding.active.delete(attempt); release(); }
    }
    /** Unpublish first, then drain. Cleanup cannot hide a possible remote effect. @complexity O(a) active calls. */
    async function unregister(input: { name: string }): Promise<Outcome<{ readonly removed: boolean }>> {
        const retirement = retiring.get(input.name);
        if (retirement) return retirement;
        const binding = bindings.get(input.name);
        if (!binding) return { ok: true, value: { removed: false } };
        bindings.delete(input.name);
        const work = retire({ binding });
        retiring.set(input.name, work);
        const result = await work;
        retiring.delete(input.name);
        return result;
    }
    /** Reject registration while resetting and drain all previously admitted calls. @complexity O(h+a). */
    async function reset(): Promise<Outcome<{ readonly reset: true }>> {
        if (resetting) return jobFailure({ code: "conflict", message: "Handler reset already running" });
        resetting = true;
        try {
            const work = [...bindings.keys()].map(name => unregister({ name }));
            const results = await Promise.all([...work, ...retiring.values()]);
            const failure = results.find(result => !result.ok);
            if (failure && !failure.ok) return failure;
            return { ok: true, value: { reset: true } };
        } finally { resetting = false; }
    }
    return {
        register(input) {
            if (disposed || resetting) return jobFailure({ code: "unavailable", message: "Handler registry closed" });
            if (!input.name.trim() || input.name.length > 256) return jobFailure({ code: "invalid_input", message: "Invalid handler name" });
            if (bindings.has(input.name) || retiring.has(input.name)) return jobFailure({ code: "conflict", message: "Handler already registered or draining" });
            if (bindings.size + retiring.size >= maxHandlers) return jobFailure({ code: "limit_exceeded", message: "Handler capacity reached" });
            bindings.set(input.name, { handler: input.handler, active: new Set() });
            return { ok: true, value: { registered: true } };
        },
        async dispatch(input, optional): Promise<Outcome<ProcessResult>> {
            const parsed = parseJobCall(input);
            if (!parsed.ok) return parsed;
            const binding = bindings.get(parsed.value.job.handler);
            return runBinding({ binding, optional, work: () => dispatchBinding({ binding: binding!, input: parsed.value, optional }) });
        },
        async dispatchClaim(input, optional): Promise<Outcome<{ readonly settled: unknown } | null>> {
            const parsed = parseJobCall(input);
            if (!parsed.ok) return parsed;
            const binding = bindings.get(parsed.value.job.handler);
            const handleClaim = binding?.handler.handleClaim;
            if (!handleClaim) return { ok: true, value: null };
            return runBinding({ binding, optional, work: async () => {
                const result = await handleClaim({ ...input, ...parsed.value }, optional);
                return result.ok ? { ok: true, value: { settled: result.value } } : result;
            } });
        },
        unregister,
        reset,
        async dispose() {
            disposed = true;
            const result = await reset();
            if (!result.ok) return result;
            return { ok: true, value: { disposed: true } };
        },
    };
}
/** Map ordinary handler output; thrown attempts stay uncertain. @complexity O(1) plus handler work. */
async function dispatchBinding(required: { binding: Binding; input: { context: CallContext; job: JobRequest }; optional?: CallOptions }): Promise<Outcome<ProcessResult>> {
    const operationId = required.input.job.operationId;
    try {
        const result = parseTransportResult({ value: await required.binding.handler.handle(required.input, required.optional) });
        return { ok: true, value: { kind: "completed", jobId: operationId, state: handlerState({ result }) } };
    } catch {
        return { ok: true, value: { kind: "completed", jobId: operationId, state: "reconcile" } };
    }
}
/** Classification is a trusted handler seam; malformed output remains uncertain. @complexity O(1). */
function handlerState(required: { result: TransportResult }): "succeeded" | "retry" | "failed" | "reconcile" {
    if (required.result?.kind === "success") return "succeeded";
    if (required.result?.kind !== "failure") return "reconcile";
    switch (required.result.classification) {
        case "transient": return "retry";
        case "permanent": return "failed";
        case "unknown": return "reconcile";
        default: { const exhaustive: never = required.result.classification; void exhaustive; return "reconcile"; }
    }
}
/** Dispose exactly once after active calls settle. Failed cleanup is explicit and cannot resurrect a binding. @complexity O(a). */
async function retire(required: { binding: Binding }): Promise<Outcome<{ readonly removed: boolean }>> {
    await Promise.all(required.binding.active);
    try {
        await required.binding.handler.dispose({});
        return { ok: true, value: { removed: true } };
    } catch { return jobFailure({ code: "unavailable", message: "Job handler disposal failed" }); }
}

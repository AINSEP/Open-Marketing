import { describe, expect, it, vi } from "vitest";
import { createJobHandlerRegistry } from "../index.js";
import type { TransportResult } from "../index.js";
import { context, job, storedJob } from "./fixtures.js";
function pendingAttempt(required: Record<string, never>) {
    const { promise: result, resolve: resolve } = Promise.withResolvers<TransportResult>();
    const { promise: started, resolve: entered } = Promise.withResolvers<void>();
    const dispose = vi.fn(async () => undefined);
    const handler = { async handle() { entered(); return result; }, dispose };
    return { handler, started, dispose, resolve };
}
describe("handler lifecycle", () => {
    it("distinguishes a claim handler's null diagnostic from no claim handler", async () => {
        const registry = createJobHandlerRegistry({});
        const handle = vi.fn(async (): Promise<TransportResult> => ({ kind: "success" }));
        const handleClaim = vi.fn(async () => ({ ok: true as const, value: null }));
        registry.register({ name: "write", handler: { handle, handleClaim, async dispose() {} } });
        const claimed = { context, job, lease: storedJob({}) };
        expect(await registry.dispatchClaim!(claimed)).toEqual({ ok: true, value: { settled: null } });
        expect(handleClaim).toHaveBeenCalledTimes(1);
        expect(handle).not.toHaveBeenCalled();
        await registry.unregister({ name: "write" });
        registry.register({ name: "write", handler: { handle, async dispose() {} } });
        expect(await registry.dispatchClaim!(claimed)).toEqual({ ok: true, value: null });
        expect(handle).not.toHaveBeenCalled();
        await registry.dispose({});
    });
    it("unregister removes admission immediately, drains the active effect and disposes once", async () => {
        const registry = createJobHandlerRegistry({});
        const attempt = pendingAttempt({});
        expect(registry.register({ name: "write", handler: attempt.handler })).toEqual({ ok: true, value: { registered: true } });
        const dispatched = registry.dispatch({ context, job });
        await attempt.started;
        const removed = registry.unregister({ name: "write" });
        expect(await registry.dispatch({ context, job })).toMatchObject({ ok: false, error: { code: "unavailable" } });
        expect(registry.register({ name: "write", handler: attempt.handler })).toMatchObject({ ok: false, error: { code: "conflict" } });
        expect(attempt.dispose).not.toHaveBeenCalled();
        attempt.resolve({ kind: "success" });
        expect(await dispatched).toMatchObject({ ok: true, value: { state: "succeeded" } });
        expect(await removed).toEqual({ ok: true, value: { removed: true } });
        expect(attempt.dispose).toHaveBeenCalledTimes(1);
        expect(await registry.unregister({ name: "write" })).toEqual({ ok: true, value: { removed: false } });
        expect(attempt.dispose).toHaveBeenCalledTimes(1);
    });
    it("reset permits later explicit registration; dispose permanently closes admission", async () => {
        const registry = createJobHandlerRegistry({});
        const dispose = vi.fn(async () => undefined);
        const handler = { async handle(): Promise<TransportResult> { return { kind: "success" }; }, dispose };
        registry.register({ name: "write", handler });
        expect(await registry.reset({})).toEqual({ ok: true, value: { reset: true } });
        expect(dispose).toHaveBeenCalledTimes(1);
        expect(registry.register({ name: "write", handler })).toEqual({ ok: true, value: { registered: true } });
        expect(await registry.dispose({})).toEqual({ ok: true, value: { disposed: true } });
        expect(dispose).toHaveBeenCalledTimes(2);
        expect(await registry.dispose({})).toEqual({ ok: true, value: { disposed: true } });
        expect(dispose).toHaveBeenCalledTimes(2);
        expect(registry.register({ name: "write", handler })).toMatchObject({ ok: false, error: { code: "unavailable" } });
    });
    it("disposal rejection is explicit and does not resurrect a handler", async () => {
        const registry = createJobHandlerRegistry({});
        registry.register({ name: "write", handler: { async handle() { return { kind: "success" }; }, async dispose() { throw new Error("secret cleanup error"); } } });
        expect(await registry.unregister({ name: "write" })).toMatchObject({ ok: false, error: { code: "unavailable" } });
        expect(await registry.dispatch({ context, job })).toMatchObject({ ok: false, error: { code: "unavailable" } });
    });
    it("bounds registrations and refuses duplicate names", () => {
        const registry = createJobHandlerRegistry({ maxHandlers: 1 });
        const handler = { async handle(): Promise<TransportResult> { return { kind: "success" }; }, async dispose() {} };
        registry.register({ name: "write", handler });
        expect(registry.register({ name: "write", handler })).toMatchObject({ ok: false, error: { code: "conflict" } });
        expect(registry.register({ name: "second", handler })).toMatchObject({ ok: false, error: { code: "limit_exceeded" } });
    });
    it("a thrown handler effect is uncertain and malformed JSON never reaches it", async () => {
        const registry = createJobHandlerRegistry({});
        const handle = vi.fn(async (): Promise<TransportResult> => { throw new Error("Remote acceptance uncertain"); });
        registry.register({ name: "write", handler: { handle, async dispose() {} } });
        expect(await registry.dispatch({ context, job })).toMatchObject({ ok: true, value: { state: "reconcile" } });
        expect(await registry.dispatch({ context, job: { ...job, payload: { invalid: Number.NaN } } })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
        expect(handle).toHaveBeenCalledTimes(1);
    });
    it("malformed handler classification cannot authorize a retry", async () => {
        const registry = createJobHandlerRegistry({});
        registry.register({ name: "write", handler: {
            async handle() { return { kind: "failure", classification: "unrecognized" } as unknown as TransportResult; },
            async dispose() {},
        } });
        expect(await registry.dispatch({ context, job })).toEqual({ ok: true, value: { kind: "completed", jobId: job.operationId, state: "reconcile" } });
        await registry.dispose({});
    });
    it("bounds active effects across handlers and frees capacity after settlement", async () => {
        const registry = createJobHandlerRegistry({ maxActive: 1 });
        const attempt = pendingAttempt({});
        registry.register({ name: "write", handler: attempt.handler });
        const handle = vi.fn(async (): Promise<TransportResult> => ({ kind: "success" }));
        registry.register({ name: "second", handler: { handle, async dispose() {} } });
        const dispatched = registry.dispatch({ context, job });
        await attempt.started;
        const second = { context, job: { ...job, handler: "second" } };
        expect(await registry.dispatch(second)).toMatchObject({ ok: false, error: { code: "limit_exceeded" } });
        expect(handle).not.toHaveBeenCalled();
        attempt.resolve({ kind: "success" });
        await dispatched;
        expect(await registry.dispatch(second)).toMatchObject({ ok: true, value: { state: "succeeded" } });
        expect(handle).toHaveBeenCalledTimes(1);
        await registry.dispose({});
    });
});

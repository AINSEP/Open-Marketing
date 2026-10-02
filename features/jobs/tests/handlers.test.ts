import { describe, expect, it, vi } from "vitest";
import { createJobHandlerRegistry } from "../index.js";
import type { TransportResult } from "../index.js";
import { context, job } from "./fixtures.js";
function pendingAttempt(required: Record<string, never>) {
    let resolve!: (result: TransportResult) => void;
    const result = new Promise<TransportResult>(done => { resolve = done; });
    let entered!: () => void;
    const started = new Promise<void>(done => { entered = done; });
    const dispose = vi.fn(async () => undefined);
    const handler = { async handle() { entered(); return result; }, dispose };
    return { handler, started, dispose, resolve };
}
describe("handler lifecycle", () => {
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
});

import { describe, expect, it, vi } from "vitest";
import { createFakeClock } from "@open-marketing/om-clock";
import { createOutbox, retryDelay } from "../src/index.js";
import type { OutboxJob, TransportResult } from "../src/types.js";
import { MemoryStore } from "./memory-store.js";
const policy = { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 20, leaseMs: 100 };
const request = { tenantId: "tenant-a", idempotencyKey: "key", requestDigest: "digest", operation: "write", payload: "private-body" };
function setup({ idempotent = false }: {
    idempotent?: boolean;
}) {
    const clock = { ...createFakeClock({ initial: 0 }) };
    const store = new MemoryStore();
    let id = 0;
    const authorize = vi.fn(async (_job: OutboxJob) => true);
    const dispatch = vi.fn(async (): Promise<TransportResult> => ({ kind: "success" }));
    const observe = vi.fn();
    const outbox = createOutbox({ ports: { store, clock, generateId: () => String(++id), authorize, transport: { idempotent, dispatch }, observe }, inputPolicy: policy });
    return { clock, store, authorize, dispatch, observe, outbox };
}
describe("idempotency", () => {
    it("rejects oversized fields before persistence", async () => {
        const { outbox, store } = setup({});
        for (const invalid of [{ ...request, tenantId: "x".repeat(257) }, { ...request, payload: "x".repeat(262145) }]) {
            await expect(outbox.enqueue(invalid)).rejects.toThrow(TypeError);
        }
        expect(store.snapshot()).toEqual([]);
    });
    it("atomically deduplicates concurrent requests scoped by tenant", async () => {
        const { outbox, store } = setup({});
        const results = await Promise.all([outbox.enqueue(request), outbox.enqueue(request)]);
        expect(results.map(value => value.kind)).toEqual(["inserted", "existing"]);
        expect(store.snapshot()).toHaveLength(1);
        expect((await outbox.enqueue({ ...request, tenantId: "tenant-b" })).kind).toBe("inserted");
    });
    it("rejects changed digest or content without overwriting", async () => {
        const { outbox, store } = setup({});
        await outbox.enqueue(request);
        expect((await outbox.enqueue({ ...request, requestDigest: "other" })).kind).toBe("conflict");
        expect((await outbox.enqueue({ ...request, payload: "different" })).kind).toBe("conflict");
        expect(store.snapshot()[0]?.payload).toBe(request.payload);
    });
});
describe("enqueue timing", () => {
    it("keeps future work unclaimed until exact due time without authorizing or dispatching early", async () => {
        const { outbox, clock, store, authorize, dispatch } = setup({});
        clock.advance({ milliseconds: 10 });
        const result = await outbox.enqueue({ ...request, availableAt: 100 });
        expect(result).toMatchObject({ kind: "inserted", job: { createdAt: 10, availableAt: 100 } });
        expect(await outbox.processOne()).toEqual({ kind: "idle" });
        clock.advance({ milliseconds: 89 });
        expect(await outbox.processOne()).toEqual({ kind: "idle" });
        expect(store.snapshot()[0]).toMatchObject({ state: "pending", attempts: 0, leaseToken: null });
        expect(authorize).not.toHaveBeenCalled(); expect(dispatch).not.toHaveBeenCalled();
        clock.advance({ milliseconds: 1 });
        expect(await outbox.processOne()).toMatchObject({ kind: "completed", state: "succeeded" });
        expect(await outbox.processOne()).toEqual({ kind: "idle" });
        expect(authorize).toHaveBeenCalledTimes(1); expect(dispatch).toHaveBeenCalledTimes(1);
    });
    it.each([undefined, 0, 99, 100])("makes omitted/current/past timing %s immediately eligible", async availableAt => {
        const { outbox, clock, dispatch } = setup({});
        clock.advance({ milliseconds: 100 });
        const now = vi.spyOn(clock, "now");
        expect(await outbox.enqueue({ ...request, availableAt })).toMatchObject({ job: { createdAt: 100, availableAt: availableAt ?? 100 } });
        expect(now).toHaveBeenCalledTimes(1);
        expect(await outbox.processOne()).toMatchObject({ state: "succeeded" });
        expect(dispatch).toHaveBeenCalledTimes(1);
    });
    it("accepts the maximum safe epoch without claiming it early", async () => {
        const { outbox, store } = setup({});
        await outbox.enqueue({ ...request, availableAt: Number.MAX_SAFE_INTEGER });
        expect(store.snapshot()[0]?.availableAt).toBe(Number.MAX_SAFE_INTEGER);
        expect(await outbox.processOne()).toEqual({ kind: "idle" });
    });
    it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, -Infinity, "100", null])("rejects invalid timing %s before persistence", async availableAt => {
        const { outbox, store } = setup({});
        await expect(outbox.enqueue({ ...request, availableAt: availableAt as number })).rejects.toMatchObject({ name: "JobStoreError", code: "invalid_input" });
        expect(store.snapshot()).toEqual([]);
    });
    it.each([undefined, 100])("keeps the first schedule %s on duplicates and still rejects malformed timing", async availableAt => {
        const { outbox, store, clock } = setup({});
        const first = await outbox.enqueue({ ...request, availableAt });
        if (first.kind !== "inserted") throw new Error("Expected inserted job");
        clock.advance({ milliseconds: 10 });
        expect(await outbox.enqueue({ ...request, availableAt: 200 })).toEqual({ kind: "existing", job: first.job });
        await expect(outbox.enqueue({ ...request, availableAt: null as unknown as number })).rejects.toMatchObject({ code: "invalid_input" });
        expect(store.snapshot()).toEqual([first.job]);
    });
});
describe("dispatch leases", () => {
    it("concurrent workers claim a job only once", async () => {
        const { outbox, dispatch, store } = setup({});
        await outbox.enqueue(request);
        await Promise.all([outbox.processOne(), outbox.processOne()]);
        expect(dispatch).toHaveBeenCalledTimes(1);
        expect(store.snapshot()[0]?.state).toBe("succeeded");
    });
    it("checks halt after enqueue and never dispatches a denied job", async () => {
        const { outbox, authorize, dispatch, store } = setup({});
        await outbox.enqueue(request);
        authorize.mockResolvedValue(false);
        expect(await outbox.processOne()).toMatchObject({ kind: "completed", state: "denied" });
        expect(dispatch).not.toHaveBeenCalled();
        expect(store.snapshot()[0]?.state).toBe("denied");
    });
    it("authorization cannot mutate the persisted request or its lease fence", async () => {
        const { outbox, authorize, dispatch } = setup({});
        await outbox.enqueue(request);
        authorize.mockImplementation(async lease => {
            Object.assign(lease, { payload: "changed-effect", leaseToken: "changed-token" });
            return true;
        });
        expect(await outbox.processOne()).toMatchObject({ state: "succeeded" });
        expect(dispatch).toHaveBeenCalledWith({ ...request, context: undefined }, undefined);
    });
    it("does not dispatch when authorization outlives the lease", async () => {
        const { outbox, authorize, clock, dispatch, store } = setup({});
        await outbox.enqueue(request);
        authorize.mockImplementation(async () => { clock.advance({ milliseconds: 100 }); return true; });
        expect(await outbox.processOne()).toEqual({ kind: "stale" });
        expect(dispatch).not.toHaveBeenCalled();
        await outbox.processOne();
        expect(store.snapshot()[0]?.state).toBe("reconcile");
    });
    it("fences stale ack and retry by token, tenant, and exact lease expiry", async () => {
        const { outbox, store } = setup({});
        await outbox.enqueue(request);
        const job = (await store.claim({ now: 0, leaseToken: "token", leaseExpiresAt: 100, maxAttempts: 3 }))!;
        for (const fence of [
            { id: job.id, tenantId: request.tenantId, token: "wrong", now: 1 },
            { id: job.id, tenantId: "other", token: "token", now: 1 },
            { id: job.id, tenantId: request.tenantId, token: "token", now: 100 },
        ]) {
            expect(await store.complete(fence, { state: "succeeded" })).toBe(false);
            expect(await store.complete(fence, { state: "retry", availableAt: 200 })).toBe(false);
        }
        expect(await store.recoverExpired({ now: 100, limit: 100 })).toBe(1);
        expect(await store.claim({ now: 100, leaseToken: "new", leaseExpiresAt: 200, maxAttempts: 3 })).toBeNull();
    });
    it("lost completion cannot cause blind redispatch", async () => {
        const { outbox, store, clock, dispatch } = setup({});
        await outbox.enqueue(request);
        vi.spyOn(store, "complete").mockRejectedValueOnce(new Error("database unavailable"));
        await expect(outbox.processOne()).rejects.toThrow("database unavailable");
        clock.advance({ milliseconds: 100 });
        await outbox.processOne();
        expect(dispatch).toHaveBeenCalledTimes(1);
        expect(store.snapshot()[0]?.state).toBe("reconcile");
    });
});
describe("retries and uncertainty", () => {
    it("bounds backoff and stops at attempt cap", async () => {
        const { outbox, dispatch, clock, store } = setup({});
        dispatch.mockResolvedValue({ kind: "failure", classification: "transient" });
        await outbox.enqueue(request);
        await outbox.processOne();
        expect(store.snapshot()[0]?.availableAt).toBe(10);
        expect(await outbox.processOne()).toEqual({ kind: "idle" });
        clock.advance({ milliseconds: 10 });
        await outbox.processOne();
        expect(store.snapshot()[0]?.availableAt).toBe(30);
        clock.advance({ milliseconds: 20 });
        expect(await outbox.processOne()).toMatchObject({ state: "failed" });
        clock.advance({ milliseconds: 1000 });
        expect(await outbox.processOne()).toEqual({ kind: "idle" });
        expect(dispatch).toHaveBeenCalledTimes(3);
        expect(retryDelay({ attempt: 1000, policy: policy })).toBe(20);
    });
    it("permanent failures never retry", async () => {
        const { outbox, dispatch } = setup({});
        dispatch.mockResolvedValue({ kind: "failure", classification: "permanent" });
        await outbox.enqueue(request);
        expect(await outbox.processOne()).toMatchObject({ state: "failed" });
    });
    it("malformed transport output reconciles rather than granting retry authority", async () => {
        const { outbox, dispatch } = setup({});
        dispatch.mockResolvedValue({ kind: "failure", classification: "unexpected" } as unknown as TransportResult);
        await outbox.enqueue(request);
        expect(await outbox.processOne()).toMatchObject({ state: "reconcile" });
        expect(await outbox.processOne()).toEqual({ kind: "idle" });
        expect(dispatch).toHaveBeenCalledTimes(1);
    });
    it("thrown or reported unknown outcomes require reconciliation without deduplication", async () => {
        for (const throws of [true, false]) {
            const { outbox, dispatch } = setup({});
            if (throws)
                dispatch.mockRejectedValue(new Error("secret provider error"));
            else
                dispatch.mockResolvedValue({ kind: "failure", classification: "unknown" });
            await outbox.enqueue(request);
            expect(await outbox.processOne()).toMatchObject({ state: "reconcile" });
            expect(await outbox.processOne()).toEqual({ kind: "idle" });
        }
    });
    it("replays unknown outcome only with explicit transport idempotency; exhausted unknown stays reconcile", async () => {
        const { outbox, dispatch, clock } = setup({ idempotent: true });
        dispatch.mockResolvedValue({ kind: "failure", classification: "unknown" });
        await outbox.enqueue(request);
        expect(await outbox.processOne()).toMatchObject({ state: "retry" });
        clock.advance({ milliseconds: 10 });
        await outbox.processOne();
        clock.advance({ milliseconds: 20 });
        expect(await outbox.processOne()).toMatchObject({ state: "reconcile" });
    });
    it("authorization outage retries without transport", async () => {
        const { outbox, authorize, dispatch } = setup({});
        authorize.mockRejectedValue(new Error("permission store offline"));
        await outbox.enqueue(request);
        expect(await outbox.processOne()).toMatchObject({ state: "retry" });
        expect(dispatch).not.toHaveBeenCalled();
    });
    it("aborts before a claim and before dispatch", async () => {
        const { outbox, authorize, dispatch } = setup({});
        const signal = { aborted: true };
        await outbox.enqueue(request);
        expect(await outbox.processOne(signal)).toEqual({ kind: "aborted" });
        signal.aborted = false;
        authorize.mockImplementation(async () => { signal.aborted = true; return true; });
        expect(await outbox.processOne(signal)).toMatchObject({ state: "retry" });
        expect(dispatch).not.toHaveBeenCalled();
    });
    it("observer failures cannot duplicate a write and events contain no payload", async () => {
        const { outbox, observe, dispatch } = setup({});
        observe.mockImplementation(() => { throw new Error("observer offline"); });
        await outbox.enqueue(request);
        expect(await outbox.processOne()).toMatchObject({ state: "succeeded" });
        expect(dispatch).toHaveBeenCalledTimes(1);
        const events = JSON.stringify(observe.mock.calls);
        expect(events).not.toContain(request.payload);
        expect(events).not.toContain(request.requestDigest);
        expect(events).not.toContain(request.tenantId);
    });
});

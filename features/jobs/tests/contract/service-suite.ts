import { afterEach, describe, expect, it, vi } from "vitest";
import type { JobRepoPort, JobDispatchPort, JobAuthorizationPort, ProcessResult } from "../../index.js";
import { createJobService, createMemoryJobObserver, jobTenant } from "../../index.js";
import { clockFixture, idsFixture, context, job, policy } from "../fixtures.js";
export function JobServiceSuite(required: { name: string; create: (required: { clock: ReturnType<typeof clockFixture>; ids: ReturnType<typeof idsFixture> }) => { repo: JobRepoPort; close: () => void } }): void {
    describe(required.name + " worker acceptance", () => {
        let close: (() => void) | undefined;
        function setup(input: Record<string, never>) {
            const clock = clockFixture({}); const ids = idsFixture({});
            const fixture = required.create({ clock, ids }); close = fixture.close;
            const dispatch = vi.fn<JobDispatchPort["dispatch"]>(async () => ({ ok: true, value: { kind: "completed", state: "succeeded", jobId: job.operationId } }));
            const authorize = vi.fn<JobAuthorizationPort["authorize"]>(async () => ({ ok: true, value: { allowed: true } }));
            const observer = createMemoryJobObserver({});
            const dependencies = { repo: fixture.repo, dispatcher: { dispatch }, authorization: { authorize }, clock, ids, retryPolicy: policy };
            const service = createJobService(dependencies, { observer });
            return { ...fixture, clock, ids, dispatch, authorize, observer, dependencies, service };
        }
        afterEach(() => { close?.(); close = undefined; });
        it("dispatches once under competing workers and carries stable identity/context", async () => {
            const fixture = setup({});
            const receipt = await fixture.service.enqueue({ context, job });
            const results = await Promise.all([fixture.service.processOne({ worker: { workerId: "a" } }), fixture.service.processOne({ worker: { workerId: "b" } })]);
            expect(results).toContainEqual({ ok: true, value: { kind: "idle" } });
            expect(fixture.dispatch).toHaveBeenCalledTimes(1);
            expect(fixture.dispatch.mock.calls[0][0]).toEqual({ context, job });
            if (receipt.ok) expect(await fixture.repo.outbox.get({ tenantId: jobTenant({ context }), id: receipt.value.jobId })).toMatchObject({ state: "succeeded" });
            expect(fixture.observer.snapshot({})).toContainEqual({ operation: "jobs.dispatch", outcome: "success", correlationId: context.correlationId, traceId: context.traceId, runId: context.runId });
            expect(JSON.stringify(fixture.observer.snapshot({}))).not.toContain(job.argumentsDigest);
        });
        it("keeps future work pending until exact due time, then authorizes and dispatches once", async () => {
            const fixture = setup({});
            fixture.clock.advance({ milliseconds: 10 });
            const receipt = await fixture.service.enqueue({ context, job, availableAt: 100 });
            if (!receipt.ok) throw new Error("Expected scheduled receipt");
            expect(await fixture.service.processOne({ worker: { workerId: "a" } })).toEqual({ ok: true, value: { kind: "idle" } });
            fixture.clock.advance({ milliseconds: 89 });
            expect(await fixture.service.processOne({ worker: { workerId: "a" } })).toEqual({ ok: true, value: { kind: "idle" } });
            expect(await fixture.repo.outbox.get({ tenantId: jobTenant({ context }), id: receipt.value.jobId })).toMatchObject({ state: "pending", attempts: 0, leaseToken: null, createdAt: 10, availableAt: 100 });
            expect(fixture.authorize).not.toHaveBeenCalled(); expect(fixture.dispatch).not.toHaveBeenCalled();
            fixture.clock.advance({ milliseconds: 1 });
            expect(await fixture.service.processOne({ worker: { workerId: "a" } })).toMatchObject({ ok: true, value: { state: "succeeded", jobId: receipt.value.jobId } });
            expect(await fixture.service.processOne({ worker: { workerId: "a" } })).toEqual({ ok: true, value: { kind: "idle" } });
            expect(fixture.authorize).toHaveBeenCalledTimes(1); expect(fixture.dispatch).toHaveBeenCalledTimes(1);
            expect(fixture.dispatch.mock.calls[0][0]).toEqual({ context, job });
        });
        it.each([undefined, 0, 99, 100])("preserves immediate eligibility for timing %s using one clock read", async availableAt => {
            const fixture = setup({});
            fixture.clock.advance({ milliseconds: 100 });
            const now = vi.spyOn(fixture.clock, "now");
            const receipt = await fixture.service.enqueue({ context, job, availableAt });
            expect(now).toHaveBeenCalledTimes(1);
            if (!receipt.ok) throw new Error("Expected receipt");
            expect(await fixture.repo.outbox.get({ tenantId: jobTenant({ context }), id: receipt.value.jobId })).toMatchObject({ createdAt: 100, availableAt: availableAt ?? 100 });
            expect(await fixture.service.processOne({ worker: { workerId: "a" } })).toMatchObject({ ok: true, value: { state: "succeeded" } });
            expect(fixture.dispatch).toHaveBeenCalledTimes(1);
        });
        it("future work does not block an immediately eligible job enqueued behind it", async () => {
            const fixture = setup({});
            await fixture.service.enqueue({ context, job, availableAt: 100 });
            const immediate = { ...job, operationId: "immediate", idempotencyKey: "immediate" };
            const receipt = await fixture.service.enqueue({ context, job: immediate });
            fixture.dispatch.mockResolvedValue({ ok: true, value: { kind: "completed", state: "succeeded", jobId: immediate.operationId } });
            if (!receipt.ok) throw new Error("Expected receipt");
            expect(await fixture.service.processOne({ worker: { workerId: "a" } })).toMatchObject({ ok: true, value: { state: "succeeded", jobId: receipt.value.jobId } });
            expect(fixture.dispatch).toHaveBeenCalledTimes(1);
            expect(fixture.dispatch.mock.calls[0][0]).toEqual({ context, job: immediate });
            expect(await fixture.service.processOne({ worker: { workerId: "a" } })).toEqual({ ok: true, value: { kind: "idle" } });
            expect(fixture.authorize).toHaveBeenCalledTimes(1);
        });
        it.each([undefined, 100, Number.MAX_SAFE_INTEGER])("retains first schedule %s on duplicate enqueue without changing payload/digest", async availableAt => {
            const fixture = setup({});
            const first = await fixture.service.enqueue({ context, job, availableAt });
            if (!first.ok) throw new Error("Expected receipt");
            const input = { tenantId: jobTenant({ context }), id: first.value.jobId };
            const original = await fixture.repo.outbox.get(input);
            expect(original?.availableAt).toBe(availableAt ?? 0);
            fixture.clock.advance({ milliseconds: 10 });
            expect(await fixture.service.enqueue({ context, job, availableAt: 200 })).toEqual({ ok: true, value: { ...first.value, status: "existing" } });
            expect(await fixture.service.enqueue({ context, job, availableAt: null as unknown as number })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
            expect(await fixture.repo.outbox.get(input)).toEqual(original);
        });
        it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, -Infinity, "100", null])("rejects invalid timing %s without persisting a job", async availableAt => {
            const fixture = setup({});
            expect(await fixture.service.enqueue({ context, job, availableAt: availableAt as number })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
            // Invalid input must leave the same key available for a valid first enqueue.
            expect(await fixture.service.enqueue({ context, job })).toMatchObject({ ok: true, value: { status: "enqueued" } });
            expect(fixture.authorize).not.toHaveBeenCalled(); expect(fixture.dispatch).not.toHaveBeenCalled();
        });
        it("rechecks authority withdrawn while waiting and denies without dispatch", async () => {
            const fixture = setup({});
            await fixture.service.enqueue({ context, job, availableAt: 100 });
            expect(await fixture.service.processOne({ worker: { workerId: "a" } })).toEqual({ ok: true, value: { kind: "idle" } });
            expect(fixture.authorize).not.toHaveBeenCalled();
            fixture.authorize.mockResolvedValue({ ok: true, value: { allowed: false } });
            fixture.clock.advance({ milliseconds: 100 });
            expect(await fixture.service.processOne({ worker: { workerId: "a" } })).toMatchObject({ ok: true, value: { kind: "completed", state: "denied" } });
            expect(fixture.authorize).toHaveBeenCalledTimes(1);
            expect(fixture.dispatch).not.toHaveBeenCalled();
        });
        it("authorization unavailability fails closed and retries only the pre-effect attempt", async () => {
            const fixture = setup({});
            await fixture.service.enqueue({ context, job });
            fixture.authorize.mockResolvedValue({ ok: false, error: { code: "unavailable", message: "Gate unavailable", retryable: true } });
            expect(await fixture.service.processOne({ worker: { workerId: "a" } })).toMatchObject({ ok: true, value: { state: "retry" } });
            expect(fixture.dispatch).not.toHaveBeenCalled();
        });
        it("does not dispatch when authorization crosses exact lease expiry", async () => {
            const fixture = setup({});
            await fixture.service.enqueue({ context, job });
            fixture.authorize.mockImplementation(async () => { fixture.clock.advance({ milliseconds: 100 }); return { ok: true, value: { allowed: true } }; });
            expect(await fixture.service.processOne({ worker: { workerId: "a" } })).toEqual({ ok: true, value: { kind: "stale" } });
            expect(fixture.dispatch).not.toHaveBeenCalled();
            expect(await fixture.service.processOne({ worker: { workerId: "b" } })).toEqual({ ok: true, value: { kind: "idle" } });
        });
        it("fences a store acknowledgement that returns after its dispatch lease expired", async () => {
            const fixture = setup({});
            await fixture.service.enqueue({ context, job });
            const begin = fixture.repo.outbox.beginDispatch.bind(fixture.repo.outbox);
            vi.spyOn(fixture.repo.outbox, "beginDispatch").mockImplementation(async fence => {
                const applied = await begin(fence); fixture.clock.advance({ milliseconds: 100 }); return applied;
            });
            expect(await fixture.service.processOne({ worker: { workerId: "a" } })).toEqual({ ok: true, value: { kind: "stale" } });
            expect(fixture.dispatch).not.toHaveBeenCalled();
        });
        it("unknown errors/returned uncertainty never replay a non-idempotent effect", async () => {
            const fixture = setup({});
            const receipt = await fixture.service.enqueue({ context, job });
            fixture.dispatch.mockRejectedValue(new Error("Provider may have accepted; secret"));
            expect(await fixture.service.processOne({ worker: { workerId: "a" } })).toMatchObject({ ok: true, value: { state: "reconcile" } });
            fixture.clock.advance({ milliseconds: 1000 });
            expect(await fixture.service.processOne({ worker: { workerId: "b" } })).toEqual({ ok: true, value: { kind: "idle" } });
            expect(fixture.dispatch).toHaveBeenCalledTimes(1);
            if (receipt.ok) expect(await fixture.repo.outbox.get({ tenantId: jobTenant({ context }), id: receipt.value.jobId })).toMatchObject({ state: "reconcile" });
            expect(JSON.stringify(fixture.observer.snapshot({}))).not.toContain("secret");
        });
        it("typed dispatch errors also remain uncertain rather than trusting retryable as proof of no effect", async () => {
            const fixture = setup({});
            await fixture.service.enqueue({ context, job });
            fixture.dispatch.mockResolvedValue({ ok: false, error: { code: "unavailable", message: "Timeout", retryable: true } });
            expect(await fixture.service.processOne({ worker: { workerId: "a" } })).toMatchObject({ ok: true, value: { state: "reconcile" } });
            expect(await fixture.service.processOne({ worker: { workerId: "b" } })).toEqual({ ok: true, value: { kind: "idle" } });
        });
        it("malformed dispatch results reconcile instead of claiming success or retry authority", async () => {
            const fixture = setup({});
            await fixture.service.enqueue({ context, job });
            const malformed = { ok: true, value: { kind: "completed", state: "retry", jobId: "different-operation" } };
            fixture.dispatch.mockResolvedValue(malformed as unknown as Awaited<ReturnType<JobDispatchPort["dispatch"]>>);
            expect(await fixture.service.processOne({ worker: { workerId: "a" } })).toMatchObject({ ok: true, value: { state: "reconcile" } });
            fixture.clock.advance({ milliseconds: 1000 });
            expect(await fixture.service.processOne({ worker: { workerId: "b" } })).toEqual({ ok: true, value: { kind: "idle" } });
            expect(fixture.dispatch).toHaveBeenCalledTimes(1);
        });
        it("bounds known transient retries and preserves operation/key/digest through every attempt", async () => {
            const fixture = setup({});
            await fixture.service.enqueue({ context, job });
            fixture.dispatch.mockResolvedValue({ ok: true, value: { kind: "completed", state: "retry", jobId: job.operationId } });
            expect(await fixture.service.processOne({ worker: { workerId: "a" } })).toMatchObject({ ok: true, value: { state: "retry" } });
            expect(await fixture.service.processOne({ worker: { workerId: "a" } })).toEqual({ ok: true, value: { kind: "idle" } });
            fixture.clock.advance({ milliseconds: 10 });
            await fixture.service.processOne({ worker: { workerId: "a" } });
            fixture.clock.advance({ milliseconds: 20 });
            expect(await fixture.service.processOne({ worker: { workerId: "a" } })).toMatchObject({ ok: true, value: { state: "failed" } });
            expect(fixture.dispatch).toHaveBeenCalledTimes(3);
            for (const call of fixture.dispatch.mock.calls) expect(call[0]).toEqual({ context, job });
        });
        it("a lost completion does not turn an accepted remote write into a second write", async () => {
            const fixture = setup({});
            const receipt = await fixture.service.enqueue({ context, job });
            vi.spyOn(fixture.repo.outbox, "complete").mockRejectedValueOnce(new Error("DB ack lost"));
            expect(await fixture.service.processOne({ worker: { workerId: "a" } })).toMatchObject({ ok: false, error: { code: "unavailable" } });
            fixture.clock.advance({ milliseconds: 100 });
            const restarted = createJobService(fixture.dependencies);
            expect(await restarted.processOne({ worker: { workerId: "restart" } })).toEqual({ ok: true, value: { kind: "idle" } });
            expect(fixture.dispatch).toHaveBeenCalledTimes(1);
            if (receipt.ok) expect(await fixture.repo.outbox.get({ tenantId: jobTenant({ context }), id: receipt.value.jobId })).toMatchObject({ state: "reconcile" });
        });
        it("crash before dispatch survives worker restart without asserting no remote effect", async () => {
            const fixture = setup({});
            const receipt = await fixture.service.enqueue({ context, job });
            const claimed = await fixture.repo.claim({ worker: { workerId: "crashed" } });
            expect(claimed).toMatchObject({ ok: true, value: { lease: { state: "leased" } } });
            fixture.clock.advance({ milliseconds: 100 });
            const restarted = createJobService(fixture.dependencies);
            expect(await restarted.processOne({ worker: { workerId: "restart" } })).toEqual({ ok: true, value: { kind: "idle" } });
            expect(fixture.dispatch).not.toHaveBeenCalled();
            if (receipt.ok) expect(await fixture.repo.outbox.get({ tenantId: jobTenant({ context }), id: receipt.value.jobId })).toMatchObject({ state: "reconcile" });
        });
        it("aborts before claim and after authority before dispatch", async () => {
            const fixture = setup({});
            await fixture.service.enqueue({ context, job });
            const controller = new AbortController(); controller.abort();
            expect(await fixture.service.processOne({ worker: { workerId: "a" } }, { signal: controller.signal })).toEqual({ ok: true, value: { kind: "aborted" } });
            const beforeDispatch = new AbortController();
            fixture.authorize.mockImplementation(async () => { beforeDispatch.abort(); return { ok: true, value: { allowed: true } }; });
            expect(await fixture.service.processOne({ worker: { workerId: "a" } }, { signal: beforeDispatch.signal })).toMatchObject({ ok: true, value: { state: "retry" } });
            expect(fixture.dispatch).not.toHaveBeenCalled();
        });
        it("in-flight cancellation cannot claim the external effect was cancelled or refunded", async () => {
            const fixture = setup({});
            const receipt = await fixture.service.enqueue({ context, job });
            fixture.dispatch.mockImplementation(async () => {
                if (!receipt.ok) throw new Error("Expected receipt");
                await fixture.repo.outbox.cancel({ tenantId: jobTenant({ context }), id: receipt.value.jobId, now: fixture.clock.now({}) });
                return { ok: true, value: { kind: "completed", state: "succeeded", jobId: job.operationId } };
            });
            expect(await fixture.service.processOne({ worker: { workerId: "a" } })).toEqual({ ok: true, value: { kind: "stale" } });
            if (receipt.ok) expect(await fixture.repo.outbox.get({ tenantId: jobTenant({ context }), id: receipt.value.jobId })).toMatchObject({ state: "reconcile" });
            expect(fixture.dispatch).toHaveBeenCalledTimes(1);
        });
        it("observer failure does not alter the durable result", async () => {
            const fixture = setup({});
            const service = createJobService(fixture.dependencies, { observer: { observe() { throw new Error("Observer failed"); } } });
            await service.enqueue({ context, job });
            expect(await service.processOne({ worker: { workerId: "a" } })).toMatchObject({ ok: true, value: { state: "succeeded" } });
            expect(fixture.dispatch).toHaveBeenCalledTimes(1);
        });
    });
}

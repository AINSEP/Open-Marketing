import { afterEach, describe, it, expect } from "vitest";
import type { JobRepoPort, JobDispatchPort, JobAuthorizationPort, JobObserverPort } from "../../index.js";
import type { TransportResult } from "../../index.js";
import { context, job } from "../fixtures.js";
/** One behavioral repository suite, used unchanged by the double and durable adapter. */
export function JobRepoPortSuite(required: { name: string; create: () => { port: JobRepoPort; close: () => void } }): void {
    describe(required.name + " JobRepoPort", () => {
        let close: (() => void) | undefined;
        function setup(input: Record<string, never>): JobRepoPort {
            const fixture = required.create(); close = fixture.close; return fixture.port;
        }
        afterEach(() => { close?.(); close = undefined; });
        it("enqueues and deduplicates with a stable receipt, rejecting changed effect/digest", async () => {
            const port = setup({});
            const first = await port.enqueue({ context, job });
            expect(first).toMatchObject({ ok: true, value: { operationId: job.operationId, status: "enqueued" } });
            const duplicate = await port.enqueue({ context: { ...context, traceId: "retry-trace" }, job: { ...job, payload: { amount: 10 } } });
            expect(duplicate).toMatchObject({ ok: true, value: { status: "existing" } });
            if (first.ok && duplicate.ok) expect(duplicate.value.jobId).toBe(first.value.jobId);
            expect(await port.enqueue({ context, job: { ...job, argumentsDigest: "b".repeat(64) } })).toMatchObject({ ok: false, error: { code: "conflict" } });
            expect(await port.enqueue({ context, job: { ...job, payload: { amount: 11 } } })).toMatchObject({ ok: false, error: { code: "conflict" } });
        });
        it("claims context plus fence, while preserving the first trace across duplicate enqueue", async () => {
            const port = setup({});
            await port.enqueue({ context, job });
            await port.enqueue({ context: { ...context, traceId: "new-trace" }, job });
            const claimed = await port.claim({ worker: { workerId: "worker" } });
            expect(claimed).toMatchObject({ ok: true, value: { context, job, lease: { state: "leased", attempts: 1 } } });
            if (claimed.ok && claimed.value) {
                expect(claimed.value.lease.leaseToken).toBeTypeOf("string");
                expect(claimed.value.lease.leaseExpiresAt).toBe(100);
            }
            expect(await port.claim({ worker: { workerId: "other-worker" } })).toEqual({ ok: true, value: null });
        });
        it("validates bounded JSON, scope and digest before any enqueue", async () => {
            const port = setup({});
            expect(await port.enqueue({ context, job: { ...job, argumentsDigest: "wrong" } })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
            expect(await port.enqueue({ context, job: { ...job, payload: { invalid: undefined } } })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
            expect(await port.enqueue({ context, job: { ...job, payload: { oversized: "x".repeat(262145) } } })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
            expect(await port.claim({ worker: { workerId: "worker" } })).toEqual({ ok: true, value: null });
        });
        it("canonicalizes key order and isolates owner/workspace scopes", async () => {
            const port = setup({});
            expect(await port.enqueue({ context, job: { ...job, payload: { b: 2, a: 1 } } })).toMatchObject({ ok: true, value: { status: "enqueued" } });
            expect(await port.enqueue({ context, job: { ...job, payload: { a: 1, b: 2 } } })).toMatchObject({ ok: true, value: { status: "existing" } });
            expect(await port.enqueue({ context: { ...context, scope: { ...context.scope, workspaceId: "second" } }, job })).toMatchObject({ ok: true, value: { status: "enqueued" } });
        });
        it("cancellation before enqueue/claim performs no effect", async () => {
            const port = setup({});
            const controller = new AbortController(); controller.abort();
            expect(await port.enqueue({ context, job }, { signal: controller.signal })).toMatchObject({ ok: false, error: { code: "cancelled" } });
            expect(await port.claim({ worker: { workerId: "worker" } }, { signal: controller.signal })).toMatchObject({ ok: false, error: { code: "cancelled" } });
            expect(await port.claim({ worker: { workerId: "worker" } })).toEqual({ ok: true, value: null });
        });
    });
}
/** Transport double and actual handler registry share the same single-attempt output contract. */
export function JobDispatchPortSuite(required: { name: string; create: (required: { result?: TransportResult }) => JobDispatchPort }): void {
    describe(required.name + " JobDispatchPort", () => {
        it("fails explicitly for an unconfigured/missing handler", async () => {
            expect(await required.create({}).dispatch({ context, job })).toMatchObject({ ok: false, error: { code: "unavailable" } });
        });
        it("reports success/transient/permanent/unknown exactly", async () => {
            const pairs: readonly { result: TransportResult; state: string }[] = [
                { result: { kind: "success" }, state: "succeeded" },
                { result: { kind: "failure", classification: "transient" }, state: "retry" },
                { result: { kind: "failure", classification: "permanent" }, state: "failed" },
                { result: { kind: "failure", classification: "unknown" }, state: "reconcile" },
            ];
            for (const pair of pairs) expect(await required.create({ result: pair.result }).dispatch({ context, job })).toMatchObject({ ok: true, value: { kind: "completed", state: pair.state } });
        });
        it("honors cancellation before beginning an attempt", async () => {
            const controller = new AbortController(); controller.abort();
            expect(await required.create({ result: { kind: "success" } }).dispatch({ context, job }, { signal: controller.signal })).toMatchObject({ ok: false, error: { code: "cancelled" } });
        });
    });
}
export function JobAuthorizationPortSuite(required: { create: (required: { allowed?: boolean }) => JobAuthorizationPort }): void {
    describe("JobAuthorizationPort double", () => {
        it("denies by default and requires an explicit allow fixture", async () => {
            expect(await required.create({}).authorize({ context, job })).toEqual({ ok: true, value: { allowed: false } });
            expect(await required.create({ allowed: true }).authorize({ context, job })).toEqual({ ok: true, value: { allowed: true } });
        });
        it("cancellation never returns permission", async () => {
            const controller = new AbortController(); controller.abort();
            expect(await required.create({ allowed: true }).authorize({ context, job }, { signal: controller.signal })).toMatchObject({ ok: false, error: { code: "cancelled" } });
        });
    });
}
export function JobObserverPortSuite(required: { create: () => JobObserverPort & { snapshot(required: Record<string, never>): readonly unknown[]; reset(required: Record<string, never>): void } }): void {
    describe("JobObserverPort double", () => {
        it("keeps detached trace events and resets", () => {
            const observer = required.create();
            const event = { operation: "jobs.dispatch", outcome: "success", correlationId: context.correlationId, traceId: context.traceId, runId: context.runId };
            observer.observe(event); event.traceId = "mutated";
            expect(observer.snapshot({})).toEqual([{ ...event, traceId: context.traceId }]);
            observer.reset({}); expect(observer.snapshot({})).toEqual([]);
        });
    });
}

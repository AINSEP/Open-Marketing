import { afterEach, describe, expect, it } from "vitest";
import type { CallContext, DomainIntentTransactionPort, JobReceipt, JobRepoPort, Outcome } from "../../index.js";
import { context, job } from "../fixtures.js";
export interface IntentFixture {
    port: DomainIntentTransactionPort;
    repo: JobRepoPort;
    readIntent(required: { context: CallContext; intentId: string }): Promise<{ jobId: string; operationId: string } | null>;
    close: () => void;
}
export function DomainIntentSuite(required: {
    name: string;
    create: (required: { reject?: boolean; throwWriter?: boolean; abortWriter?: AbortController }) => IntentFixture;
}): void {
    describe(required.name + " atomic domain intent/outbox", () => {
        let close: (() => void) | undefined;
        function setup(input: { reject?: boolean; throwWriter?: boolean; abortWriter?: AbortController }): IntentFixture {
            const fixture = required.create(input); close = fixture.close; return fixture;
        }
        afterEach(() => { close?.(); close = undefined; });
        it("commits one domain intent and its job together, including concurrent duplicate commits", async () => {
            const fixture = setup({});
            const input = { context, intentId: "intent", job };
            const results = await Promise.all([fixture.port.commit(input), fixture.port.commit(input)]);
            expect(results).toMatchObject([{ ok: true, value: { status: "enqueued" } }, { ok: true, value: { status: "existing" } }]);
            const first = receipt({ result: results[0] });
            expect(await fixture.readIntent({ context, intentId: "intent" })).toEqual({ jobId: first.jobId, operationId: job.operationId });
            expect(receipt({ result: results[1] }).jobId).toBe(first.jobId);
            expect(await fixture.repo.claim({ worker: { workerId: "worker" } })).toMatchObject({ ok: true, value: { job } });
            expect(await fixture.repo.claim({ worker: { workerId: "second" } })).toEqual({ ok: true, value: null });
        });
        it("typed writer rejection rolls back both intent and enqueue", async () => {
            const fixture = setup({ reject: true });
            expect(await fixture.port.commit({ context, intentId: "intent", job })).toMatchObject({ ok: false, error: { code: "conflict" } });
            expect(await fixture.readIntent({ context, intentId: "intent" })).toBeNull();
            expect(await fixture.repo.claim({ worker: { workerId: "worker" } })).toEqual({ ok: true, value: null });
        });
        it("writer exception rolls back every staged domain/outbox write", async () => {
            const fixture = setup({ throwWriter: true });
            expect(await fixture.port.commit({ context, intentId: "intent", job })).toMatchObject({ ok: false, error: { code: "unavailable" } });
            expect(await fixture.readIntent({ context, intentId: "intent" })).toBeNull();
            expect(await fixture.repo.claim({ worker: { workerId: "worker" } })).toEqual({ ok: true, value: null });
        });
        it("conflicting key creates no second intent and does not overwrite the first effect", async () => {
            const fixture = setup({});
            const first = receipt({ result: await fixture.port.commit({ context, intentId: "intent", job }) });
            expect(await fixture.port.commit({ context, intentId: "new-intent", job: { ...job, payload: { amount: 20 } } })).toMatchObject({ ok: false, error: { code: "conflict" } });
            expect(await fixture.readIntent({ context, intentId: "new-intent" })).toBeNull();
            expect(await fixture.readIntent({ context, intentId: "intent" })).toEqual({ jobId: first.jobId, operationId: job.operationId });
        });
        it("an existing intent conflict rolls back a newly enqueued different key", async () => {
            const fixture = setup({});
            await fixture.port.commit({ context, intentId: "intent", job });
            expect(await fixture.port.commit({ context, intentId: "intent", job: { ...job, operationId: "second-operation", idempotencyKey: "second-key" } })).toMatchObject({ ok: false, error: { code: "conflict" } });
            expect(await fixture.repo.claim({ worker: { workerId: "worker" } })).toMatchObject({ ok: true, value: { job } });
            expect(await fixture.repo.claim({ worker: { workerId: "worker" } })).toEqual({ ok: true, value: null });
        });
        it("cancellation during the domain write rolls back instead of reporting a committed intent", async () => {
            const controller = new AbortController();
            const fixture = setup({ abortWriter: controller });
            expect(await fixture.port.commit({ context, intentId: "intent", job }, { signal: controller.signal })).toMatchObject({ ok: false, error: { code: "cancelled" } });
            expect(await fixture.readIntent({ context, intentId: "intent" })).toBeNull();
            expect(await fixture.repo.claim({ worker: { workerId: "worker" } })).toEqual({ ok: true, value: null });
        });
    });
}
function receipt(required: { result: Outcome<JobReceipt> }): JobReceipt {
    if (!required.result.ok) throw new Error("Expected successful receipt");
    return required.result.value;
}

import { afterEach, describe, expect, it } from "vitest";
import type { Completion, ManagedOutboxStore } from "../../index.js";
import { context, storedJob } from "../fixtures.js";
export function OutboxStoreSuite(required: { name: string; create: (required: { maxJobs?: number }) => { store: ManagedOutboxStore; close: () => void } }): void {
    describe(required.name + " durable outbox contract", () => {
        let close: (() => void) | undefined;
        function setup(input: { maxJobs?: number }): ManagedOutboxStore {
            const fixture = required.create(input);
            close = fixture.close;
            return fixture.store;
        }
        afterEach(() => { close?.(); close = undefined; });
        it("deduplicates concurrent exact requests and rejects digest/content conflicts", async () => {
            const store = setup({});
            const request = storedJob({});
            const outcomes = await Promise.all([store.enqueue(request), store.enqueue({ ...request, id: "different-id" })]);
            expect(outcomes.map(value => value.kind)).toEqual(["inserted", "existing"]);
            for (const changed of [{ requestDigest: "other" }, { payload: "other" }, { operation: "other" }]) {
                expect(await store.enqueue({ ...request, ...changed })).toEqual({ kind: "conflict" });
            }
            expect(await store.enqueue({ ...request, id: "second-tenant", tenantId: "tenant-b" })).toMatchObject({ kind: "inserted" });
            expect(await store.get({ tenantId: "tenant", id: request.id })).toMatchObject(request);
        });
        it("rejects generated ID collisions without losing the first key", async () => {
            const store = setup({});
            await store.enqueue(storedJob({}));
            await expect(store.enqueue(storedJob({ idempotencyKey: "new-key" }))).rejects.toMatchObject({ code: "conflict" });
            expect(await store.get({ tenantId: "tenant", id: "job-a" })).toMatchObject({ idempotencyKey: "key" });
        });
        it("returns detached input/output/context snapshots and denies cross-tenant reads", async () => {
            const store = setup({});
            const request = storedJob({ context: structuredClone(context) });
            const inserted = await store.enqueue(request);
            request.context!.scope.workspaceId = "mutated-input";
            if (inserted.kind === "conflict") throw new Error("Expected insert");
            inserted.job.context!.scope.workspaceId = "mutated-output";
            const saved = await store.get({ tenantId: "tenant", id: request.id });
            expect(saved?.context?.scope.workspaceId).toBe(context.scope.workspaceId);
            expect(await store.get({ tenantId: "other", id: request.id })).toBeNull();
        });
        it("captures enqueue input before awaiting transaction admission", async () => {
            const store = setup({});
            const request = storedJob({ context: structuredClone(context) });
            const pending = store.enqueue(request);
            Object.assign(request, { payload: "mutated-after-call" });
            request.context!.scope.workspaceId = "mutated-after-call";
            expect(await pending).toMatchObject({ kind: "inserted", job: { payload: "private", context } });
            expect(await store.get({ tenantId: "tenant", id: "job-a" })).toMatchObject({ payload: "private", context });
        });
        it("claims due work deterministically once and respects scheduling/attempt limits", async () => {
            const store = setup({});
            await store.enqueue(storedJob({ id: "later", idempotencyKey: "later", availableAt: 10 }));
            await store.enqueue(storedJob({ id: "now", idempotencyKey: "now" }));
            const input = { now: 0, leaseToken: "token", leaseExpiresAt: 100, maxAttempts: 1 };
            const results = await Promise.all([store.claim(input), store.claim({ ...input, leaseToken: "other-token" })]);
            expect(results.filter(Boolean)).toHaveLength(1);
            expect(results[0]).toMatchObject({ id: "now", state: "leased", attempts: 1 });
            expect(await store.complete({ id: "now", tenantId: "tenant", token: "token", now: 1 }, { state: "retry", availableAt: 2 })).toBe(true);
            expect(await store.claim({ ...input, now: 2, leaseToken: "last-token" })).toBeNull();
            expect(await store.claim({ ...input, now: 10, leaseToken: "later-token" })).toMatchObject({ id: "later" });
        });
        it("orders non-ASCII IDs identically to SQLite binary collation", async () => {
            const store = setup({});
            await store.enqueue(storedJob({ id: "😀", idempotencyKey: "emoji" }));
            await store.enqueue(storedJob({ id: "\uE000", idempotencyKey: "private-use" }));
            expect(await store.claim({ now: 0, leaseToken: "first", leaseExpiresAt: 100, maxAttempts: 3 })).toMatchObject({ id: "\uE000" });
            expect(await store.claim({ now: 0, leaseToken: "second", leaseExpiresAt: 100, maxAttempts: 3 })).toMatchObject({ id: "😀" });
        });
        it("checks token, tenant, state and exact lease expiry for both dispatch and completion", async () => {
            const store = setup({});
            await store.enqueue(storedJob({}));
            await store.claim({ now: 0, leaseToken: "token", leaseExpiresAt: 100, maxAttempts: 3 });
            const live = { id: "job-a", tenantId: "tenant", token: "token", now: 1 };
            const stale = [{ ...live, token: "wrong" }, { ...live, tenantId: "other" }, { ...live, now: 100 }];
            for (const fence of stale) {
                expect(await store.beginDispatch(fence)).toBe(false);
                expect(await store.complete(fence, { state: "succeeded" })).toBe(false);
                expect(await store.complete(fence, { state: "retry", availableAt: 200 })).toBe(false);
            }
            expect(await store.beginDispatch(live)).toBe(true);
            expect(await store.beginDispatch(live)).toBe(false);
            expect(await store.complete(live, { state: "succeeded" })).toBe(true);
            expect(await store.complete(live, { state: "retry", availableAt: 10 })).toBe(false);
        });
        it("recovers pre/post dispatch crashes in bounded batches without making them claimable", async () => {
            const store = setup({});
            await store.enqueue(storedJob({ id: "a", idempotencyKey: "a" }));
            await store.enqueue(storedJob({ id: "b", idempotencyKey: "b" }));
            await store.claim({ now: 0, leaseToken: "a-token", leaseExpiresAt: 100, maxAttempts: 3 });
            await store.claim({ now: 0, leaseToken: "b-token", leaseExpiresAt: 100, maxAttempts: 3 });
            await store.beginDispatch({ id: "b", tenantId: "tenant", token: "b-token", now: 1 });
            expect(await store.recoverExpired({ now: 99, limit: 1 })).toBe(0);
            expect(await store.recoverExpired({ now: 100, limit: 1 })).toBe(1);
            expect(await store.recoverExpired({ now: 100, limit: 1 })).toBe(1);
            expect(await store.recoverExpired({ now: 100, limit: 1 })).toBe(0);
            expect(await store.claim({ now: 100, leaseToken: "new", leaseExpiresAt: 200, maxAttempts: 3 })).toBeNull();
            expect(await store.get({ tenantId: "tenant", id: "a" })).toMatchObject({ state: "reconcile", leaseToken: null });
            expect(await store.get({ tenantId: "tenant", id: "b" })).toMatchObject({ state: "reconcile", leaseToken: null });
        });
        it("cancels queued work honestly and fences leased cancellation as uncertain", async () => {
            const store = setup({});
            await store.enqueue(storedJob({}));
            expect(await store.cancel({ tenantId: "other", id: "job-a", now: 0 })).toBe(false);
            expect(await store.cancel({ tenantId: "tenant", id: "job-a", now: 0 })).toBe(true);
            expect(await store.get({ tenantId: "tenant", id: "job-a" })).toMatchObject({ state: "cancelled" });
            await store.enqueue(storedJob({ id: "leased", idempotencyKey: "leased" }));
            await store.claim({ now: 0, leaseToken: "token", leaseExpiresAt: 100, maxAttempts: 3 });
            expect(await store.cancel({ tenantId: "tenant", id: "leased", now: 1 })).toBe(true);
            expect(await store.complete({ tenantId: "tenant", id: "leased", token: "token", now: 2 }, { state: "succeeded" })).toBe(false);
            expect(await store.get({ tenantId: "tenant", id: "leased" })).toMatchObject({ state: "reconcile" });
        });
        it("requires evidence and one CAS to resolve uncertainty; never adds retry authority", async () => {
            const store = setup({});
            await store.enqueue(storedJob({}));
            await store.claim({ now: 0, leaseToken: "token", leaseExpiresAt: 100, maxAttempts: 3 });
            await store.recoverExpired({ now: 100, limit: 1 });
            await expect(store.resolve({ tenantId: "tenant", id: "job-a", now: 101, state: "succeeded", evidenceId: "" })).rejects.toMatchObject({ code: "invalid_input" });
            expect(await store.resolve({ tenantId: "tenant", id: "job-a", now: 101, state: "succeeded", evidenceId: "remote-readback" })).toBe(true);
            expect(await store.resolve({ tenantId: "tenant", id: "job-a", now: 101, state: "failed", evidenceId: "different-readback" })).toBe(false);
            expect(await store.get({ tenantId: "tenant", id: "job-a" })).toMatchObject({ state: "succeeded" });
        });
        it("rejects malformed completions without overwriting a live job", async () => {
            const store = setup({});
            await store.enqueue(storedJob({}));
            await store.claim({ now: 0, leaseToken: "token", leaseExpiresAt: 100, maxAttempts: 3 });
            const fence = { tenantId: "tenant", id: "job-a", token: "token", now: 1 };
            const malformed = [{ state: "pending" }, { state: "succeeded", payload: "replacement" }, { state: "retry", availableAt: NaN }];
            for (const completion of malformed) {
                await expect(store.complete(fence, completion as unknown as Completion)).rejects.toMatchObject({ code: "invalid_input" });
            }
            expect(await store.get({ tenantId: "tenant", id: "job-a" })).toMatchObject({ state: "leased", payload: "private", leaseToken: "token" });
        });
        it("rejects an untyped reconciliation request that attempts to requeue an unknown effect", async () => {
            const store = setup({});
            await store.enqueue(storedJob({}));
            await store.claim({ now: 0, leaseToken: "token", leaseExpiresAt: 100, maxAttempts: 3 });
            await store.recoverExpired({ now: 100, limit: 1 });
            const input = { tenantId: "tenant", id: "job-a", now: 101, state: "retry", evidenceId: "unverified" };
            await expect(store.resolve(input as unknown as Parameters<ManagedOutboxStore["resolve"]>[0])).rejects.toMatchObject({ code: "invalid_input" });
            expect(await store.get({ tenantId: "tenant", id: "job-a" })).toMatchObject({ state: "reconcile" });
            expect(await store.claim({ now: 101, leaseToken: "new", leaseExpiresAt: 200, maxAttempts: 3 })).toBeNull();
        });
        it("rejects concurrent reuse of a live lease token without claiming another job", async () => {
            const store = setup({});
            await store.enqueue(storedJob({ id: "a", idempotencyKey: "a" }));
            await store.enqueue(storedJob({ id: "b", idempotencyKey: "b" }));
            const input = { now: 0, leaseToken: "token", leaseExpiresAt: 100, maxAttempts: 3 };
            expect(await store.claim(input)).toMatchObject({ id: "a" });
            await expect(store.claim(input)).rejects.toMatchObject({ code: "conflict" });
            expect(await store.get({ tenantId: "tenant", id: "b" })).toMatchObject({ state: "pending", attempts: 0 });
        });
        it("bounds capacity and recovery/lease input before changing state", async () => {
            const store = setup({ maxJobs: 1 });
            await store.enqueue(storedJob({}));
            await expect(store.enqueue(storedJob({ id: "b", idempotencyKey: "b" }))).rejects.toMatchObject({ code: "limit_exceeded" });
            await expect(store.claim({ now: 0, leaseToken: "token", leaseExpiresAt: 0, maxAttempts: 3 })).rejects.toMatchObject({ code: "invalid_input" });
            await expect(store.recoverExpired({ now: 0, limit: 1001 })).rejects.toMatchObject({ code: "invalid_input" });
            expect(await store.get({ tenantId: "tenant", id: "job-a" })).toMatchObject({ state: "pending" });
        });
    });
}

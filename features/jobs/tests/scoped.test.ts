import { describe, expect, it } from "vitest";
import type { CallContext, Outcome } from "@open-marketing/contracts";
import { createMemoryOutboxStore, createMemoryScopedJobs, createJobRepository, createSqlOutboxStore, createSqlScopedJobs } from "../index.js";
import { sqliteFixture } from "./sql-fixture.js";
const context: CallContext = { scope: { ownerId: "owner", workspaceId: "workspace" }, principal: { kind: "owner", ownerId: "owner" }, correlationId: "correlation", traceId: "trace" };
function value<T>(required: { result: Outcome<T> }): T { if (!required.result.ok) throw new Error("Fixture failed"); return required.result.value; }
for (const adapter of ["memory", "sql"] as const) describe("scoped jobs shared suite / " + adapter, () => {
    function fixture() {
        const sql = adapter === "sql" ? sqliteFixture({}) : undefined;
        const memory = createMemoryOutboxStore({});
        const store = sql ? createSqlOutboxStore({ database: sql.database }) : memory;
        let sequence = 0;
        const clock = { now: () => 1000 }; const ids = { next: () => "id-" + ++sequence }; const observer = { observe() {} };
        const jobs = sql ? createSqlScopedJobs({ database: sql.database, clock, observer }) : createMemoryScopedJobs({ store: memory, clock, observer });
        const repo = createJobRepository({ outbox: store, clock, ids, retryPolicy: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 10, leaseMs: 1000 } });
        async function enqueue(input: { operationId: string; context?: CallContext }) {
            return value({ result: await repo.enqueue({ context: input.context ?? context, job: { operationId: input.operationId, handler: "fixture", idempotencyKey: input.operationId, argumentsDigest: "a".repeat(64), payload: { token: "secret-fixture" } } }) });
        }
        return { store, jobs, enqueue, close: () => sql?.close() };
    }
    it("lists and reads only the current scope, paginates and withholds payloads", async () => {
        const f = fixture();
        try {
            const first = await f.enqueue({ operationId: "one" }); await f.enqueue({ operationId: "two" });
            const foreign: CallContext = { ...context, scope: { ownerId: "other", workspaceId: "workspace" }, principal: { kind: "owner", ownerId: "other" } };
            const other = await f.enqueue({ operationId: "three", context: foreign });
            const page = value({ result: await f.jobs.list({ context, query: { limit: 1 } }) });
            expect(page.items).toHaveLength(1); expect(page.cursor).toBe(first.jobId);
            expect(value({ result: await f.jobs.list({ context, query: { limit: 1, cursor: page.cursor! } }) }).items).toHaveLength(1);
            expect(await f.jobs.get({ context, jobId: other.jobId })).toEqual({ ok: true, value: null });
            expect(JSON.stringify(page)).not.toContain("secret-fixture");
            expect(await f.jobs.cancel({ context, jobId: other.jobId })).toEqual({ ok: true, value: { cancelled: false } });
            expect(await f.jobs.list({ context, query: { limit: 101 } })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
        } finally { f.close(); }
    });
    it("cancels never-claimed jobs once, preserving every claimed/dispatched state", async () => {
        const f = fixture();
        try {
            const first = await f.enqueue({ operationId: "cancel" });
            expect(await f.jobs.cancel({ context, jobId: first.jobId })).toEqual({ ok: true, value: { cancelled: true } });
            expect(await f.jobs.cancel({ context, jobId: first.jobId })).toEqual({ ok: true, value: { cancelled: false } });
            const pending = await f.enqueue({ operationId: "claim" });
            const claimed = await f.store.claim({ now: 1000, leaseToken: "lease", leaseExpiresAt: 2000, maxAttempts: 3 });
            expect(claimed?.id).toBe(pending.jobId);
            expect(await f.jobs.cancel({ context, jobId: pending.jobId })).toEqual({ ok: true, value: { cancelled: false } });
            const fence = { tenantId: claimed!.tenantId, id: pending.jobId, token: "lease", now: 1000 };
            expect(await f.store.beginDispatch(fence)).toBe(true);
            expect(await f.jobs.cancel({ context, jobId: pending.jobId })).toEqual({ ok: true, value: { cancelled: false } });
            expect(await f.store.complete(fence, { state: "retry", availableAt: 1500 })).toBe(true);
            expect(await f.jobs.cancel({ context, jobId: pending.jobId })).toEqual({ ok: true, value: { cancelled: false } });
            expect(value({ result: await f.jobs.get({ context, jobId: pending.jobId }) })?.state).toBe("retry");
        } finally { f.close(); }
    });
    it("arbitrates a simultaneous cancellation and worker claim without mutating a dispatched job", async () => {
        const f = fixture();
        try {
            const pending = await f.enqueue({ operationId: "race" });
            const [cancelled, claimed] = await Promise.all([f.jobs.cancel({ context, jobId: pending.jobId }), f.store.claim({ now: 1000, leaseToken: "race", leaseExpiresAt: 2000, maxAttempts: 3 })]);
            const won = value({ result: cancelled }).cancelled;
            expect(won ? claimed === null : claimed?.id === pending.jobId).toBe(true);
            expect(value({ result: await f.jobs.get({ context, jobId: pending.jobId }) })?.state).toBe(won ? "cancelled" : "leased");
        } finally { f.close(); }
    });
});

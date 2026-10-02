import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJobService, createSqlJobRepo, jobTenant } from "../index.js";
import type { JobDispatchPort } from "../index.js";
import { sqliteFixture } from "./sql-fixture.js";
import { clockFixture, context, idsFixture, job, policy } from "./fixtures.js";
describe("SQLite fault injection", () => {
    it("failed enqueue journal append rolls back the job insert", async () => {
        const fixture = sqliteFixture({});
        try {
            fixture.native.exec("CREATE TRIGGER fail_enqueue BEFORE INSERT ON job_attempt WHEN NEW.event_type = 'enqueue' BEGIN SELECT RAISE(ABORT, 'injected'); END");
            const repo = createSqlJobRepo({ database: fixture.database, clock: clockFixture({}), ids: idsFixture({}), retryPolicy: policy });
            expect(await repo.enqueue({ context, job })).toMatchObject({ ok: false, error: { code: "unavailable" } });
            expect(fixture.native.prepare("SELECT COUNT(*) AS count FROM job").get()).toEqual({ count: 0 });
            expect(fixture.native.prepare("SELECT COUNT(*) AS count FROM job_attempt").get()).toEqual({ count: 0 });
        } finally { fixture.close(); }
    });
    it("post-effect journal failure leaves dispatch uncertain and restart never blindly replays", async () => {
        const fixture = sqliteFixture({});
        try {
            const clock = clockFixture({}); const ids = idsFixture({});
            const repo = createSqlJobRepo({ database: fixture.database, clock, ids, retryPolicy: policy });
            const dispatch = vi.fn<JobDispatchPort["dispatch"]>(async () => ({ ok: true, value: { kind: "completed", state: "succeeded", jobId: job.operationId } }));
            const dependencies = { repo, clock, ids, retryPolicy: policy, dispatcher: { dispatch }, authorization: { async authorize() { return { ok: true, value: { allowed: true } } as const; } } };
            const service = createJobService(dependencies);
            const receipt = await service.enqueue({ context, job });
            expect(receipt.ok).toBe(true);
            fixture.native.exec("CREATE TRIGGER fail_complete BEFORE INSERT ON job_attempt WHEN NEW.event_type = 'complete' BEGIN SELECT RAISE(ABORT, 'injected'); END");
            expect(await service.processOne({ worker: { workerId: "worker" } })).toMatchObject({ ok: false, error: { code: "unavailable" } });
            if (receipt.ok) expect(await repo.outbox.get({ tenantId: jobTenant({ context }), id: receipt.value.jobId })).toMatchObject({ state: "dispatching" });
            fixture.native.exec("DROP TRIGGER fail_complete");
            clock.advance({ milliseconds: 100 });
            expect(await createJobService(dependencies).processOne({ worker: { workerId: "restart" } })).toEqual({ ok: true, value: { kind: "idle" } });
            expect(dispatch).toHaveBeenCalledTimes(1);
            expect(fixture.native.prepare("SELECT event_type, state FROM job_attempt ORDER BY sequence").all()).toEqual([
                { event_type: "enqueue", state: "pending" }, { event_type: "claim", state: "leased" },
                { event_type: "dispatch", state: "dispatching" }, { event_type: "recovery", state: "reconcile" },
            ]);
        } finally { fixture.close(); }
    });
    it("corrupt durable context is rejected before authority or dispatch", async () => {
        const fixture = sqliteFixture({});
        try {
            const clock = clockFixture({}); const ids = idsFixture({});
            const repo = createSqlJobRepo({ database: fixture.database, clock, ids, retryPolicy: policy });
            await repo.enqueue({ context, job });
            fixture.native.prepare("UPDATE job SET context_json = ?").run('{"scope":"wrong"}');
            const dispatch = vi.fn(); const authorize = vi.fn();
            const service = createJobService({ repo, clock, ids, retryPolicy: policy, dispatcher: { dispatch }, authorization: { authorize } });
            expect(await service.processOne({ worker: { workerId: "worker" } })).toMatchObject({ ok: false, error: { code: "unavailable" } });
            expect(authorize).not.toHaveBeenCalled(); expect(dispatch).not.toHaveBeenCalled();
            expect(fixture.native.prepare("SELECT state FROM job").get()).toEqual({ state: "pending" });
        } finally { fixture.close(); }
    });
    it("evidence resolution appends lineage without rewriting earlier uncertainty", async () => {
        const fixture = sqliteFixture({});
        try {
            const clock = clockFixture({}); const ids = idsFixture({});
            const repo = createSqlJobRepo({ database: fixture.database, clock, ids, retryPolicy: policy });
            const receipt = await repo.enqueue({ context, job });
            await repo.claim({ worker: { workerId: "worker" } });
            clock.advance({ milliseconds: 100 });
            await repo.outbox.recoverExpired({ now: 100, limit: 1 });
            if (!receipt.ok) throw new Error("Expected enqueue");
            await repo.outbox.resolve({ tenantId: jobTenant({ context }), id: receipt.value.jobId, now: 101, state: "succeeded", evidenceId: "remote-operation-readback" });
            expect(fixture.native.prepare("SELECT event_type, state, evidence_id FROM job_attempt ORDER BY sequence").all()).toEqual([
                { event_type: "enqueue", state: "pending", evidence_id: null }, { event_type: "claim", state: "leased", evidence_id: null },
                { event_type: "recovery", state: "reconcile", evidence_id: null }, { event_type: "resolve", state: "succeeded", evidence_id: "remote-operation-readback" },
            ]);
        } finally { fixture.close(); }
    });
    it("reopening a file-backed database preserves pre/post dispatch uncertainty and queued cancellation", async () => {
        const directory = mkdtempSync(join(tmpdir(), "om-jobs-"));
        const path = join(directory, "jobs.sqlite");
        let fixture = sqliteFixture({ path });
        try {
            const clock = clockFixture({}); const ids = idsFixture({});
            const repo = createSqlJobRepo({ database: fixture.database, clock, ids, retryPolicy: policy });
            const first = await repo.enqueue({ context, job });
            const second = await repo.enqueue({ context, job: { ...job, idempotencyKey: "second", operationId: "second" } });
            const cancelled = await repo.enqueue({ context, job: { ...job, idempotencyKey: "cancelled", operationId: "cancelled" } });
            const leaseA = await repo.claim({ worker: { workerId: "a" } });
            const leaseB = await repo.claim({ worker: { workerId: "b" } });
            expect(leaseA).toMatchObject({ ok: true, value: { lease: { state: "leased" } } });
            if (!leaseB.ok || !leaseB.value || !cancelled.ok || !first.ok || !second.ok) throw new Error("Expected leases/receipts");
            await repo.outbox.beginDispatch({ tenantId: leaseB.value.lease.tenantId, id: leaseB.value.lease.id, token: leaseB.value.lease.leaseToken!, now: 1 });
            await repo.outbox.cancel({ tenantId: jobTenant({ context }), id: cancelled.value.jobId, now: 1 });
            fixture.close(); fixture = sqliteFixture({ path });
            clock.advance({ milliseconds: 100 });
            const reopened = createSqlJobRepo({ database: fixture.database, clock, ids: idsFixture({ prefix: "restart" }), retryPolicy: policy });
            expect(await reopened.claim({ worker: { workerId: "restart" } })).toEqual({ ok: true, value: null });
            expect(await reopened.outbox.get({ tenantId: jobTenant({ context }), id: first.value.jobId })).toMatchObject({ state: "reconcile" });
            expect(await reopened.outbox.get({ tenantId: jobTenant({ context }), id: second.value.jobId })).toMatchObject({ state: "reconcile" });
            expect(await reopened.outbox.get({ tenantId: jobTenant({ context }), id: cancelled.value.jobId })).toMatchObject({ state: "cancelled" });
        } finally { fixture.close(); rmSync(directory, { recursive: true, force: true }); }
    });
});

import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendJobEvidence, enqueueInlineJob, createJobService, createSqlJobRepo, jobTenant } from "../index.js";
import type { JobDispatchPort } from "../index.js";
import { sqliteFixture } from "./sql-fixture.js";
import { clockFixture, context, idsFixture, job, policy } from "./fixtures.js";
import type { UnitOfWork } from "@open-marketing/contracts";
describe("SQLite fault injection", () => {
    it("returns the committed dispatch checkpoint when the clock reaches expiry after the transaction", async () => {
        const fixture = sqliteFixture({});
        try {
            const input = { database: fixture.database, clock: clockFixture({}), ids: idsFixture({}), context, job, leaseMs: 100 };
            const queued = await enqueueInlineJob(input);
            if (!queued.ok || queued.value.kind !== "inserted") throw new Error("Expected inline claim");
            const leased = queued.value.job;
            const repo = createSqlJobRepo({ ...input, retryPolicy: policy });
            await repo.outbox.beginDispatch({ id: leased.id, tenantId: leased.tenantId, token: leased.leaseToken!, now: 0 });
            const database: UnitOfWork = { async transaction(request) {
                const result = await fixture.database.transaction(request);
                input.clock.advance({ milliseconds: 100 });
                return result;
            } };
            const checkpoint = { ...input, jobId: leased.id, event: "step", evidence: { phase: "dispatch" } };
            expect(await appendJobEvidence({ ...checkpoint, database })).toEqual({ ok: true, value: undefined });
            expect(fixture.native.prepare("SELECT event_type FROM job_attempt WHERE event_type='step'").all()).toEqual([{ event_type: "step" }]);
            expect(await appendJobEvidence({ ...checkpoint, event: "next-step" })).toMatchObject({ ok: false, error: { code: "conflict" } });
            expect(fixture.native.prepare("SELECT event_type FROM job_attempt WHERE event_type='next-step'").all()).toEqual([]);
        } finally { fixture.close(); }
    });
    it("competing inline calls reserve once and cannot reclaim expired work or change its intent", async () => {
        const fixture = sqliteFixture({});
        try {
            const input = { database: fixture.database, clock: clockFixture({}), ids: idsFixture({}), context, job, leaseMs: 100 };
            const results = await Promise.all([enqueueInlineJob(input), enqueueInlineJob(input)]);
            expect(results.map(result => result.ok && result.value.kind)).toEqual(["inserted", "existing"]);
            expect(results[0]).toMatchObject({ ok: true, value: { job: { state: "leased", attempts: 1, leaseExpiresAt: 100, context } } });
            input.clock.advance({ milliseconds: 100 });
            expect(await enqueueInlineJob(input)).toMatchObject({ ok: true, value: { kind: "existing", job: { attempts: 1, leaseExpiresAt: 100 } } });
            expect(await enqueueInlineJob({ ...input, job: { ...job, payload: { amount: 11 } } })).toEqual({ ok: true, value: { kind: "conflict" } });
            expect(fixture.native.prepare("SELECT event_type FROM job_attempt ORDER BY sequence").all()).toEqual([{ event_type: "enqueue" }, { event_type: "claim" }]);
        } finally { fixture.close(); }
    });
    it("checkpoint failure rolls back evidence and exact expiry blocks a new dispatch step", async () => {
        const fixture = sqliteFixture({});
        try {
            const input = { database: fixture.database, clock: clockFixture({}), ids: idsFixture({}), context, job, leaseMs: 100 };
            const queued = await enqueueInlineJob(input);
            if (!queued.ok || queued.value.kind !== "inserted") throw new Error("Expected inline claim");
            const leased = queued.value.job;
            const repo = createSqlJobRepo({ ...input, retryPolicy: policy });
            await repo.outbox.beginDispatch({ id: leased.id, tenantId: leased.tenantId, token: leased.leaseToken!, now: 0 });
            const checkpoint = { ...input, jobId: leased.id, event: "step", evidence: { phase: "dispatch" } };
            fixture.native.exec("CREATE TRIGGER fail_step BEFORE INSERT ON job_attempt WHEN NEW.event_type='step' BEGIN SELECT RAISE(ABORT, 'injected'); END");
            expect(await appendJobEvidence(checkpoint)).toMatchObject({ ok: false, error: { code: "unavailable" } });
            fixture.native.exec("DROP TRIGGER fail_step");
            input.clock.advance({ milliseconds: 100 });
            expect(await appendJobEvidence(checkpoint)).toMatchObject({ ok: false, error: { code: "conflict" } });
            expect(fixture.native.prepare("SELECT event_type FROM job_attempt WHERE event_type='step'").all()).toEqual([]);
            expect(await appendJobEvidence({ ...checkpoint, evidence: { phase: "observation" } })).toEqual({ ok: true, value: undefined });
        } finally { fixture.close(); }
    });
    it.each(["repository", "inline", "joined"] as const)("failed enqueue/claim journal rolls back the intent and reservation: %s", async mode => {
        const fixture = sqliteFixture({});
        try {
            fixture.native.exec("CREATE TRIGGER fail_enqueue BEFORE INSERT ON job_attempt WHEN NEW.event_type = '" + (mode === "joined" ? "claim" : "enqueue") + "' BEGIN SELECT RAISE(ABORT, 'injected'); END");
            const input = { database: fixture.database, clock: clockFixture({}), ids: idsFixture({}), context, job, leaseMs: 100 };
            let result;
            if (mode === "repository") result = await createSqlJobRepo({ ...input, retryPolicy: policy }).enqueue({ context, job });
            else if (mode === "inline") result = await enqueueInlineJob(input);
            else result = await fixture.database.transaction({ work: ({ session }) => enqueueInlineJob({ ...input, database: session }) });
            expect(result).toMatchObject({ ok: false, error: { code: "unavailable" } });
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
    it("reopening a file-backed database preserves a future due time and exact claim eligibility", async () => {
        const directory = mkdtempSync(join(tmpdir(), "om-jobs-due-"));
        const path = join(directory, "jobs.sqlite");
        let fixture = sqliteFixture({ path });
        try {
            const clock = clockFixture({});
            const repo = createSqlJobRepo({ database: fixture.database, clock, ids: idsFixture({}), retryPolicy: policy });
            const receipt = await repo.enqueue({ context, job, availableAt: 100 });
            if (!receipt.ok) throw new Error("Expected scheduled receipt");
            fixture.close(); fixture = sqliteFixture({ path });
            const reopened = createSqlJobRepo({ database: fixture.database, clock, ids: idsFixture({ prefix: "restart" }), retryPolicy: policy });
            expect(await reopened.outbox.get({ tenantId: jobTenant({ context }), id: receipt.value.jobId })).toMatchObject({ state: "pending", attempts: 0, createdAt: 0, availableAt: 100 });
            clock.advance({ milliseconds: 99 });
            expect(await reopened.claim({ worker: { workerId: "restart" } })).toEqual({ ok: true, value: null });
            clock.advance({ milliseconds: 1 });
            expect(await reopened.claim({ worker: { workerId: "restart" } })).toMatchObject({ ok: true, value: { job, lease: { id: receipt.value.jobId, availableAt: 100 } } });
            expect(await reopened.claim({ worker: { workerId: "restart" } })).toEqual({ ok: true, value: null });
        } finally { fixture.close(); rmSync(directory, { recursive: true, force: true }); }
    });
});

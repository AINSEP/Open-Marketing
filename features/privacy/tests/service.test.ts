import { describe, expect, it } from "vitest";
import type { CallOptions } from "@open-marketing/contracts";
import { createMemoryPrivacyRepo, createPrivacyService, createSqlPrivacyRepo } from "../index.js";
import type { ErasureParticipantPort, ErasurePhase, PrivacyRepoPort } from "../index.js";
import { context, digest, memoryParticipant, serviceFixture, sqliteFixture, unavailable, valueOf } from "./fixtures.js";

describe("erasure orchestration", () => {
  it("is inert until requested, blocks before effects and runs one ordered phase per call", async () => {
    const fixture = serviceFixture({});
    const member = fixture.members[0];
    expect(fixture.blocked.size).toBe(0);
    expect(member.calls).toEqual([]);
    const requested = valueOf({ outcome: await fixture.service.requestErasure({ context, subjectId: "subject" }) });
    expect(requested).toMatchObject({ requestId: "request-1", requestedAt: 123, phase: "plan", status: "pending" });
    expect(fixture.blocked.has(JSON.stringify([context.scope, "subject"]))).toBe(true);
    expect(member.calls).toEqual([]);
    const phaseOrder: ErasurePhase[] = ["plan", "externalRemoval", "purgeLocal", "attest"];
    const nextPhases: ErasurePhase[] = ["externalRemoval", "purgeLocal", "attest", "attest"];
    for (let index = 0; index < phaseOrder.length; index += 1) {
      const result = valueOf({ outcome: await fixture.service.advance({ context, requestId: requested.requestId }) });
      expect(member.calls.at(-1)).toEqual({ context, requestId: "request-1", subjectId: "subject", phase: phaseOrder[index] });
      expect(member.calls.map(call => call.phase)).toEqual(phaseOrder.slice(0, index + 1));
      expect(result.phase).toBe(nextPhases[index]);
      expect(result.status).toBe(index === 3 ? "complete" : "pending");
    }
    const status = valueOf({ outcome: await fixture.service.status({ context, requestId: requested.requestId }) });
    expect(status.retainedSuppression).toEqual([digest]);
    expect(member.state).toEqual({ address: null, externalPresent: false, purges: 1, removals: 1, attestations: 1 });
    const replay = await fixture.service.advance({ context, requestId: requested.requestId });
    expect(replay).toEqual({ ok: true, value: status });
    expect(member.calls).toHaveLength(4);
    expect(fixture.blocked.has(JSON.stringify([context.scope, "subject"]))).toBe(true);
    expect(fixture.blockCalls).toHaveLength(6);
  });
  it("does not persist an erasure until its processing block succeeds", async () => {
    const fixture = serviceFixture({});
    fixture.controls.failBlock = true;
    expect(await fixture.service.requestErasure({ context, subjectId: "subject" })).toEqual(unavailable);
    expect(await fixture.repo.get({ context, requestId: "request-1" })).toEqual({ ok: true, value: null });
    expect(fixture.members[0].calls).toEqual([]);
    fixture.controls.failBlock = false;
    expect(await fixture.service.requestErasure({ context, subjectId: "subject" })).toMatchObject({ ok: true, value: { requestId: "request-2" } });
    expect(fixture.blocked.size).toBe(1);
  });
  it("blocks before request persistence and keeps the block when persistence fails", async () => {
    const base = createMemoryPrivacyRepo({});
    const fixture = serviceFixture({ repo: { ...base, async create() {
      expect(fixture.blocked.has(JSON.stringify([context.scope, "subject"]))).toBe(true);
      expect(fixture.blockCalls[0]).toMatchObject({ requestId: "request-1", subjectId: "subject" });
      return unavailable;
    } } });
    expect(await fixture.service.requestErasure({ context, subjectId: "subject" })).toEqual(unavailable);
    expect(fixture.blocked.size).toBe(1);
    expect(await base.get({ context, requestId: "request-1" })).toEqual({ ok: true, value: null });
    expect(fixture.members[0].calls).toEqual([]);
  });
  it("keeps pending external removal blocked and does not purge or attest until it finishes", async () => {
    const member = memoryParticipant({ id: "contacts", suppression: [digest] });
    member.pending.add("externalRemoval");
    const fixture = serviceFixture({ members: [member] });
    await fixture.service.requestErasure({ context, subjectId: "subject" });
    await fixture.service.advance({ context, requestId: "request-1" });
    const pending = valueOf({ outcome: await fixture.service.advance({ context, requestId: "request-1" }) });
    expect(pending).toMatchObject({ phase: "externalRemoval", status: "pending", retainedSuppression: [digest] });
    expect(member.state.address).toBe("fixture@example.invalid");
    expect(member.state.attestations).toBe(0);
    member.pending.clear();
    expect(await fixture.service.advance({ context, requestId: "request-1" })).toMatchObject({ ok: true, value: { phase: "purgeLocal", status: "pending" } });
    expect(member.state.address).toBe("fixture@example.invalid");
  });
  it("checkpoints sequentially and skips completed participants while pending work is retried", async () => {
    const first = memoryParticipant({ id: "contacts", suppression: [digest] });
    const second = memoryParticipant({ id: "forms" });
    second.pending.add("plan");
    const fixture = serviceFixture({ members: [first, second] });
    await fixture.service.requestErasure({ context, subjectId: "subject" });
    const pending = valueOf({ outcome: await fixture.service.advance({ context, requestId: "request-1" }) });
    expect(pending.participants).toEqual([{ participantId: "contacts", phase: "plan", status: "complete", removedCount: 0 }, { participantId: "forms", phase: "plan", status: "pending", removedCount: 0 }]);
    second.pending.clear();
    expect(await fixture.service.advance({ context, requestId: "request-1" })).toMatchObject({ ok: true, value: { phase: "externalRemoval" } });
    expect(first.calls).toHaveLength(1);
    expect(second.calls).toHaveLength(2);
  });
  it("retries a later failed participant without rerunning earlier completed participants", async () => {
    const first = memoryParticipant({ id: "contacts" });
    const second = memoryParticipant({ id: "forms" });
    const third = memoryParticipant({ id: "events" });
    second.failed.add("plan");
    const fixture = serviceFixture({ members: [first, second, third] });
    await fixture.service.requestErasure({ context, subjectId: "subject" });
    expect(await fixture.service.advance({ context, requestId: "request-1" })).toMatchObject({ ok: true, value: { phase: "plan", status: "failed" } });
    expect(third.calls).toEqual([]);
    second.failed.clear();
    expect(await fixture.service.advance({ context, requestId: "request-1" })).toMatchObject({ ok: true, value: { phase: "externalRemoval", status: "pending" } });
    expect(first.calls).toHaveLength(1);
    expect(second.calls).toHaveLength(2);
    expect(third.calls).toHaveLength(1);
  });
  it("resolves every frozen participant before effects and excludes later registrations", async () => {
    const first = memoryParticipant({ id: "contacts" });
    const missing = memoryParticipant({ id: "forms" });
    const late = memoryParticipant({ id: "later" });
    const fixture = serviceFixture({ members: [first, missing] });
    await fixture.service.requestErasure({ context, subjectId: "subject" });
    fixture.participants.unregister({ id: "forms" });
    fixture.participants.register({ participant: late.participant });
    expect(await fixture.service.advance({ context, requestId: "request-1" })).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(first.calls).toEqual([]);
    fixture.participants.register({ participant: missing.participant });
    expect(await fixture.service.advance({ context, requestId: "request-1" })).toMatchObject({ ok: true, value: { phase: "externalRemoval" } });
    expect(late.calls).toEqual([]);
  });
  it("stops on a lost checkpoint and replays the same external identity without a duplicate effect", async () => {
    const base = createMemoryPrivacyRepo({});
    let loseCheckpoint = false;
    const repo: PrivacyRepoPort = { ...base, async save(input, options) {
      if (loseCheckpoint) { loseCheckpoint = false; return unavailable; }
      return base.save(input, options);
    } };
    const fixture = serviceFixture({ repo });
    const member = fixture.members[0];
    await fixture.service.requestErasure({ context, subjectId: "subject" });
    await fixture.service.advance({ context, requestId: "request-1" });
    loseCheckpoint = true;
    expect(await fixture.service.advance({ context, requestId: "request-1" })).toEqual(unavailable);
    expect(member.state).toMatchObject({ externalPresent: false, removals: 1, address: "fixture@example.invalid", purges: 0 });
    expect(await fixture.service.status({ context, requestId: "request-1" })).toMatchObject({ ok: true, value: { phase: "externalRemoval", status: "pending" } });
    const restarted = createPrivacyService(fixture);
    expect(await restarted.advance({ context, requestId: "request-1" })).toMatchObject({ ok: true, value: { phase: "purgeLocal" } });
    expect(member.calls.filter(call => call.phase === "externalRemoval")).toEqual([
      { context, requestId: "request-1", subjectId: "subject", phase: "externalRemoval" },
      { context, requestId: "request-1", subjectId: "subject", phase: "externalRemoval" },
    ]);
    expect(member.state.removals).toBe(1);
    expect(member.state.purges).toBe(0);
  });
  it("retains only tombstones through purge and attestation in real SQL storage", async () => {
    const sql = sqliteFixture({});
    try {
      const fixture = serviceFixture({ repo: createSqlPrivacyRepo(sql) });
      await fixture.service.requestErasure({ context, subjectId: "subject" });
      for (let index = 0; index < 4; index += 1) valueOf({ outcome: await fixture.service.advance({ context, requestId: "request-1" }) });
      expect(fixture.members[0].state.address).toBeNull();
      const result = valueOf({ outcome: await createSqlPrivacyRepo(sql).get({ context, requestId: "request-1" }) });
      expect(result).toMatchObject({ phase: "attest", status: "complete", retainedSuppression: [digest] });
      const row = sql.db.prepare("SELECT payload FROM privacy_request").get() as { payload: string };
      expect(row.payload).not.toContain("fixture@example.invalid");
      expect(JSON.parse(row.payload).retainedSuppression).toEqual([digest]);
    } finally { sql.close(); }
  });
  it("stops subsequent effects when a checkpoint acknowledgement returns inconsistent identity", async () => {
    const base = createMemoryPrivacyRepo({});
    const repo: PrivacyRepoPort = { ...base, async save(input, options) {
      const saved = await base.save(input, options);
      return saved.ok ? { ok: true, value: { ...saved.value, subjectId: "wrong-subject" } } : saved;
    } };
    const first = memoryParticipant({ id: "contacts" });
    const second = memoryParticipant({ id: "forms" });
    const fixture = serviceFixture({ repo, members: [first, second] });
    await fixture.service.requestErasure({ context, subjectId: "subject" });
    expect(await fixture.service.advance({ context, requestId: "request-1" })).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(second.calls).toEqual([]);
    expect(await fixture.service.status({ context, requestId: "request-1" })).toMatchObject({ ok: true, value: { subjectId: "subject", phase: "plan" } });
  });
  it("rejects cancellation before work and between participants", async () => {
    const first = memoryParticipant({ id: "contacts" });
    const second = memoryParticipant({ id: "forms" });
    const fixture = serviceFixture({ members: [first, second] });
    const options: CallOptions = { signal: AbortSignal.abort() };
    expect(await fixture.service.requestErasure({ context, subjectId: "subject" }, options)).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(fixture.blockCalls).toEqual([]);
    await fixture.service.requestErasure({ context, subjectId: "subject" });
    const controller = new AbortController();
    const run = first.participant.run.bind(first.participant);
    fixture.participants.unregister({ id: "contacts" });
    fixture.participants.register({ participant: { id: "contacts", async run(input, optional) { const result = await run(input, optional); controller.abort(); return result; } } });
    expect(await fixture.service.advance({ context, requestId: "request-1" }, { signal: controller.signal })).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(second.calls).toEqual([]);
    expect(await fixture.service.advance({ context, requestId: "request-1" })).toMatchObject({ ok: true, value: { phase: "externalRemoval" } });
  });
  it("rejects overlapping advances for different requests for the same scoped subject", async () => {
    const { promise: started, resolve: entered } = Promise.withResolvers<void>();
    const { promise: paused, resolve: release } = Promise.withResolvers<void>();
    const fixture = serviceFixture({ members: [] });
    fixture.participants.register({ participant: { id: "paused", async run() { entered(); await paused; return { ok: true, value: { complete: true, removedCount: 0 } }; } } });
    await fixture.service.requestErasure({ context, subjectId: "subject" });
    await fixture.service.requestErasure({ context, subjectId: "subject" });
    const advancing = fixture.service.advance({ context, requestId: "request-1" });
    await started;
    const overlap = await fixture.service.advance({ context, requestId: "request-2" });
    release();
    expect(overlap).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(await advancing).toMatchObject({ ok: true, value: { phase: "externalRemoval" } });
    expect(await fixture.service.advance({ context, requestId: "request-2" })).toMatchObject({ ok: true, value: { phase: "externalRemoval" } });
  });
  it("denies malformed, thrown and late-suppression participant outcomes without purge", async () => {
    const badResults: ErasureParticipantPort["run"][] = [
      async () => { throw new Error("PII must not leak"); },
      async () => ({ ok: true, value: { complete: true, removedCount: -1 } }),
      async () => ({ ok: true, value: { complete: true, removedCount: 0, unsupported: true } } as unknown as Awaited<ReturnType<ErasureParticipantPort["run"]>>),
    ];
    for (const run of badResults) {
      const fixture = serviceFixture({ members: [] });
      fixture.participants.register({ participant: { id: "bad", run } });
      await fixture.service.requestErasure({ context, subjectId: "subject" });
      expect(await fixture.service.advance({ context, requestId: "request-1" })).toMatchObject({ ok: true, value: { phase: "plan", status: "failed" } });
    }
    const fixture = serviceFixture({ members: [] });
    fixture.participants.register({ participant: { id: "late", async run(input) { return { ok: true, value: { complete: true, removedCount: 0, ...(input.phase === "externalRemoval" ? { retainedSuppression: [digest] } : {}) } }; } } });
    await fixture.service.requestErasure({ context, subjectId: "subject" });
    await fixture.service.advance({ context, requestId: "request-1" });
    expect(await fixture.service.advance({ context, requestId: "request-1" })).toMatchObject({ ok: true, value: { phase: "externalRemoval", status: "failed", retainedSuppression: [] } });
  });
  it("deduplicates planned tombstones and stops when the retained payload exceeds its bound", async () => {
    const first = memoryParticipant({ id: "contacts", suppression: [digest] });
    const second = memoryParticipant({ id: "policy", suppression: [digest] });
    const fixture = serviceFixture({ members: [first, second] });
    await fixture.service.requestErasure({ context, subjectId: "subject" });
    expect(await fixture.service.advance({ context, requestId: "request-1" })).toMatchObject({ ok: true, value: { retainedSuppression: [digest], phase: "externalRemoval" } });
    const large = Array.from({ length: 1000 }, (_, index) => ({ ...digest, keyVersion: `key-${index}`, reason: "r".repeat(256), topic: "t".repeat(256) }));
    const overflow = serviceFixture({ members: [memoryParticipant({ id: "large", suppression: large })] });
    await overflow.service.requestErasure({ context, subjectId: "subject" });
    expect(await overflow.service.advance({ context, requestId: "request-1" })).toMatchObject({ ok: false, error: { code: "limit_exceeded" } });
    expect(await overflow.service.status({ context, requestId: "request-1" })).toMatchObject({ ok: true, value: { phase: "plan", retainedSuppression: [] } });
  });
  it("reports missing requests, empty/disposed inventory and invalid input without effects", async () => {
    const fixture = serviceFixture({ members: [] });
    expect(await fixture.service.requestErasure({ context, subjectId: "subject" })).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(await fixture.service.status({ context, requestId: "missing" })).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(await fixture.service.advance({ context, requestId: "missing" })).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(await fixture.service.requestErasure({ context, subjectId: "" })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    fixture.participants.dispose({});
    expect(await fixture.service.requestErasure({ context, subjectId: "subject" })).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(fixture.blockCalls).toEqual([]);
  });
});

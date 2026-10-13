import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { UnitOfWork } from "@open-marketing/contracts";
import { createErasureParticipantRegistry, createMemoryPrivacyRepo, createSqlPrivacyRepo } from "../index.js";
import type { ErasureRequest, PrivacyRepoPort } from "../index.js";
import { context, digest, initialRequest, memoryParticipant, sqliteFixture, valueOf } from "./fixtures.js";

/** B1: exactly the same behavior suite exercises the double and the actual SQLite adapter. */
function repositorySuite(required: { name: string; create: () => { repo: PrivacyRepoPort; close: () => void } }): void {
  describe(required.name, () => {
    let fixture: ReturnType<typeof required.create>;
    beforeEach(() => { fixture = required.create(); });
    afterEach(() => fixture.close());
    it("creates, reads, saves and returns isolated snapshots", async () => {
      const request = initialRequest({});
      const created = valueOf({ outcome: await fixture.repo.create({ context, request }) });
      (request.participants as unknown as { removedCount: number }[])[0].removedCount = 9;
      (created.participants as unknown as { removedCount: number }[])[0].removedCount = 8;
      const stored = valueOf({ outcome: await fixture.repo.get({ context, requestId: "request" }) });
      expect(stored).toEqual(initialRequest({}));
      const planned = { ...initialRequest({}), retainedSuppression: [digest], participants: [{ participantId: "contacts", phase: "plan" as const, status: "complete" as const, removedCount: 3 }] };
      expect(await fixture.repo.save({ context, request: planned })).toEqual({ ok: true, value: planned });
      expect(await fixture.repo.get({ context, requestId: "request" })).toEqual({ ok: true, value: planned });
    });
    it("isolates both owner and workspace, including the same request ID", async () => {
      await fixture.repo.create({ context, request: initialRequest({}) });
      for (const scope of [{ ...context.scope, workspaceId: "other" }, { ...context.scope, ownerId: "other" }]) {
        const other = { ...context, scope };
        expect(await fixture.repo.get({ context: other, requestId: "request" })).toEqual({ ok: true, value: null });
        const request = initialRequest({ scope, subjectId: "other-subject" });
        expect(await fixture.repo.create({ context: other, request })).toEqual({ ok: true, value: request });
      }
      expect(await fixture.repo.get({ context, requestId: "request" })).toEqual({ ok: true, value: initialRequest({}) });
    });
    it("accepts identical create/save replay and rejects conflicting create and missing save", async () => {
      const request = initialRequest({});
      expect(await fixture.repo.create({ context, request })).toEqual({ ok: true, value: request });
      expect(await fixture.repo.create({ context, request })).toEqual({ ok: true, value: request });
      expect(await fixture.repo.save({ context, request })).toEqual({ ok: true, value: request });
      expect(await fixture.repo.create({ context, request: { ...request, subjectId: "other" } })).toMatchObject({ ok: false, error: { code: "conflict" } });
      expect(await fixture.repo.save({ context, request: { ...request, requestId: "missing" } })).toMatchObject({ ok: false, error: { code: "unavailable" } });
    });
    it("freezes identity and participant membership", async () => {
      const request = initialRequest({});
      await fixture.repo.create({ context, request });
      const changes: Partial<ErasureRequest>[] = [{ subjectId: "changed" }, { requestedAt: 124 }, { participants: [{ ...request.participants[0], participantId: "new" }] }];
      for (const change of changes) expect(await fixture.repo.save({ context, request: { ...request, ...change } })).toMatchObject({ ok: false, error: { code: "conflict" } });
      expect(await fixture.repo.get({ context, requestId: "request" })).toEqual({ ok: true, value: request });
    });
    it("rejects completed-progress regressions and tombstone removal independently", async () => {
      await fixture.repo.create({ context, request: initialRequest({}) });
      const pending = initialRequest({ retainedSuppression: [digest] });
      await fixture.repo.save({ context, request: pending });
      expect(await fixture.repo.save({ context, request: initialRequest({}) })).toMatchObject({ ok: false, error: { code: "conflict" } });
      const complete = { ...pending, participants: [{ ...pending.participants[0], status: "complete" as const, removedCount: 4 }] };
      await fixture.repo.save({ context, request: complete });
      expect(await fixture.repo.save({ context, request: pending })).toMatchObject({ ok: false, error: { code: "conflict" } });
      expect(await fixture.repo.save({ context, request: { ...complete, participants: [{ ...complete.participants[0], removedCount: 5 }] } })).toMatchObject({ ok: false, error: { code: "conflict" } });
      expect(await fixture.repo.get({ context, requestId: "request" })).toEqual({ ok: true, value: complete });
    });
    it("checks monotonic counts while allowing failed work to be retried", async () => {
      await fixture.repo.create({ context, request: initialRequest({}) });
      const pending = initialRequest({ participants: [{ participantId: "contacts", phase: "plan", status: "pending", removedCount: 2 }] });
      await fixture.repo.save({ context, request: pending });
      expect(await fixture.repo.save({ context, request: initialRequest({}) })).toMatchObject({ ok: false, error: { code: "conflict" } });
      const failed = { ...pending, status: "failed" as const, participants: [{ ...pending.participants[0], status: "failed" as const }] };
      await fixture.repo.save({ context, request: failed });
      expect(await fixture.repo.save({ context, request: pending })).toEqual({ ok: true, value: pending });
    });
    it("enforces phase barriers and accepts only final attestation completion", async () => {
      const request = initialRequest({});
      await fixture.repo.create({ context, request });
      const phases = ["plan", "externalRemoval", "purgeLocal", "attest"] as const;
      let current = request;
      for (const phase of phases) {
        current = { ...current, participants: current.participants.map(entry => entry.phase === phase ? { ...entry, status: "complete" } : entry), status: phase === "attest" ? "complete" : "pending" };
        expect(await fixture.repo.save({ context, request: current })).toEqual({ ok: true, value: current });
        if (phase === "attest") break;
        const next = phases[phases.indexOf(phase) + 1];
        current = { ...current, phase: next, participants: [...current.participants, { participantId: "contacts", phase: next, status: "pending", removedCount: 0 }] };
        expect(await fixture.repo.save({ context, request: current })).toEqual({ ok: true, value: current });
      }
      expect(current).toMatchObject({ phase: "attest", status: "complete" });
      expect(await fixture.repo.save({ context, request })).toMatchObject({ ok: false, error: { code: "conflict" } });
    });
    it("rejects invalid context, cross-scope writes, unknown fields and cancellation before effects", async () => {
      const request = initialRequest({});
      expect(await fixture.repo.create({ context: { ...context, traceId: "" }, request })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
      expect(await fixture.repo.create({ context, request: { ...request, scope: { ...context.scope, ownerId: "other" } } })).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(await fixture.repo.create({ context, request: { ...request, address: "fixture@example.invalid" } as ErasureRequest })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
      expect(await fixture.repo.create({ context, request }, { signal: AbortSignal.abort() })).toMatchObject({ ok: false, error: { code: "cancelled" } });
      expect(await fixture.repo.get({ context, requestId: "request" })).toEqual({ ok: true, value: null });
    });
    it("rejects duplicate participants, dishonest completion, phase skips and bounded overflows", async () => {
      const request = initialRequest({});
      const duplicates = { ...request, participants: [request.participants[0], request.participants[0]] };
      expect(await fixture.repo.create({ context, request: duplicates })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
      expect(await fixture.repo.create({ context, request: { ...request, status: "complete" } })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
      const oversized = { ...request, participants: Array.from({ length: 101 }, (_, index) => ({ ...request.participants[0], participantId: `member-${index}` })) };
      expect(await fixture.repo.create({ context, request: oversized })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
      await fixture.repo.create({ context, request });
      const skipped = { ...request, phase: "purgeLocal" as const, participants: [
        { ...request.participants[0], status: "complete" as const },
        { ...request.participants[0], phase: "externalRemoval" as const, status: "complete" as const },
        { ...request.participants[0], phase: "purgeLocal" as const },
      ] };
      expect(await fixture.repo.save({ context, request: skipped })).toMatchObject({ ok: false, error: { code: "conflict" } });
      const digests = Array.from({ length: 1001 }, (_, index) => ({ ...digest, keyVersion: `key-${index}` }));
      expect(await fixture.repo.save({ context, request: { ...request, retainedSuppression: digests } })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
      expect(await fixture.repo.save({ context, request: { ...request, retainedSuppression: [digest, digest] } })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    });
    it("accepts the exact 100-participant, 400-checkpoint and 1000-digest bounds", async () => {
      const participants = Array.from({ length: 100 }, (_, index) => ({ participantId: `member-${index}`, phase: "plan" as const, status: "pending" as const, removedCount: 0 }));
      const request = initialRequest({ participants });
      await fixture.repo.create({ context, request });
      let current = { ...request, retainedSuppression: Array.from({ length: 1000 }, (_, index) => ({ ...digest, keyVersion: `key-${index}` })) };
      for (const phase of ["plan", "externalRemoval", "purgeLocal", "attest"] as const) {
        current = { ...current, participants: current.participants.map(entry => ({ ...entry, status: "complete" })), status: phase === "attest" ? "complete" : "pending" };
        expect(await fixture.repo.save({ context, request: current })).toEqual({ ok: true, value: current });
        if (phase === "attest") break;
        const next = ({ plan: "externalRemoval", externalRemoval: "purgeLocal", purgeLocal: "attest" } as const)[phase];
        current = { ...current, phase: next, participants: [...current.participants, ...participants.map(entry => ({ ...entry, phase: next }))] };
        valueOf({ outcome: await fixture.repo.save({ context, request: current }) });
      }
      expect(current.participants).toHaveLength(400);
      expect(current.retainedSuppression).toHaveLength(1000);
      expect(await fixture.repo.get({ context, requestId: "request" })).toEqual({ ok: true, value: current });
    });
  });
}
repositorySuite({ name: "memory repository", create: () => ({ repo: createMemoryPrivacyRepo({}), close() {} }) });
repositorySuite({ name: "SQLite repository", create: () => { const fixture = sqliteFixture({}); return { repo: createSqlPrivacyRepo(fixture), close: fixture.close }; } });

describe("participant registry", () => {
  it("isolates instances, snapshots registrations and supports unregister/reset/dispose", () => {
    const registry = createErasureParticipantRegistry({});
    const other = createErasureParticipantRegistry({});
    const member = memoryParticipant({ id: "contacts" });
    expect(registry.register({ participant: member.participant })).toEqual({ ok: true, value: undefined });
    expect(other.list({})).toEqual({ ok: true, value: [] });
    (valueOf({ outcome: registry.list({}) }) as unknown as unknown[]).pop();
    expect(valueOf({ outcome: registry.list({}) }).map(participant => participant.id)).toEqual(["contacts"]);
    expect(registry.register({ participant: member.participant })).toMatchObject({ ok: false, error: { code: "conflict" } });
    registry.unregister({ id: "contacts" });
    expect(registry.list({})).toEqual({ ok: true, value: [] });
    registry.register({ participant: member.participant });
    registry.reset({});
    expect(registry.list({})).toEqual({ ok: true, value: [] });
    registry.dispose({});
    expect(registry.dispose({})).toEqual({ ok: true, value: undefined });
    for (const outcome of [registry.list({}), registry.reset({}), registry.unregister({ id: "contacts" }), registry.register({ participant: member.participant })]) expect(outcome).toMatchObject({ ok: false, error: { code: "unavailable" } });
  });
  it("admits exactly 100 participants and rejects invalid IDs", () => {
    const registry = createErasureParticipantRegistry({});
    expect(registry.register({ participant: memoryParticipant({ id: "" }).participant })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    for (let index = 0; index < 100; index += 1) expect(registry.register({ participant: memoryParticipant({ id: `participant-${index}` }).participant })).toEqual({ ok: true, value: undefined });
    expect(registry.register({ participant: memoryParticipant({ id: "overflow" }).participant })).toMatchObject({ ok: false, error: { code: "limit_exceeded" } });
    registry.unregister({ id: "participant-0" });
    expect(registry.register({ participant: memoryParticipant({ id: "replacement" }).participant })).toEqual({ ok: true, value: undefined });
  });
});

describe("SQL persistence protections", () => {
  let fixture: ReturnType<typeof sqliteFixture>;
  beforeEach(() => { fixture = sqliteFixture({}); });
  afterEach(() => fixture.close());
  it("does not update the version for identical saves and reads through a new adapter", async () => {
    const repo = createSqlPrivacyRepo(fixture);
    const request = initialRequest({});
    await repo.create({ context, request });
    await repo.save({ context, request });
    expect(fixture.db.prepare("SELECT version FROM privacy_request").get()).toEqual({ version: 1 });
    const changed = { ...request, retainedSuppression: [digest] };
    await repo.save({ context, request: changed });
    expect(fixture.db.prepare("SELECT version FROM privacy_request").get()).toEqual({ version: 2 });
    expect(await createSqlPrivacyRepo(fixture).get({ context, requestId: "request" })).toEqual({ ok: true, value: changed });
  });
  it("returns unavailable for corrupted JSON, wrong request IDs and metadata drift", async () => {
    const repo = createSqlPrivacyRepo(fixture);
    await repo.create({ context, request: initialRequest({}) });
    for (const payload of ["{", JSON.stringify(initialRequest({ requestId: "wrong" })), JSON.stringify(initialRequest({ subjectId: "wrong" })), JSON.stringify(initialRequest({ requestedAt: 124 }))]) {
      fixture.db.prepare("UPDATE privacy_request SET payload=?").run(payload);
      expect(await repo.get({ context, requestId: "request" })).toMatchObject({ ok: false, error: { code: "unavailable" } });
    }
  });
  it("stops on driver failure and leaves the last committed state intact", async () => {
    const repo = createSqlPrivacyRepo(fixture);
    const request = initialRequest({});
    await repo.create({ context, request });
    fixture.db.exec("CREATE TRIGGER fail_update BEFORE UPDATE ON privacy_request BEGIN SELECT RAISE(ABORT, 'fixture'); END");
    expect(await repo.save({ context, request: { ...request, retainedSuppression: [digest] } })).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(await repo.get({ context, requestId: "request" })).toEqual({ ok: true, value: request });
  });
  it("fails the optimistic update when the expected version no longer matches", async () => {
    const request = initialRequest({});
    await createSqlPrivacyRepo(fixture).create({ context, request });
    // Force the competing version at the real UPDATE boundary; SQLite must affect zero rows.
    const unitOfWork: UnitOfWork = { transaction({ work }) {
      return fixture.unitOfWork.transaction({ work: ({ session }) => work({ session: {
        ...session,
        async query<Row extends Record<string, unknown>>(input: { text: string; values?: unknown[] }) {
          if (!input.text.startsWith("UPDATE privacy_request")) return session.query<Row>(input);
          const values = [...input.values!];
          values[values.length - 1] = Number(values.at(-1)) + 1;
          return session.query<Row>({ ...input, values });
        },
      } }) });
    } };
    expect(await createSqlPrivacyRepo({ unitOfWork }).save({ context, request: { ...request, retainedSuppression: [digest] } })).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(await createSqlPrivacyRepo(fixture).get({ context, requestId: "request" })).toEqual({ ok: true, value: request });
    expect(fixture.db.prepare("SELECT version FROM privacy_request").get()).toEqual({ version: 1 });
  });
  it("rolls back SQL writes if cancellation arrives before the root transaction returns", async () => {
    const controller = new AbortController();
    const unitOfWork: UnitOfWork = { transaction({ work }) {
      return fixture.unitOfWork.transaction({ work: ({ session }) => work({ session: {
        ...session,
        async query<Row extends Record<string, unknown>>(input: { text: string; values?: unknown[] }) {
          const result = await session.query<Row>(input);
          if (input.text.startsWith("INSERT INTO privacy_request")) controller.abort();
          return result;
        },
      } }) });
    } };
    expect(await createSqlPrivacyRepo({ unitOfWork }).create({ context, request: initialRequest({}) }, { signal: controller.signal })).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(await createSqlPrivacyRepo(fixture).get({ context, requestId: "request" })).toEqual({ ok: true, value: null });
  });
});

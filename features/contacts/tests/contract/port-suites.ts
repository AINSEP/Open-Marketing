import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CallContext, Outcome } from "@open-marketing/contracts";
import type { ContactRepoPort, Identifier, Subject } from "../../index.js";

export const context: CallContext = { scope: { ownerId: "owner", workspaceId: "workspace" }, principal: { kind: "owner", ownerId: "owner" }, correlationId: "correlation", traceId: "trace", runId: "run" };
/** Inputs deliberately contain an untrusted creationOrder; storage allocates its own. */
export function subject(required: { id: string }): Subject {
  return { scope: context.scope, subjectId: required.id, creationOrder: 999, createdAt: 100, mergedInto: null, timezone: "America/Los_Angeles", lineage: [] };
}
export function identifier(required: { subjectId: string; id: string; digest?: string; kind?: Identifier["kind"] }): Identifier {
  return { identifierId: required.id, subjectId: required.subjectId, kind: required.kind ?? "email", normalizedValue: `${required.id}@example.test`, normalizationVersion: "v1", identifierDigest: required.digest ?? "a".repeat(64), keyVersion: "v1" };
}
export function value<T>(required: { outcome: Outcome<T> }): T {
  if (!required.outcome.ok) throw new Error(`Expected success: ${required.outcome.error.code}`);
  return required.outcome.value;
}

/** B1: identical behavioral assertions for memory and the real SQLite implementation.
 * Each test owns a fresh repository. Assertions inspect durable state after denied writes. */
export function contactRepoSuite(required: { name: string; create: () => { repo: ContactRepoPort; close: () => void } }): void {
  describe(required.name, () => {
    let repo: ContactRepoPort;
    let close: () => void;
    beforeEach(() => { const fixture = required.create(); repo = fixture.repo; close = fixture.close; });
    afterEach(() => close());

    it("returns null for missing subjects/digests and denies missing export/purge/merge", async () => {
      expect(await repo.get({ context, subjectId: "missing" })).toEqual({ ok: true, value: null });
      expect(await repo.findByDigest({ context, kind: "email", identifierDigest: "a".repeat(64) })).toEqual({ ok: true, value: null });
      expect(await repo.identifiersFor({ context, subjectId: "missing" })).toMatchObject({ ok: false, error: { code: "unavailable" } });
      expect(await repo.purgeIdentifiers({ context, subjectId: "missing" })).toMatchObject({ ok: false });
      expect(await repo.merge({ context, sourceSubjectId: "missing", targetSubjectId: "other", mergedAt: 200 })).toMatchObject({ ok: false });
    });
    it("isolates both owner and workspace, including digest collisions", async () => {
      await repo.upsert({ context, subject: subject({ id: "one" }), identifiers: [identifier({ subjectId: "one", id: "email" })] });
      for (const scope of [{ ownerId: "other", workspaceId: "workspace" }, { ownerId: "owner", workspaceId: "other" }]) {
        const other = { ...context, scope };
        expect(await repo.get({ context: other, subjectId: "one" })).toEqual({ ok: true, value: null });
        expect(await repo.findByDigest({ context: other, kind: "email", identifierDigest: "a".repeat(64) })).toEqual({ ok: true, value: null });
        expect(await repo.upsert({ context: other, subject: { ...subject({ id: "one" }), scope }, identifiers: [identifier({ subjectId: "one", id: "email" })] })).toMatchObject({ ok: true });
      }
    });
    it("copies input and output and preserves immutable creation metadata on updates", async () => {
      const input = { context: structuredClone(context), subject: structuredClone(subject({ id: "one" })), identifiers: [identifier({ subjectId: "one", id: "email" })] };
      const pending = repo.upsert(input);
      (input.subject as { timezone?: string }).timezone = "UTC";
      input.identifiers[0] = { ...input.identifiers[0], normalizedValue: "changed@example.test" };
      const inserted = value({ outcome: await pending });
      expect(inserted.timezone).toBe("America/Los_Angeles");
      expect(inserted.creationOrder).not.toBe(999);
      (inserted.scope as { ownerId: string }).ownerId = "mutated";
      const loaded = value({ outcome: await repo.identifiersFor({ context, subjectId: "one" }) });
      (loaded as Identifier[])[0] = { ...loaded[0], normalizedValue: "output@example.test" };
      expect(value({ outcome: await repo.identifiersFor({ context, subjectId: "one" }) })[0].normalizedValue).toBe("email@example.test");
      const original = value({ outcome: await repo.get({ context, subjectId: "one" }) })!;
      expect(await repo.upsert({ context, subject: { ...original, createdAt: 500, creationOrder: 777, timezone: "UTC" }, identifiers: [identifier({ subjectId: "one", id: "email" })] })).toMatchObject({ ok: false, error: { code: "conflict" } });
      expect(await repo.get({ context, subjectId: "one" })).toEqual({ ok: true, value: original });
      const updated = value({ outcome: await repo.upsert({ context, subject: { ...original, timezone: "UTC" }, identifiers: [identifier({ subjectId: "one", id: "email" })] }) });
      expect(updated).toMatchObject({ createdAt: 100, creationOrder: original.creationOrder, timezone: "UTC", scope: context.scope });
    });
    it("rolls back a whole batch when a later identifier collides with another subject", async () => {
      await repo.upsert({ context, subject: subject({ id: "existing" }), identifiers: [identifier({ subjectId: "existing", id: "old" })] });
      const outcome = await repo.upsert({ context, subject: subject({ id: "new" }), identifiers: [identifier({ subjectId: "new", id: "fresh", digest: "b".repeat(64) }), identifier({ subjectId: "new", id: "collision" })] });
      expect(outcome).toMatchObject({ ok: false, error: { code: "conflict" } });
      expect(await repo.get({ context, subjectId: "new" })).toEqual({ ok: true, value: null });
      expect(await repo.findByDigest({ context, kind: "email", identifierDigest: "b".repeat(64) })).toEqual({ ok: true, value: null });
      expect(value({ outcome: await repo.identifiersFor({ context, subjectId: "existing" }) })).toHaveLength(1);
    });
    it("denies duplicate identifier IDs with conflicting batch values atomically", async () => {
      const first = identifier({ subjectId: "one", id: "duplicate" });
      expect(await repo.upsert({ context, subject: subject({ id: "one" }), identifiers: [first, { ...first, identifierDigest: "b".repeat(64), normalizedValue: "second@example.test" }] })).toMatchObject({ ok: false, error: { code: "conflict" } });
      expect(await repo.get({ context, subjectId: "one" })).toEqual({ ok: true, value: null });
    });
    it("deduplicates repeated digests and returns a typed conflict for concurrent ownership", async () => {
      const outputs = await Promise.all(["one", "two"].map(id => repo.upsert({ context, subject: subject({ id }), identifiers: [identifier({ subjectId: id, id })] })));
      expect(outputs.filter(output => output.ok)).toHaveLength(1);
      expect(outputs.filter(output => !output.ok)).toMatchObject([{ ok: false, error: { code: "conflict" } }]);
      const canonical = value({ outcome: await repo.findByDigest({ context, kind: "email", identifierDigest: "a".repeat(64) }) })!;
      expect(await repo.upsert({ context, subject: canonical, identifiers: [identifier({ subjectId: canonical.subjectId, id: "duplicate-value" })] })).toMatchObject({ ok: true });
      expect(value({ outcome: await repo.identifiersFor({ context, subjectId: canonical.subjectId }) })).toHaveLength(1);
      expect(await repo.get({ context, subjectId: canonical.subjectId === "one" ? "two" : "one" })).toEqual({ ok: true, value: null });
    });
    it("allows shared clicks across subjects without treating them as identity collisions", async () => {
      for (const [index, id] of ["one", "two"].entries()) {
        expect(await repo.upsert({ context, subject: subject({ id }), identifiers: [identifier({ subjectId: id, id, digest: String(index + 1).repeat(64) }), identifier({ subjectId: id, id: `click-${id}`, kind: "gclid", digest: "c".repeat(64) })] })).toMatchObject({ ok: true });
      }
      expect(await repo.findByDigest({ context, kind: "gclid", identifierDigest: "c".repeat(64) })).toEqual({ ok: true, value: null });
    });
    it.each([false, true])("retains insertion order despite merge argument direction (reversed=%s)", async reversed => {
      const first = value({ outcome: await repo.upsert({ context, subject: subject({ id: "z-first" }), identifiers: [identifier({ subjectId: "z-first", id: "first" })] }) });
      const second = value({ outcome: await repo.upsert({ context, subject: { ...subject({ id: "a-second" }), createdAt: 1, creationOrder: 0 }, identifiers: [identifier({ subjectId: "a-second", id: "second", digest: "b".repeat(64) })] }) });
      expect(first.creationOrder).toBeLessThan(second.creationOrder);
      const sourceSubjectId = reversed ? first.subjectId : second.subjectId;
      const targetSubjectId = reversed ? second.subjectId : first.subjectId;
      const merged = value({ outcome: await repo.merge({ context, sourceSubjectId, targetSubjectId, mergedAt: 200 }) });
      expect(merged.subjectId).toBe(first.subjectId);
      expect(merged.lineage).toEqual([{ sourceSubjectId: second.subjectId, targetSubjectId: first.subjectId, mergedAt: 200 }]);
      expect(await repo.get({ context, subjectId: second.subjectId })).toEqual({ ok: true, value: merged });
      expect(value({ outcome: await repo.identifiersFor({ context, subjectId: second.subjectId }) }).map(item => item.subjectId)).toEqual([first.subjectId, first.subjectId]);
      expect(await repo.findByDigest({ context, kind: "email", identifierDigest: "b".repeat(64) })).toEqual({ ok: true, value: merged });
      expect(await repo.merge({ context, sourceSubjectId: first.subjectId, targetSubjectId: second.subjectId, mergedAt: 300 })).toEqual({ ok: true, value: merged });
      expect(await repo.upsert({ context, subject: merged, identifiers: [identifier({ subjectId: first.subjectId, id: "third", digest: "d".repeat(64) })] })).toMatchObject({ ok: true, value: { lineage: merged.lineage } });
    });
    it("retains lineage through multiple roots and rejects missing/cross-scope merges", async () => {
      for (const [index, id] of ["one", "two", "three"].entries()) await repo.upsert({ context, subject: subject({ id }), identifiers: [identifier({ subjectId: id, id, digest: String(index + 1).repeat(64) })] });
      await repo.merge({ context, sourceSubjectId: "three", targetSubjectId: "two", mergedAt: 200 });
      const merged = value({ outcome: await repo.merge({ context, sourceSubjectId: "three", targetSubjectId: "one", mergedAt: 300 }) });
      expect(merged.lineage).toEqual([{ sourceSubjectId: "three", targetSubjectId: "two", mergedAt: 200 }, { sourceSubjectId: "two", targetSubjectId: "one", mergedAt: 300 }]);
      expect(await repo.get({ context, subjectId: "three" })).toEqual({ ok: true, value: merged });
      expect(await repo.merge({ context: { ...context, scope: { ...context.scope, workspaceId: "other" } }, sourceSubjectId: "one", targetSubjectId: "two", mergedAt: 400 })).toMatchObject({ ok: false });
      expect(await repo.merge({ context, sourceSubjectId: "one", targetSubjectId: "absent", mergedAt: 400 })).toMatchObject({ ok: false });
      expect(value({ outcome: await repo.get({ context, subjectId: "one" }) })!.lineage).toHaveLength(2);
    });
    it("purges values/clicks/timezone, retains stable digests/lineage and denies revival", async () => {
      await repo.upsert({ context, subject: subject({ id: "one" }), identifiers: [identifier({ subjectId: "one", id: "email" }), identifier({ subjectId: "one", id: "click", kind: "gclid", digest: "c".repeat(64) })] });
      await repo.upsert({ context, subject: subject({ id: "two" }), identifiers: [identifier({ subjectId: "two", id: "phone", kind: "phone", digest: "b".repeat(64) })] });
      await repo.merge({ context, sourceSubjectId: "two", targetSubjectId: "one", mergedAt: 200 });
      expect(await repo.purgeIdentifiers({ context, subjectId: "two" })).toEqual({ ok: true, value: { purged: 3 } });
      expect(await repo.purgeIdentifiers({ context, subjectId: "one" })).toEqual({ ok: true, value: { purged: 0 } });
      const retained = value({ outcome: await repo.findByDigest({ context, kind: "email", identifierDigest: "a".repeat(64) }) })!;
      expect(retained.timezone).toBeUndefined();
      expect(retained.lineage).toHaveLength(1);
      expect(await repo.findByDigest({ context, kind: "phone", identifierDigest: "b".repeat(64) })).toMatchObject({ ok: true, value: { subjectId: "one" } });
      expect(await repo.findByDigest({ context, kind: "gclid", identifierDigest: "c".repeat(64) })).toEqual({ ok: true, value: null });
      expect(await repo.identifiersFor({ context, subjectId: "two" })).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(await repo.upsert({ context, subject: retained, identifiers: [identifier({ subjectId: "one", id: "revive" })] })).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(await repo.upsert({ context, subject: subject({ id: "new" }), identifiers: [identifier({ subjectId: "new", id: "reimport" })] })).toMatchObject({ ok: false, error: { code: "conflict" } });
      expect(await repo.merge({ context, sourceSubjectId: "two", targetSubjectId: "one", mergedAt: 400 })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    });
    it("validates input scope, batch limits and cancellation without creating state", async () => {
      const wrongScope = { ...subject({ id: "one" }), scope: { ownerId: "other", workspaceId: "workspace" } };
      expect(await repo.upsert({ context, subject: wrongScope, identifiers: [identifier({ subjectId: "one", id: "email" })] })).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(await repo.upsert({ context, subject: subject({ id: "one" }), identifiers: Array.from({ length: 21 }, (_, index) => identifier({ subjectId: "one", id: String(index) })) })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
      expect(await repo.upsert({ context, subject: subject({ id: "one" }), identifiers: [identifier({ subjectId: "two", id: "email" })] })).toMatchObject({ ok: false });
      expect(await repo.upsert({ context, subject: subject({ id: "one" }), identifiers: [identifier({ subjectId: "one", id: "email" })] }, { signal: AbortSignal.abort() })).toMatchObject({ ok: false, error: { code: "cancelled" } });
      expect(await repo.get({ context, subjectId: "one" })).toEqual({ ok: true, value: null });
    });
  });
}

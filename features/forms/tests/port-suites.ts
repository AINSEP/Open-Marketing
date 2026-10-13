/** One OM storage contract suite; Jini's own repositories are not retested here. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SqlSession } from "@open-marketing/contracts";
import type { Fixture } from "./fixtures.js";
import { context, otherContext, publication, receipt } from "./fixtures.js";

/** Assert immutable snapshots, replay identities, rollback and isolation against both adapters.
 * @example formsStorageSuite({ name: "SQLite", create: () => createFixture({ kind: "sql" }) }); */
export function formsStorageSuite(required: { name: string; create: () => Fixture }): void {
  describe(`${required.name} OM publication/receipt ports`, () => {
    let fixture: Fixture;
    beforeEach(async () => { fixture = required.create(); await fixture.prepare({ publication: publication(), receipt }); });
    afterEach(() => fixture.close());
    const append = (input: { publication?: ReturnType<typeof publication> } = {}) => fixture.unitOfWork.transaction({ work: ({ session }) => fixture.publications.append({ context, publication: input.publication ?? publication(), session }) });
    const appendReceipt = (input: { receipt?: typeof receipt } = {}) => fixture.unitOfWork.transaction({ work: ({ session }) => fixture.receipts.append({ context, receipt: input.receipt ?? receipt, session }) });
    const readReceipt = () => fixture.unitOfWork.transaction({ work: ({ session }) => fixture.receipts.find({ context, ...receipt, session }) });

    it("acceptance receipt is scoped, immutable, rollback-safe and retained after idempotent purge", async () => {
      await append(); await appendReceipt();
      const accepted = { submissionId: receipt.submissionId, publicationId: receipt.publicationId, subjectId: "subject-one", acceptedAt: 123 };
      const save = (input = accepted) => fixture.unitOfWork.transaction({ work: ({ session }) => fixture.subjects.append({ context, receipt: input, session }) });
      const find = () => fixture.unitOfWork.transaction({ work: ({ session }) => fixture.subjects.find({ context, submissionId: receipt.submissionId, session }) });
      expect(await save()).toEqual({ ok: true, value: accepted });
      expect(await save()).toEqual({ ok: true, value: accepted });
      expect(await save({ ...accepted, subjectId: "subject-two" })).toMatchObject({ ok: false, error: { code: "conflict" } });
      expect(await fixture.subjects.list({ context, limit: 1 })).toEqual({ ok: true, value: [accepted] });
      expect(await fixture.subjects.list({ context: otherContext, limit: 1 })).toEqual({ ok: true, value: [] });
      expect(await fixture.subjects.list({ context, limit: 101 })).toMatchObject({ ok: false });
      expect(await fixture.subjects.purgeSubject({ context, subjectId: accepted.subjectId })).toEqual({ ok: true, value: undefined });
      expect(await fixture.subjects.purgeSubject({ context, subjectId: accepted.subjectId })).toEqual({ ok: true, value: undefined });
      expect(await find()).toEqual({ ok: true, value: accepted });
      expect(await fixture.submissions.findById({ workspaceId: context.scope.workspaceId, id: receipt.submissionId })).toBeNull();
    });
    it("returned acceptance failure rolls back its receipt", async () => {
      await append(); await appendReceipt();
      await fixture.unitOfWork.transaction({ work: async ({ session }) => {
        expect((await fixture.subjects.append({ context, session, receipt: { submissionId: receipt.submissionId, publicationId: receipt.publicationId, subjectId: "rollback-subject", acceptedAt: 123 } })).ok).toBe(true);
        return { ok: false as const, error: { code: "conflict" as const, message: "Fixture rollback", retryable: false } };
      } });
      expect(await fixture.subjects.list({ context, limit: 10 })).toEqual({ ok: true, value: [] });
    });
    it("exact publication replay returns its original immutable snapshot", async () => {
      expect(await append()).toEqual({ ok: true, value: publication() });
      expect(await append()).toEqual({ ok: true, value: publication() });
      const result = await fixture.publications.find({ context, publicationId: receipt.publicationId });
      expect(result).toEqual({ ok: true, value: publication() });
      if (!result.ok || !result.value) throw new Error("Expected publication");
      result.value.fields[0].label = "Mutated caller object";
      expect(await fixture.publications.find({ context, publicationId: receipt.publicationId })).toEqual({ ok: true, value: publication() });
    });
    it("publication ID and slug/version collisions deny drift", async () => {
      await append();
      expect(await append({ publication: { ...publication(), publishedAt: 123 } })).toMatchObject({ ok: false, error: { code: "conflict" } });
      expect(await append({ publication: publication({ publicationId: "colliding-id" }) })).toMatchObject({ ok: false, error: { code: "conflict" } });
      expect(await fixture.publications.find({ context, publicationId: receipt.publicationId })).toEqual({ ok: true, value: publication() });
    });
    it("latest slug lookup preserves earlier wording and chooses the largest version", async () => {
      await append();
      const newer = publication({ version: 2, publicationId: "publication-two" });
      expect(await append({ publication: newer })).toEqual({ ok: true, value: newer });
      expect(await fixture.publications.findBySlug({ context, slug: "lead" })).toEqual({ ok: true, value: newer });
      expect(await fixture.publications.find({ context, publicationId: receipt.publicationId })).toEqual({ ok: true, value: publication() });
    });
    it("workspace isolation hides publication and receipt IDs", async () => {
      await append(); await appendReceipt();
      expect(await fixture.publications.find({ context: otherContext, publicationId: receipt.publicationId })).toEqual({ ok: true, value: null });
      expect(await fixture.publications.findBySlug({ context: otherContext, slug: "lead" })).toEqual({ ok: true, value: null });
      expect(await fixture.unitOfWork.transaction({ work: ({ session }) => fixture.receipts.find({ context: otherContext, ...receipt, session }) })).toEqual({ ok: true, value: null });
      expect(await append({ publication: { ...publication(), scope: otherContext.scope } })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    });
    it("same receipt replays; a changed digest or reload ID conflicts without overwriting", async () => {
      await append();
      expect(await appendReceipt()).toEqual({ ok: true, value: receipt });
      expect(await appendReceipt()).toEqual({ ok: true, value: receipt });
      expect(await appendReceipt({ receipt: { ...receipt, bodyDigest: "b".repeat(64) } })).toMatchObject({ ok: false, error: { code: "conflict" } });
      expect(await appendReceipt({ receipt: { ...receipt, jobId: "wrong-job" } })).toMatchObject({ ok: false, error: { code: "conflict" } });
      expect(await readReceipt()).toEqual({ ok: true, value: receipt });
    });
    it("receipt cannot precede its publication", async () => {
      expect(await appendReceipt()).toMatchObject({ ok: false, error: { code: "unavailable" } });
      expect(await readReceipt()).toEqual({ ok: true, value: null });
    });
    it("returned failure rolls back both OM inserts", async () => {
      const result = await fixture.unitOfWork.transaction({ work: async ({ session }) => {
        expect(await fixture.publications.append({ context, publication: publication(), session })).toMatchObject({ ok: true });
        expect(await fixture.receipts.append({ context, receipt, session })).toMatchObject({ ok: true });
        return { ok: false, error: { code: "conflict", message: "Injected rollback", retryable: false } };
      } });
      expect(result).toMatchObject({ ok: false });
      expect(await fixture.publications.find({ context, publicationId: receipt.publicationId })).toEqual({ ok: true, value: null });
      expect(await readReceipt()).toEqual({ ok: true, value: null });
    });
    it("thrown failure rolls back both OM inserts", async () => {
      await expect(fixture.unitOfWork.transaction({ work: async ({ session }) => {
        await fixture.publications.append({ context, publication: publication(), session });
        await fixture.receipts.append({ context, receipt, session });
        throw new Error("Injected rollback");
      } })).rejects.toThrow("Injected rollback");
      expect(await fixture.publications.find({ context, publicationId: receipt.publicationId })).toEqual({ ok: true, value: null });
      expect(await readReceipt()).toEqual({ ok: true, value: null });
    });
    it("expired sessions cannot read or append receipts", async () => {
      let expired: SqlSession | undefined;
      await fixture.unitOfWork.transaction({ work: async ({ session }) => { expired = session; } });
      if (!expired) throw new Error("Missing fixture session");
      expect(await fixture.receipts.find({ context, ...receipt, session: expired })).toMatchObject({ ok: false, error: { code: "unavailable" } });
      expect(await fixture.receipts.append({ context, receipt, session: expired })).toMatchObject({ ok: false, error: { code: "unavailable" } });
    });
    it("invalid consent and receipt shapes fail before evidence is stored", async () => {
      const invalid = { ...publication(), consent: publication().consent.map(item => ({ ...item, wordingDigest: "c".repeat(64) })) };
      expect(await append({ publication: invalid })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
      await append();
      expect(await appendReceipt({ receipt: { ...receipt, attemptId: "" } })).toMatchObject({ ok: false });
      expect(await readReceipt()).toEqual({ ok: true, value: null });
    });
  });
}

import { afterEach, expect, it } from "vitest";
import { SafetyRepoPortSuite, ConfirmationExchangePortSuite } from "./port-suites.js";
import { approver, context, createHarness, generationRequest, unwrap, sqliteFixture, timing, spendRequest } from "../fixtures.js";
import { createSqlSafetyRepo, createSqlConfirmationExchange } from "../../index.js";
SafetyRepoPortSuite({ create: () => createHarness({ backend: "sql" }) });
it('balance reads do not insert state, change versions, or append financial journal entries', async () => {
 const harness = createHarness({ backend: 'sql' });
 try {
  unwrap({ outcome: await harness.repo.getGenerationAllowanceView({ context }) });
  expect(harness.sqlite!.db.prepare('SELECT COUNT(*) AS count FROM safety_state').get()).toMatchObject({ count: 0 });
  unwrap({ outcome: await harness.repo.halt({ context, adAccountId: 'account' }) });
  const before = harness.sqlite!.db.prepare('SELECT * FROM safety_state').all();
  const journal = harness.sqlite!.db.prepare('SELECT * FROM safety_journal').all();
  harness.time.setNow({ now: harness.time.clock.now({}) + 3 * 86400000 });
  unwrap({ outcome: await harness.repo.getGenerationAllowanceView({ context }) });
  expect(harness.sqlite!.db.prepare('SELECT * FROM safety_state').all()).toEqual(before);
  expect(harness.sqlite!.db.prepare('SELECT * FROM safety_journal').all()).toEqual(journal);
  harness.sqlite!.db.prepare('UPDATE safety_state SET payload=?').run('{broken');
  expect(await harness.repo.getGenerationAllowanceView({ context })).toMatchObject({ ok: false, error: { code: 'unavailable' } });
 } finally { harness.close(); }
});
it("rolls back state and financial journal together on SQLite append failure", async () => {
 const harness = createHarness({ backend: "sql" });
 harness.sqlite!.setJournalFailure({ fail: true });
 expect(await harness.repo.halt({ context, adAccountId: "account" })).toMatchObject({ ok: false, error: { code: "unavailable" } });
 harness.sqlite!.setJournalFailure({ fail: false });
 expect(await harness.repo.snapshot({ context, accountId: "account" })).toMatchObject({ ok: true, value: { halted: false } });
 expect(harness.sqlite!.db.prepare("SELECT COUNT(*) AS count FROM safety_journal").get()).toMatchObject({ count: 0 });
 harness.close();
});
it("reopening the SQL adapter preserves defaults, setting history and halt", async () => {
 const harness = createHarness({ backend: "sql" });
 unwrap({ outcome: await harness.repo.halt({ context, adAccountId: "account" }) });
 const settings = unwrap({ outcome: await harness.repo.getGenerationAllowance({ context }) });
 unwrap({ outcome: await harness.repo.setGenerationAllowance({ context, settings: { ...settings, amount: { minorUnits: 750, currency: "USD" } } }) });
 const reopened = createSqlSafetyRepo({ ...harness.time, db: harness.sqlite!.port, observer: { observe() {} } });
 expect(await reopened.snapshot({ context, accountId: "account" })).toMatchObject({ ok: true, value: { halted: true } });
 expect(await reopened.getGenerationAllowance({ context })).toMatchObject({ ok: true, value: { amount: { minorUnits: 750 }, revision: 1 } });
 expect(harness.sqlite!.db.prepare("SELECT kind FROM safety_journal ORDER BY sequence").all()).toEqual([{ kind: "account_halted" }, { kind: "allowance_setting_changed" }]);
 harness.close();
});
it("corrupt durable financial state fails closed rather than resetting allowance", async () => {
 const harness = createHarness({ backend: "sql" });
 unwrap({ outcome: await harness.repo.getGenerationAllowance({ context }) });
 harness.sqlite!.db.prepare("UPDATE safety_state SET payload = ?").run('{"settings":{}}');
 expect(await harness.repo.getGenerationAllowance({ context })).toMatchObject({ ok: false, error: { code: "unavailable" } });
 harness.close();
});
it("deduplicates repeated settlement evidence in the append-only financial journal", async () => {
 const harness = createHarness({ backend: "sql" });
 const request = generationRequest().generation;
 const reservation = unwrap({ outcome: await harness.repo.reserveGeneration({ context, ...request, expectedKind: "normal_write", expectedRevision: 0 }) });
 const settlement = { reservationId: reservation.reservationId, observationId: "charge", actual: { minorUnits: 500, currency: "USD" } };
 unwrap({ outcome: await harness.repo.settleGeneration({ context, settlement }) });
 unwrap({ outcome: await harness.repo.settleGeneration({ context, settlement }) });
 expect(harness.sqlite!.db.prepare("SELECT COUNT(*) AS count FROM safety_journal WHERE kind = 'generation_cost_observed'").get()).toMatchObject({ count: 1 });
 harness.close();
});
it("a failed SQL observer still returns a typed boundary error", async () => {
 const harness = createHarness({ backend: "sql" });
 const repo = createSqlSafetyRepo({ ...harness.time, db: harness.sqlite!.port, observer: { observe() { throw new Error("observer unavailable"); } } });
 await expect(repo.getGenerationAllowance({ context })).resolves.toMatchObject({ ok: false, error: { code: "unavailable" } });
 harness.close();
});

const confirmationFixtures: ReturnType<typeof sqliteFixture>[] = [];
const reopeners = new WeakMap<object, () => ReturnType<typeof createSqlConfirmationExchange>>();
afterEach(() => { for (const fixture of confirmationFixtures.splice(0)) fixture.close(); });
ConfirmationExchangePortSuite({
 create(input) {
  const sqlite = sqliteFixture(); confirmationFixtures.push(sqlite);
  const time = timing();
  function open() {
   const port = createSqlConfirmationExchange({ ...time, db: sqlite.port, ...input });
   reopeners.set(port, open); return port;
  }
  return open();
 },
 reopen({ port }) { return reopeners.get(port)!(); },
});
it("SQL confirmation expiry and corrupt storage fail closed after reopening", async () => {
 const sqlite = sqliteFixture(); confirmationFixtures.push(sqlite);
 const time = timing();
 const original = createSqlConfirmationExchange({ ...time, db: sqlite.port, ttlMs: 10 });
 const card = unwrap({ outcome: await original.present({ context, request: spendRequest() }) });
 const reopened = createSqlConfirmationExchange({ ...time, db: sqlite.port });
 time.setNow({ now: time.clock.now({}) + 10 });
 expect(await reopened.list({ context, query: { limit: 100 } })).toEqual({ ok: true, value: { items: [], cursor: null } });
 expect(await reopened.confirm({ context, approver, response: { cardId: card.cardId, operationId: card.operationId, argumentsDigest: card.argumentsDigest, choice: "allow" } })).toMatchObject({ ok: false, error: { code: "expired" } });
 sqlite.db.prepare("UPDATE safety_confirmations SET payload=?").run("{broken");
 expect(await reopened.get({ context, cardId: card.cardId })).toMatchObject({ ok: false, error: { code: "unavailable", retryable: false } });
});

it("persists identity and answer time across reopen and rejects old or malformed identity", async () => {
 const sqlite = sqliteFixture(); confirmationFixtures.push(sqlite);
 const time = timing();
 const port = createSqlConfirmationExchange({ ...time, db: sqlite.port });
 const request = spendRequest();
 const card = unwrap({ outcome: await port.present({ context, request }) });
 const response = { cardId: card.cardId, operationId: card.operationId, argumentsDigest: card.argumentsDigest, choice: "allow" as const };
 unwrap({ outcome: await port.confirm({ context, response, approver }) });
 const stored = JSON.parse((sqlite.db.prepare("SELECT payload FROM safety_confirmations").get() as { payload: string }).payload);
 expect(stored.answer).toEqual({ response, approver, answeredAt: time.clock.now({}) });
 expect(stored.choice).toBeUndefined();
 const reopened = createSqlConfirmationExchange({ ...time, db: sqlite.port });
 const dispatch = { context, request: { ...request, approvalId: card.cardId, policyRevision: 0 }, classification: "spend" as const };
 expect(await reopened.verify(dispatch)).toEqual({ ok: true, value: undefined });
 for (const bad of [{ reference: undefined, code: "unavailable" }, { reference: { kind: "local_token", ownerId: "owner" }, code: "unavailable" }, { reference: { ...approver, ownerId: "other" }, code: "forbidden" }]) {
  sqlite.db.prepare("UPDATE safety_confirmations SET payload=?").run(JSON.stringify({ ...stored, answer: { ...stored.answer, approver: bad.reference } }));
  expect(await reopened.verify(dispatch)).toMatchObject({ ok: false, error: { code: bad.code } });
 }
 const { answer: _answer, ...old } = stored;
 sqlite.db.prepare("UPDATE safety_confirmations SET payload=?").run(JSON.stringify({ ...old, choice: "allow" }));
 expect(await reopened.verify(dispatch)).toMatchObject({ ok: false, error: { code: "unavailable" } });
});

it("rolls answer and append back together on failed Outcomes and thrown audit/update faults", async () => {
 const sqlite = sqliteFixture(); confirmationFixtures.push(sqlite);
 sqlite.db.exec("CREATE TABLE approval_evidence (payload TEXT NOT NULL)");
 const time = timing();
 let fault: "outcome" | "throw" | "none" = "outcome";
 const port = createSqlConfirmationExchange({ ...time, db: sqlite.port, async recordAnswer({ session, answer }) {
  await session.query({ text: "INSERT INTO approval_evidence (payload) VALUES ($1)", values: [JSON.stringify(answer)] });
  if (fault === "throw") throw new Error("fixture audit fault");
  if (fault === "outcome") return { ok: false, error: { code: "unavailable", message: "Audit unavailable", retryable: false } };
  return { ok: true, value: undefined };
 } });
 const card = unwrap({ outcome: await port.present({ context, request: spendRequest() }) });
 const response = { cardId: card.cardId, operationId: card.operationId, argumentsDigest: card.argumentsDigest, choice: "allow" as const };
 for (const mode of ["outcome", "throw"] as const) {
  fault = mode;
  expect(await port.confirm({ context, response, approver })).toMatchObject({ ok: false, error: { code: "unavailable" } });
  expect(sqlite.db.prepare("SELECT status FROM safety_confirmations").get()).toEqual({ status: "pending" });
  expect(sqlite.db.prepare("SELECT COUNT(*) AS count FROM approval_evidence").get()).toEqual({ count: 0 });
 }
 fault = "none";
 sqlite.db.exec("CREATE TRIGGER answer_fault BEFORE UPDATE ON safety_confirmations BEGIN SELECT RAISE(IGNORE); END");
 expect(await port.confirm({ context, response, approver })).toMatchObject({ ok: false, error: { code: "unavailable", message: "Approval answer update failed" } });
 expect(sqlite.db.prepare("SELECT COUNT(*) AS count FROM approval_evidence").get()).toEqual({ count: 0 });
 sqlite.db.exec("DROP TRIGGER answer_fault");
 unwrap({ outcome: await port.confirm({ context, response, approver }) });
 expect(sqlite.db.prepare("SELECT COUNT(*) AS count FROM approval_evidence").get()).toEqual({ count: 1 });
});

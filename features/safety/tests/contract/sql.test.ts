import { afterEach, expect, it } from "vitest";
import { SafetyRepoPortSuite, ConfirmationExchangePortSuite } from "./port-suites.js";
import { context, createHarness, generationRequest, unwrap, sqliteFixture, timing, spendRequest } from "../fixtures.js";
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
 create() {
  const sqlite = sqliteFixture(); confirmationFixtures.push(sqlite);
  const time = timing();
  function open() {
   const port = createSqlConfirmationExchange({ ...time, db: sqlite.port });
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
 expect(await reopened.confirm({ context, response: { cardId: card.cardId, operationId: card.operationId, argumentsDigest: card.argumentsDigest, choice: "allow" } })).toMatchObject({ ok: false, error: { code: "expired" } });
 sqlite.db.prepare("UPDATE safety_confirmations SET payload=?").run("{broken");
 expect(await reopened.get({ context, cardId: card.cardId })).toMatchObject({ ok: false, error: { code: "unavailable", retryable: false } });
});

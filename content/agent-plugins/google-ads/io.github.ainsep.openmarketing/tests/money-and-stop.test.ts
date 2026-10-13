import { test } from "node:test";
import assert from "node:assert/strict";
import { billingExposure, effectFor, localDate, microsToMoney } from "../src/rules.ts";
import { createGooglePlugin } from "../src/plugin.ts";
import { createStopBinding } from "../src/stop.ts";
import { createFixtureDependencies, createFixtureTransport, fixtureBinding, fixtureContext, fixtureTime } from "../src/fixture.ts";
import { plan, value } from "./helpers.ts";
import type { HaltStopRequest } from "@open-marketing/contracts";
import type { Receipt, BillingEvidence, Hierarchy } from "../src/types.ts";

async function hierarchy(): Promise<Hierarchy> {
  const plugin = createGooglePlugin(createFixtureDependencies({}));
  const receipt = value<Receipt>({ outcome: await plugin.invoke({ context: fixtureContext, name: "create_paused", arguments: { operationId: "money-create", plan } }) });
  assert.ok(receipt.hierarchy);
  return receipt.hierarchy;
}
const evidence: BillingEvidence = { evidenceId: "money-evidence", observedAt: fixtureTime, localDate: localDate({ epoch: fixtureTime, timezone: fixtureBinding.timezone }), historyComplete: true, highestBudgetTodayMicros: "50000000", monthToDateBilledMicros: "270000000", remainingDaysIncludingToday: 5, productionVerified: false };
test("same-day 10 -> 50 -> 5 budget retains $100 daily billed bound", async () => {
  const result = value<{ dailyMicros: string; unchangedMonthlyMicros: string; changedMonthlyMicros: string }>({ outcome: billingExposure({ hierarchy: await hierarchy(), evidence, candidateMicros: "5000000", now: fixtureTime }) });
  assert.equal(result.dailyMicros, "100000000");
  assert.equal(result.unchangedMonthlyMicros, "152000000");
  assert.equal(result.changedMonthlyMicros, "295000000");
});
test("missing/stale/day-mismatched history and unverified production controls fail closed", async () => {
  const state = await hierarchy();
  for (const invalid of [{ ...evidence, historyComplete: false }, { ...evidence, observedAt: fixtureTime - 30001 }, { ...evidence, localDate: "2026-10-11" }]) {
    assert.equal(billingExposure({ hierarchy: state, evidence: invalid, candidateMicros: "5000000", now: fixtureTime }).ok, false);
  }
  const effect = effectFor({ binding: { ...fixtureBinding, mode: "production" }, call: { name: "activate", arguments: { operationId: "activate-money", campaignId: "201" } }, hierarchy: state, evidence, now: fixtureTime });
  assert.equal(effect.ok, false);
});
test("money rounds upward in currency units and rejects overflow", () => {
  assert.deepEqual(microsToMoney({ micros: "10001", currency: "USD" }), { ok: true, value: { minorUnits: 2, currency: "USD" } });
  assert.deepEqual(microsToMoney({ micros: "1000001", currency: "JPY" }), { ok: true, value: { minorUnits: 2, currency: "JPY" } });
  assert.equal(microsToMoney({ micros: "99999999999999999999999", currency: "USD" }).ok, false);
});
const stopRequest: HaltStopRequest = { operationId: "halt-stop-1", scope: fixtureBinding.scope, connectionId: fixtureBinding.connectionId, adAccountId: fixtureBinding.customerId, entityIds: ["201"], action: "pause", haltId: "halt-1", haltEpoch: 1, pluginDigest: fixtureBinding.pluginDigest, bindingId: "google-ads.stop.v1", argumentsDigest: "c".repeat(64) };
test("stop-only binding emits only PAUSED campaign status updates", async () => {
  const requests: Record<string, unknown>[] = [];
  const stop = createStopBinding({ binding: fixtureBinding, authority: { async dispatchStop(input) { assert.deepEqual(input.effect.effects, ["halt_stop"]); return input.execute(); } }, transport: { async request(input) {
    requests.push(input.body);
    if (input.method === "search") return { ok: true, value: { results: [{ campaign: { id: "201", status: "PAUSED" } }] } };
    return { ok: true, value: { mutateOperationResponses: [{}] } };
  } } });
  assert.deepEqual(await stop.stop({ context: fixtureContext, request: stopRequest }), { ok: true, value: { status: "stopped" } });
  assert.deepEqual(requests[0], { mutateOperations: [{ campaignOperation: { update: { resourceName: "customers/1234567890/campaigns/201", status: "PAUSED" }, updateMask: "status" } }], partialFailure: false, validateOnly: false });
});
test("stop rejects activation/budget/duplicate/foreign-account payloads before authority", async () => {
  let dispatches = 0;
  const stop = createStopBinding({ binding: fixtureBinding, transport: createFixtureTransport({}).transport, authority: { async dispatchStop(input) { dispatches += 1; return input.execute(); } } });
  for (const request of [{ ...stopRequest, action: "activate" }, { ...stopRequest, averageDailyBudgetMicros: "999" }, { ...stopRequest, entityIds: ["201", "201"] }, { ...stopRequest, adAccountId: "9999999999" }]) {
    assert.equal((await stop.stop({ context: fixtureContext, request: request as HaltStopRequest })).ok, false);
  }
  assert.equal(dispatches, 0);
});

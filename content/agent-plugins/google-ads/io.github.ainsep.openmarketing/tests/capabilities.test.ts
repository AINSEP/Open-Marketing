import { test } from "node:test";
import assert from "node:assert/strict";
import { createGooglePlugin } from "../src/plugin.ts";
import { createFixtureDependencies, createFixtureTransport, fixtureContext } from "../src/fixture.ts";
import { memoryHarness, plan, restHarness, stdioHarness, value } from "./helpers.ts";
import type { Harness } from "./helpers.ts";
import type { Hierarchy, Receipt } from "../src/types.ts";

/** ONE shared capability suite across the double, real REST codec and real local MCP. */
function capabilitySuite(required: { label: string; create: () => Promise<Harness> }): void {
  test(required.label + " shared lifecycle/scoping suite", { timeout: 15000 }, async () => {
    const harness = await required.create();
    try {
      const created = await harness.plugin.invoke({ context: fixtureContext, name: "create_paused", arguments: { operationId: "create-1", plan } });
      const receipt = value<Receipt>({ outcome: created });
      assert.equal(receipt.status, "acknowledged");
      assert.equal(receipt.hierarchy?.status, "PAUSED");
      assert.deepEqual(receipt.hierarchy?.childStatuses, ["PAUSED", "PAUSED", "PAUSED"]);
      const duplicate = await harness.plugin.invoke({ context: fixtureContext, name: "create_paused", arguments: { operationId: "create-1", plan } });
      assert.deepEqual(duplicate, created);
      const conflict = await harness.plugin.invoke({ context: fixtureContext, name: "create_paused", arguments: { operationId: "create-1", plan: { ...plan, name: "Changed exact intent" } } });
      assert.equal(conflict.ok, false);
      const active = value<Receipt>({ outcome: await harness.plugin.invoke({ context: fixtureContext, name: "activate", arguments: { operationId: "activate-1", campaignId: "201" } }) });
      assert.equal(active.hierarchy?.status, "ENABLED");
      assert.deepEqual(active.hierarchy?.childStatuses, ["ENABLED", "ENABLED", "ENABLED"]);
      const budget = value<Receipt>({ outcome: await harness.plugin.invoke({ context: fixtureContext, name: "set_budget", arguments: { operationId: "budget-1", campaignId: "201", averageDailyBudgetMicros: "5000000" } }) });
      assert.equal(budget.hierarchy?.averageDailyBudgetMicros, "5000000");
      const paused = value<Receipt>({ outcome: await harness.plugin.invoke({ context: fixtureContext, name: "pause", arguments: { operationId: "pause-1", campaignId: "201" } }) });
      assert.equal(paused.hierarchy?.status, "PAUSED");
      const read = value<Hierarchy>({ outcome: await harness.plugin.invoke({ context: fixtureContext, name: "read_campaign", arguments: { operationId: "read-1", campaignId: "201" } }) });
      assert.equal(read.campaignId, "201");
      assert.equal(read.sharedBudget, false);
      const foreign = await harness.plugin.invoke({ context: { ...fixtureContext, scope: { ...fixtureContext.scope, workspaceId: "foreign" } }, name: "list_accounts", arguments: { operationId: "foreign-1" } });
      assert.equal(foreign.ok, false);
      const arbitrary = await harness.plugin.invoke({ context: fixtureContext, name: "mutate", arguments: { operationId: "bad-1" } });
      assert.equal(arbitrary.ok, false);
      const expanded = await harness.plugin.invoke({ context: fixtureContext, name: "pause", arguments: { operationId: "bad-2", campaignId: "201", budget: "999" } });
      assert.equal(expanded.ok, false);
      const report = value<{ costSemantics: string; items: { costMicros: string }[] }>({ outcome: await harness.plugin.invoke({ context: fixtureContext, name: "report", arguments: { operationId: "report-1", startDate: "2026-10-10", endDate: "2026-10-12" } }) });
      assert.equal(report.costSemantics, "served_cost_not_billed_cost");
      assert.equal(report.items[0].costMicros, "1234000");
    } finally { await harness.close(); }
  });
}
capabilitySuite({ label: "memory", create: memoryHarness });
capabilitySuite({ label: "real REST adapter/local fixtures", create: restHarness });
capabilitySuite({ label: "real stdio/local MCP adapter", create: stdioHarness });

for (const fault of ["timeout_before", "timeout_after", "partial"] as const) {
  test("stable operation reconciliation: " + fault, async () => {
    const fixture = createFixtureTransport({ fault });
    const plugin = createGooglePlugin(createFixtureDependencies({ transport: fixture.transport }));
    const args = { context: fixtureContext, name: "create_paused", arguments: { operationId: "uncertain-1", plan } };
    const first = value<Receipt>({ outcome: await plugin.invoke(args) });
    assert.equal(first.status, "unknown");
    await plugin.invoke(args);
    assert.equal(fixture.writes(), 1);
    const reconciled = value<Receipt>({ outcome: await plugin.invoke({ context: fixtureContext, name: "reconcile", arguments: { operationId: "uncertain-1" } }) });
    assert.equal(reconciled.status, fault === "timeout_after" ? "acknowledged" : "unknown");
    assert.equal(fixture.writes(), 1);
  });
}
test("concurrent duplicates produce exactly one mutation", async () => {
  const fixture = createFixtureTransport({});
  const plugin = createGooglePlugin(createFixtureDependencies({ transport: fixture.transport }));
  const args = { context: fixtureContext, name: "create_paused", arguments: { operationId: "concurrent-1", plan } };
  const outcomes = await Promise.all([plugin.invoke(args), plugin.invoke(args)]);
  assert.equal(fixture.writes(), 1);
  assert.ok(outcomes.every(outcome => outcome.ok));
});
test("sandbox rejects a production account readback before mutation", async () => {
  const fixture = createFixtureTransport({});
  const plugin = createGooglePlugin(createFixtureDependencies({ transport: { async request(input) {
    const result = await fixture.transport.request(input);
    if (input.method === "search" && String(input.body.query).endsWith("FROM customer")) return { ok: true, value: { results: [{ customer: { id: "1234567890", currencyCode: "USD", timeZone: "America/Los_Angeles", testAccount: false } }] } };
    return result;
  } } }));
  const result = await plugin.invoke({ context: fixtureContext, name: "create_paused", arguments: { operationId: "sandbox-1", plan } });
  assert.equal(result.ok, false);
  assert.equal(fixture.writes(), 0);
});

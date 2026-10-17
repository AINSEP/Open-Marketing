import { test } from "node:test";
import assert from "node:assert/strict";
import { createGooglePlugin } from "../src/index.ts";
import { createFixtureDependencies, createFixtureTransport, fixtureContext } from "../src/fixture.ts";
import { createMemoryJournal } from "../src/memory.ts";
import { failure, success } from "../src/schema.ts";
import { plan, value } from "./helpers.ts";
import type { Receipt } from "../src/index.ts";
const references = ["campaignBudgets/101", "campaigns/201", "adGroups/301", "campaignCriteria/201~2840", "adGroupCriteria/301~501", "adGroupAds/301~401"].map(path => "customers/1234567890/" + path);
test("mutation references append before failed readback; reconcile and restart never replay creation", async () => {
  const fixture = createFixtureTransport({}); const journal = createMemoryJournal({ maxRecords: 100 }); let mutated = false; let failRead = true;
  const dependencies = createFixtureDependencies({ transport: { async request(input) {
    if (mutated && input.method === "search" && failRead) { assert.deepEqual(journal.records()[0].receipt.references, references); return failure({ code: "unavailable", message: "fixture read failure" }); }
    const response = await fixture.transport.request(input);
    if (input.method !== "mutate") return response;
    assert.equal(input.body.partialFailure, false); mutated = true;
    return success({ value: { mutateOperationResponses: references.map((resourceName, index) => ({ [["campaignBudgetResult", "campaignResult", "adGroupResult", "campaignCriterionResult", "adGroupCriterionResult", "adGroupAdResult"][index]]: { resourceName } })) } });
  } } }); dependencies.journal = journal;
  const request = { context: fixtureContext, name: "create_paused", arguments: { operationId: "launch", plan } };
  const first = value<Receipt>({ outcome: await createGooglePlugin(dependencies).invoke(request) }); assert.equal(first.status, "unknown"); assert.deepEqual(first.references, references);
  await createGooglePlugin(dependencies).invoke(request); assert.equal(fixture.writes(), 1); failRead = false;
  const reconciled = value<Receipt>({ outcome: await createGooglePlugin(dependencies).invoke({ context: fixtureContext, name: "reconcile", arguments: { operationId: "launch" } }) });
  assert.equal(reconciled.status, "acknowledged"); assert.deepEqual(reconciled.references, references); assert.equal(fixture.writes(), 1);
});
for (const checkpoint of ["failure", "throw", "final-throw"] as const) {
test(`${checkpoint} acknowledgement checkpoint preserves references and stops execution`, async () => {
  const fixture = createFixtureTransport({}); const journal = createMemoryJournal({ maxRecords: 100 }); let mutated = false; let readsAfter = 0;
  let appends = 0;
  const dependencies = createFixtureDependencies({ transport: { async request(input) {
    if (mutated && input.method === "search") readsAfter++;
    const response = await fixture.transport.request(input); if (input.method !== "mutate") return response; mutated = true;
    return success({ value: { mutateOperationResponses: references.map((resourceName, index) => ({ [["campaignBudgetResult", "campaignResult", "adGroupResult", "campaignCriterionResult", "adGroupCriterionResult", "adGroupAdResult"][index]]: { resourceName } })) } });
  } } }); dependencies.journal = { ...journal, async append(input) {
    appends++;
    if (checkpoint === "final-throw" && appends === 1) return journal.append(input);
    if (checkpoint !== "failure") throw new Error("opaque journal failure");
    return failure({ code: "unavailable", message: "fixture journal failure" });
  } };
  const receipt = value<Receipt>({ outcome: await createGooglePlugin(dependencies).invoke({ context: fixtureContext, name: "create_paused", arguments: { operationId: "launch", plan } }) });
  assert.equal(receipt.status, "unknown"); assert.deepEqual(receipt.references, references); assert.equal(fixture.writes(), 1);
  assert.equal(readsAfter > 0, checkpoint === "final-throw"); assert.equal(appends, checkpoint === "final-throw" ? 2 : 1);
  assert.ok(!JSON.stringify(receipt).includes("opaque journal failure"));
  await createGooglePlugin(dependencies).invoke({ context: fixtureContext, name: "create_paused", arguments: { operationId: "launch", plan } });
  assert.equal(fixture.writes(), 1);
});
}
test("malformed ACK preserves only valid scoped references and cannot claim completion", async () => {
  const fixture = createFixtureTransport({});
  const dependencies = createFixtureDependencies({ transport: { async request(input) {
    if (input.method === "search") return fixture.transport.request(input);
    return success({ value: { mutateOperationResponses: [{ campaignResult: { resourceName: references[1] } }, { campaignResult: { resourceName: "customers/9999999999/campaigns/9" } }, { campaignResult: { resourceName: "not-a-resource" } }] } });
  } } });
  const result = value<Receipt>({ outcome: await createGooglePlugin(dependencies).invoke({ context: fixtureContext, name: "create_paused", arguments: { operationId: "bad-ack", plan } }) });
  assert.equal(result.status, "unknown"); assert.deepEqual(result.references, [references[1]]);
});

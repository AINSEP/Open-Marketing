import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createGooglePlugin } from "../src/plugin.ts";
import { createFixtureDependencies, fixtureBinding, fixtureContext } from "../src/fixture.ts";
import { tools } from "../src/index.ts";
import { createHttpAdapter, createGoogleRestTransport } from "../src/transport.ts";
import { success } from "../src/schema.ts";
import { createMemoryJournal } from "../src/memory.ts";
import { plan, value } from "./helpers.ts";
import type { OperationRecord, Receipt } from "../src/types.ts";
import { capabilityEnvelopeSchema } from "@open-marketing/contracts";

test("host manifest retains disabled admission and valid capability envelopes", async () => {
  const manifest = JSON.parse(await readFile(new URL("../../plugin.json", import.meta.url), "utf8"));
  const extension = manifest.extensions["io.github.ainsep.openmarketing"];
  assert.equal(extension.enabled, false);
  assert.equal(extension.admitted, false);
  assert.equal(extension.servers["google-ads"].authMode, "host");
  assert.ok(Array.isArray(extension.capabilities));
  for (const envelope of extension.capabilities) {
    assert.equal(capabilityEnvelopeSchema.safeParse({ ...envelope, pluginDigest: "a".repeat(64) }).success, true);
    assert.equal(envelope.pluginId, "google-ads");
    assert.equal(envelope.admitted, false);
  }
});
test("tool catalogue excludes conversions, arbitrary HTTP/mutate, shell and backend halt permits", () => {
  const names = tools.map(tool => tool.name);
  for (const name of ["upload_conversions", "http", "mutate", "shell", "halt_stop"]) assert.equal(names.includes(name), false);
  assert.equal(names.length, 11);
  const expectedEffects = {
    list_accounts: ["read"], read_campaign: ["read"], read_budget: ["read"], report: ["read"],
    create_paused: ["write"], activate: ["write", "ad_spend"], set_budget: ["write", "ad_spend"],
    pause: ["write"], reconcile: ["read"],
    search_terms_report: ["read"], add_negative_keyword: ["write", "destructive"],
  };
  assert.deepEqual(tools.map(tool => tool.name).sort(), Object.keys(expectedEffects).sort());
  const unavailable = ["create_paused", "activate", "set_budget", "pause", "reconcile"];
  for (const tool of tools) {
    assert.deepEqual(tool.effects, expectedEffects[tool.name as keyof typeof expectedEffects]);
    assert.equal(tool.unavailableReason, unavailable.includes(tool.name) ? "NEEDS: Google durable controlled-plan journal and verified billing evidence" : undefined);
    assert.equal(Object.hasOwn(tool.inputSchema.properties as Record<string, unknown>, "operationId"), false);
  }
});
test("real REST authentication is server-contained and omits developer-token", async () => {
  let captured: { url: string; headers: Record<string, string>; body: string } | undefined;
  const transport = createGoogleRestTransport({ binding: fixtureBinding,
    credentials: { async access() { return success({ value: { accessToken: "fixture-token-never-real", loginCustomerId: "1111111111" } }); } },
    http: { async post(input) { captured = input; return success({ value: { status: 200, body: { results: [] } } }); } },
  });
  const result = await transport.request({ method: "search", body: { query: "SELECT customer.id FROM customer" }, context: fixtureContext, operationId: "auth-1" });
  assert.ok(result.ok);
  assert.equal(captured?.headers.Authorization, "Bearer fixture-token-never-real");
  assert.equal(captured?.headers["login-customer-id"], "1111111111");
  assert.equal(captured?.headers["developer-token"], undefined);
  assert.equal(JSON.stringify(result).includes("fixture-token"), false);
});
test("HTTP rejects oversized output, redirects and non-Google destinations", async () => {
  const observed: string[] = [];
  const http = createHttpAdapter({ fetch: async (_url, init) => {
    assert.equal(init?.redirect, "error");
    return new Response("x".repeat(2000));
  }, observer: { observe(input) { observed.push(input.outcome); } } });
  const input = { url: "https://googleads.googleapis.com/v26/customers/1234567890/googleAds:search", headers: {}, body: "{}", timeoutMs: 1000, maxBytes: 100, context: fixtureContext, operationId: "http-1" };
  const oversized = await http.post(input);
  assert.equal(oversized.ok, false);
  assert.deepEqual(observed, ["limit_exceeded"]);
  assert.equal((await http.post({ ...input, url: "https://example.test" })).ok, false);
});
test("REST and HTTP agree on v26 search/mutate and retain Data Manager v1", async () => {
  const calls: { url: string; method?: string }[] = [];
  const transport = createGoogleRestTransport({ binding: fixtureBinding,
    credentials: { async access() { return success({ value: { accessToken: "fixture-token", scopes: ["https://www.googleapis.com/auth/datamanager"], cloudProjectId: "fixture-project" } }); } },
    http: createHttpAdapter({ fetch: async (url, init) => { calls.push({ url: String(url), method: init?.method }); return Response.json({ results: [] }); }, observer: { observe() {} } }),
  });
  const input = { context: fixtureContext, operationId: "v26-routing", body: {} };
  assert.ok((await transport.request({ ...input, method: "search" })).ok);
  assert.ok((await transport.request({ ...input, method: "mutate" })).ok);
  assert.ok((await transport.request({ ...input, method: "ingest", cloudProjectId: "fixture-project" })).ok);
  assert.ok((await transport.request({ ...input, method: "request_status", cloudProjectId: "fixture-project", body: { requestId: "receipt-1" } })).ok);
  assert.deepEqual(calls, [
    { url: "https://googleads.googleapis.com/v26/customers/" + fixtureBinding.customerId + "/googleAds:search", method: "POST" },
    { url: "https://googleads.googleapis.com/v26/customers/" + fixtureBinding.customerId + "/googleAds:mutate", method: "POST" },
    { url: "https://datamanager.googleapis.com/v1/events:ingest", method: "POST" },
    { url: "https://datamanager.googleapis.com/v1/requestStatus:retrieve?requestId=receipt-1", method: "GET" },
  ]);
});
test("HTTP rejects obsolete Ads versions and wrong methods before network access", async () => {
  let calls = 0;
  const http = createHttpAdapter({ fetch: async () => { calls++; return Response.json({}); }, observer: { observe() {} } });
  const input = { headers: {}, timeoutMs: 1000, maxBytes: 1024, context: fixtureContext, operationId: "version-denied" };
  for (const method of ["search", "mutate"]) {
    const url = "https://googleads.googleapis.com/v25/customers/1234567890/googleAds:" + method;
    assert.deepEqual(await http.post({ ...input, url, body: "{}" }), { ok: false, error: { code: "forbidden", message: "HTTP destination is outside Google plugin scope", retryable: false } });
  }
  assert.equal((await http.get!({ ...input, url: "https://googleads.googleapis.com/v26/customers/1234567890/googleAds:search" })).ok, false);
  assert.equal(calls, 0);
});
test("journal evidence appends, isolates same customer across scopes, and disposes", async () => {
  const journal = createMemoryJournal({ maxRecords: 10 });
  const dependencies = createFixtureDependencies({});
  const plugin = createGooglePlugin({ ...dependencies, journal });
  const receipt = value<Receipt>({ outcome: await plugin.invoke({ context: fixtureContext, name: "create_paused", arguments: { operationId: "journal-1", plan } }) });
  assert.equal(receipt.status, "acknowledged");
  assert.equal(journal.history().length, 3);
  assert.equal(journal.history()[0].receipt.status, "unknown");
  const foreign = await journal.findCampaign({ binding: { ...fixtureBinding, scope: { ...fixtureBinding.scope, ownerId: "foreign-owner" } }, campaignId: "201" });
  assert.deepEqual(foreign, { ok: true, value: null });
  const stored = journal.records()[0];
  stored.digest = "changed";
  assert.notEqual(journal.records()[0].digest, "changed");
  journal.dispose();
  assert.equal((await journal.claim({ record: stored as OperationRecord })).ok, false);
});
test("optional developer token is call-time Google Ads configuration and never reaches Data Manager", async () => {
  const headers: Record<string, string>[] = [];
  const transport = createGoogleRestTransport({ binding: fixtureBinding,
    credentials: { async access() { return success({ value: { accessToken: "fixture-oauth", developerToken: "abcdefghijklmnopqrstuv", loginCustomerId: "1111111111", scopes: ["https://www.googleapis.com/auth/datamanager"], cloudProjectId: "fixture-project" } }); } },
    http: { async post(input) { headers.push(input.headers); return success({ value: { status: 200, body: {} } }); }, async get() { return success({ value: { status: 200, body: {} } }); } },
  });
  const request = { body: {}, context: fixtureContext, operationId: "optional-config" };
  assert.ok((await transport.request({ ...request, method: "mutate" })).ok);
  assert.ok((await transport.request({ ...request, method: "ingest", cloudProjectId: "fixture-project" })).ok);
  assert.equal(headers[0]["developer-token"], "abcdefghijklmnopqrstuv"); assert.equal(headers[0]["login-customer-id"], "1111111111");
  assert.equal(headers[1]["developer-token"], undefined); assert.equal(headers[1]["login-customer-id"], undefined);
});

test("REST transport needs only scope, connection and selected customer identity", async () => {
  const binding = { scope: fixtureBinding.scope, connectionId: fixtureBinding.connectionId, customerId: fixtureBinding.customerId };
  let accesses = 0;
  const transport = createGoogleRestTransport({ binding, credentials: { async access(input) { accesses++; assert.deepEqual(input.binding, binding); return success({ value: { accessToken: "fixture" } }); } },
    http: { async post(input) { assert.match(input.url, /\/v26\/customers\/1234567890\/googleAds:search$/); return success({ value: { status: 200, body: {} } }); } },
  });
  assert.ok((await transport.request({ context: fixtureContext, operationId: "narrow-read", method: "search", body: { query: "SELECT customer.id FROM customer" } })).ok);
  assert.equal(accesses, 1);
});
test("inline canonical declarations have no orphaned binding files; tracked backend bindings remain", async () => {
  for (const name of ["report.metrics.v1", "campaign.status.v1", "tracking.tag.v1"]) {
    await assert.rejects(readFile(new URL(`../bindings/${name}.json`, import.meta.url)), { code: "ENOENT" });
  }
  for (const name of ["search.v1", "reporting.v1", "stop.v1", "conversions.v1"]) await readFile(new URL(`../bindings/${name}.json`, import.meta.url));
});

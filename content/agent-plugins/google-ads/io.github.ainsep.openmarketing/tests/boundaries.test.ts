import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { createGooglePlugin } from "../src/plugin.ts";
import { createFixtureDependencies, fixtureBinding, fixtureContext } from "../src/fixture.ts";
import { createMcpSession, createLocalMcpAdapter, serveStdio, tools } from "../src/mcp.ts";
import { createHttpAdapter, createGoogleRestTransport } from "../src/transport.ts";
import { success } from "../src/schema.ts";
import { createMemoryJournal } from "../src/memory.ts";
import { plan, value } from "./helpers.ts";
import type { OperationRecord, Receipt } from "../src/types.ts";

test("portable mcp entries contain transport fields only; namespace holds host metadata", async () => {
  const mcp = JSON.parse(await readFile(new URL("../../mcp.json", import.meta.url), "utf8"));
  const manifest = JSON.parse(await readFile(new URL("../../plugin.json", import.meta.url), "utf8"));
  assert.deepEqual(Object.keys(mcp.mcpServers["google-ads"]).sort(), ["args", "command", "cwd", "type"]);
  assert.equal(mcp.mcpServers["google-ads"].command, "node");
  assert.equal((mcp.mcpServers["google-ads"].args as string[]).some(arg => arg.includes("npx")), false);
  const extension = manifest.extensions["io.github.ainsep.openmarketing"];
  assert.equal(extension.enabled, false);
  assert.equal(extension.admitted, false);
  assert.equal(extension.servers["google-ads"].authMode, "host");
  for (const entry of Object.values(extension.capabilities) as { binding: string }[]) {
    const envelope = JSON.parse(await readFile(new URL("../../" + entry.binding, import.meta.url), "utf8"));
    assert.equal(envelope.pluginId, "google-ads");
    assert.equal(envelope.admitted, false);
  }
});
test("tool catalogue excludes conversions, arbitrary HTTP/mutate, shell and backend halt permits", () => {
  const names = (tools({}) as { name: string }[]).map(tool => tool.name);
  for (const name of ["upload_conversions", "http", "mutate", "shell", "halt_stop"]) assert.equal(names.includes(name), false);
  assert.equal(names.length, 9);
});
test("negative portable fixture places forbidden metadata in a closed stdio entry", async () => {
  const fixture = JSON.parse(await readFile(new URL("../fixtures/invalid-mcp-extra-field.json", import.meta.url), "utf8"));
  const allowed = new Set(["type", "command", "args", "env", "cwd"]);
  const unknown = Object.keys(fixture.mcpServers["google-ads"]).filter(key => !allowed.has(key));
  assert.deepEqual(unknown, ["authMode"]);
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
test("stdio initialization, malformed JSON and frame bounds are explicit", async () => {
  const session = createMcpSession({ plugin: createGooglePlugin(createFixtureDependencies({})), context: fixtureContext });
  const beforeInit = await session.handle({ input: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
  assert.ok(beforeInit?.error);
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const chunks: Buffer[] = [];
  stdout.on("data", chunk => chunks.push(chunk));
  stdin.end("malformed-json\n");
  const result = await serveStdio({ stdin, stdout, session });
  assert.ok(result.ok);
  assert.equal(JSON.parse(Buffer.concat(chunks).toString()).error.code, -32700);
  const excessive = new PassThrough();
  excessive.end("x".repeat(262145));
  assert.equal((await serveStdio({ stdin: excessive, stdout: new PassThrough(), session })).ok, false);
});
test("MCP client rejects malformed successful provider projections", async () => {
  const adapter = createLocalMcpAdapter({ context: fixtureContext, client: { async call() {
    return success({ value: { content: [{ type: "text", text: JSON.stringify({ ok: true, value: { active: true, credential: "secret" } }) }] } });
  } } });
  const result = await adapter.invoke({ context: fixtureContext, name: "read_campaign", arguments: { operationId: "taint-1", campaignId: "201" } });
  assert.equal(result.ok, false);
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

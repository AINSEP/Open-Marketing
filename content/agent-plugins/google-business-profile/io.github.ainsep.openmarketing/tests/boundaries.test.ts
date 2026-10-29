import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { PassThrough } from "node:stream";
import { createReadTools, runCli } from "../src/main.ts";
import { createGoogleBusinessProfilePlugin } from "../src/plugin.ts";
import { failure } from "../src/transport.ts";
import { binding, context, days, fixture } from "./fixtures.ts";

test("portable manifests declare backend publishing while stdio tools remain read-only", async () => {
  const root = new URL("../../", import.meta.url);
  const manifest = JSON.parse(await readFile(new URL("plugin.json", root), "utf8"));
  const mcp = JSON.parse(await readFile(new URL("mcp.json", root), "utf8"));
  const oauth = JSON.parse(await readFile(new URL("io.github.ainsep.openmarketing/oauth.json", root), "utf8"));
  const capabilities = JSON.parse(await readFile(new URL("io.github.ainsep.openmarketing/capabilities.json", root), "utf8"));
  const extension = manifest.extensions["io.github.ainsep.openmarketing"];
  assert.match(manifest.$schema, /1\.0\.0/); assert.equal(extension.admitted, false); assert.equal(extension.enabled, false);
  assert.equal(extension.servers["google-business-profile"].authMode, "host");
  assert.deepEqual(Object.keys(mcp.mcpServers["google-business-profile"]).sort(), ["args", "command", "cwd", "type"]);
  assert.equal(mcp.mcpServers["google-business-profile"].command, "node");
  assert.equal(oauth.provider.providerId, manifest.name); assert.deepEqual(oauth.provider.defaultScopes, ["https://www.googleapis.com/auth/business.manage"]);
  assert.equal(oauth.provider.usesPkce, true); assert.equal(oauth.extraAuthorizationParams.access_type, "offline");
  assert.equal(capabilities.admitted, false);
  assert.ok(Array.isArray(extension.capabilities));
  assert.deepEqual(extension.capabilities, capabilities.capabilities);
  assert.equal(extension.capabilities.length, 1);
  assert.equal(extension.capabilities[0].capabilityId, "organic.publish.v1");
  assert.deepEqual(extension.capabilities[0].effects, ["write"]);
  assert.equal(extension.capabilities[0].admitted, false);
  const source = await readFile(new URL("io.github.ainsep.openmarketing/src/posts.ts", root));
  assert.equal(extension.capabilities[0].schemaFingerprint, createHash("sha256").update(source).digest("hex"));
  const setup = fixture({}); const tools = createReadTools({ plugin: setup.plugin, context });
  assert.deepEqual(tools.map(tool => tool.name), ["list_locations", "read_performance"]);
  const list = await tools[0].handler({ args: {}, ctx: { baseUrl: "https://unused.invalid", fetchImpl: setup.dependencies.fetch } }); assert.ok(list);
  assert.equal("publishOrganic" in setup.plugin, false);
});
test("fixed Google GET endpoints, one page, sanitized observations and no token in results", async () => {
  const setup = fixture({}); const result = await setup.plugin.listLocations({ context, pageToken: "https://evil.test/?x=1" }); assert.ok(result.ok);
  const { url, init } = setup.calls[0]; assert.equal(setup.calls.length, 1);
  assert.equal(url.origin, "https://mybusinessbusinessinformation.googleapis.com"); assert.equal(url.pathname, "/v1/accounts/100/locations");
  assert.equal(url.searchParams.get("readMask"), "name,title"); assert.equal(url.searchParams.get("pageSize"), "100"); assert.equal(url.searchParams.get("pageToken"), "https://evil.test/?x=1");
  assert.equal(init?.method, "GET"); assert.equal(init?.redirect, "error"); assert.equal(init?.body, undefined);
  assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer fixture-token-never-real"); assert.equal(JSON.stringify(result).includes("fixture-token"), false);
  assert.deepEqual(setup.observations, [{ operation: "google-business-profile.locations", outcome: "ok", correlationId: "correlation", traceId: "trace", runId: "run" }]);
  await setup.plugin.readPerformance({ context, days }); assert.equal(setup.calls[1].url.origin, "https://businessprofileperformance.googleapis.com");
});
test("invalid bindings, scope, extra input and oversized pages/tokens cannot widen egress", async () => {
  const setup = fixture({ binding: { ...binding, accountName: "accounts/100/../../evil" } }); assert.equal((await setup.plugin.listLocations({ context })).ok, false); assert.equal(setup.accesses.length, 0);
  const valid = fixture({});
  for (const input of [{ context: { ...context, scope: { ...context.scope, workspaceId: "other" } } }, { context, pageToken: "x".repeat(2049) }, { context, url: "https://evil.test" }]) assert.equal((await valid.plugin.listLocations(input)).ok, false);
  assert.equal(valid.calls.length, 0); assert.equal(valid.accesses.length, 0);
  for (const size of [100, 101]) {
    const page = fixture({ fetch: async () => Response.json({ locations: Array.from({ length: size }, () => ({ name: "locations/200", title: "Business" })) }) });
    assert.equal((await page.plugin.listLocations({ context })).ok, size === 100);
  }
});
test("credentials, HTTP errors, redirects, malformed JSON and body bounds return sanitized typed failures", async () => {
  const disconnected = fixture({ credentials: { async access() { return failure({ code: "unauthenticated", message: "SECRET" }); } } });
  const missing = await disconnected.plugin.listLocations({ context }); assert.ok(!missing.ok); assert.equal(missing.error.code, "unauthenticated"); assert.equal(JSON.stringify(missing).includes("SECRET"), false); assert.equal(disconnected.calls.length, 0);
  for (const [status, code] of [[401, "unauthenticated"], [403, "forbidden"], [302, "forbidden"], [429, "unavailable"], [500, "unavailable"]] as const) {
    const setup = fixture({ fetch: async () => new Response("SECRET", { status }) }); const result = await setup.plugin.listLocations({ context }); assert.ok(!result.ok); assert.equal(result.error.code, code); assert.equal(JSON.stringify(result).includes("SECRET"), false); assert.equal(setup.calls.length, 1);
  }
  for (const body of ["invalid-json", "x".repeat(1048577)]) { const result = await fixture({ fetch: async () => new Response(body) }).plugin.listLocations({ context }); assert.ok(!result.ok); assert.equal(result.error.code, body.length > 1048576 ? "limit_exceeded" : "unavailable"); }
  const thrown = await fixture({ fetch: async () => { throw new Error("Bearer SECRET"); } }).plugin.listLocations({ context }); assert.ok(!thrown.ok); assert.equal(thrown.error.code, "unavailable"); assert.equal(JSON.stringify(thrown).includes("SECRET"), false);
  const invalidToken = fixture({ credentials: { async access() { return { ok: true, value: { accessToken: "Bearer\r\nSECRET" } }; } } });
  assert.equal((await invalidToken.plugin.listLocations({ context })).ok, false); assert.equal(invalidToken.calls.length, 0);
});
test("15-second deadline and caller cancellation are forwarded without retries", async () => {
  const expired = new AbortController();
  const setup = fixture({ deadline: { signal(input) { assert.equal(input.timeoutMs, 15000); return expired.signal; } }, fetch: async (_url, init) => { expired.abort(); init?.signal?.throwIfAborted(); return Response.json({}); } });
  const result = await setup.plugin.listLocations({ context }); assert.ok(!result.ok); assert.equal(result.error.code, "expired"); assert.equal(setup.calls.length, 1);
  const cancelled = new AbortController(); cancelled.abort(); const other = fixture({});
  const stopped = await other.plugin.readPerformance({ context, days }, { signal: cancelled.signal }); assert.ok(!stopped.ok); assert.equal(stopped.error.code, "cancelled"); assert.equal(other.calls.length, 0); assert.equal(other.accesses.length, 0);
});
test("deadline cancels a stalled response body and releases it", async () => {
  const deadline = new AbortController(); let cancelled = false; let pulls = 0;
  const setup = fixture({ deadline: { signal: () => deadline.signal }, fetch: async () => new Response(new ReadableStream<Uint8Array>({
    pull(stream) { pulls++; if (pulls === 1) { stream.enqueue(new TextEncoder().encode("{")); return; } deadline.abort(); },
    cancel() { cancelled = true; },
  })) });
  const result = await setup.plugin.listLocations({ context }); assert.ok(!result.ok); assert.equal(result.error.code, "expired"); assert.equal(cancelled, true);
});
test("factory import/construction is inert; invalid CLI args start no server", async () => {
  const setup = fixture({}); createGoogleBusinessProfilePlugin(setup.dependencies); assert.equal(setup.calls.length, 0); assert.equal(setup.accesses.length, 0);
  const stderr = new PassThrough(); let text = ""; stderr.on("data", chunk => { text += String(chunk); });
  assert.equal(await runCli({ args: ["--live"], stdin: new PassThrough(), stdout: new PassThrough(), stderr }), 2); assert.match(text, /Usage/);
});

test("published MCP callbacks validate arguments and forward the caller signal", async () => {
  const setup = fixture({}); const tools = createReadTools({ plugin: setup.plugin, context });
  for (const tool of tools) {
    assert.equal(tool.inputSchema.type, "object");
    assert.ok(Object.values(tool.inputSchema.properties ?? {}).every(property => typeof property === "object" && property !== null));
  }
  assert.deepEqual(Object.keys(tools[0].inputSchema.properties ?? {}), ["pageToken"]);
  assert.deepEqual(Object.keys(tools[1].inputSchema.properties ?? {}), ["days"]);
  const controller = new AbortController(); const ctx = { baseUrl: "https://unused.invalid", fetchImpl: setup.dependencies.fetch, signal: controller.signal };
  const result = await tools[1].handler({ args: { days }, ctx });
  const native = await setup.plugin.readPerformance({ context, days }); assert.ok(native.ok);
  assert.deepEqual(result, { ok: true, value: native.value });
  assert.equal(setup.calls[0].init?.signal, controller.signal);
  const before = setup.calls.length;
  assert.equal((await tools[0].handler({ args: { context: { scope: {} }, url: "https://evil.test" }, ctx }) as { ok: boolean }).ok, false);
  assert.equal(setup.calls.length, before);
});

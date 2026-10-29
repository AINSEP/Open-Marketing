import { describe, expect, it } from "vitest";
import { capabilityCatalog, pluginConfigurationSchema } from "@open-marketing/contracts";
import type { CallContext, Outcome, PluginCapabilityDependencies, ServiceContext } from "@open-marketing/contracts";
import { createCapabilities, createMetaInstagramFetchDispatch } from "../src/index.js";
import type { MetaInstagramDispatch } from "../src/index.js";
import { createAudienceCapabilities } from "../src/audiences.js";
import { digest } from "../src/boundary.js";
import { adsGraphVersion } from "../src/instagram-fetch.js";

const configuration = pluginConfigurationSchema.parse({ scope: { ownerId: "owner", workspaceId: "workspace" }, connectionId: "meta-connection", accountId: "123", pluginDigest: "a".repeat(64), settings: {} });
const context: CallContext = { scope: configuration.scope, principal: { kind: "service", serviceId: "audience-sync" }, correlationId: "audience-call-1", traceId: "trace-1", runId: "run-1" };
const connection = { connectionId: configuration.connectionId, accountId: configuration.accountId };
// Meta guide vector: SHA-256 of trimmed, lowercase mary@example.com; pass through, never hash twice.
const emailSha256 = "f1904cf1a9d73a55fa5de0ac823c4403ded71afd4c3248d00bdcd0866552bb79";
const input = { audienceId: "456", emailSha256 };
const call = { context, connection, input };
const token = "fixture-audience-token";
const ownership = { account_id: configuration.accountId, subtype: "CUSTOM" };
const accepted = { audience_id: input.audienceId, num_received: 1, num_invalid_entries: 0 };
type Recorded = { method: string; url: URL; parameters: URLSearchParams };

/** One fixture response seam exercises the dispatch double and the real configured fetch adapter. */
function fixture(required: { real: boolean; respond?: (request: Recorded) => unknown }) {
  const requests: Recorded[] = [];
  const effects: Parameters<MetaInstagramDispatch>[0][] = [];
  let accesses = 0;
  const respond = (request: Recorded): unknown => {
    requests.push(request);
    if (required.respond) return required.respond(request);
    return request.method === "GET" ? ownership : accepted;
  };
  const fetch: typeof globalThis.fetch = async (url, init) => {
    expect(init?.headers).toMatchObject({ Authorization: "Bearer " + token });
    expect(init?.redirect).toBe("error");
    const target = new URL(String(url));
    const request = { method: init?.method ?? "GET", url: target, parameters: init?.method === "POST" ? new URLSearchParams(String(init.body)) : target.searchParams };
    return Response.json(respond(request));
  };
  const dependencies: PluginCapabilityDependencies = { configuration, fetch, clock: { now: () => 0 }, observer: { observe() {} }, wait: async () => ({ ok: true, value: undefined }),
    credentials: { async access(binding) { accesses++; expect(binding).toEqual(connection); return { ok: true, value: { accessToken: token } }; } },
  };
  const dispatch: MetaInstagramDispatch = async request => {
    effects.push(request);
    const url = new URL(request.request.endpoint);
    return { ok: true, value: respond({ method: request.request.method, url, parameters: new URLSearchParams(request.request.parameters as Record<string, string>) }) };
  };
  const capabilities = required.real ? createCapabilities(dependencies) : createAudienceCapabilities({ configured: { ok: true, value: { configuration, dispatch } } });
  return { handler: capabilities["audience.member.add.v1"]!, requests, effects, dependencies, accesses: () => accesses };
}

describe.each([false, true])("audience upload shared behavior (real fetch: %s)", real => {
  it("uses the real server-shaped configuration and passes the doc digest unchanged to a catalog-valid receipt", async () => {
    const adapter = fixture({ real });
    expect(adapter.requests).toEqual([]); expect(adapter.accesses()).toBe(0);
    const result = await adapter.handler(call);
    expect(result).toEqual({ ok: true, value: { audienceId: input.audienceId, status: "accepted" } });
    if (result.ok) expect(capabilityCatalog["audience.member.add.v1"].output.safeParse(result.value).success).toBe(true);
    expect(adapter.requests.map(request => [request.method, request.url.pathname])).toEqual([["GET", `/${adsGraphVersion}/456`], ["POST", `/${adsGraphVersion}/456/users`]]);
    expect(adapter.requests[0].parameters.get("fields")).toBe("account_id,subtype");
    const post = adapter.requests[1].parameters;
    expect(JSON.parse(post.get("payload")!)).toEqual({ schema: "EMAIL_SHA256", data: [emailSha256] });
    const argumentsDigest = digest({ value: [context.correlationId, input.audienceId, emailSha256] });
    expect(JSON.parse(post.get("session")!)).toEqual({ session_id: Number.parseInt(argumentsDigest.slice(0, 13), 16), batch_seq: 1, last_batch_flag: true });
    expect(Number.isSafeInteger(JSON.parse(post.get("session")!).session_id)).toBe(true);
    if (real) expect(adapter.accesses()).toBe(2);
    else expect(adapter.effects.map(effect => effect.effect)).toEqual(["read", "write"].map(effect => ({ operationId: argumentsDigest, ...connection, effects: [effect], argumentsDigest, moneyExposure: null, requiredLimit: null })));
  });
  it.each([emailSha256.toUpperCase(), "mary@example.com", "a".repeat(63)])("rejects malformed emailSha256 before fetch (%s)", async value => {
    const adapter = fixture({ real });
    const result = await adapter.handler({ ...call, input: { ...input, emailSha256: value } });
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_input", retryable: false } });
    expect(JSON.stringify(result)).not.toContain(value);
    expect(adapter.requests).toEqual([]); expect(adapter.accesses()).toBe(0);
  });
  it.each(["0", "-1", "act_456", "456/users", "1".repeat(33)])("narrows the catalog audience ID before fetch (%s)", async audienceId => {
    const adapter = fixture({ real });
    expect(await adapter.handler({ ...call, input: { ...input, audienceId } })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(adapter.requests).toEqual([]);
  });
  it.each([{ ...ownership, account_id: "999" }, { ...ownership, subtype: "LOOKALIKE" }])("refuses foreign or non-CUSTOM audiences before the write: %j", async response => {
    const adapter = fixture({ real, respond: () => response });
    expect(await adapter.handler(call)).toMatchObject({ ok: false, error: { code: "forbidden", retryable: false } });
    expect(adapter.requests.map(request => request.method)).toEqual(["GET"]);
  });
  it("returns invalid_input without exposing invalid-entry samples", async () => {
    const adapter = fixture({ real, respond: request => request.method === "GET" ? ownership : { ...accepted, num_invalid_entries: 1, invalid_entry_samples: [token, emailSha256] } });
    const result = await adapter.handler(call);
    expect(result).toEqual({ ok: false, error: { code: "invalid_input", message: "Meta rejected the audience identifier", retryable: false } });
    expect(JSON.stringify(result)).not.toContain(token); expect(JSON.stringify(result)).not.toContain(emailSha256);
  });
  it.each([{}, null, { ...accepted, audience_id: "999" }, { ...accepted, num_received: 0 }, { ...accepted, num_received: "1" }, { ...accepted, num_invalid_entries: -1 }])("keeps an unproven receipt unknown and never retries: %j", async receipt => {
    const adapter = fixture({ real, respond: request => request.method === "GET" ? ownership : receipt });
    expect(await adapter.handler(call)).toEqual({ ok: true, value: { audienceId: input.audienceId, status: "unknown" } });
    expect(adapter.requests.filter(request => request.method === "POST")).toHaveLength(1);
  });
  it("keeps a lost POST acknowledgement unknown without leaking the thrown message or retrying", async () => {
    const adapter = fixture({ real, respond: request => { if (request.method === "POST") throw new Error(token + emailSha256); return ownership; } });
    const result = await adapter.handler(call);
    expect(result).toEqual({ ok: true, value: { audienceId: input.audienceId, status: "unknown" } });
    expect(JSON.stringify(result)).not.toContain(token); expect(JSON.stringify(result)).not.toContain(emailSha256);
    expect(adapter.requests.map(request => request.method)).toEqual(["GET", "POST"]);
  });
  it("fails a lost or malformed ownership read without a POST", async () => {
    for (const response of [null, { account_id: "123" }]) {
      const adapter = fixture({ real, respond: () => response });
      expect(await adapter.handler(call)).toMatchObject({ ok: false, error: { code: "invalid_input" } });
      expect(adapter.requests.map(request => request.method)).toEqual(["GET"]);
    }
    const adapter = fixture({ real, respond: () => { throw new Error(token + emailSha256); } });
    const result = await adapter.handler(call);
    expect(result).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(JSON.stringify(result)).not.toContain(token); expect(JSON.stringify(result)).not.toContain(emailSha256);
    expect(adapter.requests).toHaveLength(1);
  });
  it("cancels before I/O and after the ownership read without a POST", async () => {
    const before = fixture({ real });
    expect(await before.handler(call, { signal: AbortSignal.abort() })).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(before.requests).toEqual([]);
    const controller = new AbortController();
    const between = fixture({ real, respond: () => { controller.abort(); return ownership; } });
    expect(await between.handler(call, { signal: controller.signal })).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(between.requests.map(request => request.method)).toEqual(["GET"]);
  });
  it("rejects mismatched scope, account or connection before credentials and fetch", async () => {
    for (const changed of [{ ...call, connection: { ...connection, connectionId: "foreign" } }, { ...call, connection: { ...connection, accountId: "999" } },
      { ...call, context: { ...context, scope: { ...context.scope, workspaceId: "foreign" } } }, { ...call, context: { ...context, scope: { ...context.scope, ownerId: "foreign" } } }]) {
      const adapter = fixture({ real });
      expect(await adapter.handler(changed)).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(adapter.requests).toEqual([]); expect(adapter.accesses()).toBe(0);
    }
  });
  it("normalizes the server ServiceContext through the shared context boundary", async () => {
    const service: ServiceContext = { scope: configuration.scope, serviceId: "audience-sync", correlationId: context.correlationId, traceId: context.traceId };
    const adapter = fixture({ real });
    expect(await adapter.handler({ ...call, context: service })).toMatchObject({ ok: true, value: { status: "accepted" } });
  });
});

it("exposes the audience handler on invalid factory configuration without accessing credentials", async () => {
  const adapter = fixture({ real: true });
  const dependencies = { ...adapter.dependencies };
  Reflect.set(dependencies, "configuration", { ...configuration, accountId: null });
  const handler = createCapabilities(dependencies)["audience.member.add.v1"]!;
  expect(await handler(call)).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  expect(adapter.requests).toEqual([]); expect(adapter.accesses()).toBe(0);
});

it("permits only the current-version numeric audience POST with exactly one write effect", async () => {
  const fixtureAdapter = fixture({ real: false });
  await fixtureAdapter.handler(call);
  const post = fixtureAdapter.effects[1];
  let accesses = 0; let fetches = 0;
  const dispatch = createMetaInstagramFetchDispatch({ credentials: { async access() { accesses++; return { ok: true, value: { accessToken: token } }; } },
    fetch: async () => { fetches++; return Response.json(accepted); },
  });
  for (const change of [
    { request: { ...post.request, endpoint: "https://graph.facebook.com/v25.0/456/users" } },
    { request: { ...post.request, endpoint: `https://graph.facebook.com/${adsGraphVersion}/456/users/` } },
    { request: { ...post.request, endpoint: `https://graph.facebook.com/${adsGraphVersion}/0456/users` } },
    { request: { ...post.request, method: "GET" as const } },
    { effect: { ...post.effect, effects: ["read" as const] } },
    { effect: { ...post.effect, effects: ["write" as const, "read" as const] } },
    { effect: { ...post.effect, effects: [] } },
  ]) expect(await dispatch({ ...post, ...change })).toMatchObject({ ok: false, error: { code: "forbidden" } });
  expect(accesses).toBe(0); expect(fetches).toBe(0);
  expect(await dispatch(post)).toEqual({ ok: true, value: accepted });
  expect(accesses).toBe(1); expect(fetches).toBe(1);
});

it.each(["malformed", "oversized", "non-2xx", "aborted"])("keeps a %s POST acknowledgement unknown with one attempt", async mode => {
  const adapter = fixture({ real: true });
  const methods: string[] = [];
  const controller = new AbortController();
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    methods.push(init?.method ?? "GET");
    if (init?.method === "GET") return Response.json(ownership);
    if (mode === "malformed") return new Response(token + emailSha256);
    if (mode === "oversized") return new Response('"' + "x".repeat(1048576) + '"');
    if (mode === "non-2xx") return new Response(token + emailSha256, { status: 400 });
    controller.abort(); throw new Error(token + emailSha256);
  };
  const handler = createCapabilities({ ...adapter.dependencies, fetch })["audience.member.add.v1"]!;
  expect(await handler(call, { signal: controller.signal })).toEqual({ ok: true, value: { audienceId: input.audienceId, status: "unknown" } });
  expect(methods).toEqual(["GET", "POST"]);
});

it("returns forbidden when credentials are refused after the ownership GET, without a POST", async () => {
  const adapter = fixture({ real: true });
  let accesses = 0;
  const access = async (): Promise<Outcome<{ accessToken: string }>> => {
    accesses++;
    if (accesses === 2) return { ok: false, error: { code: "forbidden", message: token + emailSha256, retryable: false } };
    return adapter.dependencies.credentials.access(connection);
  };
  const handler = createCapabilities({ ...adapter.dependencies, credentials: { access } })["audience.member.add.v1"]!;
  const result = await handler(call);
  expect(result).toMatchObject({ ok: false, error: { code: "forbidden", retryable: false } });
  expect(accesses).toBe(2);
  expect(adapter.requests.map(request => request.method)).toEqual(["GET"]);
  expect(JSON.stringify(result)).not.toContain(token); expect(JSON.stringify(result)).not.toContain(emailSha256);
});

it.each(["invalid", "refused"])("redacts %s credentials before any fetch", async mode => {
  const adapter = fixture({ real: true });
  const access = async (): Promise<Outcome<{ accessToken: string }>> => {
    if (mode === "invalid") return { ok: true, value: { accessToken: token + "\n" + emailSha256 } };
    return { ok: false, error: { code: "forbidden", message: token + emailSha256, retryable: false } };
  };
  const handler = createCapabilities({ ...adapter.dependencies, credentials: { access } })["audience.member.add.v1"]!;
  const result = await handler(call);
  expect(result).toMatchObject({ ok: false, error: { code: mode === "invalid" ? "invalid_input" : "forbidden", retryable: false } });
  expect(JSON.stringify(result)).not.toContain(token); expect(JSON.stringify(result)).not.toContain(emailSha256);
  expect(adapter.requests).toEqual([]);
});

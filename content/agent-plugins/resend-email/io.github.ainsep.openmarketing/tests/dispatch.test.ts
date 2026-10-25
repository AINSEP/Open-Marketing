import { expect, it } from "vitest";
import { commandSchema, resendEmailTools } from "../src/index.js";
import { dispatchSuite } from "./contract-suite.js";
import { domain, domainId, fixture, invocation } from "./fixtures.js";
dispatchSuite({ name: "memory broker/gateway", makeFixture: fixture });

it("exposes only domain reads and rejects legacy sends, including malformed URLs without throwing", async () => {
  const f = fixture();
  expect(resendEmailTools.map(tool => ({ name: tool.name, effects: tool.effects }))).toEqual([{ name: "domain_status", effects: ["read"] }]);
  for (const unsubscribeUrl of ["http://[", "https://%", "https://om.example/unsubscribe"]) {
    const command = { kind: "send", contactId: "contact", recipient: "member@example.com", intent: "marketing", from: "hello@example.com", subject: "Hello", text: "News", unsubscribeUrl };
    expect(() => commandSchema.safeParse(command)).not.toThrow();
    expect(commandSchema.safeParse(command).success).toBe(false);
    expect(await f.adapter.invoke({ ...invocation(), command } as unknown as ReturnType<typeof invocation>)).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  }
  expect(f.calls).toHaveLength(0); expect(f.state.credentialCalls).toBe(0);
});
it("denies malformed, oversized, cancelled and foreign-scope requests before credential I/O", async () => {
  const f = fixture(); const input = invocation(); const cancelled = new AbortController(); cancelled.abort();
  expect(await f.adapter.invoke(input, { signal: cancelled.signal })).toMatchObject({ ok: false, error: { code: "cancelled" } });
  expect(await f.adapter.invoke({ ...input, context: { ...input.context, scope: { ownerId: "foreign", workspaceId: "workspace" } } })).toMatchObject({ ok: false, error: { code: "forbidden" } });
  expect(await f.adapter.invoke({ ...input, command: { ...input.command, domainId: "x".repeat(70000) } })).toMatchObject({ ok: false, error: { code: "limit_exceeded" } });
  for (const change of [{ domainId: "bad" }, { domainId, after: domainId }, { limit: 101 }, { limit: 0 }, { url: "https://untrusted.example" }]) {
    const command = { ...input.command, ...change };
    expect(commandSchema.safeParse(command).success).toBe(false);
    expect(await f.adapter.invoke({ ...input, command })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  }
  expect(f.calls).toHaveLength(0); expect(f.state.credentialCalls).toBe(0);
});
for (const status of [302, 401, 403, 409, 422, 429, 500]) it("maps HTTP " + status + " safely without retry", async () => {
  const f = fixture({ response: () => new Response("synthetic-secret", { status }) });
  const result = await f.adapter.invoke(invocation());
  expect(result).toMatchObject({ ok: false, error: { code: status === 401 || status === 403 ? "forbidden" : "unavailable", retryable: false } });
  expect(JSON.stringify({ result, observations: f.observations })).not.toContain("synthetic-secret"); expect(f.calls).toHaveLength(1);
});
it("fails closed on thrown transport, invalid JSON and oversized bodies", async () => {
  for (const response of [async () => { throw new Error("synthetic-secret"); }, () => new Response("not JSON"), () => new Response("x".repeat(1048577))]) {
    const f = fixture({ response }); const result = await f.adapter.invoke(invocation());
    expect(result.ok).toBe(false); expect(JSON.stringify(result)).not.toContain("synthetic-secret"); expect(f.calls).toHaveLength(1);
  }
});
it("rejects malformed credentials before gateway and fetch", async () => {
  const f = fixture({ credential: { accessToken: "bad\r\ntoken" } });
  expect(await f.adapter.invoke(invocation())).toMatchObject({ ok: false, error: { code: "unauthenticated" } }); expect(f.effects).toHaveLength(0); expect(f.calls).toHaveLength(0);
});
it("reads bounded domains and detail, strips additions and returns cursor without following URLs", async () => {
  const f = fixture({ response: () => Response.json({ data: [{ ...domain, secret: "discarded" }], has_more: true }) });
  expect(await f.adapter.invoke(invocation({ command: { kind: "domain_status", limit: 1 } }))).toEqual({ ok: true, value: { operationId: "operation", status: "succeeded", domains: [domain], nextCursor: domainId } });
  expect(f.calls[0].url).toBe("https://api.resend.com/domains?limit=1");
  const detail = fixture({ response: () => Response.json(domain) });
  expect(await detail.adapter.invoke(invocation({ command: { kind: "domain_status", domainId, limit: 100 } }))).toMatchObject({ ok: true, value: { domains: [domain], nextCursor: null } });
  expect(detail.calls[0].url).toBe("https://api.resend.com/domains/" + domainId);
});
it("rejects duplicate and partially malformed domain pages atomically", async () => {
  for (const data of [[domain, domain], [domain, { ...domain, id: "bad" }]]) {
    const f = fixture({ response: () => Response.json({ data, has_more: false }) });
    expect(await f.adapter.invoke(invocation({ command: { kind: "domain_status", limit: 100 } }))).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
  }
});
it("bounds list cursors and rejects wrong detail IDs, over-limit pages and malformed tracking", async () => {
  for (const body of [{ data: [domain, { ...domain, id: "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794" }], has_more: false }, { data: [{ ...domain, open_tracking: "false" }], has_more: false }, { data: [], has_more: true }]) {
    const f = fixture({ response: () => Response.json(body) });
    expect(await f.adapter.invoke(invocation({ command: { kind: "domain_status", limit: 1 } }))).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
  }
  const f = fixture({ response: () => Response.json({ ...domain, id: "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794" }) });
  expect(await f.adapter.invoke(invocation({ command: { kind: "domain_status", domainId, limit: 100 } }))).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
});
it("returns safe permission denial for Sending-only domain reads", async () => {
  const f = fixture({ response: () => new Response("synthetic-secret restricted_api_key", { status: 401 }) });
  expect(await f.adapter.invoke(invocation({ command: { kind: "domain_status", after: domainId, limit: 3 } }))).toEqual({ ok: false, error: { code: "forbidden", message: "Resend request forbidden", retryable: false } });
  expect(f.calls[0].url).toBe("https://api.resend.com/domains?limit=3&after=" + domainId);
});
it("allows only one gateway callback request and preserves the snapshot across credential I/O", async () => {
  const input = invocation(); let repeated: unknown;
  const f = fixture({ credentialHook: () => { Object.assign(input.command, { limit: 1 }); }, gateway: { async dispatch(call) { const first = await call.execute(); repeated = await call.execute(); return first; } } });
  expect(await f.adapter.invoke(input)).toMatchObject({ ok: true, value: { status: "succeeded" } });
  expect(repeated).toMatchObject({ ok: false, error: { code: "conflict" } });
  expect(f.calls).toHaveLength(1); expect(f.calls[0].url).toBe("https://api.resend.com/domains?limit=100");
});
it("rechecks cancellation after the broker and keeps gateway throws safe", async () => {
  const controller = new AbortController(); const cancelled = fixture({ credentialHook: () => controller.abort() });
  expect(await cancelled.adapter.invoke(invocation(), { signal: controller.signal })).toMatchObject({ ok: false, error: { code: "cancelled" } }); expect(cancelled.calls).toHaveLength(0);
  const f = fixture({ gateway: { async dispatch(call) { await call.execute(); throw new Error("synthetic-secret"); } } });
  expect(await f.adapter.invoke(invocation())).toEqual({ ok: false, error: { code: "unavailable", message: "Resend request unavailable", retryable: false } }); expect(f.calls).toHaveLength(1);
});
for (const phase of ["fetch", "body"] as const) it("uses the injected 10s deadline during " + phase + " without real time or retries", async () => {
  const controller = new AbortController(); const durations: number[] = [];
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const f = fixture({ deadline: ({ timeoutMs }) => { durations.push(timeoutMs); return controller.signal; }, response: ({ signal }) => {
    if (phase === "fetch") return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("synthetic-secret")), { once: true }); started();
    });
    return new Response(new ReadableStream({ start(stream) {
      signal.addEventListener("abort", () => stream.error(new Error("synthetic-secret")), { once: true }); started();
    } }));
  } });
  const pending = f.adapter.invoke(invocation(), { signal: new AbortController().signal });
  await ready; controller.abort(); const result = await pending;
  expect(result).toMatchObject({ ok: false, error: { code: "unavailable", retryable: false } });
  expect(durations).toEqual([10000]); expect(f.calls).toHaveLength(1);
  expect(f.calls[0].init.signal?.aborted).toBe(true);
  expect(JSON.stringify({ result, observations: f.observations })).not.toContain("synthetic-secret");
});
it("does not fetch with an already expired deadline", async () => {
  const controller = new AbortController(); controller.abort();
  const f = fixture({ deadline: () => controller.signal });
  expect(await f.adapter.invoke(invocation())).toMatchObject({ ok: false, error: { code: "unavailable" } }); expect(f.calls).toHaveLength(0);
});

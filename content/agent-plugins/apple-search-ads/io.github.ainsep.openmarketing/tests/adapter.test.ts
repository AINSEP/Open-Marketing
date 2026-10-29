import { describe, expect, it } from "vitest";
import { invokeAppleSearchAds } from "../src/index.js";
import { account, campaign, context, fixture, now, pagination } from "./fixtures.js";
import { dispatchSuite } from "./contract/dispatch-suite.js";
dispatchSuite({ name: "plugin fixture", makeFixture: fixture });

describe("Apple bounded reads", () => {
  it("maps a campaign page and sends the bound ad account with explicit pagination", async () => {
    const f = fixture(); f.state.response = () => Response.json({ result: [campaign], pagination: { ...pagination, offset: 1, pageSize: 2 }, error: null });
    expect(await f.invoke({ command: { kind: "list_campaigns", offset: 1, limit: 2 } })).toMatchObject({ ok: true, value: { data: { items: [{ id: "456", adAccountId: "123", status: "PAUSED", dailyBudget: { value: { amount: "37.0123" } } }], pagination: { offset: 1, requestedLimit: 2, returned: 1, coverage: "page", totalCount: 3 } } } });
    expect(f.calls[0].url).toBe("https://api.ads.apple.com/v1/campaigns/query");
    expect(f.calls[0].init.method).toBe("POST");
    expect(JSON.parse(String(f.calls[0].init.body))).toEqual({ sorting: [{ field: "id", order: "ASC" }], pagination: { offset: 1, pageSize: 2, fetchTotalCount: true } });
    expect(new Headers(f.calls[0].init.headers).get("X-AP-Context")).toBe("adAccountId=123");
  });
  it.each([401, 403, 429, 500, 302])("never retries HTTP %s or returns its raw error", async status => {
    const f = fixture(); f.state.response = () => new Response("synthetic-secret", { status });
    const result = await f.invoke(); expect(result.ok).toBe(false); expect(f.calls).toHaveLength(1); expect(JSON.stringify(result)).not.toContain("synthetic-secret");
  });
  it("rejects foreign scope and pre-abort before credentials", async () => {
    const f = fixture(); const controller = new AbortController(); controller.abort();
    expect(await f.invoke({}, { signal: controller.signal })).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(await invokeAppleSearchAds({ context: { ...context, scope: { ...context.scope, ownerId: "foreign" } }, operationId: "read", command: { kind: "list_accounts" }, dependencies: f.dependencies })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(f.calls).toEqual([]); expect(f.credentialCalls).toEqual([]);
  });
  it("rejects expired credentials before egress", async () => {
    const f = fixture(); f.state.credential = { ok: true, value: { accessToken: "synthetic-secret", expiresAt: now } };
    expect(await f.invoke()).toMatchObject({ ok: false, error: { code: "expired" } });
    expect(f.calls).toEqual([]);
  });
  it.each(["{", "x".repeat(1048577)])("rejects malformed or oversized streamed JSON without leaking content", async raw => {
    const f = fixture(); f.state.response = () => new Response(raw);
    expect((await f.invoke()).ok).toBe(false); expect(f.calls).toHaveLength(1);
  });
  it("decodes ACL identity/roles without invented metadata and strips unknown provider fields", async () => {
    const f = fixture(); f.state.response = () => Response.json({ result: { acls: [{ ...account, private: "synthetic-secret" }] } });
    const result = await f.invoke(); expect(result.ok).toBe(true); expect(JSON.stringify(result)).not.toContain("synthetic-secret");
  });
  it.each([{}, { kind: "list_campaigns", limit: 101 }, { kind: "list_campaigns", offset: -1 }, { kind: "list_accounts", url: "https://foreign.example" }, { kind: "report", startDate: "2026-10-22", endDate: "2026-10-23" }])("rejects invalid command %# before credential access", async command => {
    const f = fixture(); expect(await f.invoke({ command })).toMatchObject({ ok: false, error: { code: "invalid_input" } }); expect(f.credentialCalls).toEqual([]); expect(f.calls).toEqual([]);
  });
  it("cancels a pending response body read on caller abort", async () => {
    const f = fixture(); const controller = new AbortController(); let cancelCount = 0;
    const readStarted = Promise.withResolvers<void>();
    const body = new ReadableStream<Uint8Array>({
      pull() { readStarted.resolve(); },
      cancel() { cancelCount += 1; },
    }, { highWaterMark: 0 }); // No prefetch: pull signals an actual pending reader.read().
    f.state.response = () => new Response(body);
    const result = f.invoke({}, { signal: controller.signal });
    await readStarted.promise;
    expect(body.locked).toBe(true); expect(controller.signal.aborted).toBe(false); expect(cancelCount).toBe(0);
    controller.abort();
    expect(await result).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(cancelCount).toBe(1); expect(body.locked).toBe(false);
    expect(f.calls).toHaveLength(1); expect(f.calls[0].init.signal?.aborted).toBe(true);
  });
  it("maps thrown/bad credentials and native network errors without secret echoes", async () => {
    const f = fixture(); f.dependencies.credentials.access = async () => { throw new Error("synthetic-secret"); };
    expect(await f.invoke()).toMatchObject({ ok: false, error: { code: "unavailable" } }); expect(f.calls).toEqual([]);
    const bad = fixture(); bad.state.credential = { ok: true, value: { accessToken: "bad\r\nheader" } };
    expect(await bad.invoke()).toMatchObject({ ok: false, error: { code: "unauthenticated" } }); expect(bad.calls).toEqual([]);
    const network = fixture(); network.state.response = () => { throw new Error("synthetic-secret"); };
    expect(await network.invoke()).toMatchObject({ ok: false, error: { code: "unavailable" } });
  });
  it.each(["duplicate", "foreign", "unsafe", "error-envelope", "missing-page"])("rejects invalid campaign pages atomically: %s", async kind => {
    const f = fixture(); const second = { ...campaign, id: 789 };
    if (kind === "duplicate") second.id = 456;
    if (kind === "foreign") second.adAccountId = 999;
    if (kind === "unsafe") second.id = Number.MAX_SAFE_INTEGER + 1;
    f.state.response = () => Response.json({ result: [campaign, second], pagination: kind === "missing-page" ? null : pagination, error: kind === "error-envelope" ? { code: "INVALID_REQUEST", message: "synthetic-secret", details: [] } : null });
    expect(await f.invoke({ command: { kind: "list_campaigns" } })).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
  });
  it("rejects oversized/cyclic input before credentials", async () => {
    const f = fixture(); const cyclic: Record<string, unknown> = { kind: "list_accounts" }; cyclic.self = cyclic;
    expect(await f.invoke({ command: cyclic })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(await f.invoke({ command: { kind: "list_accounts", extra: "x".repeat(65536) } })).toMatchObject({ ok: false, error: { code: "limit_exceeded" } }); expect(f.credentialCalls).toEqual([]);
  });
  it.each([
    { offset: 1, pageSize: 2, totalCount: 3 }, { offset: 0, pageSize: 3, totalCount: 3 },
    { offset: 0, pageSize: 0, totalCount: 3 }, { offset: 0, pageSize: 2, totalCount: 0 },
  ])("rejects inconsistent v1 page metadata %#", async page => {
    const f = fixture(); f.state.response = () => Response.json({ result: [campaign], pagination: page });
    expect(await f.invoke({ command: { kind: "list_campaigns", limit: 2 } })).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
    expect(f.calls).toHaveLength(1);
  });
  it.each([
    { result: { acls: [account, account] } }, { result: { acls: Array.from({ length: 101 }, (_, index) => ({ ...account, adAccount: { ...account.adAccount, id: index + 1 } })) } },
    { result: { acls: [{ ...account, adAccount: { ...account.adAccount, id: Number.MAX_SAFE_INTEGER + 1 } }] } },
    { data: [account], pagination: null }, { result: { acls: [{ ...account, roles: [1] }] } },
  ])("rejects duplicate, oversized, unsafe or legacy ACLs atomically %#", async body => {
    const f = fixture(); f.state.response = () => Response.json(body);
    expect(await f.invoke()).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
  });
  it.each([
    { code: "REJECTED", message: "synthetic-secret", details: [{ code: "BAD_FIELD", message: null, info: { field: "name" } }] },
    { code: "REJECTED", message: "x".repeat(4097) }, { code: "REJECTED", details: Array.from({ length: 101 }, () => ({ code: "BAD" })) },
  ])("never exposes successful-looking payloads accompanied by provider errors %#", async error => {
    const f = fixture(); f.state.response = () => Response.json({ result: { acls: [account] }, error });
    const result = await f.invoke();
    expect(result).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
    expect(JSON.stringify(result)).not.toContain("synthetic-secret"); expect(f.calls).toHaveLength(1);
  });
  it("freezes command bytes before broker awaits and rechecks expiry after them", async () => {
    const f = fixture(); const command = { kind: "list_campaigns", limit: 2 }; f.state.response = () => Response.json({ result: [campaign], pagination: { ...pagination, pageSize: 2 } });
    f.state.credentialHook = () => { command.limit = 99; };
    expect((await f.invoke({ command })).ok).toBe(true); expect(JSON.parse(String(f.calls[0].init.body)).pagination).toEqual({ offset: 0, pageSize: 2, fetchTotalCount: true });
    const expired = fixture(); expired.state.credentialHook = () => { expired.state.time = now + 60000; };
    expect(await expired.invoke()).toMatchObject({ ok: false, error: { code: "expired" } }); expect(expired.calls).toEqual([]);
  });
});

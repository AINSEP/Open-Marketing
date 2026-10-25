import { describe, expect, it } from "vitest";
import { commandSchema, redditAdsTools } from "../src/index.js";
import { businessId, businessPage, fixture, invocation, metric, now, reportCommand, reportPage } from "./fixtures.js";
import { dispatchSuite } from "./contract/dispatch-suite.js";

dispatchSuite({ name: "fixture", makeFixture: () => fixture() });
describe("Reddit bounds and evidence", () => {
  it("offers exactly four read descriptors and blocks unsourced operations before credentials", async () => {
    expect(redditAdsTools.map(tool => [tool.name, tool.effect])).toEqual([["list_businesses", "read"], ["list_accounts", "read"], ["list_campaigns", "read"], ["report", "read"]]);
    const f = fixture();
    for (const command of [{ kind: "list_accounts" as const, businessId }, { kind: "list_campaigns" as const }]) expect(await f.adapter.invoke(invocation({ command }))).toMatchObject({ ok: false, error: { code: "not_implemented" } });
    expect(f.calls).toHaveLength(0); expect(f.credentialCalls).toHaveLength(0);
  });
  it("allows null-account business discovery and requires binding for reports", async () => {
    const f = fixture({ configuration: { accountId: null, currency: null } });
    expect(await f.adapter.invoke(invocation())).toMatchObject({ ok: true });
    expect(f.credentialCalls).toEqual([{ connectionId: "connection", accountId: null }]);
    expect(await f.adapter.invoke(invocation({ command: reportCommand }))).toMatchObject({ ok: false, error: { code: "invalid_input" } }); expect(f.calls).toHaveLength(1);
  });
  it("rechecks revocation after awaiting credentials", async () => {
    const f = fixture({ credentialHook: ({ state }) => { state.admitted = false; } });
    expect(await f.adapter.invoke(invocation())).toMatchObject({ ok: false, error: { code: "forbidden" } }); expect(f.calls).toHaveLength(0);
  });
  it("cancels after credentials and sanitizes broker denials", async () => {
    const controller = new AbortController(), f = fixture({ credentialHook: () => { controller.abort(); } });
    expect(await f.adapter.invoke(invocation(), { signal: controller.signal })).toMatchObject({ ok: false, error: { code: "cancelled" } }); expect(f.calls).toHaveLength(0);
    const denied = fixture(); denied.dependencies.credentials.access = async () => ({ ok: false, error: { code: "unauthenticated", message: "synthetic-secret", retryable: true } });
    const result = await denied.adapter.invoke(invocation()); expect(result).toMatchObject({ ok: false, error: { code: "unauthenticated", retryable: false } }); expect(JSON.stringify(result)).not.toContain("synthetic-secret"); expect(denied.calls).toHaveLength(0);
  });
  it.each(["deadline", "deadline_with_caller", "caller"] as const)("propagates %s aborts to fetch without real timers or retries", async cause => {
    const caller = new AbortController();
    const f = fixture({ response: () => {
      const signal = f.calls[0].init.signal!;
      expect(signal.aborted).toBe(false);
      if (cause === "caller") caller.abort(new Error("synthetic-secret"));
      else f.deadline.abort(new Error("synthetic-secret"));
      expect(signal.aborted).toBe(true);
      signal.throwIfAborted();
      return Response.json(businessPage);
    } });
    const result = await f.adapter.invoke(invocation(), cause === "deadline" ? undefined : { signal: caller.signal });
    expect(f.deadlineCalls).toEqual([{ timeoutMs: 15000 }]);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].init.signal?.aborted).toBe(true);
    expect(result).toMatchObject({ ok: false, error: { code: cause === "caller" ? "cancelled" : "unavailable", retryable: false } });
    expect(JSON.stringify({ result, observations: f.observations })).not.toContain("synthetic-secret");
  });
  it("snapshots parsed commands before an awaited credential broker can mutate caller input", async () => {
    const input = { ...invocation({ command: reportCommand }) };
    const f = fixture({ credentialHook: () => { input.command = { kind: "list_businesses" }; } }); f.state.body = reportPage();
    expect(await f.adapter.invoke(input)).toMatchObject({ ok: true }); expect(f.calls[0].init.method).toBe("POST");
  });
  it.each([{ accessToken: "unsafe\r\nvalue" }, { accessToken: "synthetic-secret", expiresAt: now }])("rejects malformed or expired paste tokens: %j", async credential => {
    const f = fixture({ credential }); expect(await f.adapter.invoke(invocation())).toMatchObject({ ok: false }); expect(f.calls).toHaveLength(0);
  });
  it.each([{ kind: "list_businesses", pageSize: 101 }, { kind: "list_businesses", pageToken: "https://bad.invalid/next path" }, { ...reportCommand, window: { start: now, end: now + 32 * 86400000 } }, { ...reportCommand, window: { start: now + 1, end: now + 86400000 } }, { kind: "activate" }, { kind: "list_businesses", token: "untrusted" }])("rejects invalid commands before I/O: %j", async command => {
    const f = fixture(); expect(commandSchema.safeParse(command).success).toBe(false);
    expect(await f.adapter.invoke(invocation({ command: command as never }))).toMatchObject({ ok: false, error: { code: "invalid_input" } }); expect(f.credentialCalls).toHaveLength(0);
  });
  it("returns a validated continuation without following it, then encodes only the token", async () => {
    const f = fixture(); f.state.body = { ...businessPage, pagination: { next_url: "https://ads-api.reddit.com/api/v3/me/businesses?page.size=100&page.token=next%2Btoken" } };
    expect(await f.adapter.invoke(invocation())).toMatchObject({ ok: true, value: { data: { incomplete: true, nextPageToken: "next+token" } } }); expect(f.calls).toHaveLength(1);
    f.state.body = businessPage; await f.adapter.invoke(invocation({ command: { kind: "list_businesses", pageToken: "next+token" } }));
    expect(f.calls[1].url).toContain("page.token=next%2Btoken");
  });
  it.each(["https://evil.invalid/next", "http://ads-api.reddit.com/api/v3/me/businesses?page.token=x", "https://ads-api.reddit.com/api/v3/me/businesses?page.token=x&account_id=foreign", "https://user@ads-api.reddit.com/api/v3/me/businesses?page.token=x", "https://ads-api.reddit.com/api/v3/me/businesses?page.token=x&page.token=y", "https://ads-api.reddit.com/api/v3/me/businesses?page.token=x&page.size=101", "https://ads-api.reddit.com/api/v3/ad_accounts/foreign/reports?page.token=x", "not a url"]) ("rejects malicious continuation %s without forwarding credentials", async next => {
    const f = fixture(); f.state.body = { ...businessPage, pagination: { next_url: next } };
    expect(await f.adapter.invoke(invocation())).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } }); expect(f.calls).toHaveLength(1);
  });
  it.each([{ ...metric, spend: Number.MAX_SAFE_INTEGER + 1 }, { ...metric, spend: -1 }, { ...metric, spend: 1.5 }, { ...metric, clicks: "3" }, { ...metric, account_id: "a2_foreign" }, { ...metric, currency: "EUR" }])("rejects an entire mixed report page: %j", async row => {
    const f = fixture(); f.state.body = reportPage({ metrics: [{ ...metric, campaign_id: "1" }, { ...row, campaign_id: "2" }] });
    expect(await f.adapter.invoke(invocation({ command: { ...reportCommand, pivot: "CAMPAIGN" } }))).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
  });
  it("rejects duplicate campaigns and preserves large IDs and exact safe microcurrency", async () => {
    const f = fixture(), row = { ...metric, campaign_id: "579922433862993631", spend: Number.MAX_SAFE_INTEGER };
    f.state.body = reportPage({ metrics: [row] }); const input = invocation({ command: { ...reportCommand, pivot: "CAMPAIGN" } });
    expect(await f.adapter.invoke(input)).toMatchObject({ ok: true, value: { data: { rows: [{ entityId: row.campaign_id, spendMicros: "9007199254740991" }] } } });
    f.state.body = reportPage({ metrics: [row, row] }); expect(await f.adapter.invoke(input)).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
  });
  it("keeps null metrics and empty pages distinct from zero", async () => {
    const f = fixture(); f.state.body = reportPage({ metrics: [{ ...metric, spend: null, clicks: null, impressions: null }] });
    expect(await f.adapter.invoke(invocation({ command: reportCommand }))).toMatchObject({ ok: true, value: { data: { rows: [{ spendMicros: null, impressions: null, clicks: null }], retrievedAt: now, metricsUpdatedAt: "2026-10-24T00:00:00Z", windowBasis: "request_utc" } } });
    f.state.body = reportPage({ metrics: [] }); expect(await f.adapter.invoke(invocation({ command: reportCommand }))).toMatchObject({ ok: true, value: { data: { availability: "no_data_access_unconfirmed", rows: [] } } });
  });
  it("rejects fractional source metrics even when native double parsing would round to a safe integer", async () => {
    const body = JSON.stringify(reportPage()).replace('"spend":123456789', '"spend":9007199254740991.1');
    const f = fixture({ response: () => new Response(body, { headers: { "content-type": "application/json" } }) });
    expect(await f.adapter.invoke(invocation({ command: reportCommand }))).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
  });
  it.each([[401, "unauthenticated"], [403, "forbidden"], [429, "limit_exceeded"], [503, "unavailable"], [302, "protocol_mismatch"]] as const)("maps HTTP %i without retrying or echoing errors", async (status, code) => {
    const f = fixture({ response: () => new Response("synthetic-secret", { status }) });
    expect(await f.adapter.invoke(invocation())).toMatchObject({ ok: false, error: { code, retryable: false } }); expect(f.calls).toHaveLength(1);
  });
  it.each([() => new Response("bad-json", { headers: { "content-type": "application/json" } }), () => new Response("<html>"), () => Response.json({ data: [], pagination: null }), () => new Response("x".repeat(1048577), { headers: { "content-type": "application/json", "content-length": "1" } })])("rejects malformed and oversized provider responses", async response => {
    const f = fixture({ response }); expect(await f.adapter.invoke(invocation())).toMatchObject({ ok: false }); expect(f.calls).toHaveLength(1);
  });
  it("rejects overfull pages, duplicate businesses and repeated continuation tokens", async () => {
    const f = fixture(); f.state.body = { ...businessPage, data: [...businessPage.data, ...businessPage.data] };
    expect(await f.adapter.invoke(invocation())).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
    expect(await f.adapter.invoke(invocation({ command: { kind: "list_businesses", pageSize: 1 } }))).toMatchObject({ ok: false });
    f.state.body = { ...businessPage, pagination: { next_url: "https://ads-api.reddit.com/api/v3/me/businesses?page.token=same" } };
    expect(await f.adapter.invoke(invocation({ command: { kind: "list_businesses", pageToken: "same" } }))).toMatchObject({ ok: false });
  });
  it("sanitizes thrown I/O errors and isolates telemetry failure", async () => {
    const f = fixture({ response: () => { throw new Error("synthetic-secret"); } });
    const result = await f.adapter.invoke(invocation()); expect(result).toMatchObject({ ok: false, error: { code: "unavailable" } }); expect(JSON.stringify(result)).not.toContain("synthetic-secret");
    expect(await fixture({ observerThrows: true }).adapter.invoke(invocation())).toMatchObject({ ok: true });
  });
});

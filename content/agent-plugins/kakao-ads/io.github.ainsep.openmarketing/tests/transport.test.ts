import { describe, expect, it } from "vitest";
import { commandSchema, createKakaoAdsAdapter, kakaoAdsTools } from "../src/index.js";
import { accounts, campaigns, fixture, invocation, now, pendingBody, pendingFetch, report, reportCommand } from "./fixtures.js";
import { dispatchSuite } from "./contract/dispatch-suite.js";

dispatchSuite({ name: "Real plugin with synthetic broker", makeFixture: fixture });
describe("Kakao reads", () => {
  it("constructs inertly and sends one scoped campaign GET", async () => {
    const f = fixture({ response: () => Response.json(campaigns) });
    createKakaoAdsAdapter(f.dependencies); expect(f.calls).toHaveLength(0); expect(f.credentialCalls).toHaveLength(0); expect(f.deadlines).toHaveLength(0);
    expect(await f.adapter.invoke(invocation({ command: { kind: "list_campaigns", config: "OFF" } }))).toEqual({ ok: true, value: { operationId: "operation", data: { content: [{ id: "456", name: "Fixture campaign", config: "OFF" }] } } });
    expect(f.calls[0].url).toBe("https://apis.moment.kakao.com/openapi/v4/campaigns?config=OFF");
    expect(f.calls[0].init.headers).toMatchObject({ adAccountId: "123" });
    expect(f.calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });
  it.each([ { ...accounts, number: 1 }, { ...accounts, content: [accounts.content[0], accounts.content[0]] }, { ...accounts, content: [...accounts.content, { id: 999, config: "ON" }] }, { content: [{ ...campaigns.content[0], adAccountId: 999 }] }, { content: Array.from({ length: 1001 }, () => campaigns.content[0]) } ])("rejects entire invalid, duplicate, foreign or over-cap pages", async body => {
    const f = fixture({ response: () => Response.json(body) });
    const command = "number" in body ? { kind: "list_accounts" as const } : { kind: "list_campaigns" as const };
    expect((await f.adapter.invoke(invocation({ command }))).ok).toBe(false); expect(f.calls).toHaveLength(1);
  });
  it("returns requested account page metadata without following provider links", async () => {
    const f = fixture({ response: () => Response.json({ ...accounts, number: 2, page: 2, next: "https://foreign.example" }) });
    const result = await f.adapter.invoke(invocation({ command: { kind: "list_accounts", page: 2 } }));
    expect(result).toMatchObject({ ok: true, value: { data: { number: 2, page: 2 } } });
    expect(JSON.stringify(result)).not.toContain("foreign.example"); expect(f.calls).toHaveLength(1);
  });
  it.each([ { kind: "activate" }, { kind: "list_accounts", accountId: "999" }, { ...reportCommand, start: "20260230" }, { ...reportCommand, end: "20261101" }, { ...reportCommand, end: "20260930" } ])("rejects unsupported/inflated commands before I/O", async command => {
    const f = fixture(); expect(commandSchema.safeParse(command).success).toBe(false);
    expect((await f.adapter.invoke({ ...invocation(), command } as unknown as ReturnType<typeof invocation>)).ok).toBe(false);
    expect(f.calls).toHaveLength(0); expect(f.credentialCalls).toHaveLength(0);
  });
  it("uses inclusive 31-day windows, explicit yyyyMMdd encoding and BASIC metrics", async () => {
    expect(commandSchema.safeParse({ ...reportCommand, end: "20261031" }).success).toBe(true);
    const f = fixture({ response: () => Response.json(report) });
    expect(await f.adapter.invoke(invocation({ command: reportCommand }))).toEqual({ ok: true, value: { operationId: "operation", data: { source: "kakao-moment-v4", metricsGroup: "BASIC", retrievedAt: now, rows: report.data } } });
    expect(f.calls[0].url).toBe("https://apis.moment.kakao.com/openapi/v4/adAccounts/report?adAccountId=123&start=20261001&end=20261001&timeUnit=DAY&level=AD_ACCOUNT&metricsGroup=BASIC");
    expect(kakaoAdsTools.map(tool => [tool.name, tool.effect])).toEqual([["list_accounts", "read"], ["list_campaigns", "read"], ["report", "read"]]);
  });
  it("rejects today at the KST boundary before resolving credentials", async () => {
    const f = fixture(); f.state.now = Date.parse("2026-10-23T15:00:00Z");
    expect(await f.adapter.invoke(invocation({ command: { kind: "report", start: "20261024", end: "20261024" } }))).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(f.credentialCalls).toHaveLength(0); expect(f.calls).toHaveLength(0);
  });
  it("preserves the documented no-data response without fabricating metrics", async () => {
    const empty = { ...report.data[0], dimensions: {}, metrics: {} };
    const f = fixture({ response: () => Response.json({ code: 200, data: [empty] }) });
    expect(await f.adapter.invoke(invocation({ command: reportCommand }))).toMatchObject({ ok: true, value: { data: { rows: [empty] } } });
    const compact = { ...report.data[0], start: "20261001", end: "20261001" };
    const alternate = fixture({ response: () => Response.json({ code: 200, data: [compact] }) });
    expect(await alternate.adapter.invoke(invocation({ command: reportCommand }))).toMatchObject({ ok: true, value: { data: { rows: [compact] } } });
  });
  it.each([ { data: [report.data[0], report.data[0]] }, { data: [{ ...report.data[0], dimensions: { ad_account_id: "999" } }] }, { data: [{ ...report.data[0], start: "2026-09-30" }] }, { data: [{ ...report.data[0], metrics: { cost: -1 } }] }, { data: [{ ...report.data[0], dimensions: {} }] } ])("rejects invalid report batches atomically", async ({ data }) => {
    const f = fixture({ response: () => Response.json({ code: 200, data }) });
    expect((await f.adapter.invoke(invocation({ command: reportCommand }))).ok).toBe(false);
  });
  it.each([ [401, {}, "unauthenticated"], [403, {}, "forbidden"], [429, {}, "limit_exceeded"], [400, { code: -10 }, "limit_exceeded"], [500, {}, "unavailable"] ])("maps HTTP %s without retry or raw errors", async (status, body, code) => {
    const f = fixture({ response: () => Response.json(body, { status: Number(status) }) });
    expect(await f.adapter.invoke(invocation())).toMatchObject({ ok: false, error: { code, retryable: false } }); expect(f.calls).toHaveLength(1);
  });
  it.each([ { accessToken: "bad\r\nheader" }, { accessToken: "synthetic-secret", expiresAt: now } ])("denies malformed/expired credentials", async credential => {
    const f = fixture({ credential }); expect((await f.adapter.invoke(invocation())).ok).toBe(false); expect(f.calls).toHaveLength(0);
  });
  it("rechecks admission and host egress after credential resolution", async () => {
    const f = fixture({ credentialHook: () => { f.configuration.admitted = false; } });
    expect((await f.adapter.invoke(invocation())).ok).toBe(false); expect(f.calls).toHaveLength(0);
    const host = fixture({ credentialHook: () => { host.state.egressAllowed = false; } });
    expect(await host.adapter.invoke(invocation())).toMatchObject({ ok: false, error: { code: "unavailable" } }); expect(host.calls).toHaveLength(0);
  });
  it("honors cancellation before and during credential resolution", async () => {
    const controller = new AbortController(); controller.abort(); const f = fixture();
    expect(await f.adapter.invoke(invocation(), { signal: controller.signal })).toMatchObject({ ok: false, error: { code: "cancelled" } }); expect(f.credentialCalls).toHaveLength(0);
    const during = new AbortController(); const g = fixture({ credentialHook: () => during.abort() });
    expect(await g.adapter.invoke(invocation(), { signal: during.signal })).toMatchObject({ ok: false, error: { code: "cancelled" } }); expect(g.calls).toHaveLength(0);
  });
  it("bounds actual streamed bytes and rejects malformed JSON", async () => {
    const f = fixture({ response: () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(600000)); controller.enqueue(new Uint8Array(500000)); controller.close(); } })) });
    expect(await f.adapter.invoke(invocation())).toMatchObject({ ok: false, error: { code: "limit_exceeded" } });
    const bad = fixture({ response: () => new Response("synthetic-secret") });
    expect(await bad.adapter.invoke(invocation())).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
    expect(JSON.stringify(bad.observations)).not.toContain("synthetic-secret");
    const json = JSON.stringify(accounts), exact = fixture({ response: () => new Response(json + " ".repeat(1048576 - Buffer.byteLength(json))) });
    expect((await exact.adapter.invoke(invocation())).ok).toBe(true);
  });
  it("bounds input and tolerates observer failure", async () => {
    const f = fixture({ observerThrows: true }); expect((await f.adapter.invoke(invocation())).ok).toBe(true);
    expect(await f.adapter.invoke({ ...invocation(), operationId: "x".repeat(65536) })).toMatchObject({ ok: false, error: { code: "limit_exceeded" } });
  });
  it.each(["caller", "deadline"] as const)("settles pending fetch on %s abort without retry", async source => {
    const pending = pendingFetch(), caller = new AbortController();
    const f = fixture({ response: pending.response });
    let settled = false;
    const result = f.adapter.invoke(invocation(), { signal: caller.signal });
    void result.then(() => { settled = true; });
    const signal = await pending.started;
    expect(settled).toBe(false); expect(signal.aborted).toBe(false);
    expect(f.deadlines.map(deadline => deadline.timeoutMs)).toEqual([15000]);
    (source === "caller" ? caller : f.deadlines[0].controller).abort();
    expect(signal.aborted).toBe(true);
    const code = source === "caller" ? "cancelled" : "unavailable";
    expect(await result).toMatchObject({ ok: false, error: { code, message: "Kakao request " + code, retryable: false } });
    expect(settled).toBe(true); expect(f.calls).toHaveLength(1); expect(f.credentialCalls).toHaveLength(1);
    expect(f.observations).toHaveLength(1); expect(f.observations[0].outcome).toBe(code);
  });
  it.each(["caller", "deadline"] as const)("settles pending body read on %s abort and releases the reader", async source => {
    const pending = pendingBody(), caller = new AbortController();
    const f = fixture({ response: pending.response });
    let settled = false;
    const result = f.adapter.invoke(invocation(), { signal: caller.signal });
    void result.then(() => { settled = true; });
    const { signal, body } = await pending.started;
    expect(settled).toBe(false); expect(signal.aborted).toBe(false); expect(body.locked).toBe(true);
    expect(f.deadlines.map(deadline => deadline.timeoutMs)).toEqual([15000]);
    (source === "caller" ? caller : f.deadlines[0].controller).abort();
    expect(signal.aborted).toBe(true);
    const code = source === "caller" ? "cancelled" : "unavailable";
    expect(await result).toMatchObject({ ok: false, error: { code, message: "Kakao request " + code, retryable: false } });
    expect(settled).toBe(true); expect(body.locked).toBe(false); expect(f.calls).toHaveLength(1);
    expect(f.observations).toHaveLength(1); expect(f.observations[0].outcome).toBe(code);
  });
  it("redacts thrown credential and network failures", async () => {
    const broker = fixture({ credentialHook: () => { throw new Error("synthetic-secret"); } });
    expect(await broker.adapter.invoke(invocation())).toMatchObject({ ok: false, error: { code: "unavailable", message: "Kakao request unavailable" } }); expect(broker.calls).toHaveLength(0);
    const network = fixture({ response: () => { throw new Error("synthetic-secret"); } });
    expect(await network.adapter.invoke(invocation())).toMatchObject({ ok: false, error: { code: "unavailable", message: "Kakao request unavailable" } }); expect(network.calls).toHaveLength(1);
  });
});

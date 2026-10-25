import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { commandSchema, createLineAdsAdapter, lineAdsTools } from "../src/index.js";
import { accountPage, bundle, campaignPage, fixture, invocation, report, reportPage } from "./fixtures.js";
import { dispatchSuite } from "./contract/dispatch-suite.js";

dispatchSuite({ name: "fixture", makeFixture: fixture });
describe("LINE read boundaries", () => {
  it("matches the official GET signing procedure with numeric account 123", async () => {
    const f = fixture(); f.state.time = 1640131200000;
    await f.adapter.invoke(invocation());
    const headers = f.calls[0].init.headers as Record<string, string>;
    expect(headers.Date).toBe("Wed, 22 Dec 2021 00:00:00 GMT");
    expect(headers.Authorization).toBe("Bearer eyJhbGciOiJIUzI1NiIsImtpZCI6IkxJTkVBRFNBTVBMRSIsInR5cCI6InRleHQvcGxhaW4ifQ==.ZTNiMGM0NDI5OGZjMWMxNDlhZmJmNGM4OTk2ZmI5MjQyN2FlNDFlNDY0OWI5MzRjYTQ5NTk5MWI3ODUyYjg1NQoKMjAyMTEyMjIKL2FwaS92My9hZGFjY291bnRzLzEyMy9jYW1wYWlnbnM=.ish0BWb9cpExPKvbZbJKC_0tc5TeN-yziN13ywQFaVE=");
    expect(headers["Content-Type"]).toBeUndefined(); expect(f.calls[0].init.body).toBeUndefined();
  });
  it("discovers accounts with only connection custody and authenticated group", async () => {
    const f = fixture({ response: () => Response.json(accountPage) }); f.binding.accountId = null;
    expect(await f.adapter.invoke(invocation({ command: { kind: "list_accounts" } }))).toMatchObject({ ok: true, value: { data: { items: [{ id: "123", currency: "JPY", timezone: "Asia/Tokyo", country: "JP" }] } } });
    expect(f.calls[0].url).toBe("https://ads.line.me/api/v3/groups/G1/adaccounts?page=1&size=100");
    expect(f.credentialCalls).toEqual([{ connectionId: "connection", accountId: null }]);
  });
  it.each(["TW", "TH"] as const)("keeps %s unavailable despite admission", async country => {
    const f = fixture(); f.binding.country = country;
    expect(await f.adapter.invoke(invocation())).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(f.calls).toEqual([]); expect(f.credentialCalls).toEqual([]);
  });
  it.each(["revoke", "rebind"])("blocks %s during credential resolution", async change => {
    const f = fixture({ credentialHook: ({ state, binding }) => { if (change === "revoke") state.admitted = false; else binding.accountId = "999"; } });
    expect(await f.adapter.invoke(invocation())).toMatchObject({ ok: false, error: { code: "forbidden" } }); expect(f.calls).toEqual([]);
  });
  it.each(["bearer", JSON.stringify({ ...bundle, groupId: "../foreign" }), JSON.stringify({ ...bundle, secretKey: "" })])("rejects malformed credential bundle %s", async token => {
    const f = fixture({ token });
    expect(await f.adapter.invoke(invocation())).toMatchObject({ ok: false, error: { code: "unauthenticated" } }); expect(f.calls).toEqual([]);
  });
  it.each([[401, "unauthenticated"], [403, "forbidden"], [429, "limit_exceeded"], [302, "unavailable"], [500, "unavailable"]])("maps HTTP %s without retry or body leakage", async (status, code) => {
    const f = fixture({ response: () => new Response(bundle.secretKey, { status: Number(status) }) });
    const result = await f.adapter.invoke(invocation()); expect(result).toMatchObject({ ok: false, error: { code, retryable: false } });
    expect(f.calls).toHaveLength(1); expect(JSON.stringify({ result, observations: f.observations })).not.toContain(bundle.secretKey);
  });
  it("bounds one page and never follows vendor links", async () => {
    const f = fixture({ response: () => Response.json({ ...campaignPage, paging: { page: 2, size: 1, totalElements: 3 }, next: "https://foreign.example/" }) });
    expect(await f.adapter.invoke(invocation({ command: { kind: "list_campaigns", page: 2, size: 1 } }))).toMatchObject({ ok: true, value: { data: { nextPage: 3 } } });
    expect(f.calls).toHaveLength(1); expect(f.calls[0].url).toBe("https://ads.line.me/api/v3/adaccounts/123/campaigns?page=2&size=1");
  });
  it.each([{ ...campaignPage, datas: [...campaignPage.datas, ...campaignPage.datas], paging: { page: 1, size: 100, totalElements: 2 } }, { ...campaignPage, datas: [{ ...campaignPage.datas[0], id: Number.MAX_SAFE_INTEGER + 1 }] }, { ...campaignPage, datas: [{ id: 456 }] }, { ...campaignPage, paging: { page: 2, size: 100, totalElements: 1 } }])("rejects invalid pages atomically", async page => {
    const f = fixture({ response: () => Response.json(page) });
    expect(await f.adapter.invoke(invocation())).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
  });
  it("preserves report dates, source and missing metrics without summing pages", async () => {
    const f = fixture({ response: () => Response.json(reportPage) });
    expect(await f.adapter.invoke(invocation({ command: report }))).toMatchObject({ ok: true, value: { data: { source: "line_ads_online_campaign", apiVersion: "v3", accountId: "123", currency: "JPY", timezone: "Asia/Tokyo", vendorDateRange: reportPage.timeRange, coverage: "page_only", rows: [{ campaignId: "456", cost: 12.75, impressions: 345, clicks: 7, conversions: null }] } } });
    expect(f.calls[0].url).toBe("https://ads.line.me/api/v3/adaccounts/123/reports/online/campaign?page=1&size=100&since=2026-10-20&until=2026-10-21");
  });
  it.each([{ ...reportPage, timeRange: { since: "2026-10-01", until: report.until } }, { ...reportPage, datas: [{ ...reportPage.datas[0], adaccount: { id: 999 } }] }, { ...reportPage, datas: [{ ...reportPage.datas[0], statistics: { currency: "USD", cost: 4 } }] }])("rejects conflicting report provenance", async page => {
    const f = fixture({ response: () => Response.json(page) });
    expect(await f.adapter.invoke(invocation({ command: report }))).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
  });
  it("does not infer zero spend when report statistics are absent", async () => {
    const f = fixture({ response: () => Response.json({ ...reportPage, datas: [{ adaccount: { id: 123 }, campaign: { id: 456 } }] }) });
    expect(await f.adapter.invoke(invocation({ command: report }))).toMatchObject({ ok: true, value: { data: { rows: [{ cost: null, impressions: null, clicks: null, conversions: null }] } } });
  });
  it("rejects malformed JSON", async () => {
    const f = fixture({ response: () => new Response("{bad") });
    expect(await f.adapter.invoke(invocation())).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } }); expect(f.calls).toHaveLength(1);
  });
  it("rejects an oversized valid page despite a misleading Content-Length", async () => {
    const page = JSON.stringify({ ...campaignPage, padding: "x".repeat(1048576) });
    const f = fixture({ response: () => new Response(page, { headers: { "Content-Length": "1" } }) });
    expect(await f.adapter.invoke(invocation())).toMatchObject({ ok: false, error: { code: "limit_exceeded" } }); expect(f.calls).toHaveLength(1);
  });
  it("denies inflated input without credentials", async () => {
    const f = fixture();
    for (const command of [{ kind: "list_campaigns", accountId: "999" }, { kind: "list_accounts", groupId: "G2" }, { kind: "create_campaign" }, { kind: "list_campaigns", size: 101 }]) {
      expect(await f.adapter.invoke({ ...invocation(), command } as unknown as ReturnType<typeof invocation>)).toMatchObject({ ok: false });
    }
    expect(f.calls).toEqual([]); expect(f.credentialCalls).toEqual([]);
    expect(commandSchema.safeParse({ ...report, since: "2026-02-30" }).success).toBe(false);
  });
  it("reports the input byte limit before field validation or credential access", async () => {
    const f = fixture();
    expect(await f.adapter.invoke({ ...invocation(), operationId: "x".repeat(65536) })).toMatchObject({ ok: false, error: { code: "limit_exceeded" } });
    expect(f.calls).toEqual([]); expect(f.credentialCalls).toEqual([]);
  });
  it("maps custody/telemetry failures without leaking secrets", async () => {
    const f = fixture({ credentialThrows: true }); expect(await f.adapter.invoke(invocation())).toMatchObject({ ok: false, error: { code: "unavailable" } });
    const telemetry = fixture({ observerThrows: true }); expect(await telemetry.adapter.invoke(invocation())).toMatchObject({ ok: true });
    expect(f.calls).toEqual([]);
  });
  it.each([false, true])("uses an injected 15-second deadline and maps its abort (caller signal: %s)", async withCallerSignal => {
    const deadline = new AbortController();
    const createDeadline = vi.fn((_required: { timeoutMs: number }) => deadline.signal);
    const caller = new AbortController();
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const f = fixture();
    const adapter = createLineAdsAdapter({ ...f.dependencies, createDeadline, fetch: async (_url, options) => new Promise((_resolve, reject) => { options!.signal!.addEventListener("abort", () => reject(new Error("timeout")), { once: true }); entered(); }) });
    const pending = adapter.invoke(invocation(), withCallerSignal ? { signal: caller.signal } : undefined); await ready; deadline.abort();
    expect(await pending).toMatchObject({ ok: false, error: { code: "unavailable", retryable: false } });
    expect(createDeadline).toHaveBeenCalledExactlyOnceWith({ timeoutMs: 15000 });
    expect(caller.signal.aborted).toBe(false);
  });
  it("packages only unadmitted read capabilities with matching source fingerprints", async () => {
    const root = new URL("../../", import.meta.url);
    const manifest = JSON.parse(await readFile(new URL("plugin.json", root), "utf8"));
    const capabilities = JSON.parse(await readFile(new URL("io.github.ainsep.openmarketing/capabilities.json", root), "utf8"));
    const fingerprint = createHash("sha256").update(await readFile(new URL("../src/commands.ts", import.meta.url))).digest("hex");
    expect(manifest.extensions["io.github.ainsep.openmarketing"]).toMatchObject({ enabled: false, admitted: false, capabilities: capabilities.capabilities });
    expect(lineAdsTools.map(tool => tool.name)).toEqual(["list_accounts", "list_campaigns", "report"]);
    expect(capabilities.capabilities).toHaveLength(2);
    for (const capability of capabilities.capabilities) expect(capability).toMatchObject({ admitted: false, effects: ["read"], schemaFingerprint: fingerprint });
    expect(JSON.parse(await readFile(new URL("mcp.json", root), "utf8")).mcpServers).toEqual({});
  });
});

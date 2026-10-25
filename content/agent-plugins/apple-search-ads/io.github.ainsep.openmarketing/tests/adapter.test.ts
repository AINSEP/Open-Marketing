import { describe, expect, it } from "vitest";
import { commandSchema, invokeAppleSearchAds } from "../src/index.js";
import { account, campaign, context, fixture, now, pagination, reportCommand, reportPage, reportRow } from "./fixtures.js";
import { dispatchSuite } from "./contract/dispatch-suite.js";
dispatchSuite({ name: "plugin fixture", makeFixture: fixture });

describe("Apple bounded reads", () => {
  it("maps a campaign page and sends the bound org with explicit pagination", async () => {
    const f = fixture(); f.state.response = () => Response.json({ data: [campaign], pagination: { ...pagination, startIndex: 1, itemsPerPage: 2 }, error: null });
    expect(await f.invoke({ command: { kind: "list_campaigns", offset: 1, limit: 2 } })).toMatchObject({ ok: true, value: { data: { items: [{ id: "456", orgId: "123", status: "PAUSED", dailyBudgetAmount: { amount: "37.0123" } }], pagination: { startIndex: 1, requestedLimit: 2, returned: 1, coverage: "page", totalResults: 3 } } } });
    expect(f.calls[0].url).toBe("https://api.searchads.apple.com/api/v5/campaigns?offset=1&limit=2");
    expect(new Headers(f.calls[0].init.headers).get("X-AP-Context")).toBe("orgId=123");
  });
  it("preserves UTC daily spend, dates and distinct tap/total install counts", async () => {
    const f = fixture(); f.state.response = () => Response.json(reportPage);
    expect(await f.invoke({ command: reportCommand })).toMatchObject({ ok: true, value: { data: { source: "apple_search_ads_campaign_reports", retrievedAt: now, timeZone: "UTC", availability: "reported", rows: [{ metadata: { campaignId: "456", orgId: "123" }, granularity: [{ date: "2026-10-22", taps: 17, tapInstalls: 4, totalInstalls: 9, localSpend: { amount: "123456789.123456789", currency: "USD" } }] }] } } });
    expect(f.calls[0].url).toBe("https://api.searchads.apple.com/api/v5/reports/campaigns"); expect(f.calls[0].init.method).toBe("POST");
    expect(JSON.parse(String(f.calls[0].init.body))).toEqual({ startTime: "2026-10-22", endTime: "2026-10-23", timeZone: "UTC", granularity: "DAILY", selector: { orderBy: [{ field: "campaignId", sortOrder: "ASCENDING" }], pagination: { offset: 0, limit: 100 } }, returnRowTotals: false, returnGrandTotals: false, returnRecordsWithNoMetrics: false });
  });
  it.each(["foreign", "unsafe", "duplicate", "wrong-date", "wrong-currency", "wrong-page"])("rejects an entire mixed-validity report: %s", async kind => {
    const f = fixture(); const page = structuredClone(reportPage);
    const second = structuredClone(reportRow); second.metadata.campaignId = 789;
    if (kind === "foreign") second.metadata.orgId = 999;
    if (kind === "unsafe") second.metadata.campaignId = Number.MAX_SAFE_INTEGER + 1;
    if (kind === "duplicate") second.metadata.campaignId = 456;
    if (kind === "wrong-date") second.granularity[0].date = "2026-10-24";
    if (kind === "wrong-currency") second.granularity[0].localSpend.currency = "EUR";
    if (kind === "wrong-page") page.pagination.startIndex = 1;
    page.data.reportingDataResponse.row.push(second); f.state.response = () => Response.json(page);
    expect(await f.invoke({ command: reportCommand })).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } }); expect(f.calls).toHaveLength(1);
  });
  it("returns no-data without inventing account totals", async () => {
    const f = fixture(); f.state.response = () => Response.json({ data: { reportingDataResponse: { row: [] } }, pagination: { totalResults: 0, startIndex: 0, itemsPerPage: 100 } });
    expect(await f.invoke({ command: reportCommand })).toMatchObject({ ok: true, value: { data: { availability: "no_data_access_unconfirmed", rows: [], pagination: { coverage: "page", returned: 0 } } } });
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
  it("rejects expired credentials and expired report windows before egress", async () => {
    const f = fixture(); f.state.credential = { ok: true, value: { accessToken: "synthetic-secret", expiresAt: now } };
    expect(await f.invoke()).toMatchObject({ ok: false, error: { code: "expired" } });
    expect(await f.invoke({ command: { kind: "report", startDate: "2026-01-01", endDate: "2026-01-02" } })).toMatchObject({ ok: false, error: { code: "invalid_input" } }); expect(f.calls).toEqual([]);
  });
  it.each(["{", "x".repeat(1048577)])("rejects malformed or oversized streamed JSON without leaking content", async raw => {
    const f = fixture(); f.state.response = () => new Response(raw);
    expect((await f.invoke()).ok).toBe(false); expect(f.calls).toHaveLength(1);
  });
  it("accepts the documented ACL singleton and strips unknown provider fields", async () => {
    const f = fixture(); f.state.response = () => Response.json({ data: { ...account, private: "synthetic-secret" }, pagination: null });
    const result = await f.invoke(); expect(result.ok).toBe(true); expect(JSON.stringify(result)).not.toContain("synthetic-secret");
  });
  it.each([{}, { kind: "list_campaigns", limit: 101 }, { kind: "list_campaigns", offset: -1 }, { kind: "list_accounts", url: "https://foreign.example" }, { kind: "report", startDate: "2026-02-30", endDate: "2026-10-23" }, { kind: "report", startDate: "2026-10-23", endDate: "2026-10-22" }])("rejects invalid command %# before credential access", async command => {
    const f = fixture(); expect(await f.invoke({ command })).toMatchObject({ ok: false, error: { code: "invalid_input" } }); expect(f.credentialCalls).toEqual([]); expect(f.calls).toEqual([]);
  });
  it("accepts exactly the DAILY date/page boundaries and rejects expanded windows", async () => {
    const f = fixture(); f.state.response = () => Response.json({ data: { reportingDataResponse: { row: [] } }, pagination: { totalResults: 0, startIndex: 0, itemsPerPage: 100 } });
    expect((await f.invoke({ command: { kind: "report", startDate: "2026-07-26", endDate: "2026-10-24", limit: 100 } })).ok).toBe(true);
    expect(await f.invoke({ command: { kind: "report", startDate: "2026-07-25", endDate: "2026-10-24" } })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(await f.invoke({ command: { kind: "report", startDate: "2026-10-24", endDate: "2026-10-25" } })).toMatchObject({ ok: false, error: { code: "invalid_input" } }); expect(f.calls).toHaveLength(1);
    expect(commandSchema.safeParse({ kind: "report", startDate: "2026-10-22", endDate: "2026-10-23" }).success).toBe(true);
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
    if (kind === "foreign") second.orgId = 999;
    if (kind === "unsafe") second.id = Number.MAX_SAFE_INTEGER + 1;
    f.state.response = () => Response.json({ data: [campaign, second], pagination: kind === "missing-page" ? null : pagination, error: kind === "error-envelope" ? { message: "synthetic-secret" } : null });
    expect(await f.invoke({ command: { kind: "list_campaigns" } })).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
  });
  it("rejects oversized/cyclic input before credentials and duplicate dates atomically", async () => {
    const f = fixture(); const cyclic: Record<string, unknown> = { kind: "list_accounts" }; cyclic.self = cyclic;
    expect(await f.invoke({ command: cyclic })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(await f.invoke({ command: { kind: "list_accounts", extra: "x".repeat(65536) } })).toMatchObject({ ok: false, error: { code: "limit_exceeded" } }); expect(f.credentialCalls).toEqual([]);
    const page = structuredClone(reportPage); page.data.reportingDataResponse.row[0].granularity.push(structuredClone(reportRow.granularity[0])); f.state.response = () => Response.json(page);
    expect(await f.invoke({ command: reportCommand })).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
  });
  it("freezes command bytes before broker awaits and rechecks expiry after them", async () => {
    const f = fixture(); const command = { kind: "list_campaigns", limit: 2 }; f.state.response = () => Response.json({ data: [campaign], pagination: { ...pagination, itemsPerPage: 2 } });
    f.state.credentialHook = () => { command.limit = 99; };
    expect((await f.invoke({ command })).ok).toBe(true); expect(f.calls[0].url).toBe("https://api.searchads.apple.com/api/v5/campaigns?offset=0&limit=2");
    const expired = fixture(); expired.state.credentialHook = () => { expired.state.time = now + 60000; };
    expect(await expired.invoke()).toMatchObject({ ok: false, error: { code: "expired" } }); expect(expired.calls).toEqual([]);
  });
});

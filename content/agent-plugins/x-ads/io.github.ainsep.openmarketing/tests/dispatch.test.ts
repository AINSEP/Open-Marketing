import { describe, expect, it } from "vitest";
import { accountAnalyticsPage, accountPage, accountReport, analyticsPage, campaignPage, context, dispatchSuite, fixture, now, pasted, report } from "./fixtures.js";

dispatchSuite({ name: "X fixture gateway / real plugin transport", makeFixture: () => fixture() });
describe("X read boundary", () => {
  it.each(["-1", "1.0"])("accepts safe provider numeric token %s before projecting extras away", async token => {
    const text = JSON.stringify(accountPage).slice(0, -1) + ',"provider_extra":' + token + '}';
    const f = fixture({ response: () => new Response(text) });
    expect(await f.invoke()).toMatchObject({ ok: true, value: { status: "succeeded" } });
    expect(f.calls).toHaveLength(1);
  });
  it.each(["not-json", JSON.stringify({ ...pasted, accessTokenSecret: undefined }), JSON.stringify({ ...pasted, extra: "x" }), JSON.stringify({ ...pasted, consumerKey: "\n" }), "x".repeat(65537)])("rejects invalid pasted credentials without egress", async credential => {
    const f = fixture({ credential }); expect(await f.invoke()).toMatchObject({ ok: false, error: { code: "unauthenticated" } }); expect(f.calls).toEqual([]);
  });
  it("rechecks expiry and cancellation after credentials; carries no broker secrets", async () => {
    const expired = fixture({ expiresAt: now }); expect(await expired.invoke()).toMatchObject({ ok: false, error: { code: "expired" } }); expect(expired.calls).toEqual([]);
    const f = fixture(); const controller = new AbortController(); f.credentialHook = () => controller.abort();
    expect(await f.invoke({}, { signal: controller.signal })).toMatchObject({ ok: false, error: { code: "cancelled" } }); expect(f.calls).toEqual([]);
  });
  it("encodes opaque cursors, includes drafts and strips provider extras", async () => {
    const f = fixture({ response: () => Response.json(campaignPage) });
    const result = await f.invoke({ command: { kind: "list_campaigns", count: 2, cursor: "next+/=" } });
    expect(result).toMatchObject({ ok: true, value: { data: { items: campaignPage.data, cursor: null } } });
    expect(f.calls[0].url).toBe("https://ads-api.x.com/12/accounts/abc1/campaigns?count=2&cursor=next%2B%2F%3D&with_draft=true");
    const accounts = await fixture().invoke(); expect(JSON.stringify(accounts)).not.toContain("untrusted");
    expect(f.effects[0]).toMatchObject({ operationId: "operation", connectionId: "connection", accountId: "abc1", effects: ["read"], moneyExposure: null });
  });
  it.each([401, 403, 429, 500, 302])("maps HTTP %i without retry or vendor body leakage", async status => {
    const f = fixture({ response: () => new Response("token-secret", { status }) }); const result = await f.invoke();
    const code = status === 401 ? "unauthenticated" : status === 403 ? "forbidden" : status === 429 ? "limit_exceeded" : "unavailable";
    expect(result).toMatchObject({ ok: false, error: { code, retryable: false } }); expect(f.calls).toHaveLength(1);
    expect(JSON.stringify([result, f.observations])).not.toContain("token-secret");
  });
  it("bounds response bytes across chunks and releases the stream", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(600000)); controller.enqueue(new Uint8Array(600000)); }, cancel() { cancelled = true; } });
    const f = fixture({ response: () => new Response(body) });
    expect(await f.invoke()).toMatchObject({ ok: false, error: { code: "limit_exceeded" } }); expect(cancelled).toBe(true); expect(body.locked).toBe(false);
  });
  it.each([null, { ...accountPage, data: [accountPage.data[0], accountPage.data[0]] }, { ...accountPage, next_cursor: "x".repeat(2049) }])("rejects invalid/duplicate pages atomically", async page => {
    const f = fixture({ response: () => Response.json(page) }); expect(await f.invoke()).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
  });
  it("rejects foreign campaign parents and rows exceeding the requested page size", async () => {
    const f = fixture({ response: () => Response.json({ ...campaignPage, request: { params: { account_id: "foreign" } } }) });
    expect(await f.invoke({ command: { kind: "list_campaigns" } })).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
    const many = fixture({ response: () => Response.json({ ...accountPage, data: [accountPage.data[0], { ...accountPage.data[0], id: "abc2" }] }) });
    expect(await many.invoke({ command: { kind: "list_accounts", count: 1 } })).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
  });
  it("passes deadline/redirect controls and returns account-preferred pacing headers", async () => {
    const f = fixture({ response: () => Response.json(accountPage, { headers: { "x-account-rate-limit-limit": "5", "x-account-rate-limit-remaining": "0", "x-account-rate-limit-reset": "1792800900", "x-rate-limit-limit": "999" } }) });
    expect(await f.invoke()).toMatchObject({ ok: true, value: { rateLimit: { limit: 5, remaining: 0, resetAtSeconds: 1792800900 } } });
    expect(f.calls[0].init.redirect).toBe("error"); expect(f.calls[0].init.signal).toBeInstanceOf(AbortSignal);
    expect(f.observations).toEqual([{ operation: "x_ads.list_accounts", outcome: "succeeded", correlationId: context.correlationId, traceId: context.traceId, runId: context.runId }]);
  });
  it("never sends twice even when a broken gateway calls execute twice", async () => {
    const f = fixture({ gateway: { async dispatch(input) { const first = await input.execute(); expect(first.ok).toBe(true); return input.execute(); } } });
    expect(await f.invoke()).toMatchObject({ ok: false, error: { code: "conflict" } }); expect(f.calls).toHaveLength(1);
  });
  it("maps thrown I/O errors and ignores observer failure", async () => {
    const broken = fixture({ response: async () => { throw new Error("consumer-secret"); } });
    expect(await broken.invoke()).toMatchObject({ ok: false, error: { code: "unavailable" } });
    const f = fixture(); f.dependencies.observer.observe = () => { throw new Error("observer"); };
    expect(await f.invoke()).toMatchObject({ ok: true });
  });
  it("preserves source/currency/window/placement and nullable metrics", async () => {
    const f = fixture({ response: () => Response.json(analyticsPage()) });
    expect(await f.invoke({ command: report })).toMatchObject({ ok: true, value: { data: { source: "x_ads_analytics", currency: "USD", retrievedAt: now, window: report.window, placement: "ALL_ON_TWITTER", rows: [{ entityId: "camp1", spendMicros: 1234567, impressions: 123, clicks: null }] } } });
    const url = new URL(f.calls[0].url); expect(url.pathname).toBe("/12/stats/accounts/abc1"); expect(Object.fromEntries(url.searchParams)).toMatchObject({ entity: "CAMPAIGN", entity_ids: "camp1", granularity: "TOTAL", metric_groups: "ENGAGEMENT,BILLING", end_time: new Date(now + 3600000).toISOString() });
  });
  it("requests only ENGAGEMENT for ACCOUNT and projects unsupported metrics as null", async () => {
    const f = fixture({ response: () => Response.json(accountAnalyticsPage()) });
    expect(await f.invoke({ command: accountReport })).toMatchObject({ ok: true, value: { data: { entity: "ACCOUNT", accountId: "abc1", currency: "USD", window: report.window, placement: "ALL_ON_TWITTER", availability: "reported", rows: [{ entityId: "abc1", impressions: 321, clicks: null, spendMicros: null }] } } });
    const url = new URL(f.calls[0].url); expect(url.pathname).toBe("/12/stats/accounts/abc1");
    expect(Object.fromEntries(url.searchParams)).toEqual({ entity: "ACCOUNT", entity_ids: "abc1", start_time: new Date(now).toISOString(), end_time: new Date(now + 3600000).toISOString(), granularity: "TOTAL", placement: "ALL_ON_TWITTER", metric_groups: "ENGAGEMENT" });
  });
  it("does not promote unexpected ACCOUNT clicks or spend into supported metrics", async () => {
    const page = accountAnalyticsPage();
    Object.assign(page.data[0].id_data[0].metrics, { clicks: [99], billed_charge_local_micro: [1234567] });
    expect(await fixture({ response: () => Response.json(page) }).invoke({ command: accountReport })).toMatchObject({ ok: true, value: { data: { rows: [{ entityId: "abc1", impressions: 321, clicks: null, spendMicros: null }] } } });
  });
  it.each(["missing", "billing", "duplicate"])("rejects %s ACCOUNT metric-group echoes", async defect => {
    const page = accountAnalyticsPage();
    page.request.params.metric_groups = defect === "missing" ? [] : defect === "billing" ? ["ENGAGEMENT", "BILLING"] : ["ENGAGEMENT", "ENGAGEMENT"];
    expect(await fixture({ response: () => Response.json(page) }).invoke({ command: accountReport })).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
  });
  it.each(["deadline", "caller"] as const)("cancels a pending streamed read on %s abort and never returns partial JSON", async source => {
    const deadline = new AbortController(), caller = new AbortController();
    let cancelCount = 0, pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls === 1) { controller.enqueue(new TextEncoder().encode(JSON.stringify(accountPage))); return; }
        // Complete JSON has arrived, but EOF has not. An abort must still fail the call.
        (source === "deadline" ? deadline : caller).abort();
      },
      cancel() { cancelCount += 1; },
    }, { highWaterMark: 0 });
    const timeouts: number[] = [];
    const f = fixture({ response: () => new Response(body), timeoutSignal: input => { timeouts.push(input.timeoutMs); return deadline.signal; } });
    const result = await f.invoke({}, source === "caller" ? { signal: caller.signal } : {});
    expect(result).toMatchObject({ ok: false, error: { code: source === "deadline" ? "unavailable" : "cancelled", retryable: false } });
    expect(timeouts).toEqual([15000]); expect(f.calls).toHaveLength(1);
    expect(f.calls[0].init.signal?.aborted).toBe(true);
    expect(pulls).toBe(2); expect(cancelCount).toBe(1); expect(body.locked).toBe(false);
  });
  it.each(["foreign", "duplicate", "unsafe", "window", "placement", "segment", "groups"])("rejects %s analytics atomically", async defect => {
    const page = analyticsPage();
    if (defect === "foreign") page.data[0].id = "other";
    if (defect === "duplicate") page.data.push(page.data[0]);
    if (defect === "unsafe") page.data[0].id_data[0].metrics.billed_charge_local_micro = [Number.MAX_SAFE_INTEGER + 1];
    if (defect === "window") page.request.params.end_time = new Date(now + 7200000).toISOString();
    if (defect === "placement") page.request.params.placement = "SPOTLIGHT";
    if (defect === "segment") Object.assign(page.data[0].id_data[0], { segment: "US" });
    if (defect === "groups") page.request.params.metric_groups = ["BILLING", "BILLING"];
    expect(await fixture({ response: () => Response.json(page) }).invoke({ command: report })).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
  });
  it("does not turn empty analytics into zero spend", async () => {
    const page = analyticsPage(); page.data = [];
    expect(await fixture({ response: () => Response.json(page) }).invoke({ command: report })).toMatchObject({ ok: true, value: { data: { rows: [], availability: "no_data_access_unconfirmed" } } });
  });
  it("rejects malformed JSON, invalid signing inputs and a failed broker", async () => {
    const badJson = fixture({ response: () => new Response("not-json") }); expect(await badJson.invoke()).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
    const badTime = fixture(); badTime.dependencies.clock.now = () => NaN;
    expect(await badTime.invoke()).toMatchObject({ ok: false, error: { code: "invalid_input" } }); expect(badTime.calls).toEqual([]);
    const badNonce = fixture(); badNonce.dependencies.ids.next = () => "bad\nnonce";
    expect(await badNonce.invoke()).toMatchObject({ ok: false, error: { code: "invalid_input" } }); expect(badNonce.calls).toEqual([]);
    const badBroker = fixture(); badBroker.dependencies.credentials.access = async () => ({ ok: false, error: { code: "unauthenticated", message: "token-secret", retryable: false } });
    expect(await badBroker.invoke()).toEqual({ ok: false, error: { code: "unauthenticated", message: "X Ads request failed (unauthenticated)", retryable: false } }); expect(badBroker.calls).toEqual([]);
  });
});

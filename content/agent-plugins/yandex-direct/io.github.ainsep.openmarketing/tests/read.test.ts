import { describe, expect, it } from "vitest";
import { createYandexDirectAdapter } from "../src/index.js";
import type { YandexDirectInvocation } from "../src/index.js";
import { account, campaign, configuration, fixture, invocation, now, report, tsv } from "./fixtures.js";
import { dispatchSuite } from "./contract/dispatch-suite.js";

dispatchSuite({ name: "fixture", makeFixture: fixture });
describe("Yandex read boundaries", () => {
  it("uses the host fence and credential login rather than local admission or configured login", async () => {
    const f = fixture({ configuration: { ...configuration, clientLogin: "ignored" } });
    expect(await createYandexDirectAdapter({ ...f.dependencies, admitted: () => false }).invoke(invocation())).toMatchObject({ ok: true });
    expect(new Headers(f.calls[0].init.headers).get("Client-Login")).toBe("fixture-login");
  });
  it("factory is inert; accountless connected/agency discovery uses credential Client-Login", async () => {
    const { accountId, clientLogin, currency, ...discovery } = configuration;
    const f = fixture({ configuration: discovery, response: () => Response.json({ result: { Clients: [{ ...account, Type: "AGENCY", Currency: undefined, token: "synthetic-secret" }] } }) });
    expect(f.calls).toHaveLength(0); expect(f.credentialCalls).toHaveLength(0);
    for (const view of ["connected", "agency"] as const) {
      const result = await f.adapter.invoke(invocation({ command: { kind: "list_accounts", view, limit: 1 } }));
      expect(result).toMatchObject({ ok: true, value: { data: { items: [{ ClientId: "123", Login: "fixture-login", Type: "AGENCY" }] } } });
      expect(JSON.stringify(result)).not.toContain("synthetic-secret");
      const call = f.calls.at(-1)!;
      expect(call.url).toBe("https://api.direct.yandex.com/json/v501/" + (view === "agency" ? "agencyclients" : "clients"));
      expect(new Headers(call.init.headers).get("Client-Login")).toBe("fixture-login");
      expect(JSON.parse(String(call.init.body))).toEqual({ method: "get", params: { FieldNames: ["ClientId", "Login", "Currency", "Type"], ...(view === "agency" ? { SelectionCriteria: {}, Page: { Limit: 1, Offset: 0 } } : {}) } });
    }
    expect(await f.adapter.invoke(invocation())).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(f.credentialCalls).toHaveLength(2);
  });
  it.each(["admission", "connection"])("revocation of %s after token lookup prevents egress", async kind => {
    const f = fixture({ credentialHook: () => { if (kind === "admission") f.state.admitted = false; else f.state.authorized = false; } });
    expect(await f.adapter.invoke(invocation())).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(f.credentialCalls).toHaveLength(1); expect(f.calls).toHaveLength(0);
  });
  it("rechecks admission inside execute and rejects a second callback send", async () => {
    const f = fixture();
    const gateway = { async dispatch(input: Parameters<typeof f.dependencies.gateway.dispatch>[0]) { f.state.admitted = false; return input.execute(); } };
    expect(await createYandexDirectAdapter({ ...f.dependencies, gateway }).invoke(invocation())).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(f.calls).toHaveLength(0);
    const twice = fixture({ repeatExecute: true });
    expect(await twice.adapter.invoke(invocation())).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(twice.calls).toHaveLength(1);
  });
  it("rejects expired/malformed credentials without leaking them", async () => {
    for (const { credential, code } of [{ credential: { accessToken: "synthetic-secret", expiresAt: now }, code: "expired" }, { credential: { accessToken: "synthetic-secret\n" }, code: "unauthenticated" }]) {
      const f = fixture({ credential }); const result = await f.adapter.invoke(invocation());
      expect(result).toMatchObject({ ok: false, error: { code, retryable: false } });
      expect(JSON.stringify(result)).not.toContain("synthetic-secret"); expect(f.calls).toHaveLength(0);
    }
  });
  it("rejects unsupported writes, extra fields, duplicate/unsafe IDs and oversized/cyclic inputs before I/O", async () => {
    const f = fixture(); const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    for (const command of [{ kind: "activate" }, { kind: "list_campaigns", url: "https://foreign.invalid" }, { kind: "list_campaigns", ids: ["456", "456"] }, { kind: "list_campaigns", ids: ["9007199254740992"] }, { kind: "list_accounts", view: "connected", offset: 1 }, { kind: "list_campaigns", text: "x".repeat(65536) }, cyclic]) {
      expect((await f.adapter.invoke(invocation({ command: command as YandexDirectInvocation["command"] }))).ok).toBe(false);
    }
    expect(f.calls).toHaveLength(0); expect(f.credentialCalls).toHaveLength(0);
  });
  it("normalizes filtered IDs and preserves bounded continuation without following provider links", async () => {
    const f = fixture({ response: () => Response.json({ result: { Campaigns: [{ ...campaign, url: "https://foreign.invalid" }], LimitedBy: 11 } }) });
    const result = await f.adapter.invoke(invocation({ command: { kind: "list_campaigns", ids: ["456"], limit: 1, offset: 10 } }));
    expect(result).toMatchObject({ ok: true, value: { data: { items: [{ Id: "456" }], nextOffset: 11, potentiallyIncomplete: true } } });
    expect(JSON.stringify(result)).not.toContain("foreign.invalid");
    expect(JSON.parse(String(f.calls[0].init.body)).params.SelectionCriteria).toEqual({ Ids: [456] });
  });
  it.each([{ items: [campaign, campaign] }, { items: [campaign, { ...campaign, Id: 789 }] }, { items: [campaign, { ...campaign, Id: 9007199254740992 }] }, { items: [{ ...campaign, State: "SURPRISE" }] }])("rejects an entire duplicate/foreign/malformed campaign page", async ({ items }) => {
    const f = fixture({ response: () => Response.json({ result: { Campaigns: items } }) });
    expect(await f.adapter.invoke(invocation({ command: { kind: "list_campaigns", ids: ["456"] } }))).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
  });
  it.each([401, 403, 429, 500, 201, 202])("does not retry HTTP %s", async status => {
    const f = fixture({ response: () => new Response("synthetic-secret", { status }) });
    expect((await f.adapter.invoke(invocation())).ok).toBe(false); expect(f.calls).toHaveLength(1);
  });
  it.each(["{", JSON.stringify({ error: { error_code: 53, error_string: "synthetic-secret" } }), "x".repeat(1048577)])("rejects malformed/error/oversized responses", async body => {
    const f = fixture({ response: () => new Response(body) }); const result = await f.adapter.invoke(invocation());
    expect(result.ok).toBe(false); expect(JSON.stringify(result)).not.toContain("synthetic-secret"); expect(f.calls).toHaveLength(1);
  });
  it("rejects foreign connected identity, excessive rows and stale continuations atomically", async () => {
    const identity = fixture({ response: () => Response.json({ result: { Clients: [{ ...account, ClientId: 789 }] } }) });
    expect(await identity.adapter.invoke(invocation({ command: { kind: "list_accounts", view: "connected" } }))).toMatchObject({ ok: false, error: { code: "forbidden" } });
    for (const result of [{ Campaigns: [campaign], LimitedBy: 10 }, { Campaigns: [], LimitedBy: 11 }, { Campaigns: [campaign, { ...campaign, Id: 789 }] }]) {
      const f = fixture({ response: () => Response.json({ result }) });
      expect(await f.adapter.invoke(invocation({ command: { kind: "list_campaigns", limit: 1, offset: 10 } }))).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
    }
  });
  it("preserves incompleteness at the offset cap and bounds a stream with misleading Content-Length", async () => {
    const f = fixture();
    expect(await f.adapter.invoke(invocation({ command: { kind: "list_campaigns", limit: 1, offset: 1000000 } }))).toMatchObject({ ok: true, value: { data: { nextOffset: null, potentiallyIncomplete: true } } });
    let cancelled = false;
    const oversized = fixture({ response: () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(1048577)); }, cancel() { cancelled = true; } }), { headers: { "Content-Length": "1" } }) });
    expect(await oversized.adapter.invoke(invocation())).toMatchObject({ ok: false, error: { code: "limit_exceeded" } });
    expect(cancelled).toBe(true); expect(oversized.calls).toHaveLength(1);
  });
  it("redacts thrown credential errors and records the failed operation with context IDs", async () => {
    const f = fixture();
    const adapter = createYandexDirectAdapter({ ...f.dependencies, credentials: { async access() { throw new Error("synthetic-secret"); } } });
    const result = await adapter.invoke(invocation());
    expect(result).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(JSON.stringify(result)).not.toContain("synthetic-secret"); expect(f.calls).toHaveLength(0);
    expect(f.observations).toEqual([{ operation: "yandex-direct.list_campaigns", outcome: "unavailable", correlationId: "correlation", traceId: "trace", runId: "run" }]);
  });
  it("rechecks cancellation and injected clock validity inside the host callback", async () => {
    const controller = new AbortController(); const cancelled = fixture({ credentialHook: () => controller.abort() });
    expect(await cancelled.adapter.invoke(invocation(), { signal: controller.signal })).toMatchObject({ ok: false, error: { code: "cancelled" } });
    const invalidClock = fixture(); invalidClock.state.time = NaN;
    expect(await invalidClock.adapter.invoke(invocation())).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(cancelled.calls).toHaveLength(0); expect(invalidClock.calls).toHaveLength(0);
  });
  it("maps fetch failures and cancellation to redacted outcomes; telemetry cannot change a read", async () => {
    const f = fixture({ response: () => { throw new Error("synthetic-secret"); } });
    expect(await f.adapter.invoke(invocation())).toMatchObject({ ok: false, error: { code: "unavailable" } });
    const controller = new AbortController(); const cancelled = fixture({ response: () => { controller.abort(); throw new Error("cancelled"); } });
    expect(await cancelled.adapter.invoke(invocation(), { signal: controller.signal })).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect((await fixture({ observerThrows: true }).adapter.invoke(invocation())).ok).toBe(true);
  });
  it.each(["fetch", "body"] as const)("deadline aborts a pending %s with one request and a typed failure", async phase => {
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const f = fixture({ response: ({ signal }) => {
      if (phase === "fetch") return new Promise<Response>((_, reject) => {
        signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
        entered();
      });
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) { signal!.addEventListener("abort", () => controller.error(signal!.reason), { once: true }); },
        pull() { entered(); },
      }, { highWaterMark: 0 }));
    } });
    const caller = new AbortController();
    const pending = f.adapter.invoke(invocation(), { signal: caller.signal });
    await started;
    expect(f.deadlines).toHaveLength(1); expect(f.deadlines[0].milliseconds).toBe(15000);
    expect(f.calls[0].init.signal?.aborted).toBe(false);
    f.deadlines[0].controller.abort(new Error("synthetic-secret"));
    const result = await pending;
    expect(result).toMatchObject({ ok: false, error: { code: "unavailable", retryable: false } });
    expect(f.calls[0].init.signal?.aborted).toBe(true); expect(caller.signal.aborted).toBe(false);
    expect(f.calls).toHaveLength(1); expect(f.effects).toHaveLength(1);
    expect(JSON.stringify({ result, observations: f.observations })).not.toContain("synthetic-secret");
  });
});
describe("fixed Yandex TSV reports", () => {
  it("preserves exact micros, provider dates and provenance; full pages are potentially incomplete", async () => {
    const f = fixture({ response: () => new Response(tsv) });
    expect(await f.adapter.invoke(invocation({ command: { ...report, limit: 1 } }))).toMatchObject({ ok: true, value: { data: { source: "yandex_direct_reports", apiVersion: "v501", accountId: "123", currency: "RUB", retrievedAt: now, calendar: "provider", moneyUnit: "micros", includeVAT: false, potentiallyIncomplete: true, nextOffset: 1, rows: [{ Date: "2026-10-01", CampaignId: "456", Impressions: "9007199254740993", Clicks: "2", Cost: "12345678901234567890" }] } } });
    const call = f.calls[0]; const headers = new Headers(call.init.headers);
    expect(call.url).toBe("https://api.direct.yandex.com/json/v501/reports");
    expect(headers.get("processingMode")).toBe("online"); expect(headers.has("returnMoneyInMicros")).toBe(false);
    expect(JSON.parse(String(call.init.body))).toMatchObject({ params: { ReportType: "CAMPAIGN_PERFORMANCE_REPORT", IncludeVAT: "NO", DateRangeType: "CUSTOM_DATE", Format: "TSV", FieldNames: ["Date", "CampaignId", "Impressions", "Clicks", "Cost"], Page: { Limit: 1, Offset: 0 }, SelectionCriteria: { Filter: [{ Field: "CampaignId", Operator: "IN", Values: ["456"] }] } } });
  });
  it("supports the fixed account view and preserves empty as no-data/access-unconfirmed", async () => {
    const f = fixture({ response: () => new Response("Date\tImpressions\tClicks\tCost\n") });
    expect(await f.adapter.invoke(invocation({ command: { kind: "report", view: "account", dateFrom: "2026-10-01", dateTo: "2026-10-31" } }))).toMatchObject({ ok: true, value: { data: { rows: [], availability: "no_data_access_unconfirmed", potentiallyIncomplete: false } } });
    expect(JSON.parse(String(f.calls[0].init.body)).params.ReportType).toBe("ACCOUNT_PERFORMANCE_REPORT");
  });
  it.each([tsv + tsv.split("\n")[1] + "\n", tsv.replace("\t456\t", "\t789\t"), tsv.replace("2026-10-01\t", "2026-10-03\t"), tsv.replace("\t2\t", "\t--\t"), tsv.replace("CampaignId", "Arbitrary"), tsv.replace("\t2\t", "\t2.1\t")])("atomically rejects duplicate/foreign/out-of-window/malformed rows", async body => {
    const f = fixture({ response: () => new Response(body) });
    expect(await f.adapter.invoke(invocation({ command: report }))).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
  });
  it.each([{ ...report, dateFrom: "2026-02-30" }, { ...report, dateTo: "2026-11-01" }, { ...report, dateTo: "2026-09-30" }, { ...report, view: "account" as const }, { ...report, limit: 1001 }, { ...report, offset: 1000001 }])("rejects impossible/long/reversed windows, inconsistent views and over-cap pages before secrets", async command => {
    const f = fixture();
    expect(await f.adapter.invoke(invocation({ command }))).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(f.calls).toHaveLength(0); expect(f.credentialCalls).toHaveLength(0);
  });
});

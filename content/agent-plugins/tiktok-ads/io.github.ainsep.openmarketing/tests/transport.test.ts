import { describe, expect, it } from "vitest";
import type { Outcome } from "@open-marketing/contracts";
import { createTikTokFetchEgress, decimalToMinor, decodeTikTokRead, decodeTikTokReport, encodeTikTokCommand, tiktokCommandSchema } from "../src/index.js";
import type { TikTokCommand } from "../src/index.js";
import { ad, adResponse, adgroup, adgroupResponse, advertiserResponse, campaign, campaignResponse, clock, context, fixture, metadata, pageInfo, reportQuery, reportResponse, request } from "./fixtures.js";

/** Assert the specific typed failure rather than accepting any error. */
function expectError(required: { result: Outcome<unknown>; code: string }): void {
  expect(required.result).toMatchObject({ ok: false, error: { code: required.code, retryable: false } });
}

for (const kind of ["memory", "fetch"] as const) {
  describe(`${kind} egress shared contract`, () => {
    it("reads the host-bound advertiser using scoped call-time credentials", async () => {
      const f = fixture({ kind });
      const result = await f.egress.send(request({ fixture: f }));
      expect(result).toEqual({ ok: true, value: { code: 0, data: advertiserResponse.data } });
      expect(f.credentialCalls).toEqual([{ context, connectionId: "connection", accountId: "123" }]);
      expect(f.sent).toHaveLength(1);
    });
    it("denies revocation before resolving credentials", async () => {
      const f = fixture({ kind }); f.state.current = false;
      expectError({ result: await f.egress.send(request({ fixture: f })), code: "forbidden" });
      expect(f.credentialCalls).toHaveLength(0); expect(f.sent).toHaveLength(0);
    });
    it("rechecks revocation after credentials resolve", async () => {
      const f = fixture({ kind }); f.state.onAccess = () => { f.state.current = false; };
      expectError({ result: await f.egress.send(request({ fixture: f })), code: "forbidden" });
      expect(f.credentialCalls).toHaveLength(1); expect(f.sent).toHaveLength(0);
    });
    it("cancels before credential lookup", async () => {
      const f = fixture({ kind }); const controller = new AbortController(); controller.abort();
      expectError({ result: await f.egress.send(request({ fixture: f }), { signal: controller.signal }), code: "cancelled" });
      expect(f.credentialCalls).toHaveLength(0); expect(f.sent).toHaveLength(0);
    });
    it("cancels during credential lookup without sending", async () => {
      const f = fixture({ kind }); const controller = new AbortController(); f.state.onAccess = () => controller.abort();
      expectError({ result: await f.egress.send(request({ fixture: f }), { signal: controller.signal }), code: "cancelled" });
      expect(f.credentialCalls).toHaveLength(1); expect(f.sent).toHaveLength(0);
    });
    it("rejects unsafe tokens without sending", async () => {
      const f = fixture({ kind }); f.state.token = "fixture\r\nInjected: secret";
      expectError({ result: await f.egress.send(request({ fixture: f })), code: "invalid_input" });
      expect(f.sent).toHaveLength(0);
    });
    it("preserves a typed credential denial and never retries", async () => {
      const f = fixture({ kind }); f.state.credentialError = { code: "forbidden", message: "Fixture denied", retryable: false };
      expectError({ result: await f.egress.send(request({ fixture: f })), code: "forbidden" });
      expect(f.credentialCalls).toHaveLength(1); expect(f.sent).toHaveLength(0);
    });
    it("rejects a successful HTTP body for a different advertiser", async () => {
      const body = structuredClone(advertiserResponse); body.data.list[0].advertiser_id = "999";
      const f = fixture({ kind, body });
      expectError({ result: await f.egress.send(request({ fixture: f })), code: "forbidden" });
      expect(f.sent).toHaveLength(1);
    });
    it("rejects nonzero vendor codes and malformed successful responses", async () => {
      const f = fixture({ kind, body: { code: 40001, message: "fixture-token" } });
      expectError({ result: await f.egress.send(request({ fixture: f })), code: "unavailable" });
      f.state.body = { code: 0, data: { list: [{}] } };
      expectError({ result: await f.egress.send(request({ fixture: f })), code: "invalid_input" });
      expect(f.sent).toHaveLength(2);
    });
    it.each([
      { command: { kind: "get-campaigns", page: 1, pageSize: 100 } as TikTokCommand, body: campaignResponse },
      { command: { kind: "get-adgroups", page: 1, pageSize: 100 } as TikTokCommand, body: adgroupResponse },
      { command: { kind: "get-ads", page: 1, pageSize: 100 } as TikTokCommand, body: adResponse },
      { command: reportQuery, body: reportResponse },
    ])("reads a bounded $command.kind page", async ({ command, body }) => {
      const f = fixture({ kind, body });
      expect(await f.egress.send(request({ fixture: f, command }))).toEqual({ ok: true, value: { code: 0, data: body.data } });
      expect(f.sent).toHaveLength(1);
    });
  });
}

describe("fixed read mappings and boundary validation", () => {
  it("uses advertiser_ids only for the configured advertiser", () => {
    expect(encodeTikTokCommand({ input: { kind: "get-advertiser" }, accountId: "123" })).toEqual({ ok: true, value: { method: "GET", path: "advertiser/info/", parameters: { advertiser_ids: '["123"]' } } });
  });
  it("maps only documented ID filter keys", () => {
    const cases = [
      { input: { kind: "get-campaigns", campaignIds: ["456"] }, path: "campaign/get/", filtering: '{"campaign_ids":["456"]}' },
      { input: { kind: "get-adgroups", adgroupIds: ["457"] }, path: "adgroup/get/", filtering: '{"adgroup_ids":["457"]}' },
      { input: { kind: "get-ads", adIds: ["458"] }, path: "ad/get/", filtering: '{"ad_ids":["458"]}' },
    ];
    for (const item of cases) expect(encodeTikTokCommand({ input: item.input, accountId: "123" })).toEqual({ ok: true, value: { method: "GET", path: item.path, parameters: { advertiser_id: "123", page: "1", page_size: "100", filtering: item.filtering } } });
  });
  it("requests only account-total spend, with inclusive dates", () => {
    expect(encodeTikTokCommand({ input: reportQuery, accountId: "123" })).toEqual({ ok: true, value: { method: "GET", path: "report/integrated/get/", parameters: { advertiser_id: "123", page: "1", page_size: "100", report_type: "BASIC", service_type: "AUCTION", data_level: "AUCTION_ADVERTISER", dimensions: '["advertiser_id"]', metrics: '["spend"]', start_date: "2026-10-01", end_date: "2026-10-13" } } });
  });
  it.each([
    { kind: "get-campaigns", pageSize: 101 }, { kind: "get-ads", page: 0 },
    { kind: "get-ads", adIds: ["456", "456"] }, { kind: "get-ads", adIds: Array.from({ length: 101 }, (_, i) => String(i + 1)) },
    { kind: "get-advertiser", advertiser_id: "999" }, { kind: "get-advertiser", accessToken: "secret" },
    { kind: "get-advertiser", endpoint: "https://example.com" }, { kind: "create-campaign" },
    { kind: "report", startDate: "2026-10-13", endDate: "2026-10-01" },
    { kind: "report", startDate: "2026-10-01", endDate: "2026-11-01" },
    { kind: "report", startDate: "2026-02-30", endDate: "2026-03-01" },
  ])("rejects closed-command or bound violation %j", input => {
    expectError({ result: encodeTikTokCommand({ input, accountId: "123" }), code: "invalid_input" });
  });
  it("accepts exactly 31 dates and 100 IDs", () => {
    expect(tiktokCommandSchema.safeParse({ kind: "report", startDate: "2026-10-01", endDate: "2026-10-31" }).success).toBe(true);
    expect(tiktokCommandSchema.safeParse({ kind: "get-ads", adIds: Array.from({ length: 100 }, (_, i) => String(i + 1)) }).success).toBe(true);
    expectError({ result: encodeTikTokCommand({ input: { kind: "get-advertiser" }, accountId: "123/evil" }), code: "invalid_input" });
  });
  it("rejects mixed-account pages atomically", () => {
    const body = { code: 0, data: { list: [campaignResponse.data.list[0], { ...campaignResponse.data.list[0], advertiser_id: "999", campaign_id: "999" }], page_info: { ...pageInfo, total_number: 2 } } };
    expectError({ result: decodeTikTokRead({ input: body, accountId: "123", command: { kind: "get-campaigns", page: 1, pageSize: 100 } }), code: "forbidden" });
  });
  it("rejects duplicate entities and responses outside a requested filter", () => {
    const command: TikTokCommand = { kind: "get-campaigns", page: 1, pageSize: 100, campaignIds: ["789"] };
    expectError({ result: decodeTikTokRead({ input: campaignResponse, accountId: "123", command }), code: "forbidden" });
    const body = { code: 0, data: { list: [campaignResponse.data.list[0], campaignResponse.data.list[0]], page_info: { ...pageInfo, total_number: 2 } } };
    expectError({ result: decodeTikTokRead({ input: body, accountId: "123", command: { kind: "get-campaigns", page: 1, pageSize: 100 } }), code: "invalid_input" });
  });
  it("rejects missing rows and wrong pagination", () => {
    const command: TikTokCommand = { kind: "get-campaigns", page: 1, pageSize: 100 };
    const partial = { code: 0, data: { list: [], page_info: pageInfo } };
    expectError({ result: decodeTikTokRead({ input: partial, command, accountId: "123" }), code: "invalid_input" });
    const wrongPage = { code: 0, data: { ...campaignResponse.data, page_info: { ...pageInfo, page: 2 } } };
    expectError({ result: decodeTikTokRead({ input: wrongPage, command, accountId: "123" }), code: "conflict" });
  });
  it("rejects inconsistent totals, out-of-range pages and missing code:0", () => {
    const command: TikTokCommand = { kind: "get-campaigns", page: 1, pageSize: 100 };
    const inconsistent = { code: 0, data: { ...campaignResponse.data, page_info: { ...pageInfo, total_page: 2 } } };
    expectError({ result: decodeTikTokRead({ input: inconsistent, command, accountId: "123" }), code: "invalid_input" });
    const outside = { code: 0, data: { list: [], page_info: { ...pageInfo, page: 2 } } };
    expectError({ result: decodeTikTokRead({ input: outside, command: { ...command, page: 2 }, accountId: "123" }), code: "invalid_input" });
    expectError({ result: decodeTikTokRead({ input: { data: campaignResponse.data }, command, accountId: "123" }), code: "invalid_input" });
  });
  it("preserves unknown statuses without claiming serving state", () => {
    const body = structuredClone(campaignResponse); body.data.list[0].operation_status = "VENDOR_NEW_STATUS";
    expect(decodeTikTokRead({ input: body, accountId: "123", command: { kind: "get-campaigns", page: 1, pageSize: 100 } })).toEqual({ ok: true, value: body });
  });
  it("strips unrequested vendor fields instead of echoing them", () => {
    const body = { ...advertiserResponse, message: "fixture-token", data: { list: [{ ...advertiserResponse.data.list[0], access_token: "fixture-token" }] } };
    expect(decodeTikTokRead({ input: body, command: { kind: "get-advertiser" }, accountId: "123" })).toEqual({ ok: true, value: { code: 0, data: advertiserResponse.data } });
  });
});

describe("fetch edge", () => {
  it.each([{ command: campaign, path: "campaign/create/", fields: { advertiser_id: "123", campaign_name: "Fixture campaign", objective_type: "TRAFFIC", budget_mode: "BUDGET_MODE_DAY", budget: 20, operation_status: "DISABLE" } }, { command: adgroup, path: "adgroup/create/", fields: { advertiser_id: "123", campaign_id: "456", adgroup_name: "Fixture group", budget_mode: "BUDGET_MODE_DAY", budget: 20, operation_status: "DISABLE", placements: ["PLACEMENT_TIKTOK"], location_ids: ["6252001"], promotion_type: "WEBSITE", optimization_goal: "CLICK", billing_event: "CPC", pacing: "PACING_MODE_SMOOTH", schedule_type: "SCHEDULE_FROM_NOW", schedule_start_time: "2026-10-13 00:00:00" } }, { command: ad, path: "ad/create/", fields: { advertiser_id: "123", adgroup_id: "457", creatives: [{ ad_name: "Fixture ad", ad_text: "Fixture creative", ad_format: "SINGLE_VIDEO", video_id: "fixture-video", identity_type: "AUTH_CODE", identity_id: "fixture-identity", landing_page_url: "https://example.com/signup", call_to_action: "LEARN_MORE", operation_status: "DISABLE" }] } }])("sends an explicitly disabled authenticated $path POST", async ({ command, path, fields }) => {
    const f = fixture({ kind: "fetch", body: { code: 0, data: {} } });
    expect(await f.egress.send(request({ fixture: f, command }))).toEqual({ ok: true, value: { code: 0, data: {} } });
    const call = f.fetchCalls[0];
    expect(call.url).toBe("https://business-api.tiktok.com/open_api/v1.3/" + path);
    expect(call.init).toMatchObject({ method: "POST", redirect: "error", headers: { "Access-Token": "fixture-token", "Content-Type": "application/json" } });
    expect(JSON.parse(String(call.init?.body))).toMatchObject(fields);
    expect(String(call.init?.body)).not.toContain("fixture-token");
    expect(f.fetchCalls).toHaveLength(1);
  });
  it("keeps an incomplete POST receipt uncertain without retrying", async () => {
    const f = fixture({ kind: "fetch", fetch: async () => new Response('{"code":0') });
    expectError({ result: await f.egress.send(request({ fixture: f, command: campaign })), code: "unavailable" });
    expect(f.fetchCalls).toHaveLength(1);
  });
  it("blocks cross-account credential requests and write inflation before HTTP", async () => {
    const f = fixture({ kind: "fetch" });
    expectError({ result: await f.egress.send({ ...request({ fixture: f, command: campaign }), accountId: "999" }), code: "forbidden" });
    expectError({ result: await f.egress.send(request({ fixture: f, command: { ...campaign, operation_status: "ENABLE" } as unknown as TikTokCommand })), code: "invalid_input" });
    expect(f.fetchCalls).toHaveLength(0);
  });
  it("sets the call-time Access-Token header on a fixed GET and propagates a deadline", async () => {
    const f = fixture({ kind: "fetch" });
    await f.egress.send(request({ fixture: f }));
    expect(f.fetchCalls).toHaveLength(1);
    const call = f.fetchCalls[0];
    expect(call.url).toBe("https://business-api.tiktok.com/open_api/v1.3/advertiser/info/?advertiser_ids=%5B%22123%22%5D");
    expect(call.init).toMatchObject({ method: "GET", redirect: "error", headers: { "Access-Token": "fixture-token", Accept: "application/json" } });
    expect(call.init?.signal).toBeInstanceOf(AbortSignal);
    expect(f.observations).toEqual([{ operation: "tiktok-ads.http", outcome: "received", correlationId: "correlation", traceId: "trace", runId: "run" }]);
    f.state.token = "replacement-token";
    await f.egress.send(request({ fixture: f }));
    expect(f.fetchCalls[1].init?.headers).toMatchObject({ "Access-Token": "replacement-token" });
  });
  it("does not retry fetch failures or expose thrown credentials/errors", async () => {
    const f = fixture({ kind: "fetch", fetch: async () => { throw new Error("fixture-token"); } });
    const result = await f.egress.send(request({ fixture: f }));
    expectError({ result, code: "unavailable" }); expect(f.fetchCalls).toHaveLength(1);
    expect(JSON.stringify({ result, observations: f.observations })).not.toContain("fixture-token");
  });
  it("rejects malformed request context before credentials or fetch", async () => {
    const f = fixture({ kind: "fetch" });
    const input = request({ fixture: f });
    expectError({ result: await f.egress.send({ ...input, accountId: "123/evil" }), code: "invalid_input" });
    expectError({ result: await f.egress.send({ ...input, context: { ...context, traceId: "" } }), code: "invalid_input" });
    expect(f.credentialCalls).toHaveLength(0); expect(f.fetchCalls).toHaveLength(0);
  });
  it("redacts opaque credential exceptions before fetch", async () => {
    let calls = 0;
    const egress = createTikTokFetchEgress({ fetch: async () => { calls += 1; return Response.json(advertiserResponse); }, credentials: { access: async () => { throw new Error("fixture-token"); } }, observer: { observe: () => undefined } });
    const f = fixture({ kind: "fetch" });
    const result = await egress.send(request({ fixture: f }));
    expectError({ result, code: "unavailable" }); expect(calls).toBe(0);
    expect(JSON.stringify(result)).not.toContain("fixture-token");
  });
  it("never reads an HTTP error body", async () => {
    const f = fixture({ kind: "fetch", fetch: async () => new Response("fixture-token", { status: 401 }) });
    const result = await f.egress.send(request({ fixture: f }));
    expectError({ result, code: "unavailable" }); expect(f.fetchCalls).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("fixture-token");
  });
  it.each(["not-json", '{"code":0', "", '\uFFFD'])('rejects incomplete or malformed body "%s"', async body => {
    const f = fixture({ kind: "fetch", fetch: async () => new Response(body) });
    expectError({ result: await f.egress.send(request({ fixture: f })), code: "invalid_input" });
  });
  it("enforces the streaming byte ceiling even with a false Content-Length", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(1048576)); controller.enqueue(new Uint8Array(1)); }, cancel() { cancelled = true; } });
    const f = fixture({ kind: "fetch", fetch: async () => new Response(stream, { headers: { "Content-Length": "1" } }) });
    expectError({ result: await f.egress.send(request({ fixture: f })), code: "limit_exceeded" });
    expect(cancelled).toBe(true); expect(f.fetchCalls).toHaveLength(1);
  });
  it("accepts a valid JSON response at exactly 1 MiB", async () => {
    const text = JSON.stringify(advertiserResponse);
    const body = text + " ".repeat(1048576 - Buffer.byteLength(text));
    const f = fixture({ kind: "fetch", fetch: async () => new Response(body) });
    expect(await f.egress.send(request({ fixture: f }))).toEqual({ ok: true, value: { code: 0, data: advertiserResponse.data } });
  });
  it("rejects invalid UTF-8 and interrupted streams", async () => {
    const invalidUtf8 = fixture({ kind: "fetch", fetch: async () => new Response(new Uint8Array([0xff])) });
    expectError({ result: await invalidUtf8.egress.send(request({ fixture: invalidUtf8 })), code: "invalid_input" });
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error("fixture stream interrupted")); } });
    const interrupted = fixture({ kind: "fetch", fetch: async () => new Response(stream) });
    expectError({ result: await interrupted.egress.send(request({ fixture: interrupted })), code: "invalid_input" });
  });
  it("isolates observer failure from the provider result", async () => {
    const egress = createTikTokFetchEgress({ fetch: async () => Response.json(advertiserResponse), credentials: { access: async () => ({ ok: true, value: { accessToken: "fixture" } }) }, observer: { observe: () => { throw new Error("fixture observation failed"); } } });
    const f = fixture({ kind: "fetch" });
    expect(await egress.send(request({ fixture: f }))).toEqual({ ok: true, value: { code: 0, data: advertiserResponse.data } });
  });
});

describe("account-spend reporting", () => {
  const decode = ({ input }: { input: unknown }) => decodeTikTokReport({ input, query: reportQuery, accountMetadata: metadata, snapshotId: "snapshot", retrievedAt: clock.now({}) });
  it("preserves exact money, account, local period, timezone and retrieval time", () => {
    expect(decode({ input: reportResponse })).toEqual({ ok: true, value: { snapshotId: "snapshot", accountId: "123", currency: "USD", timezone: "America/Los_Angeles", startDate: "2026-10-01", endDate: "2026-10-13", retrievedAt: clock.now({}), pageInfo, complete: true, rows: [{ accountId: "123", spend: { currency: "USD", minorUnits: 1234 } }], spend: { currency: "USD", minorUnits: 1234 } } });
  });
  it("keeps partial pages from becoming spend snapshots", () => {
    const body = { code: 0, data: { ...reportResponse.data, page_info: { page: 1, page_size: 1, total_page: 2, total_number: 2 } } };
    const result = decodeTikTokReport({ input: body, query: { ...reportQuery, pageSize: 1 }, accountMetadata: metadata, snapshotId: "snapshot", retrievedAt: clock.now({}) });
    expect(result).toMatchObject({ ok: true, value: { complete: false, spend: null, rows: [{ spend: { minorUnits: 1234 } }], pageInfo: body.data.page_info } });
  });
  it("never equates an empty report with zero spend", () => {
    const body = { code: 0, data: { list: [], page_info: { ...pageInfo, total_page: 0, total_number: 0 } } };
    expect(decode({ input: body })).toMatchObject({ ok: true, value: { complete: false, rows: [], spend: null } });
  });
  it("rejects duplicate or cross-account totals rather than summing them", () => {
    const duplicate = { code: 0, data: { list: [reportResponse.data.list[0], reportResponse.data.list[0]], page_info: { ...pageInfo, total_number: 2 } } };
    expectError({ result: decode({ input: duplicate }), code: "invalid_input" });
    const foreign = structuredClone(reportResponse); foreign.data.list[0].dimensions.advertiser_id = "999";
    expectError({ result: decode({ input: foreign }), code: "forbidden" });
  });
  it("rejects unknown timezone labels and invalid currency/exponent metadata", () => {
    for (const accountMetadata of [{ ...metadata, timezone: "UTC + 8" }, { ...metadata, currency: "usd" }, { ...metadata, minorUnitExponent: 4 }]) {
      expectError({ result: decodeTikTokReport({ input: reportResponse, query: reportQuery, accountMetadata, snapshotId: "snapshot", retrievedAt: clock.now({}) }), code: "invalid_input" });
    }
  });
  it("rejects unsupported report precision even on a partial page", () => {
    const body = { code: 0, data: { list: [{ dimensions: { advertiser_id: "123" }, metrics: { spend: "1.001" } }], page_info: { page: 1, page_size: 1, total_page: 2, total_number: 2 } } };
    expectError({ result: decodeTikTokReport({ input: body, query: { ...reportQuery, pageSize: 1 }, accountMetadata: metadata, snapshotId: "snapshot", retrievedAt: clock.now({}) }), code: "invalid_input" });
  });
  it.each([{ amount: "0", exponent: 0, minor: 0 }, { amount: "12.3", exponent: 2, minor: 1230 }, { amount: "0.001", exponent: 3, minor: 1 }, { amount: "90071992547409.91", exponent: 2, minor: Number.MAX_SAFE_INTEGER }])("converts exact decimal %j", ({ amount, exponent, minor }) => {
    expect(decimalToMinor({ amount, exponent })).toEqual({ ok: true, value: minor });
  });
  it.each([{ amount: "1.001", exponent: 2 }, { amount: "-1", exponent: 2 }, { amount: "1e3", exponent: 2 }, { amount: "01.00", exponent: 2 }, { amount: "1", exponent: -1 }])("rejects rounding or malformed money %j", input => {
    expectError({ result: decimalToMinor(input), code: "invalid_input" });
  });
  it("rejects money overflow", () => {
    expectError({ result: decimalToMinor({ amount: "90071992547409.92", exponent: 2 }), code: "limit_exceeded" });
  });
});

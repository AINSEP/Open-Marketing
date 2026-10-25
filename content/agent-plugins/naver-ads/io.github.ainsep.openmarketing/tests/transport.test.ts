import { describe, expect, it, vi } from "vitest";
import { createNaverAdsAdapter, commandSchema, naverAdsTools } from "../src/index.js";
import { accountPage, campaign, fixture, invocation, now, reportCommand, reportPage } from "./fixtures.js";
import { dispatchSuite } from "./contract/dispatch-suite.js";

dispatchSuite({ name: "memory credentials + recorded HTTP", makeFixture: fixture });
describe("Naver read transport", () => {
  it("signs path-only HMAC bytes and maps cursor to documented pagination", async () => {
    const f = fixture();
    await f.adapter.invoke(invocation({ command: { kind: "list_campaigns", cursor: "cmp-previous", pageSize: 1 } }));
    expect(f.calls[0]!.url).toBe("https://api.searchad.naver.com/ncc/campaigns?recordSize=1&selector=NEXT&baseSearchId=cmp-previous");
    const headers = new Headers(f.calls[0]!.init.headers);
    expect(headers.get("X-Signature")).toBe("rMFpZ5ZyxMlkMnW2i0inGN+gW4vvpazPVMhSukHsX2I=");
    expect(headers.get("X-Timestamp")).toBe(String(now));
    expect(f.calls[0]!.init).toMatchObject({ method: "GET", redirect: "error" });
  });
  it("lists account numbers separately from customer identities using the key-owner header", async () => {
    const f = fixture({ response: () => Response.json(accountPage) });
    expect(await f.adapter.invoke(invocation({ command: { kind: "list_accounts" } }))).toMatchObject({ ok: true, value: { data: { items: [{ adAccountNo: "999", adAccount: { masterCustomerId: "222" } }], nextPage: null } } });
    expect(new Headers(f.calls[0]!.init.headers).get("X-Customer")).toBe("111");
    expect(f.calls[0]!.url).toBe("https://api.searchad.naver.com/ad-accounts?page=0&size=100");
  });
  it.each([{ ...accountPage, content: [accountPage.content[0], accountPage.content[0]] }, { ...accountPage, number: 1 }, { ...accountPage, content: [{ ...accountPage.content[0], adAccountNo: 888 }] }])("rejects duplicate, wrong-page and mismatched account identities", async body => {
    const f = fixture({ response: () => Response.json(body) });
    expect(await f.adapter.invoke(invocation({ command: { kind: "list_accounts" } }))).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
  });
  it("cancels after credential resolution without sending", async () => {
    const controller = new AbortController();
    const f = fixture({ credentialHook: () => controller.abort() });
    expect(await f.adapter.invoke(invocation(), { signal: controller.signal })).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(f.calls).toHaveLength(0);
  });
  it.each(["fixture-license", "!~AZaz09+/="])("accepts printable ASCII credentials", async key => {
    const f = fixture({ credential: JSON.stringify({ apiKey: key, secretKey: key, customerId: "111" }) });
    expect(await f.adapter.invoke(invocation())).toMatchObject({ ok: true });
    expect(f.calls).toHaveLength(1);
  });
  it.each(["not json", "{}", "x".repeat(16385), ...["", " ", "key\n", "key\u007f", "keyé"].flatMap(key => [JSON.stringify({ apiKey: key, secretKey: "fixture-secret", customerId: "111" }), JSON.stringify({ apiKey: "fixture-license", secretKey: key, customerId: "111" })])])("redacts invalid credentials", async credential => {
    const f = fixture({ credential });
    const result = await f.adapter.invoke(invocation());
    expect(result).toMatchObject({ ok: false, error: { code: "unauthenticated" } }); expect(f.calls).toHaveLength(0);
    expect(JSON.stringify({ result, observations: f.observations })).not.toMatch(/fixture-secret|fixture-license/);
  });
  it("forbids a valid credential belonging to a different customer", async () => {
    const f = fixture({ credential: JSON.stringify({ apiKey: "fixture-license", secretKey: "fixture-secret", customerId: "333" }) });
    const result = await f.adapter.invoke(invocation());
    expect(result).toMatchObject({ ok: false, error: { code: "forbidden" } }); expect(f.calls).toHaveLength(0);
    expect(JSON.stringify({ result, observations: f.observations })).not.toMatch(/fixture-secret|fixture-license/);
  });
  it("rechecks admission after credential resolution", async () => {
    const f = fixture({ credentialHook: () => { f.configuration.admitted = false; } });
    expect(await f.adapter.invoke(invocation())).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(f.calls).toHaveLength(0);
  });
  it.each([{ body: [campaign, { ...campaign, customerId: 333 }] }, { body: [campaign, campaign] }, { body: [{ ...campaign, customerId: 9007199254740992 }] }, { body: [{ ...campaign, status: "UNKNOWN" }] }, { body: { elements: [campaign] } }])("rejects the entire foreign, duplicate or malformed page", async ({ body }) => {
    const f = fixture({ response: () => Response.json(body) });
    expect(await f.adapter.invoke(invocation())).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
  });
  it("preserves VAT-inclusive KRW report provenance and sends explicit KST dates", async () => {
    const f = fixture({ response: () => Response.json(reportPage) });
    expect(await f.adapter.invoke(invocation({ command: reportCommand }))).toMatchObject({ ok: true, value: { data: { source: "naver_search_ads_stats", accountId: "222", currency: "KRW", timezone: "Asia/Seoul", vatIncluded: true, retrievedAt: now, availability: "reported", rows: [{ campaignId: campaign.nccCampaignId, impressions: 120, clicks: 4, spend: 3300 }] } } });
    const query = new URL(f.calls[0]!.url).searchParams;
    expect(query.get("ids")).toBe(campaign.nccCampaignId); expect(query.get("timeIncrement")).toBe("allDays");
    expect(JSON.parse(query.get("timeRange")!)).toEqual({ since: "2026-10-01", until: "2026-10-24" });
  });
  it.each([{ body: { data: [] }, empty: true }, { body: { data: [{ ...reportPage.data[0], id: "cmp-foreign" }] }, empty: false }, { body: { data: [reportPage.data[0], reportPage.data[0]] }, empty: false }, { body: { data: [{ ...reportPage.data[0], salesAmt: 1.5 }] }, empty: false }, { body: {}, empty: false }])("distinguishes empty stats from invalid stats", async ({ body, empty }) => {
    const f = fixture({ response: () => Response.json(body) });
    const result = await f.adapter.invoke(invocation({ command: reportCommand }));
    if (empty) expect(result).toMatchObject({ ok: true, value: { data: { availability: "no_data_access_unconfirmed", rows: [] } } });
    else expect(result).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
  });
  it("keeps report windows bounded and rejects unsupported commands", () => {
    expect(commandSchema.safeParse({ ...reportCommand, since: "2026-02-30" }).success).toBe(false);
    expect(commandSchema.safeParse({ ...reportCommand, since: "2026-09-01" }).success).toBe(false);
    expect(commandSchema.safeParse({ ...reportCommand, until: "2026-09-30" }).success).toBe(false);
    expect(commandSchema.safeParse({ ...reportCommand, until: "2026-10-31" }).success).toBe(true);
    expect(naverAdsTools.map(tool => tool.name)).toEqual(["list_accounts", "list_campaigns", "report"]);
  });
  it.each([{ status: 401, code: "unauthenticated" }, { status: 403, code: "forbidden" }, { status: 429, code: "limit_exceeded" }, { status: 500, code: "unavailable" }, { status: 302, code: "protocol_mismatch" }])("does not retry or echo vendor failures", async ({ status, code }) => {
    const f = fixture({ response: () => new Response("fixture-secret", { status }) });
    expect(await f.adapter.invoke(invocation())).toMatchObject({ ok: false, error: { code } }); expect(f.calls).toHaveLength(1);
    expect(JSON.stringify(f.observations)).not.toContain("fixture-secret");
  });
  it("rejects oversized streamed bodies and malformed JSON", async () => {
    const oversized = fixture({ response: () => Response.json([{ ...campaign, padding: "x".repeat(1048576) }]) });
    expect(await oversized.adapter.invoke(invocation())).toMatchObject({ ok: false, error: { code: "limit_exceeded" } });
    const malformed = fixture({ response: () => new Response("{broken") });
    expect(await malformed.adapter.invoke(invocation())).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
  });
  it("bounds input before credentials and isolates broker/observer exceptions", async () => {
    const f = fixture({ observerThrows: true });
    expect((await f.adapter.invoke(invocation())).ok).toBe(true);
    expect(await f.adapter.invoke({ ...invocation(), operationId: "x".repeat(65537) })).toMatchObject({ ok: false, error: { code: "limit_exceeded" } });
    const broken = fixture(); broken.dependencies.credentials.access = async () => { throw new Error("fixture-secret"); };
    expect(await broken.adapter.invoke(invocation())).toMatchObject({ ok: false, error: { code: "unavailable", message: "Naver read failed" } });
  });
  it("sets a 15-second deadline on the fetch boundary", async () => {
    const controller = new AbortController();
    const createDeadline = vi.fn(() => controller.signal);
    const captured: { signal?: AbortSignal | null } = {};
    const f = fixture();
    const adapter = createNaverAdsAdapter({ ...f.dependencies, createDeadline, fetch: async (_url, init) => { captured.signal = init?.signal; controller.abort(); throw new Error("deadline"); } });
    expect(createDeadline).not.toHaveBeenCalled();
    expect(await adapter.invoke(invocation())).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(createDeadline).toHaveBeenCalledExactlyOnceWith({ timeoutMs: 15000 }); expect(captured.signal).toBe(controller.signal); expect(captured.signal?.aborted).toBe(true);
  });
  it("combines the injected deadline with caller cancellation", async () => {
    const deadline = new AbortController();
    const caller = new AbortController();
    const f = fixture();
    const captured: { signal?: AbortSignal | null } = {};
    const adapter = createNaverAdsAdapter({ ...f.dependencies, createDeadline: () => deadline.signal, fetch: async (_url, init) => { captured.signal = init?.signal; caller.abort(); throw new Error("caller cancellation"); } });
    expect(await adapter.invoke(invocation(), { signal: caller.signal })).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(captured.signal?.aborted).toBe(true); expect(deadline.signal.aborted).toBe(false);
  });
});

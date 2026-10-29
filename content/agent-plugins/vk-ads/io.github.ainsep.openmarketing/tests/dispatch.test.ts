import { describe, expect, it } from "vitest";
import { commandSchema, createVkAdsAdapter, vkAdsTools } from "../src/index.js";
import type { VkInvocation } from "../src/index.js";
import { encodeCommand } from "../src/commands.js";
import { decodeAccount, decodeCampaignPage } from "../src/reporting.js";
import { account, campaignPage, fixture, invocation, report, retrievedAt } from "./fixtures.js";

describe("VK read dispatch boundary", () => {
  it("uses host effects for admission and still verifies the token account", async () => {
    const f = fixture();
    expect(await createVkAdsAdapter(f.dependencies).invoke(invocation())).toMatchObject({ ok: true });
    expect(f.fetch.mock.calls.map(call => new URL(String(call[0])).pathname)).toEqual(["/api/v3/user.json", "/api/v2/ad_plans.json"]);
  });
  it("keeps construction inert and honors host credential denial", async () => {
    const f = fixture();
    expect(f.fetch).not.toHaveBeenCalled();
    f.state.admitted = false;
    for (const command of [{ kind: "list_accounts" } as const, { kind: "list_campaigns" } as const]) {
      expect(await f.adapter.invoke(invocation({ command }))).toMatchObject({ ok: false, error: { code: "forbidden", retryable: false } });
    }
    expect(f.credentials.access).toHaveBeenCalledTimes(2);
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.clock.now).not.toHaveBeenCalled();
    expect(f.observer.observe).toHaveBeenCalledTimes(2);
    expect(f.deadline).toHaveBeenCalledTimes(2);
    expect(vkAdsTools.map(tool => tool.name)).toEqual(["list_accounts", "list_campaigns"]);
  });
  it("discovers only the token account and verifies identity before one campaign page", async () => {
    const f = fixture();
    f.configuration.accountId = null;
    expect(await f.adapter.invoke(invocation({ command: { kind: "list_accounts" } }))).toMatchObject({ ok: true, value: { data: { accountId: "123", items: [{ id: "123", currency: "RUB" }], nextOffset: null } } });
    expect(await f.adapter.invoke(invocation())).toMatchObject({ ok: false, error: { code: "unavailable" } });
    f.configuration.accountId = "123";
    expect(await f.adapter.invoke(invocation({ command: { kind: "list_campaigns", limit: 1 } }))).toMatchObject({ ok: true, value: { data: { items: [{ id: "456" }], nextOffset: 1 } } });
    expect(f.fetch.mock.calls.map(call => String(call[0]))).toEqual(["https://ads.vk.ru/api/v3/user.json", "https://ads.vk.ru/api/v3/user.json", "https://ads.vk.ru/api/v2/ad_plans.json?limit=1&offset=0"]);
    expect(f.fetch.mock.calls[2]?.[1]).toMatchObject({ method: "GET", redirect: "error", headers: { Authorization: "Bearer SYNTHETIC_SECRET" } });
    expect(f.observer.observe).toHaveBeenCalledWith({ operation: "vk-ads.list_campaigns", outcome: "succeeded", correlationId: "correlation", traceId: "trace", runId: "run" });
  });
  it("checks scope, cancellation and malformed binding before I/O", async () => {
    const f = fixture();
    const controller = new AbortController(); controller.abort();
    expect(await f.adapter.invoke(invocation(), { signal: controller.signal })).toMatchObject({ ok: false, error: { code: "cancelled" } });
    f.configuration.scope.workspaceId = "foreign";
    expect(await f.adapter.invoke(invocation())).toMatchObject({ ok: false, error: { code: "forbidden" } });
    f.configuration.scope.ownerId = "foreign-owner";
    f.configuration.scope.workspaceId = "workspace";
    expect(await f.adapter.invoke(invocation())).toMatchObject({ ok: false, error: { code: "forbidden" } });
    f.configuration.accountId = "../escape";
    expect(await f.adapter.invoke(invocation())).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(f.credentials.access).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled();
  });
  it.each([
    { kind: "list_campaigns", accountId: "999" }, { kind: "list_campaigns", limit: 101 },
    { kind: "list_campaigns", offset: 1000001 }, { kind: "list_accounts", accessToken: "secret" },
    { kind: "activate" }, { ...report, until: "2026-11-01" }, { ...report, since: "2026-02-30" },
    { ...report, until: "2026-09-30" }, { ...report, ids: [] }, { ...report, ids: Array.from({ length: 201 }, (_, i) => String(i + 1)) }, { ...report, ids: ["123", "123"] },
  ])("rejects unsupported or inflated commands before I/O", async command => {
    const f = fixture();
    expect(commandSchema.safeParse(command).success).toBe(false);
    expect(await f.adapter.invoke({ ...invocation(), command } as unknown as VkInvocation)).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(f.credentials.access).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled();
  });
  it("bounds input and contains cyclic or throwing JSON", async () => {
    const f = fixture();
    expect(await f.adapter.invoke(undefined as unknown as VkInvocation)).toMatchObject({ ok: false, error: { code: "limit_exceeded" } });
    const large = { ...invocation(), extra: "x".repeat(65536) };
    expect(await f.adapter.invoke(large)).toMatchObject({ ok: false, error: { code: "limit_exceeded" } });
    const cyclic = { ...invocation(), extra: {} }; cyclic.extra = cyclic;
    expect(await f.adapter.invoke(cyclic)).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    const throwing = { ...invocation(), toJSON() { throw new Error("SYNTHETIC_SECRET"); } };
    expect(await f.adapter.invoke(throwing)).toEqual({ ok: false, error: { code: "invalid_input", message: "VK request invalid_input", retryable: false } });
    expect(f.credentials.access).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled();
  });
  it("parses one bounded page command without adding any vendor assumptions", () => {
    expect(commandSchema.parse({ kind: "list_campaigns" })).toEqual({ kind: "list_campaigns", limit: 20, offset: 0 });
    expect(commandSchema.safeParse(report).success).toBe(true);
    expect(encodeCommand({ command: { kind: "list_accounts" } })).toEqual({ path: "/api/v3/user.json", method: "GET" });
    expect(encodeCommand({ command: { kind: "list_campaigns", limit: 100, offset: 20 } })).toEqual({ path: "/api/v2/ad_plans.json?limit=100&offset=20", method: "GET" });
  });
  it("rejects a foreign token before campaign or statistics reads", async () => {
    const f = fixture(); f.configuration.accountId = "999";
    expect(await f.adapter.invoke(invocation())).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });
  it("keeps statistics unavailable before I/O even with admission and valid account IDs", async () => {
    const f = fixture();
    expect(await f.adapter.invoke(invocation({ command: report }))).toMatchObject({ ok: false, error: { code: "unavailable", retryable: false } });
    expect(await f.adapter.invoke(invocation({ command: { ...report, ids: ["999"] } }))).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(f.credentials.access).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.deadline).not.toHaveBeenCalled();
  });
  it.each([401, 403, 429, 500, 302])("redacts HTTP %s and never retries", async status => {
    const f = fixture(); f.fetch.mockResolvedValue(new Response("SYNTHETIC_SECRET", { status }));
    const result = await f.adapter.invoke(invocation());
    expect(result.ok).toBe(false); expect(JSON.stringify(result)).not.toContain("SYNTHETIC_SECRET");
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });
  it("contains malformed JSON, oversized streams, credential errors and revocation", async () => {
    for (const body of ["{", '"' + "x".repeat(1048576) + '"']) {
      const f = fixture(); f.fetch.mockResolvedValue(new Response(body));
      expect(await f.adapter.invoke(invocation())).toMatchObject({ ok: false });
    }
    const f = fixture(); f.credentials.access.mockRejectedValue(new Error("SYNTHETIC_SECRET"));
    expect(await f.adapter.invoke(invocation())).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(f.fetch).not.toHaveBeenCalled();
    const revoked = fixture(); revoked.credentials.access.mockImplementation(async () => { revoked.state.admitted = false; return { ok: true, value: { accessToken: "SYNTHETIC_SECRET" } }; });
    expect(await revoked.adapter.invoke(invocation())).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(revoked.fetch).toHaveBeenCalledTimes(1);
  });
  it("uses stored tokens concurrently and accepts a rotated token without stale Bearers", async () => {
    const f = fixture();
    const first = { accessToken: "SYNTHETIC_FIRST", expiresAt: retrievedAt + 1000 };
    f.setCredential({ clientId: "fixture-client", clientSecret: "SYNTHETIC_CLIENT", token: first });
    const input = invocation({ command: { kind: "list_accounts" } });
    const results = await Promise.all([f.adapter.invoke(input), f.adapter.invoke(input)]);
    for (const result of results) expect(result).toMatchObject({ ok: true, value: { data: { accountId: "123" } } });
    for (const call of f.fetch.mock.calls) expect(call[1]?.headers).toEqual({ Authorization: "Bearer SYNTHETIC_FIRST" });
    // Simulate the host replacing sealed credentials, independently of this read-only adapter.
    const rotated = { accessToken: "SYNTHETIC_ROTATED", expiresAt: retrievedAt + 86400000 };
    expect(await f.credentials.save({ token: rotated })).toEqual({ ok: true, value: undefined });
    expect(await f.credentials.access()).toEqual({ ok: true, value: { clientId: "fixture-client", clientSecret: "SYNTHETIC_CLIENT", token: rotated } });
    f.clock.now.mockReturnValue(retrievedAt + 1000);
    expect(await f.adapter.invoke(input)).toMatchObject({ ok: true });
    expect(f.fetch.mock.lastCall?.[1]?.headers).toEqual({ Authorization: "Bearer SYNTHETIC_ROTATED" });
    expect((await f.fetch("https://ads.vk.ru/api/v3/user.json", { method: "GET", headers: { Authorization: "Bearer SYNTHETIC_FIRST" } })).status).toBe(401);
    expect(f.fetch.mock.calls.filter(call => call[1]?.method === "POST")).toHaveLength(0);
    expect(f.credentials.save).toHaveBeenCalledTimes(1);
  });
  it.each([null, { accessToken: "SYNTHETIC_OLD", refreshToken: "SYNTHETIC_REFRESH", expiresAt: retrievedAt }])("never issues from stale sealed state, including after adapter recreation", async token => {
    const f = fixture(); f.setCredential({ clientId: "fixture-client", clientSecret: "SYNTHETIC_CLIENT", token });
    f.credentials.save.mockRejectedValue(new Error("SYNTHETIC_SECRET"));
    expect(await f.adapter.invoke(invocation())).toMatchObject({ ok: false, error: { code: "unavailable", retryable: false } });
    const recreated = createVkAdsAdapter(f.dependencies);
    for (const result of await Promise.all([recreated.invoke(invocation()), recreated.invoke(invocation())])) {
      expect(result).toMatchObject({ ok: false, error: { code: "unavailable", retryable: false } });
    }
    expect(f.credentials.access).toHaveBeenCalledTimes(3);
    expect(f.credentials.save).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it("accepts a pasted token without persistence support and rejects it at expiry", async () => {
    const f = fixture(); Reflect.deleteProperty(f.credentials, "save");
    expect(await f.adapter.invoke(invocation())).toMatchObject({ ok: true });
    const expired = fixture(); expired.setCredential({ accessToken: "SYNTHETIC_SECRET", expiresAt: retrievedAt });
    expect(await expired.adapter.invoke(invocation())).toMatchObject({ ok: false, error: { code: "expired" } });
    expect(expired.fetch).not.toHaveBeenCalled();
  });
  it("rejects malformed sealed credentials before data reads", async () => {
    for (const accessToken of ["", "SYNTHETIC\nSECRET", "x".repeat(4097)]) {
      const f = fixture(); f.setCredential({ accessToken });
      expect(await f.adapter.invoke(invocation())).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
      expect(f.credentials.save).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled();
    }
  });
  it("honors cancellation and binding changes after credential access", async () => {
    const controller = new AbortController();
    const f = fixture(); f.credentials.access.mockImplementation(async () => { controller.abort(); return { ok: true, value: { accessToken: "SYNTHETIC_SECRET" } }; });
    expect(await f.adapter.invoke(invocation(), { signal: controller.signal })).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(f.fetch).not.toHaveBeenCalled();
    const rebound = fixture(); rebound.credentials.access.mockImplementation(async () => { rebound.configuration.connectionId = "other"; return { ok: true, value: { accessToken: "SYNTHETIC_SECRET" } }; });
    expect(await rebound.adapter.invoke(invocation())).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(rebound.fetch).not.toHaveBeenCalled();
  });
  it("uses one injected 15-second deadline across broker, identity and campaign reads", async () => {
    const f = fixture();
    expect(await f.adapter.invoke(invocation())).toMatchObject({ ok: true });
    expect(f.deadline).toHaveBeenCalledExactlyOnceWith({ timeoutMs: 15000 });
    expect(f.credentials.access).toHaveBeenCalledWith({ connectionId: "fixture-connection", accountId: "123" }, { signal: f.deadlineController.signal });
    expect(f.fetch.mock.calls).toHaveLength(2);
    for (const call of f.fetch.mock.calls) expect(call[1]?.signal).toBe(f.deadlineController.signal);
    const cancelled = fixture();
    cancelled.fetch.mockImplementation(async () => { cancelled.deadlineController.abort(); throw new Error("SYNTHETIC_SECRET"); });
    expect(await cancelled.adapter.invoke(invocation())).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(cancelled.fetch).toHaveBeenCalledTimes(1);
  });
  it("combines caller cancellation with the injected deadline and contains deadline failures", async () => {
    const f = fixture(); const caller = new AbortController();
    f.credentials.access.mockImplementation(async () => { caller.abort(); return { ok: true, value: { accessToken: "SYNTHETIC_SECRET" } }; });
    expect(await f.adapter.invoke(invocation(), { signal: caller.signal })).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(f.fetch).not.toHaveBeenCalled();
    const failed = fixture(); failed.deadline.mockImplementation(() => { throw new Error("SYNTHETIC_SECRET"); });
    expect(await failed.adapter.invoke(invocation())).toEqual({ ok: false, error: { code: "unavailable", message: "VK request unavailable", retryable: false } });
    expect(failed.credentials.access).not.toHaveBeenCalled(); expect(failed.fetch).not.toHaveBeenCalled();
  });
  it("retains bounded report input validation while reporting is unavailable", () => {
    expect(commandSchema.safeParse({ ...report, ids: Array.from({ length: 200 }, (_, i) => String(i + 1)) }).success).toBe(true);
  });
});

describe("VK documented read projections (synthetic, not vendor acceptance)", () => {
  it("normalizes token identity and strips unconsumed fields", () => {
    expect(decodeAccount({ input: { ...account, access_token: "SYNTHETIC_SECRET", timezone: "unverified" }, accountId: null })).toEqual({ ok: true, value: { ...account, id: "123" } });
    expect(decodeAccount({ input: account, accountId: "999" })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(decodeAccount({ input: { ...account, id: "123" }, accountId: "123" })).toEqual({ ok: true, value: { ...account, id: "123" } });
  });
  it.each([{ ...account, id: Number.MAX_SAFE_INTEGER + 1 }, { ...account, currency: null }, { ...account, status: "PAUSED" }, { id: 123 }])("rejects malformed account identity", input => {
    expect(decodeAccount({ input, accountId: "123" })).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
  });
  it("returns explicit page continuation and leaves timezone unknown", () => {
    const input = { ...campaignPage, token: "SYNTHETIC_SECRET", items: [{ ...campaignPage.items[0], private: "SYNTHETIC_SECRET" }] };
    expect(decodeCampaignPage({ input, accountId: "123", limit: 1, offset: 0, retrievedAt })).toEqual({ ok: true, value: { source: "vk_ads", accountId: "123", retrievedAt, timezone: null, items: [{ id: "456", name: "Fixture campaign" }], nextOffset: 1 } });
    expect(decodeCampaignPage({ input: { count: 0, offset: 0, items: [] }, accountId: "123", limit: 20, offset: 0, retrievedAt })).toMatchObject({ ok: true, value: { items: [], nextOffset: null } });
  });
  it.each([
    { ...campaignPage, items: [...campaignPage.items, ...campaignPage.items] },
    { ...campaignPage, items: [{ id: 456 }] }, { ...campaignPage, offset: 1 },
    { ...campaignPage, count: 0 }, { ...campaignPage, items: [] },
    { ...campaignPage, items: [{ ...campaignPage.items[0], id: Number.MAX_SAFE_INTEGER + 1 }] },
    { ...campaignPage, items: Array.from({ length: 101 }, (_, i) => ({ id: i + 1, name: "fixture" })) },
  ])("rejects the whole page on invalid, duplicate or inconsistent records", input => {
    expect(decodeCampaignPage({ input, accountId: "123", limit: 100, offset: 0, retrievedAt })).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
  });
  it("rejects a page larger than requested and fails explicitly at the local offset cap", () => {
    const input = { count: 3, offset: 0, items: [{ id: 1, name: "one" }, { id: 2, name: "two" }] };
    expect(decodeCampaignPage({ input, accountId: "123", limit: 1, offset: 0, retrievedAt })).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
    expect(decodeCampaignPage({ input: { ...campaignPage, offset: 1000000, count: 1000002 }, accountId: "123", limit: 1, offset: 1000000, retrievedAt })).toMatchObject({ ok: false, error: { code: "limit_exceeded" } });
  });
});

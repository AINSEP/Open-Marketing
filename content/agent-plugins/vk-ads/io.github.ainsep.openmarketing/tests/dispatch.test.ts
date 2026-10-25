import { describe, expect, it } from "vitest";
import { commandSchema, vkAdsTools } from "../src/index.js";
import type { VkInvocation } from "../src/index.js";
import { encodeCommand } from "../src/commands.js";
import { decodeAccount, decodeCampaignPage } from "../src/reporting.js";
import { account, campaignPage, fixture, invocation, report, retrievedAt } from "./fixtures.js";

describe("VK held dispatch boundary", () => {
  it("keeps factory and denied/admitted calls free of all I/O", async () => {
    const f = fixture();
    f.state.admitted = false;
    expect(await f.adapter.invoke(invocation())).toMatchObject({ ok: false, error: { code: "forbidden", retryable: false } });
    f.state.admitted = true;
    f.configuration.accountId = null;
    for (const command of [{ kind: "list_accounts" } as const, { kind: "list_campaigns" } as const, report]) {
      const result = await f.adapter.invoke(invocation({ command }));
      expect(result).toMatchObject({ ok: false, error: { code: "unavailable", retryable: false } });
      expect(JSON.stringify(result)).not.toContain("SYNTHETIC_SECRET");
    }
    expect(f.credentials.access).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.clock.now).not.toHaveBeenCalled();
    expect(f.observer.observe).not.toHaveBeenCalled();
    expect(vkAdsTools).toEqual([]);
  });
  it("gives operation-specific evidence gaps instead of fabricated metrics", async () => {
    const f = fixture();
    expect(await f.adapter.invoke(invocation({ command: report }))).toMatchObject({ ok: false, error: { message: expect.stringContaining("spend units/currency") } });
    expect(await f.adapter.invoke(invocation())).toMatchObject({ ok: false, error: { message: expect.stringContaining("API origin") } });
  });
  it("checks scope, cancellation and malformed binding before the hold", async () => {
    const f = fixture();
    const controller = new AbortController(); controller.abort();
    expect(await f.adapter.invoke(invocation(), { signal: controller.signal })).toMatchObject({ ok: false, error: { code: "cancelled" } });
    f.configuration.scope.workspaceId = "foreign";
    expect(await f.adapter.invoke(invocation())).toMatchObject({ ok: false, error: { code: "forbidden" } });
    f.configuration.scope.ownerId = "foreign-owner";
    expect(await f.adapter.invoke(invocation())).toMatchObject({ ok: false, error: { code: "forbidden" } });
    f.configuration.accountId = "../escape";
    expect(await f.adapter.invoke(invocation())).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(f.credentials.access).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled();
  });
  it.each([
    { kind: "list_campaigns", accountId: "999" }, { kind: "list_campaigns", limit: 101 },
    { kind: "list_campaigns", offset: 1000001 }, { kind: "list_accounts", accessToken: "secret" },
    { kind: "activate" }, { ...report, until: "2026-11-01" }, { ...report, since: "2026-02-30" },
    { ...report, until: "2026-09-30" },
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

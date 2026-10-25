import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createSnapchatAdsAdapter, commandSchema, snapchatAdsTools } from "../src/index.js";
import type { SnapchatConfiguration, SnapchatDependencies, SnapchatInvocation } from "../src/index.js";
import { dispatchSuite } from "./contract-suite.js";
import type { ReadFixture } from "./contract-suite.js";
const accountId = "11111111-1111-1111-1111-111111111111", campaignId = "22222222-2222-2222-2222-222222222222", organizationId = "33333333-3333-3333-3333-333333333333";
const context = { scope: { ownerId: "owner", workspaceId: "workspace" }, principal: { kind: "owner" as const, ownerId: "owner" }, correlationId: "correlation", traceId: "trace", runId: "run" };
const configuration: SnapchatConfiguration = { scope: context.scope, connectionId: "connection", accountId, currency: "USD", timezone: "America/Los_Angeles", apiVersion: "v1", pluginDigest: "a".repeat(64) };
const input: SnapchatInvocation = { context, operationId: "operation", command: { kind: "list_campaigns" } };
const entity = { id: campaignId, name: "Fixture campaign", status: "PAUSED", ad_account_id: accountId };
const page = { request_status: "SUCCESS", campaigns: [{ sub_request_status: "SUCCESS", campaign: { ...entity, unused_secret: "synthetic-secret" } }] };
const report: SnapchatInvocation["command"] = { kind: "report", window: { start: "2026-10-01T00:00:00-07:00", end: "2026-10-02T00:00:00-07:00" } };
/** Synthetic responses only. The memory gateway models current policy; never a production registry. */
function fixture(required: { admitted?: boolean; response?: (input: { url: string }) => Response; credentialHook?: (input: { state: ReadFixture["state"] }) => void;
  expiresAt?: number; configuration?: SnapchatConfiguration; gateway?: SnapchatDependencies["gateway"] } = {}): ReadFixture {
  const calls: ReadFixture["calls"] = [], credentialCalls: unknown[] = [], effects: ReadFixture["effects"] = [], observations: ReadFixture["observations"] = [];
  const state = { admitted: true };
  const dependencies: SnapchatDependencies = { configuration: required.configuration ?? configuration, admitted: required.admitted ?? true,
    credentials: { async access(binding) { credentialCalls.push(binding); required.credentialHook?.({ state }); return { ok: true, value: { accessToken: "synthetic-secret", expiresAt: required.expiresAt ?? 2000000000000 } }; } },
    gateway: required.gateway ?? { async dispatch(call) { effects.push(call.effect); return state.admitted ? call.execute() : { ok: false, error: { code: "forbidden", message: "Fixture denial", retryable: false } }; } },
    fetch: async (url, init) => { calls.push({ url: String(url), init: init ?? {} }); return required.response?.({ url: String(url) }) ?? Response.json(page); },
    clock: { now: () => 1790810000000 }, observer: { observe(event) { observations.push(event); } } };
  return { adapter: createSnapchatAdsAdapter(dependencies), input, calls, credentialCalls, effects, observations, state };
}
function stats(required: { campaign?: boolean; metrics?: unknown; rows?: number } = {}): unknown {
  return { request_status: "success", total_stats: Array.from({ length: required.rows ?? 1 }, () => ({ sub_request_status: "success", total_stat: {
    id: required.campaign ? campaignId : accountId, type: required.campaign ? "CAMPAIGN" : "AD_ACCOUNT", granularity: "TOTAL", stats: required.metrics ?? { spend: 1234567 },
    finalized_data_end_time: "2026-10-01T00:00:00-07:00" } })) };
}
dispatchSuite({ name: "memory host + injected-fetch adapter", makeFixture: () => fixture() });
describe("Snapchat read boundaries", () => {
  it("is inert and denies unadmitted calls before credentials or fetch", async () => {
    const f = fixture({ admitted: false }); expect(f.calls).toHaveLength(0);
    expect(await f.adapter.invoke(input)).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(f.credentialCalls).toHaveLength(0); expect(f.calls).toHaveLength(0);
  });
  it("checks current authority after credential resolution and rejects expired tokens", async () => {
    const revoked = fixture({ credentialHook: ({ state }) => { state.admitted = false; } });
    expect(await revoked.adapter.invoke(input)).toMatchObject({ ok: false, error: { code: "forbidden" } }); expect(revoked.calls).toHaveLength(0);
    const expired = fixture({ expiresAt: 1 });
    expect(await expired.adapter.invoke(input)).toMatchObject({ ok: false, error: { code: "expired" } }); expect(expired.calls).toHaveLength(0);
  });
  it.each(["create_campaign", "list_ad_squads", "list_ads", "deliver"])("excludes %s", kind => {
    expect(commandSchema.safeParse({ kind }).success).toBe(false);
  });
  it("denies malformed, oversized and cyclic inputs before I/O", async () => {
    const f = fixture(); const cyclic = { ...input } as SnapchatInvocation & { cycle?: unknown }; cyclic.cycle = cyclic;
    for (const value of [cyclic, { ...input, command: { kind: "list_campaigns", url: "https://evil.example" } }, { ...input, operationId: "x".repeat(65537) }]) expect((await f.adapter.invoke(value as SnapchatInvocation)).ok).toBe(false);
    expect(f.credentialCalls).toHaveLength(0);
  });
  it.each([
    { request_status: "ERROR", campaigns: [] },
    { ...page, campaigns: [{ sub_request_status: "ERROR", campaign: entity }] },
    { ...page, campaigns: [page.campaigns[0], page.campaigns[0]] },
    { ...page, campaigns: Array.from({ length: 101 }, () => page.campaigns[0]) },
    { ...page, campaigns: [{ sub_request_status: "SUCCESS", campaign: { ...entity, ad_account_id: organizationId } }] },
    { ...page, campaigns: [page.campaigns[0], { sub_request_status: "SUCCESS", campaign: { id: "invalid" } }] },
  ])("rejects invalid/foreign/partial pages atomically", async body => {
    expect((await fixture({ response: () => Response.json(body) }).adapter.invoke(input)).ok).toBe(false);
  });
  it("returns only a cursor and rebuilds a fixed subsequent URL", async () => {
    const f = fixture({ response: () => Response.json({ ...page, paging: { next_link: "https://adsapi.snapchat.com/v1/adaccounts/" + accountId + "/campaigns?cursor=abc%3D&limit=100&extra=ignored" } }) });
    expect(await f.adapter.invoke(input)).toMatchObject({ ok: true, value: { data: { nextCursor: "abc=" } } });
    await f.adapter.invoke({ ...input, command: { kind: "list_campaigns", cursor: "abc=" } });
    expect(f.calls[1].url).toBe("https://adsapi.snapchat.com/v1/adaccounts/" + accountId + "/campaigns?limit=100&cursor=abc%3D");
  });
  it.each(["https://evil.example/?cursor=abc", "https://adsapi.snapchat.com/v1/me/organizations?cursor=abc", "https://adsapi.snapchat.com/v1/adaccounts/" + accountId + "/campaigns?cursor=abc&cursor=def"])("rejects unsafe pagination links", async link => {
    const f = fixture({ response: () => Response.json({ ...page, paging: { next_link: link } }) }); expect((await f.adapter.invoke(input)).ok).toBe(false); expect(f.calls).toHaveLength(1);
  });
  it.each([{ status: 401, code: "unauthenticated" }, { status: 403, code: "forbidden" }, { status: 429, code: "limit_exceeded" }, { status: 503, code: "unavailable" }])("redacts provider errors without retries", async ({ status, code }) => {
    const f = fixture({ response: () => new Response("synthetic-secret", { status }) });
    const result = await f.adapter.invoke(input); expect(result).toMatchObject({ ok: false, error: { code, retryable: false } }); expect(JSON.stringify(result)).not.toContain("synthetic-secret"); expect(f.calls).toHaveLength(1);
  });
  it.each(["not JSON", "x".repeat(1048577)])("bounds streamed responses without Content-Length", async body => {
    const f = fixture({ response: () => new Response(body) }); expect((await f.adapter.invoke(input)).ok).toBe(false); expect(f.calls).toHaveLength(1);
  });
  it("propagates cancellation to fetch", async () => {
    const controller = new AbortController();
    const f = fixture({ response: () => { controller.abort(); return Response.json(page); } });
    expect(await f.adapter.invoke(input, { signal: controller.signal })).toMatchObject({ ok: false, error: { code: "cancelled" } }); expect(f.calls[0].init.signal?.aborted).toBe(true);
  });
  it("cancels after credential resolution before any fetch", async () => {
    const controller = new AbortController(); const f = fixture({ credentialHook: () => { controller.abort(); } });
    expect(await f.adapter.invoke(input, { signal: controller.signal })).toMatchObject({ ok: false, error: { code: "cancelled" } }); expect(f.calls).toHaveLength(0);
  });
  it("sanitizes thrown transport errors and never retries", async () => {
    const f = fixture({ response: () => { throw new Error("synthetic-secret"); } });
    const result = await f.adapter.invoke(input); expect(result).toMatchObject({ ok: false, error: { code: "unavailable" } }); expect(JSON.stringify(result)).not.toContain("synthetic-secret"); expect(f.calls).toHaveLength(1);
  });
  it("supports discovery without a bound account and enforces organization ownership", async () => {
    const f = fixture({ configuration: { ...configuration, accountId: null }, response: () => Response.json({ request_status: "success", organizations: [{ sub_request_status: "success", organization: { id: organizationId, name: "Fixture org" } }] }) });
    expect((await f.adapter.invoke({ ...input, command: { kind: "list_organizations" } })).ok).toBe(true);
    expect(f.calls[0].url).toBe("https://adsapi.snapchat.com/v1/me/organizations");
    expect((await f.adapter.invoke(input)).ok).toBe(false);
    const accounts = fixture({ response: () => Response.json({ request_status: "SUCCESS", adaccounts: [{ sub_request_status: "SUCCESS", adaccount: { id: accountId, organization_id: organizationId, name: "Fixture account", currency: "USD", timezone: "UTC", status: "ACTIVE" } }] }) });
    expect((await accounts.adapter.invoke({ ...input, command: { kind: "list_accounts", organizationId } })).ok).toBe(true);
    expect((await accounts.adapter.invoke({ ...input, command: { kind: "list_accounts", organizationId: campaignId } })).ok).toBe(false);
  });
  it("projects existing creatives without provider URLs", async () => {
    const f = fixture({ response: () => Response.json({ request_status: "SUCCESS", creatives: [{ sub_request_status: "SUCCESS", creative: { id: campaignId, name: "Web", ad_account_id: accountId, type: "WEB_VIEW", preview_url: "https://secret.example" } }] }) });
    const result = await f.adapter.invoke({ ...input, command: { kind: "list_creatives" } }); expect(result.ok).toBe(true); expect(JSON.stringify(result)).not.toContain("secret.example");
  });
  it("permits only one execution callback per dispatch", async () => {
    const f = fixture({ gateway: { async dispatch(call) { await call.execute(); return call.execute(); } } });
    expect(await f.adapter.invoke(input)).toMatchObject({ ok: false, error: { code: "conflict" } }); expect(f.calls).toHaveLength(1);
  });
});
describe("Snapchat TOTAL reporting", () => {
  it("preserves micros, missing metrics, provider metadata and account-only spend", async () => {
    const f = fixture({ response: () => Response.json(stats({ metrics: { spend: "9007199254740993", impressions: 12 } })) });
    expect(await f.adapter.invoke({ ...input, command: report })).toMatchObject({ ok: true, value: { data: { currency: "USD", source: "snapchat_ads_stats", boundarySemantics: "provider_unspecified", rows: [{ stats: { spend: "9007199254740993" }, finalized_data_end_time: "2026-10-01T00:00:00-07:00" }] } } });
    expect(new URL(f.calls[0].url).searchParams.get("fields")).toBe("spend");
    expect(JSON.stringify(await f.adapter.invoke({ ...input, command: report }))).not.toContain("impressions");
  });
  it("labels empty data and never invents zeros", async () => {
    expect(await fixture({ response: () => Response.json(stats({ rows: 0 })) }).adapter.invoke({ ...input, command: report })).toMatchObject({ ok: true, value: { data: { availability: "no_data_access_unconfirmed", rows: [] } } });
    expect(await fixture({ response: () => Response.json(stats({ metrics: {} })) }).adapter.invoke({ ...input, command: report })).toMatchObject({ ok: true, value: { data: { rows: [{ stats: {} }] } } });
  });
  it.each([{ spend: 9007199254740992 }, { spend: -1 }, { spend: "1.2" }])("rejects unsafe monetary values", async metrics => {
    expect((await fixture({ response: () => Response.json(stats({ metrics })) }).adapter.invoke({ ...input, command: report })).ok).toBe(false);
  });
  it("checks campaign ownership before stats and rechecks authority for the second fetch", async () => {
    const f = fixture({ response: ({ url }) => Response.json(url.endsWith("/" + campaignId) ? page : stats({ campaign: true, metrics: { spend: 0, swipes: 2, impressions: 12 } })) });
    expect(await f.adapter.invoke({ ...input, command: { ...report, campaignId } })).toMatchObject({ ok: true, value: { data: { rows: [{ stats: { spend: "0", swipes: "2", impressions: "12" } }] } } }); expect(f.calls).toHaveLength(2); expect(f.credentialCalls).toHaveLength(2); expect(f.effects).toHaveLength(2);
    const denied = fixture({ response: () => { denied.state.admitted = false; return Response.json(page); } });
    expect((await denied.adapter.invoke({ ...input, command: { ...report, campaignId } })).ok).toBe(false); expect(denied.calls).toHaveLength(1);
  });
  it("rejects foreign campaign ownership before querying stats", async () => {
    const f = fixture({ response: () => Response.json({ ...page, campaigns: [{ sub_request_status: "SUCCESS", campaign: { ...entity, ad_account_id: organizationId } }] }) });
    expect((await f.adapter.invoke({ ...input, command: { ...report, campaignId } })).ok).toBe(false); expect(f.calls).toHaveLength(1);
  });
  it("rejects non-midnight windows before credentials and duplicate aggregates", async () => {
    const f = fixture(); expect((await f.adapter.invoke({ ...input, command: { kind: "report", window: { start: "2026-10-01T01:00:00-07:00", end: "2026-10-02T00:00:00-07:00" } } })).ok).toBe(false); expect(f.credentialCalls).toHaveLength(0);
    expect((await fixture({ response: () => Response.json(stats({ rows: 2 })) }).adapter.invoke({ ...input, command: report })).ok).toBe(false);
  });
  it.each([
    { window: { start: "2026-10-02T00:00:00-07:00", end: "2026-10-01T00:00:00-07:00" } },
    { window: { start: "2024-10-01T00:00:00-07:00", end: "2026-10-01T00:00:00-07:00" } },
    { window: { start: "2026-10-01T00:00:00Z", end: "2026-10-02T00:00:00Z" } },
    { granularity: "DAY" },
  ])("denies unsupported report arguments before credentials", async patch => {
    const f = fixture(); expect((await f.adapter.invoke({ ...input, command: { ...report, ...patch } as SnapchatInvocation["command"] })).ok).toBe(false); expect(f.credentialCalls).toHaveLength(0);
  });
  it.each([
    { id: organizationId }, { type: "CAMPAIGN" }, { start_time: "2026-09-01T00:00:00-07:00" }, { sub_request_status: "ERROR" },
  ])("rejects wrong report provenance or per-entity failure", async patch => {
    const body = { request_status: "SUCCESS", total_stats: [{ sub_request_status: patch.sub_request_status ?? "SUCCESS", total_stat: { id: accountId, type: "AD_ACCOUNT", granularity: "TOTAL", stats: { spend: 123 }, ...patch } }] };
    expect((await fixture({ response: () => Response.json(body) }).adapter.invoke({ ...input, command: report })).ok).toBe(false);
  });
  it("accepts account-midnight windows across DST and denies invalid account timezones", async () => {
    const command: SnapchatInvocation["command"] = { kind: "report", window: { start: "2026-11-01T00:00:00-07:00", end: "2026-11-02T00:00:00-08:00" } };
    const f = fixture({ response: () => Response.json(stats({ rows: 0 })) }); expect((await f.adapter.invoke({ ...input, command })).ok).toBe(true);
    const invalid = fixture({ configuration: { ...configuration, timezone: "Invalid/Zone" } }); expect((await invalid.adapter.invoke({ ...input, command })).ok).toBe(false); expect(invalid.credentialCalls).toHaveLength(0);
  });
});
describe("Snapchat portable metadata", () => {
  it("keeps manifest/capability effects, fingerprints, sole entry and exact pins consistent", () => {
    const root = new URL("../../", import.meta.url);
    const manifest = JSON.parse(readFileSync(new URL("plugin.json", root), "utf8"));
    const caps = JSON.parse(readFileSync(new URL("io.github.ainsep.openmarketing/capabilities.json", root), "utf8"));
    expect(manifest.extensions["io.github.ainsep.openmarketing"]).toMatchObject({ enabled: false, admitted: false, capabilities: caps.capabilities });
    expect(caps.tools.map((value: { name: string; effects: string[] }) => [value.name, value.effects])).toEqual(snapchatAdsTools.map(value => [value.name, [value.effect]]));
    for (const cap of caps.capabilities) expect(cap.schemaFingerprint).toBe(createHash("sha256").update(readFileSync(new URL("io.github.ainsep.openmarketing/src/" + (cap.capabilityId.startsWith("report.") ? "reporting.ts" : "commands.ts"), root))).digest("hex"));
    const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8")); expect(Object.keys(pkg.exports)).toEqual(["."]); expect(pkg.sideEffects).toBe(false); expect(pkg.dependencies).toEqual({ "@open-marketing/contracts": "workspace:*", zod: "4.1.13" });
  });
});

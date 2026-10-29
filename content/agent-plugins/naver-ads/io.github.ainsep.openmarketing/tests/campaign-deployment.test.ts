import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { campaignDeploymentPlanSchema, deployCampaignPaused, readCampaignDeployment, translateCampaign } from "../src/index.js";
import type { CampaignTranslationInput } from "../src/index.js";
import { context, fixture, now } from "./fixtures.js";

const references = { campaign: "cmp-fixture", adgroup: "grp-fixture", ad: "nad-fixture", keyword_0: "nkw-first", keyword_1: "nkw-second" };
function plan() {
  return {
    accountId: "222", credentialCustomerId: "111", creativeId: "creative", creativeDigest: "a".repeat(64), channelId: "bsn-fixture",
    campaign: { name: "Owner name", campaignTp: "WEB_SITE", userLock: true, dailyBudget: 10000, useDailyBudget: true, usePeriod: true, periodStartDt: "2026-10-01T15:00:00.000Z", periodEndDt: "2026-10-03T15:00:00.000Z" },
    adgroup: { name: "Owner group", adgroupType: "WEB_SITE", userLock: true, dailyBudget: 10000, useDailyBudget: true, bidAmt: 100, systemBiddingType: "NONE", useExpSearch: false },
    ad: { type: "TEXT_45", userLock: true, ad: { headline: "Fixture title", description: "Fixture copy", pc: { final: "https://example.test/pc", display: "https://example.test" }, mobile: { final: "https://example.test/mobile", display: "https://example.test" } } },
    keywords: ["first", "second"].map(keyword => ({ keyword, bidAmt: 100, useGroupBidAmt: false, userLock: true })),
  };
}
// Independently specified vendor fixtures (Ad.ad is a JSON string in the documented response).
function rows(): Record<string, Record<string, unknown>> {
  return {
    "bsn-fixture": { nccBusinessChannelId: "bsn-fixture", customerId: 222, channelTp: "SITE" },
    "cmp-fixture": { nccCampaignId: "cmp-fixture", customerId: 222, name: "Owner name", campaignTp: "WEB_SITE", status: "PAUSED", userLock: true, dailyBudget: 10000, useDailyBudget: true, usePeriod: true, periodStartDt: "2026-10-01T15:00:00.000Z", periodEndDt: "2026-10-03T15:00:00.000Z" },
    "grp-fixture": { nccAdgroupId: "grp-fixture", nccCampaignId: "cmp-fixture", customerId: 222, name: "Owner group", adgroupType: "WEB_SITE", status: "PAUSED", userLock: true, dailyBudget: 10000, useDailyBudget: true, bidAmt: 100, systemBiddingType: "NONE", useExpSearch: false, pcChannelId: "bsn-fixture", mobileChannelId: "bsn-fixture" },
    "nad-fixture": { nccAdId: "nad-fixture", nccAdgroupId: "grp-fixture", customerId: 222, status: "PAUSED", userLock: true, type: "TEXT_45", ad: '{"headline":"Fixture title","description":"Fixture copy","pc":{"final":"https://example.test/pc","display":"https://example.test"},"mobile":{"final":"https://example.test/mobile","display":"https://example.test"}}' },
    "nkw-first": { nccKeywordId: "nkw-first", nccAdgroupId: "grp-fixture", customerId: 222, status: "PAUSED", userLock: true, keyword: "first", bidAmt: 100, useGroupBidAmt: false },
    "nkw-second": { nccKeywordId: "nkw-second", nccAdgroupId: "grp-fixture", customerId: 222, status: "PAUSED", userLock: true, keyword: "second", bidAmt: 100, useGroupBidAmt: false },
  };
}
function setup() {
  const f = fixture();
  const vendor = rows();
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    f.calls.push({ url: String(url), init: init ?? {} });
    return Response.json(vendor[new URL(String(url)).pathname.split("/").at(-1)!]);
  });
  const dependencies = { ...f.dependencies, configuration: f.configuration, fetch };
  const input = { context, operationId: "operation", plan: plan(), dependencies, references: { ...references } };
  return { ...f, dependencies, vendor, fetch, input };
}
const unsupportedIntent: CampaignTranslationInput = {
  campaign: { name: "Owner name", objective: "traffic", schedule: { window: { start: 1790866800000, end: 1791039600000 }, timezone: "Asia/Seoul" }, audience: { countries: ["KR"], searchTerms: ["first"] }, creativeIds: ["creative"], creativeDigest: "a".repeat(64) },
  target: { accountId: "222", dailyBudget: { currency: "KRW", minorUnits: 10000 } }, resolved: { endSemantics: "exclusive", pausedCreateVerified: true },
};
describe("Naver R2 fail-closed launch and saved-reference readback", () => {
  it("does not accept caller claims as evidence for schedule or paused creation", async () => {
    const f = setup();
    const checkpoint = vi.fn();
    expect(translateCampaign(unsupportedIntent)).toMatchObject({ ok: false, error: { code: "not_implemented", retryable: false } });
    expect(await deployCampaignPaused({ ...f.input, checkpoint })).toMatchObject({ ok: false, error: { code: "not_implemented" } });
    expect(checkpoint).not.toHaveBeenCalled();
    expect(f.credentialCalls).toEqual([]);
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it("keeps launches unavailable on repeated operation IDs and on forged plans", async () => {
    const f = setup();
    for (const value of [f.input.plan, { ...f.input.plan, endSemantics: "inclusive", admitted: true }]) {
      expect(await deployCampaignPaused({ ...f.input, plan: value, checkpoint: vi.fn() })).toMatchObject({ ok: false, error: { code: "not_implemented" } });
    }
    expect(f.credentialCalls).toEqual([]);
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it("reads the exact hierarchy in parent order, signs each GET and preserves names", async () => {
    const f = setup();
    const result = await readCampaignDeployment(f.input);
    expect(result).toMatchObject({ ok: true, value: { status: "acknowledged", references, entityIds: Object.values(references) } });
    if (result.ok) expect(result.value.hierarchy).toHaveLength(6);
    if (result.ok) expect(result.value.hierarchy[1]).toMatchObject({ bidAmt: 100, systemBiddingType: "NONE" });
    expect(f.calls.map(call => new URL(call.url).pathname)).toEqual(["/ncc/campaigns/cmp-fixture", "/ncc/adgroups/grp-fixture", "/ncc/ads/nad-fixture", "/ncc/keywords/nkw-first", "/ncc/keywords/nkw-second", "/ncc/channels/bsn-fixture"]);
    for (const call of f.calls) {
      expect(call.init).toMatchObject({ method: "GET", redirect: "error" });
      expect(call.init.body).toBeUndefined();
      expect(call.init.headers).toMatchObject({ "X-Customer": "222", "X-Signature": createHmac("sha256", "fixture-secret").update(`${now}.GET.${new URL(call.url).pathname}`).digest("base64") });
    }
    expect(f.credentialCalls).toEqual(Array.from({ length: 6 }, () => ({ connectionId: "connection", accountId: "222" })));
    expect(f.observations).toHaveLength(6);
    expect(f.observations[0]).toMatchObject({ correlationId: "correlation", traceId: "trace", runId: "run" });
  });
  it.each(["ML", undefined])("retains refs and stops at the group when bidding mode is %s", async systemBiddingType => {
    const f = setup();
    f.vendor["grp-fixture"]!.systemBiddingType = systemBiddingType;
    const result = await readCampaignDeployment(f.input);
    expect(result).toMatchObject({ ok: true, value: { status: "unknown", references, entityIds: Object.values(references) } });
    if (result.ok) expect(result.value.hierarchy).toHaveLength(1);
    expect(f.calls.map(call => new URL(call.url).pathname)).toEqual(["/ncc/campaigns/cmp-fixture", "/ncc/adgroups/grp-fixture"]);
    expect(f.calls.every(call => call.init.method === "GET")).toBe(true);
  });
  it.each(["ML", undefined])("rejects saved bidding mode %s before credentials or network", async systemBiddingType => {
    const f = setup();
    const invalid = { ...plan(), adgroup: { ...plan().adgroup, systemBiddingType } };
    expect(campaignDeploymentPlanSchema.safeParse(invalid).success).toBe(false);
    expect(await readCampaignDeployment({ ...f.input, plan: invalid })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(f.credentialCalls).toEqual([]);
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it.each([
    ["cmp-fixture", { userLock: false }, 1], ["cmp-fixture", { dailyBudget: 20000 }, 1],
    ["cmp-fixture", { periodEndDt: "2026-10-04T15:00:00.000Z" }, 1],
    ["grp-fixture", { nccCampaignId: "cmp-foreign" }, 2], ["grp-fixture", { customerId: 333 }, 2],
    ["nad-fixture", { ad: "{}" }, 3], ["nkw-first", { bidAmt: 900 }, 4],
    ["nkw-first", { status: "ELIGIBLE" }, 4],
    ["bsn-fixture", { channelTp: "MALL" }, 6], ["bsn-fixture", { customerId: 333 }, 6],
  ] as const)("stops at mismatched %s without losing later references", async (id, change, count) => {
    const f = setup();
    Object.assign(f.vendor[id]!, change);
    expect(await readCampaignDeployment(f.input)).toMatchObject({ ok: true, value: { status: "unknown", references, entityIds: Object.values(references) } });
    expect(f.calls).toHaveLength(count);
    expect(f.calls.every(call => call.init.method === "GET")).toBe(true);
  });
  it("retains partial keyword refs and never scans or recreates a missing ID", async () => {
    const f = setup();
    const partial = { campaign: references.campaign, adgroup: references.adgroup, ad: references.ad, keyword_1: references.keyword_1 };
    expect(await readCampaignDeployment({ ...f.input, references: partial })).toMatchObject({ ok: true, value: { status: "unknown", references: partial } });
    expect(f.calls).toHaveLength(3);
    expect(await readCampaignDeployment({ ...f.input, references: { keyword_1: references.keyword_1 } })).toMatchObject({ ok: true, value: { status: "unknown", references: { keyword_1: references.keyword_1 } } });
    expect(f.calls).toHaveLength(3);
  });
  it("denies admission and scope/account mismatch before credentials", async () => {
    const f = setup();
    f.configuration.admitted = false;
    expect(await readCampaignDeployment(f.input)).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(await deployCampaignPaused({ ...f.input, checkpoint: vi.fn() })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    f.configuration.admitted = true;
    expect(await readCampaignDeployment({ ...f.input, context: { ...context, scope: { ...context.scope, workspaceId: "other" } } })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(await readCampaignDeployment({ ...f.input, plan: { ...plan(), accountId: "999" } })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(f.credentialCalls).toEqual([]);
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it("rechecks the current binding after credential access and between rows", async () => {
    const f = setup();
    const access = f.dependencies.credentials.access;
    f.dependencies.credentials.access = async input => { const result = await access(input); f.configuration.admitted = false; return result; };
    expect(await readCampaignDeployment(f.input)).toMatchObject({ ok: true, value: { status: "unknown", references } });
    expect(f.fetch).not.toHaveBeenCalled();
    const g = setup();
    g.fetch.mockImplementationOnce(async () => { g.configuration.accountId = "333"; return Response.json(g.vendor["cmp-fixture"]); });
    expect(await readCampaignDeployment(g.input)).toMatchObject({ ok: true, value: { status: "unknown", references } });
    expect(g.fetch).toHaveBeenCalledTimes(1);
  });
  it.each(["invalid JSON", "oversized", "network", "missing body", "429"])("preserves refs on %s without retries or secret leakage", async kind => {
    const f = setup();
    f.fetch.mockImplementationOnce(async () => {
      if (kind === "network") throw new Error("fixture-secret fixture-license");
      if (kind === "missing body") return new Response(null);
      if (kind === "429") return new Response("fixture-secret", { status: 429 });
      return new Response(kind === "oversized" ? " ".repeat(1048577) : "{");
    });
    const result = await readCampaignDeployment(f.input);
    expect(result).toMatchObject({ ok: true, value: { status: "unknown", references } });
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify([result, f.observations])).not.toMatch(/fixture-secret|fixture-license/);
  });
  it("honors cancellation and observer failures without erasing references", async () => {
    const f = setup();
    const signal = AbortSignal.abort();
    expect(await readCampaignDeployment(f.input, { signal })).toMatchObject({ ok: true, value: { status: "unknown", references } });
    expect(await deployCampaignPaused({ ...f.input, checkpoint: vi.fn() }, { signal })).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(f.credentialCalls).toEqual([]);
    f.dependencies.observer.observe = () => { throw new Error("fixture-secret"); };
    expect(await readCampaignDeployment(f.input)).toMatchObject({ ok: true, value: { status: "acknowledged", references } });
  });
  it("rejects duplicate refs, extra controls, invalid periods and oversized plans before I/O", async () => {
    const f = setup();
    expect(await readCampaignDeployment({ ...f.input, references: { ...references, keyword_1: references.keyword_0 } })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(await readCampaignDeployment({ ...f.input, plan: { ...plan(), targeting: { country: "KR" } } })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(await readCampaignDeployment({ ...f.input, plan: { ...plan(), unused: "x".repeat(65536) } })).toMatchObject({ ok: false, error: { code: "limit_exceeded" } });
    const invalid = plan(); invalid.campaign.periodStartDt = "2026-10-01T16:00:00.000Z";
    expect(campaignDeploymentPlanSchema.safeParse(invalid).success).toBe(false);
    expect(f.credentialCalls).toEqual([]);
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it.each(["malformed", "wrong owner", "oversized", "broker fault", "invalid clock", "deadline"])("stops on %s at the credential/transport boundary", async kind => {
    const f = setup();
    const credential = { apiKey: "fixture-license", secretKey: "fixture-secret", customerId: "333" };
    if (kind === "invalid clock") f.dependencies.clock.now = () => -1;
    else if (kind === "deadline") f.dependencies.createDeadline = () => AbortSignal.abort();
    else f.dependencies.credentials.access = async () => {
      if (kind === "broker fault") throw new Error("fixture-secret");
      return { ok: true, value: { accessToken: kind === "wrong owner" ? JSON.stringify(credential) : kind === "oversized" ? "x".repeat(16385) : "{" } };
    };
    const result = await readCampaignDeployment(f.input);
    expect(result).toMatchObject({ ok: true, value: { status: "unknown", references } });
    expect(f.fetch).toHaveBeenCalledTimes(kind === "deadline" ? 1 : 0);
    expect(JSON.stringify(result)).not.toContain("fixture-secret");
  });
  it("bounds reference maps, handles cycles and validates keyword and date aggregates", async () => {
    const f = setup();
    expect(await readCampaignDeployment({ ...f.input, references: { campaign: "x".repeat(65536) } })).toMatchObject({ ok: false, error: { code: "limit_exceeded" } });
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    expect(await readCampaignDeployment({ ...f.input, plan: cyclic })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    const duplicates = plan(); duplicates.keywords[1]!.keyword = "first";
    expect(campaignDeploymentPlanSchema.safeParse(duplicates).success).toBe(false);
    const oversized = plan(); oversized.keywords = Array.from({ length: 21 }, (_, index) => ({ keyword: String(index), bidAmt: 100, useGroupBidAmt: false, userLock: true }));
    expect(campaignDeploymentPlanSchema.safeParse(oversized).success).toBe(false);
    const reversed = plan(); reversed.campaign.periodEndDt = "2026-09-30T15:00:00.000Z";
    expect(campaignDeploymentPlanSchema.safeParse(reversed).success).toBe(false);
    expect(f.credentialCalls).toEqual([]);
    expect(f.fetch).not.toHaveBeenCalled();
  });
});

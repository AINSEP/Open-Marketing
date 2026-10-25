import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { campaignDeploymentPlanSchema, deployCampaignPaused, readCampaignDeployment, translateCampaign } from "../src/index.js";
import type { CampaignTranslationInput } from "../src/index.js";
import { deploymentFixture, pausedPlan } from "./fixtures.js";

// Exercise documented sequencing with synthetic HTTP. Actual evidence denial is tested unmocked in transport.test.ts.
vi.mock("../src/commands.js", async importOriginal => ({ ...await importOriginal<typeof import("../src/commands.js")>(), verifiedDeploymentCountries: Object.freeze(["TW", "TH"]) }));
const fixtures: ReturnType<typeof deploymentFixture>[] = [];
function make(required: Parameters<typeof deploymentFixture>[0] = {}) {
  const f = deploymentFixture(required); fixtures.push(f); return f;
}
afterEach(() => { for (const f of fixtures.splice(0)) expect(f.violations).toEqual([]); });
function translation(): CampaignTranslationInput {
  return { campaign: { name: "Traffic", objective: "traffic", schedule: { window: { start: Date.parse("2026-10-25T00:00:00Z"), end: Date.parse("2026-10-26T00:00:00Z") }, timezone: "Asia/Taipei" },
    audience: { countries: ["TW"] }, creativeIds: ["image"], creativeDigest: "a".repeat(64) }, target: { accountId: "123", dailyBudget: { minorUnits: 12345, currency: "TWD" } },
    resolved: { ...pausedPlan.metadata, bid: { minorUnits: 25, currency: "TWD" }, creative: pausedPlan.ad.creative, generatedByAi: false } };
}
describe("LINE documented fixture deployment (regional evidence replaced only in this file)", () => {
  it("translates exact integer micros, local schedule, image and explicit Taiwan declaration", () => {
    expect(translateCampaign(translation())).toEqual({ ok: true, value: pausedPlan });
  });
  it.each([0, 0.1, Number.MAX_SAFE_INTEGER])("rejects invalid/overflowing daily minor units %s", minorUnits => {
    const input = translation(); input.target.dailyBudget.minorUnits = minorUnits;
    expect(translateCampaign(input)).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });
  it("rejects widened countries, mismatched creatives, precision loss and absent AI declaration", () => {
    const countries = translation(); countries.campaign.audience.countries = ["TW", "TH"];
    const creative = translation(); creative.campaign.creativeDigest = "b".repeat(64);
    const precision = translation(); precision.campaign.schedule.window.start += 1;
    const declaration = translation(); delete (declaration.resolved as Record<string, unknown>).generatedByAi;
    for (const input of [countries, creative, precision, declaration]) expect(translateCampaign(input)).toMatchObject({ ok: false });
  });
  it("translates Thailand with an explicit country/currency/timezone and optional AI declaration", () => {
    const input = translation(); input.campaign.audience.countries = ["TH"]; input.campaign.schedule.timezone = "Asia/Bangkok"; input.target.dailyBudget.currency = "THB";
    input.resolved = { ...pausedPlan.metadata, country: "TH", currency: "THB", timezone: "Asia/Bangkok", bid: { minorUnits: 25, currency: "THB" }, creative: pausedPlan.ad.creative };
    expect(translateCampaign(input)).toMatchObject({ ok: true, value: { campaign: { startDate: "2026-10-25T07:00:00+07:00" }, adgroup: { targeting: { country: "TH" } } } });
  });
  it("creates PAUSED parents/child after exact enriched readback, projecting response-only fields", async () => {
    const f = make(); f.state.time = 1640131200000; const result = await deployCampaignPaused(f.input);
    expect(result).toMatchObject({ ok: true, value: { status: "acknowledged", references: { campaign: "456", adgroup: "789", ad: "987" }, entityIds: ["456", "789", "987"], hierarchy: [{ id: "456", configuredStatus: "PAUSED" }, { id: "789", campaignId: 456 }, { id: "987", adgroupId: 789 }] } });
    if (!result.ok) throw new Error("Expected enriched readback");
    expect(result.value.hierarchy[2]).toEqual({ ...pausedPlan.ad, adgroupId: 789, adaccountId: "123", id: "987", deliveryStatus: "PAUSED" });
    expect(f.rows.ads.creative).toMatchObject({ id: 654, image: { id: 321 }, reviewStatus: "APPROVED", callToAction: { type: "SYNTHETIC_LABEL" } });
    expect(f.calls.map(call => call.init.method)).toEqual(["GET", "POST", "GET", "POST", "GET", "POST", "GET"]);
    expect(f.journal).toEqual([
      { step: "campaign", phase: "dispatch", references: {} }, { step: "campaign", phase: "acknowledged", references: { campaign: "456" } },
      { step: "adgroup", phase: "dispatch", references: { campaign: "456" } }, { step: "adgroup", phase: "acknowledged", references: { campaign: "456", adgroup: "789" } },
      { step: "ad", phase: "dispatch", references: { campaign: "456", adgroup: "789" } }, { step: "ad", phase: "acknowledged", references: { campaign: "456", adgroup: "789", ad: "987" } },
    ]);
    const headers = f.calls[1].init.headers as Record<string, string>;
    const payload = Buffer.from(headers.Authorization.split(".")[1], "base64url").toString();
    expect(headers["Content-Type"]).toBe("application/json"); expect(payload).toBe(createHash("sha256").update(String(f.calls[1].init.body)).digest("hex") + "\napplication/json\n20211222\n/api/v3/adaccounts/123/campaigns");
    expect(f.observations).toHaveLength(7); expect(f.observations[0]).toMatchObject({ correlationId: "correlation", traceId: "trace", runId: "run" });
  });
  it.each([
    ["campaign", "dispatch", 0, {}], ["campaign", "acknowledged", 1, { campaign: "456" }],
    ["adgroup", "dispatch", 1, { campaign: "456" }], ["adgroup", "acknowledged", 2, { campaign: "456", adgroup: "789" }],
    ["ad", "dispatch", 2, { campaign: "456", adgroup: "789" }], ["ad", "acknowledged", 3, { campaign: "456", adgroup: "789", ad: "987" }],
  ])("stops on %s %s checkpoint failure and preserves refs", async (step, phase, posts, references) => {
    const f = make({ checkpoint: entry => { if (entry.step === step && entry.phase === phase) throw new Error("journal failure"); return { ok: true, value: undefined }; } });
    expect(await deployCampaignPaused(f.input)).toMatchObject({ ok: true, value: { status: "unknown", references } });
    expect(f.calls.filter(call => call.init.method === "POST")).toHaveLength(Number(posts));
  });
  it.each(["reject", "throttle", "timeout", "json", "missing-id", "unsafe-number", "unsafe-string"])("stops uncertain second create (%s); retries only GETs", async fault => {
    const f = make({ response: ({ resource, method }) => {
      if (resource !== "adgroups" || method !== "POST") return;
      if (fault === "timeout") throw new Error("timeout after vendor effect");
      if (fault === "reject" || fault === "throttle") return new Response("secret", { status: fault === "reject" ? 403 : 429 });
      if (fault === "json") return new Response("{");
      return Response.json({ id: fault === "missing-id" ? undefined : fault === "unsafe-number" ? Number.MAX_SAFE_INTEGER + 1 : "9007199254740993" });
    } });
    expect(await deployCampaignPaused(f.input)).toMatchObject({ ok: true, value: { status: "unknown", references: { campaign: "456" } } });
    expect(f.calls.map(call => call.init.method)).toEqual(["GET", "POST", "GET", "POST"]);
    const start = f.calls.length;
    expect(await readCampaignDeployment({ ...f.input, references: { campaign: "456" } })).toMatchObject({ ok: true, value: { status: "unknown", references: { campaign: "456" } } });
    expect(f.calls.slice(start).map(call => call.init.method)).toEqual(["GET", "GET"]);
    await deployCampaignPaused(f.input); expect(f.calls.filter(call => call.init.method === "POST")).toHaveLength(2);
  });
  it.each([
    ["campaigns", { id: 999 }, 1], ["campaigns", { configuredStatus: "ACTIVE" }, 1], ["campaigns", { deliveryStatus: "ACTIVE" }, 1], ["campaigns", { endDate: "2026-10-27T08:00:00+08:00" }, 1],
    ["adgroups", { campaignId: 999 }, 2], ["adgroups", { dailyBudgetMicro: 1 }, 2], ["adgroups", { bidAmountMicro: 1 }, 2], ["adgroups", { targeting: { country: "TH", targetingMode: "MANUAL" } }, 2],
    ["ads", { adgroupId: 999 }, 3], ["ads", { adaccountId: "999" }, 3], ["ads", { generatedByAi: true }, 3], ["ads", { creative: { ...pausedPlan.ad.creative, imageHash: "wrong" } }, 3],
    ["ads", { creative: { ...pausedPlan.ad.creative, id: 654, reviewStatus: "APPROVED", callToAction: { landingPageUrl: "https://example.test/wrong", type: "SYNTHETIC_LABEL" } } }, 3],
    ["ads", { creative: { ...pausedPlan.ad.creative, id: 654, image: { id: 321 }, imageHash: undefined } }, 3],
  ])("treats conflicting %s readback as unknown and creates no further child", async (resource, patch, posts) => {
    const f = make({ response: request => request.method === "GET" && request.resource === resource ? Response.json({ datas: [{ ...request.row, ...patch as object }], paging: { page: 1, size: 1, totalElements: 1 } }) : undefined });
    expect(await deployCampaignPaused(f.input)).toMatchObject({ ok: true, value: { status: "unknown" } });
    expect(f.calls.filter(call => call.init.method === "POST")).toHaveLength(Number(posts));
    expect(await readCampaignDeployment({ ...f.input, references: { campaign: "456", adgroup: "789", ad: "987" } })).toMatchObject({ ok: true, value: { status: "unknown" } });
    expect(f.calls.filter(call => call.init.method === "POST")).toHaveLength(Number(posts));
  });
  it.each([{ currency: "USD" }, { timezone: "UTC" }, { country: "TH" }, { id: 999 }])("checks account provenance before POST", async patch => {
    const f = make(); Object.assign(f.rows.accounts, patch);
    expect(await deployCampaignPaused(f.input)).toMatchObject({ ok: true, value: { status: "unknown", references: {} } }); expect(f.calls).toHaveLength(1);
  });
  it("rejects contradictory account pagination before writes", async () => {
    const f = make({ response: request => request.resource === "accounts" ? Response.json({ datas: [request.row], paging: { page: 1, size: 100, totalElements: 0 } }) : undefined });
    expect(await deployCampaignPaused(f.input)).toMatchObject({ ok: true, value: { status: "unknown", references: {} } }); expect(f.calls).toHaveLength(1);
  });
  it("requires exactly one row and explicit non-serving evidence", async () => {
    for (const datas of [[], [{ ...pausedPlan.campaign, id: 456 }], [{ ...pausedPlan.campaign, id: 456, deliveryStatus: "PAUSED" }, { ...pausedPlan.campaign, id: 456, deliveryStatus: "PAUSED" }]]) {
      const f = make({ response: request => request.resource === "campaigns" && request.method === "GET" ? Response.json({ datas, paging: { page: 1, size: 1, totalElements: datas.length } }) : undefined });
      expect(await deployCampaignPaused(f.input)).toMatchObject({ ok: true, value: { status: "unknown", references: { campaign: "456" } } }); expect(f.calls).toHaveLength(3);
    }
  });
  it("reconciles saved IDs with GETs only and preserves them when configuration drifts", async () => {
    const f = make(); await deployCampaignPaused(f.input); const start = f.calls.length;
    const references = { campaign: "456", adgroup: "789", ad: "987" };
    expect(await readCampaignDeployment({ ...f.input, references })).toMatchObject({ ok: true, value: { status: "acknowledged", references } });
    f.rows.adgroups.dailyBudgetMicro = 1;
    expect(await readCampaignDeployment({ ...f.input, references })).toMatchObject({ ok: true, value: { status: "unknown", references } });
    expect(f.calls.slice(start).every(call => call.init.method === "GET")).toBe(true); expect(f.journal).toHaveLength(6);
  });
  it("denies unadmitted, out-of-scope and inflated plans without credentials", async () => {
    const f = make(); f.state.admitted = false; expect(await deployCampaignPaused(f.input)).toMatchObject({ ok: false, error: { code: "forbidden" } }); f.state.admitted = true;
    expect(await deployCampaignPaused({ ...f.input, context: { ...f.input.context, scope: { ...f.input.context.scope, workspaceId: "foreign" } } })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(await deployCampaignPaused({ ...f.input, plan: { ...pausedPlan, activate: true } })).toMatchObject({ ok: false });
    expect(f.calls).toEqual([]); expect(f.credentialCalls).toEqual([]); expect(f.journal).toEqual([]);
  });
  it("rechecks live authority after custody and retains the validated plan snapshot across awaits", async () => {
    const revoked = make({ credentialHook: ({ state }) => { state.admitted = false; } });
    expect(await deployCampaignPaused(revoked.input)).toMatchObject({ ok: true, value: { status: "unknown", references: {} } }); expect(revoked.calls).toEqual([]);
    const rebound = make({ credentialHook: ({ binding }) => { binding.accountId = "999"; } }); await deployCampaignPaused(rebound.input); expect(rebound.calls).toEqual([]);
    const f = make({ checkpoint: () => { f.input.plan.campaign.name = "changed after review"; return { ok: true, value: undefined }; } });
    expect(await deployCampaignPaused(f.input)).toMatchObject({ ok: true, value: { status: "acknowledged" } });
  });
  it("rejects activation, missing declarations, wrong parent slots and unsafe micros at the plan boundary", () => {
    for (const plan of [{ ...pausedPlan, campaign: { ...pausedPlan.campaign, configuredStatus: "ACTIVE" } }, { ...pausedPlan, adgroup: { ...pausedPlan.adgroup, campaignId: 456 } }, { ...pausedPlan, adgroup: { ...pausedPlan.adgroup, dailyBudgetMicro: 1.5 } }, { ...pausedPlan, ad: { ...pausedPlan.ad, generatedByAi: undefined } }]) expect(campaignDeploymentPlanSchema.safeParse(plan).success).toBe(false);
  });
  it("stops on a rejected checkpoint and cancellation after a known parent", async () => {
    const stopped = make({ checkpoint: () => ({ ok: false, error: { code: "unavailable", message: "journal unavailable", retryable: false } }) });
    expect(await deployCampaignPaused(stopped.input)).toMatchObject({ ok: true, value: { status: "unknown", references: {} } }); expect(stopped.calls.map(call => call.init.method)).toEqual(["GET"]);
    const controller = new AbortController(); const f = make({ checkpoint: entry => { if (entry.phase === "acknowledged") controller.abort(); return { ok: true, value: undefined }; } });
    expect(await deployCampaignPaused(f.input, { signal: controller.signal })).toMatchObject({ ok: true, value: { status: "unknown", references: { campaign: "456" } } }); expect(f.calls.map(call => call.init.method)).toEqual(["GET", "POST"]);
  });
  it("bounds plan bytes and rejects unsafe references without credentials or discovery", async () => {
    const f = make();
    expect(await deployCampaignPaused({ ...f.input, plan: { ...pausedPlan, padding: "x".repeat(65536) } })).toMatchObject({ ok: false, error: { code: "limit_exceeded" } });
    expect(await readCampaignDeployment({ ...f.input, references: { campaign: "9007199254740993" } })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(await readCampaignDeployment({ ...f.input, references: {} })).toMatchObject({ ok: true, value: { status: "unknown", references: {} } }); expect(f.calls).toEqual([]); expect(f.credentialCalls).toEqual([]);
  });
});

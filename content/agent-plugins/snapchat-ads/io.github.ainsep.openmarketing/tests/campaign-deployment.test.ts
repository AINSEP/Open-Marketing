import { describe, expect, it } from "vitest";
import { campaignDeploymentPlanSchema, deployCampaignPaused, readCampaignDeployment, translateCampaign } from "../src/index.js";
import type { CampaignTranslationInput, SnapchatDeploymentDependencies, SnapchatDeploymentInput, SnapchatPausedPlan } from "../src/index.js";
const account = "11111111-1111-1111-1111-111111111111", creative = "22222222-2222-2222-2222-222222222222";
const ids = { campaign: "33333333-3333-3333-3333-333333333333", squad: "44444444-4444-4444-4444-444444444444", ad: "55555555-5555-5555-5555-555555555555" };
const context = { scope: { ownerId: "owner", workspaceId: "workspace" }, principal: { kind: "owner" as const, ownerId: "owner" }, correlationId: "correlation", traceId: "trace", runId: "run" };
const neutral: CampaignTranslationInput = {
  campaign: { name: "Website", objective: "traffic", schedule: { timezone: "UTC", window: { start: 1790812800000, end: 1790899200000 } }, audience: { countries: ["US", "CA"] }, creativeIds: ["asset"], creativeDigest: "a".repeat(64) },
  target: { accountId: account, dailyBudget: { currency: "USD", minorUnits: 500 } },
  resolved: { accountId: account, currency: "USD", currencyExponent: 2, timezone: "UTC", creativeId: "asset", creativeDigest: "a".repeat(64), providerCreativeId: creative, creativeAccountId: account, creativeType: "WEB_VIEW", bid: { currency: "USD", minorUnits: 1 } },
};
function plan(): SnapchatPausedPlan { const result = translateCampaign(neutral); if (!result.ok) throw new Error("Invalid fixture"); return result.value; }
type Fault = "parent" | "budget" | "schedule" | "creative" | "cardinality" | "malformed";
type FaultInput = { fault: Fault; body: Record<string, unknown>; method: string; path: string };
/** Corrupt synthetic responses only; preserve the fixture's saved provider rows for later reads. O(1). */
function corruptReadback(required: FaultInput): void {
  const { fault, body, path } = required;
  if (path.includes("/campaigns/")) {
    const row = (body.campaigns as { campaign: Record<string, unknown> }[])[0].campaign;
    switch (fault) {
      case "parent": row.ad_account_id = creative; break;
      case "budget": row.daily_budget_micro = 6000000; break;
      case "schedule": row.end_time = "2027-01-01T00:00:00Z"; break;
      default: break;
    }
  }
  if (fault === "creative" && path.includes("/ads/")) (body.ads as { ad: Record<string, unknown> }[])[0].ad.creative_id = account;
}
/** Inject one protocol/readback fault into the synthetic provider response, without I/O. O(1). */
function faultResponse(required: FaultInput): Response {
  const { fault, method } = required, body = structuredClone(required.body);
  if (method === "POST" && fault === "malformed") return new Response("not json");
  if (method === "POST" && fault === "cardinality") return Response.json({ ...body, campaigns: [] });
  if (method === "GET") corruptReadback({ ...required, body });
  return Response.json(body);
}
/** Guarded memory host + synthetic provider. The same owning-job checkpoint rejects replay. */
function fixture(required: { admitted?: boolean; response?: (input: { body: Record<string, unknown>; method: string; path: string }) => Response;
  checkpoint?: SnapchatDeploymentInput["checkpoint"]; credentialHook?: (input: { state: { current: boolean }; count: number }) => void } = {}) {
  const calls: { path: string; method: string; body: unknown; init: RequestInit }[] = [], journal: unknown[] = [], rows = new Map<string, unknown>(), observations: unknown[] = [];
  const state = { current: true }, claimed = new Set<string>(); let credentialCount = 0;
  const dependencies: SnapchatDeploymentDependencies = {
    admitted: required.admitted ?? true, configuration: { scope: context.scope, connectionId: "connection", accountId: account, currency: "USD", timezone: "UTC", apiVersion: "v1", pluginDigest: "b".repeat(64) },
    credentials: { async access() { credentialCount++; required.credentialHook?.({ state, count: credentialCount }); return { ok: true, value: { accessToken: "synthetic-secret", expiresAt: 2000000000000 } }; } },
    clock: { now: () => 1790810000000 }, observer: { observe(event) { observations.push(event); } },
    fetch: async (url, init = {}) => {
      if (!state.current) throw new Error("Fixture authority revoked");
      const path = new URL(String(url)).pathname, method = init.method ?? "GET";
      const payload = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ path, method, body: payload, init });
      if (path.endsWith("/" + creative)) return Response.json({ request_status: "SUCCESS", creatives: [{ sub_request_status: "SUCCESS", creative: { id: creative, ad_account_id: account, type: "WEB_VIEW" } }] });
      const plural = method === "POST" ? path.split("/").at(-1)! : path.split("/").at(-2)!;
      const singular = ({ campaigns: "campaign", adsquads: "adsquad", ads: "ad" } as Record<string, string>)[plural];
      const step = ({ campaigns: "campaign", adsquads: "squad", ads: "ad" } as Record<string, keyof typeof ids>)[plural];
      const row = method === "POST" ? { ...payload[plural][0], id: ids[step] } : rows.get(path);
      if (method === "POST") rows.set("/v1/" + plural + "/" + ids[step], row);
      const body = { request_status: "SUCCESS", [plural]: [{ sub_request_status: "SUCCESS", [singular]: row }] };
      return required.response?.({ body, method, path }) ?? Response.json(body);
    },
  };
  const input: SnapchatDeploymentInput = { context, operationId: "operation", dependencies, plan: plan(),
    async checkpoint(event) { journal.push(structuredClone(event)); if (required.checkpoint) return required.checkpoint(event);
      if (event.phase === "dispatch" && claimed.has(event.step)) return { ok: false, error: { code: "conflict", message: "Already dispatched", retryable: false } };
      if (event.phase === "dispatch") claimed.add(event.step); return { ok: true, value: undefined }; } };
  return { input, calls, journal, observations, state, credentialCount: () => credentialCount };
}
describe("Snapchat finite paused translation", () => {
  it("freezes exact PAUSED traffic, bid, budget, schedule, targeting and asset digest", () => {
    const result = plan(); expect(result.campaign.status).toBe("PAUSED"); expect(result.squad.status).toBe("PAUSED"); expect(result.ad.status).toBe("PAUSED");
    expect(result.campaign.objective_v2_properties).toEqual({ objective_v2_type: "TRAFFIC" });
    expect(result.squad).toMatchObject({ daily_budget_micro: 5000000, bid_micro: 10000, optimization_goal: "SWIPES", bid_strategy: "LOWEST_COST_WITH_MAX_BID", type: "SNAP_ADS", billing_event: "IMPRESSION", placement_v2: { config: "AUTOMATIC" } });
    expect(result.squad.targeting.geos).toEqual([{ country_code: "us" }, { country_code: "ca" }]); expect(result.creativeDigest).toBe(neutral.campaign.creativeDigest);
  });
  it.each([
    { campaign: { ...neutral.campaign, objective: "sales" } }, { campaign: { ...neutral.campaign, creativeIds: ["a", "b"] } },
    { campaign: { ...neutral.campaign, audience: { countries: ["US", "US"] } } }, { campaign: { ...neutral.campaign, audience: { countries: ["US"], searchTerms: ["term"] } } },
    { resolved: { ...neutral.resolved, creativeDigest: "b".repeat(64) } }, { resolved: { ...neutral.resolved, creativeAccountId: creative } },
    { resolved: { ...neutral.resolved, currencyExponent: 3 } }, { resolved: { ...neutral.resolved, creativeType: "APP_INSTALL" } },
    { target: { ...neutral.target, dailyBudget: { currency: "USD", minorUnits: 499 } } },
    { target: { ...neutral.target, dailyBudget: { currency: "USD", minorUnits: Number.MAX_SAFE_INTEGER } } },
    { resolved: { ...neutral.resolved, bid: { currency: "USD", minorUnits: 50001 } } },
  ])("denies unsupported/mismatched or lossy values", patch => { expect(translateCampaign({ ...neutral, ...patch } as CampaignTranslationInput).ok).toBe(false); });
  it("enforces currency-specific maxima and three-decimal lossless money", () => {
    const kwd = { ...neutral, target: { accountId: account, dailyBudget: { currency: "KWD", minorUnits: 5000 } }, resolved: { ...neutral.resolved, currency: "KWD", currencyExponent: 3, bid: { currency: "KWD", minorUnits: 10 } } };
    expect(translateCampaign(kwd)).toMatchObject({ ok: true, value: { squad: { bid_micro: 10000, daily_budget_micro: 5000000 } } });
    expect(translateCampaign({ ...kwd, resolved: { ...kwd.resolved, bid: { currency: "KWD", minorUnits: 100001 } } }).ok).toBe(false);
    expect(translateCampaign({ ...kwd, resolved: { ...kwd.resolved, currency: "JPY" } }).ok).toBe(false);
  });
  it("rejects activated, altered-budget and altered-schedule frozen plans", () => {
    const p = plan(); for (const patch of [{ campaign: { ...p.campaign, status: "ACTIVE" } }, { squad: { ...p.squad, daily_budget_micro: 6000000 } }, { squad: { ...p.squad, end_time: p.squad.start_time } }]) expect(campaignDeploymentPlanSchema.safeParse({ ...p, ...patch }).success).toBe(false);
  });
});
describe("Snapchat owning-job paused deployment", () => {
  it("sends the independently specified daily-budget squad payload", async () => {
    // Synthetic payload authored from Snap's Attributes table, never copied from the submitted plan/echo.
    const expected = { adsquads: [{ campaign_id: "33333333-3333-3333-3333-333333333333", name: "Website", status: "PAUSED",
      start_time: "2026-10-01T00:00:00.000Z", end_time: "2026-10-02T00:00:00.000Z", type: "SNAP_ADS", billing_event: "IMPRESSION",
      placement_v2: { config: "AUTOMATIC" }, optimization_goal: "SWIPES", bid_strategy: "LOWEST_COST_WITH_MAX_BID", bid_micro: 10000,
      daily_budget_micro: 5000000, delivery_constraint: "DAILY_BUDGET", targeting: { geos: [{ country_code: "us" }, { country_code: "ca" }] } }] };
    const f = fixture(); await deployCampaignPaused(f.input);
    expect(f.calls.find(call => call.method === "POST" && call.path.endsWith("/adsquads"))?.body).toEqual(expected);
  });
  it.each([undefined, "LIFETIME_BUDGET", "REACH_AND_FREQUENCY", "unknown"])("rejects an unreviewed delivery constraint %s before any I/O", async deliveryConstraint => {
    const f = fixture(), p = plan();
    const invalid = { ...p, squad: { ...p.squad, delivery_constraint: deliveryConstraint } };
    expect(campaignDeploymentPlanSchema.safeParse(invalid).success).toBe(false);
    f.input.plan = invalid;
    expect((await deployCampaignPaused(f.input)).ok).toBe(false);
    expect((await readCampaignDeployment({ ...f.input, references: ids })).ok).toBe(false);
    expect(f.calls).toHaveLength(0); expect(f.journal).toHaveLength(0); expect(f.credentialCount()).toBe(0);
  });
  it.each([undefined, "LIFETIME_BUDGET"])("stops before creating an ad if the squad reads back delivery constraint %s", async deliveryConstraint => {
    const f = fixture({ response: ({ body, method, path }) => {
      if (method === "GET" && path.includes("/adsquads/")) (body.adsquads as { adsquad: Record<string, unknown> }[])[0].adsquad.delivery_constraint = deliveryConstraint;
      return Response.json(body);
    } });
    expect(await deployCampaignPaused(f.input)).toMatchObject({ ok: true, value: { status: "unknown", references: { campaign: ids.campaign, squad: ids.squad } } });
    expect(f.calls.filter(call => call.method === "POST")).toHaveLength(2);
  });
  it("creates parents only after scoped readback and checkpoints each ID", async () => {
    const f = fixture(); const result = await deployCampaignPaused(f.input);
    expect(result).toMatchObject({ ok: true, value: { status: "acknowledged", references: ids, entityIds: Object.values(ids), hierarchy: [{ status: "PAUSED" }, { status: "PAUSED" }, { status: "PAUSED" }] } });
    expect(f.calls.map(call => call.method)).toEqual(["GET", "POST", "GET", "POST", "GET", "POST", "GET"]);
    expect(f.journal).toEqual(["campaign", "squad", "ad"].flatMap((step, index) => [
      { step, phase: "dispatch", references: Object.fromEntries(Object.entries(ids).slice(0, index)) }, { step, phase: "acknowledged", references: Object.fromEntries(Object.entries(ids).slice(0, index + 1)) }]));
    for (const call of f.calls.filter(call => call.method === "POST")) { expect(JSON.stringify(call.body)).toContain('"status":"PAUSED"'); expect(call.init.redirect).toBe("error"); expect(call.init.signal).toBeDefined(); expect(call.init.headers).not.toHaveProperty("Idempotency-Key"); }
    expect(JSON.stringify(result)).not.toContain("synthetic-secret"); expect(JSON.stringify(f.observations)).not.toContain("synthetic-secret");
  });
  it("denies admission and unsupported plans before credentials or checkpoints", async () => {
    const f = fixture({ admitted: false }); expect((await deployCampaignPaused(f.input)).ok).toBe(false);
    expect((await readCampaignDeployment({ ...f.input, references: ids })).ok).toBe(false); expect(f.credentialCount()).toBe(0); expect(f.journal).toHaveLength(0);
    const invalid = fixture(); invalid.input.plan = { ...plan(), ad: { ...plan().ad, status: "ACTIVE" } };
    expect((await deployCampaignPaused(invalid.input)).ok).toBe(false); expect(invalid.credentialCount()).toBe(0);
  });
  it.each(["dispatch", "acknowledged"] as const)("stops on %s checkpoint failure", async phase => {
    const f = fixture({ checkpoint: async event => { if (event.phase === phase) throw new Error("synthetic-secret"); return { ok: true, value: undefined }; } });
    expect(await deployCampaignPaused(f.input)).toMatchObject({ ok: true, value: { status: "unknown", references: phase === "acknowledged" ? { campaign: ids.campaign } : {} } });
    expect(f.calls.filter(call => call.method === "POST")).toHaveLength(phase === "acknowledged" ? 1 : 0);
  });
  it.each(["campaigns", "adsquads", "ads"])("retains partial refs when %s readback differs", async plural => {
    const f = fixture({ response: ({ body, path, method }) => { if (method === "GET" && path.includes("/" + plural + "/")) {
      const singular = ({ campaigns: "campaign", adsquads: "adsquad", ads: "ad" } as Record<string, string>)[plural];
      const rows = body[plural] as Record<string, Record<string, unknown>>[]; rows[0][singular].status = "ACTIVE";
    } return Response.json(body); } });
    const result = await deployCampaignPaused(f.input); expect(result).toMatchObject({ ok: true, value: { status: "unknown" } });
    const count = ["campaigns", "adsquads", "ads"].indexOf(plural) + 1;
    expect(f.calls.filter(call => call.method === "POST")).toHaveLength(count); if (result.ok) expect(result.value.entityIds).toEqual(Object.values(ids).slice(0, count));
  });
  it("keeps a candidate ID on failed acknowledgement success and never creates a child", async () => {
    const f = fixture({ response: ({ body, method }) => Response.json(method === "POST" ? { ...body, request_status: "ERROR" } : body) });
    expect(await deployCampaignPaused(f.input)).toMatchObject({ ok: true, value: { status: "unknown", references: { campaign: ids.campaign } } }); expect(f.calls).toHaveLength(2);
  });
  it.each(["parent", "budget", "schedule", "creative", "cardinality", "malformed"] as const)("stops on %s mismatch without losing prior references", async fault => {
    const f = fixture({ response: input => faultResponse({ ...input, fault }) });
    const result = await deployCampaignPaused(f.input); expect(result).toMatchObject({ ok: true, value: { status: "unknown" } });
    expect(f.calls.filter(call => call.method === "POST")).toHaveLength(fault === "creative" ? 3 : 1);
    if (result.ok && !["cardinality", "malformed"].includes(fault)) expect(result.value.references.campaign).toBe(ids.campaign);
  });
  it("reads the complete hierarchy using only GETs and strips unreviewed response fields", async () => {
    const f = fixture(); await deployCampaignPaused(f.input); const start = f.calls.length;
    expect(await readCampaignDeployment({ ...f.input, references: ids })).toMatchObject({ ok: true, value: { status: "acknowledged", references: ids } });
    expect(f.calls.slice(start).map(call => call.method)).toEqual(["GET", "GET", "GET", "GET"]);
    expect((await readCampaignDeployment({ ...f.input, references: { campaign: "invalid" } })).ok).toBe(false);
  });
  it("keeps earlier refs after an unknown child outcome, never resends, GET-only reconciles", async () => {
    const f = fixture({ response: ({ body, path, method }) => { if (method === "POST" && path.endsWith("/adsquads")) throw new Error("synthetic-secret"); return Response.json(body); } });
    const result = await deployCampaignPaused(f.input); expect(result).toMatchObject({ ok: true, value: { status: "unknown", references: { campaign: ids.campaign } } });
    const writes = f.calls.filter(call => call.method === "POST").length;
    await deployCampaignPaused(f.input); expect(f.calls.filter(call => call.method === "POST")).toHaveLength(writes);
    const start = f.calls.length; if (result.ok) expect(await readCampaignDeployment({ ...f.input, references: result.value.references })).toMatchObject({ ok: true, value: { status: "unknown", references: result.value.references } });
    expect(f.calls.slice(start).every(call => call.method === "GET")).toBe(true);
    const before = f.calls.length; await readCampaignDeployment({ ...f.input, references: {} }); expect(f.calls).toHaveLength(before);
  });
  it("rechecks host authority after each credential lookup and preserves earlier refs", async () => {
    const f = fixture({ credentialHook: ({ state, count }) => { if (count === 4) state.current = false; } });
    expect(await deployCampaignPaused(f.input)).toMatchObject({ ok: true, value: { status: "unknown", references: { campaign: ids.campaign } } }); expect(f.calls).toHaveLength(3);
    const cancelled = fixture(); const controller = new AbortController(); controller.abort(); await deployCampaignPaused(cancelled.input, { signal: controller.signal }); expect(cancelled.credentialCount()).toBe(0);
  });
  it("preserves caller-reviewed plan against checkpoint mutation", async () => {
    const f = fixture({ checkpoint: async () => { (f.input.plan as SnapchatPausedPlan).squad.bid_micro = 999999; return { ok: true, value: undefined }; } });
    expect((await deployCampaignPaused(f.input)).ok).toBe(true); expect(JSON.stringify(f.calls[3].body)).toContain('"bid_micro":10000');
  });
});

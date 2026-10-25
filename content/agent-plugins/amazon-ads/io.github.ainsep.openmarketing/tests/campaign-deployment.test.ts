import { describe, expect, it } from "vitest";
import { campaignDeploymentPlanSchema, deployCampaignPaused, readCampaignDeployment, translateCampaign } from "../src/index.js";
import type { AmazonDeploymentPlan, CampaignTranslationInput } from "../src/index.js";
import { context, credential, denial, fixture, profile } from "./fixtures.js";

const plan: AmazonDeploymentPlan = {
  profile: { accountId: "123", country: "US", currency: "USD", timezone: "America/Los_Angeles" },
  campaign: { name: "Fixture SP", state: "PAUSED", targetingType: "AUTO", budget: { budget: 10.29, budgetType: "DAILY" }, startDate: "2026-11-01", endDate: "2026-11-03", dynamicBidding: { strategy: "MANUAL" } },
  group: { name: "Fixture group", campaignId: { from: "campaign" }, defaultBid: 0.29, state: "PAUSED" },
  ad: { campaignId: { from: "campaign" }, adGroupId: { from: "group" }, product: { type: "seller", sku: "fixture-sku" }, state: "PAUSED" },
};
const campaignRow = { campaignId: "456", name: "Fixture SP", state: "PAUSED", targetingType: "AUTO", budget: { budget: 10.29, budgetType: "DAILY" }, startDate: "2026-11-01", endDate: "2026-11-03", dynamicBidding: { strategy: "MANUAL" } };
const groupRow = { campaignId: "456", adGroupId: "789", name: "Fixture group", defaultBid: 0.29, state: "PAUSED" };
const adRow = { campaignId: "456", adGroupId: "789", adId: "999", sku: "fixture-sku", state: "PAUSED" };
const responses = [
  [profile],
  { campaigns: { success: [{ index: 0, campaignId: "456" }], error: [] } }, { campaigns: [campaignRow] },
  { adGroups: { success: [{ index: 0, adGroupId: "789" }], error: [] } }, { adGroups: [groupRow] },
  { productAds: { success: [{ index: 0, adId: "999" }], error: [] } }, { productAds: [adRow] },
];
type Point = { step: string; phase: "dispatch" | "acknowledged"; references: Record<string, string | undefined> };
/** Independent scripted vendor replies; readback never echoes the attempted payload. */
function make(required: { response?: (input: { index: number }) => Response; checkpoint?: (input: Point) => boolean } = {}) {
  const points: Point[] = [];
  const f = fixture({ response: required.response ?? (({ index }) => Response.json(responses[(index - 1) % 7], { status: [2, 4, 6].includes((index - 1) % 7 + 1) ? 207 : 200 })) });
  const input = { context, operationId: "launch", plan: structuredClone(plan), dependencies: f.dependencies, checkpoint: async (point: Point) => {
    points.push(point); return required.checkpoint?.(point) === false ? denial() : { ok: true as const, value: undefined };
  } };
  return { ...f, points, input };
}
const translation: CampaignTranslationInput = {
  campaign: { name: "Fixture SP", objective: "traffic", schedule: { window: { start: 1793516400000, end: 1793779200000 }, timezone: "America/Los_Angeles" }, audience: { countries: ["US"] }, creativeIds: ["creative"], creativeDigest: "a".repeat(64) },
  target: { accountId: "123", dailyBudget: { minorUnits: 1029, currency: "USD" } },
  resolved: { accountId: "123", country: "US", currency: "USD", timezone: "America/Los_Angeles", creativeId: "creative", creativeDigest: "a".repeat(64), product: { type: "seller", sku: "fixture-sku" }, defaultBid: { minorUnits: 29, currency: "USD" } },
};

describe("Amazon R2 paused hierarchy", () => {
  it("creates only PAUSED, reads each parent before children, and retains the verified hierarchy", async () => {
    const f = make(); const result = await deployCampaignPaused(f.input);
    expect(result).toEqual({ ok: true, value: { status: "acknowledged", references: { campaign: "456", group: "789", ad: "999" }, entityIds: ["456", "789", "999"], hierarchy: [campaignRow, groupRow, adRow] } });
    expect(f.calls.map(call => new URL(call.url).pathname)).toEqual(["/v2/profiles", "/sp/campaigns", "/sp/campaigns/list", "/sp/adGroups", "/sp/adGroups/list", "/sp/productAds", "/sp/productAds/list"]);
    expect(JSON.parse(String(f.calls[1]!.init.body))).toEqual({ campaigns: [plan.campaign] });
    expect(JSON.parse(String(f.calls[3]!.init.body))).toEqual({ adGroups: [{ name: "Fixture group", campaignId: "456", defaultBid: 0.29, state: "PAUSED" }] });
    expect(JSON.parse(String(f.calls[5]!.init.body))).toEqual({ productAds: [{ campaignId: "456", adGroupId: "789", sku: "fixture-sku", state: "PAUSED" }] });
    expect(JSON.parse(String(f.calls[2]!.init.body))).toEqual({ maxResults: 2, campaignIdFilter: { include: ["456"] } });
    expect(JSON.parse(String(f.calls[4]!.init.body))).toEqual({ maxResults: 2, adGroupIdFilter: { include: ["789"] } });
    expect(JSON.parse(String(f.calls[6]!.init.body))).toEqual({ maxResults: 2, adIdFilter: { include: ["999"] } });
    expect(f.points.map(p => [p.step, p.phase])).toEqual([["campaign", "dispatch"], ["campaign", "acknowledged"], ["group", "dispatch"], ["group", "acknowledged"], ["ad", "dispatch"], ["ad", "acknowledged"]]);
    expect(f.calls.slice(1).map(call => new Headers(call.init.headers).get("Content-Type"))).toEqual(["application/vnd.spCampaign.v3+json", "application/vnd.spCampaign.v3+json", "application/vnd.spAdGroup.v3+json", "application/vnd.spAdGroup.v3+json", "application/vnd.spProductAd.v3+json", "application/vnd.spProductAd.v3+json"]);
    expect(f.calls.slice(1).every(call => new Headers(call.init.headers).get("Amazon-Advertising-API-Scope") === "123" && call.init.redirect === "error")).toBe(true);
    expect(f.deadlines).toHaveLength(7);
    expect(JSON.stringify({ result, points: f.points, observations: f.observations })).not.toContain(credential.accessToken);
    expect(f.observations.every(event => event.traceId === context.traceId && event.runId === context.runId && event.correlationId === context.correlationId)).toBe(true);
  });
  it("denies unadmitted deployment and reconciliation before all effects", async () => {
    const f = make(); f.state.admitted = false;
    expect(await deployCampaignPaused(f.input)).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(await readCampaignDeployment({ ...f.input, references: { campaign: "456" } })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(f.state.credentialCalls).toBe(0); expect(f.points).toEqual([]); expect(f.calls).toEqual([]);
  });
  it.each(["foreign-scope", "foreign-profile", "active", "SB", "fractional-bid", "bad-date", "bad-zone", "too-large"])("rejects %s before egress", async variation => {
    const f = make();
    if (variation === "foreign-scope") f.input.context = { ...context, scope: { ...context.scope, ownerId: "other" } };
    if (variation === "foreign-profile") f.input.plan.profile.accountId = "124";
    if (variation === "active") Object.assign(f.input.plan.ad, { state: "ENABLED" });
    if (variation === "SB") Object.assign(f.input.plan.campaign, { adProduct: "SB" });
    if (variation === "fractional-bid") f.input.plan.group.defaultBid = 0.291;
    if (variation === "bad-date") f.input.plan.campaign.startDate = "2026-02-30";
    if (variation === "bad-zone") f.input.plan.profile.timezone = "unknown";
    if (variation === "too-large") f.input.plan.campaign.name = "x".repeat(65536);
    expect((await deployCampaignPaused(f.input)).ok).toBe(false);
    expect(f.state.credentialCalls).toBe(0); expect(f.calls).toEqual([]); expect(f.points).toEqual([]);
  });
  it.each(["countryCode", "currencyCode", "timezone", "type"])("checks profile %s before dispatch", async field => {
    const row = { ...profile, [field]: "other", accountInfo: { ...profile.accountInfo, ...(field === "type" ? { type: "agency" } : {}) } };
    const f = make({ response: () => Response.json([row]) });
    expect((await deployCampaignPaused(f.input)).ok).toBe(false);
    expect(f.calls).toHaveLength(1); expect(f.points).toEqual([]);
  });
  it.each(["state", "budget", "endDate", "dynamicBidding", "campaignId"])("stops before children on campaign %s mismatch", async field => {
    const row = { ...campaignRow, [field]: field === "state" ? "ENABLED" : "different" };
    const f = make({ response: ({ index }) => Response.json(index === 3 ? { campaigns: [row] } : responses[index - 1], { status: index === 2 ? 207 : 200 }) });
    expect(await deployCampaignPaused(f.input)).toMatchObject({ ok: true, value: { status: "unknown", references: { campaign: "456" }, hierarchy: [] } });
    expect(f.calls).toHaveLength(3);
  });
  it.each(["parent", "duplicate", "pagination"])("stops before the ad on %s group readback", async variation => {
    const reply = variation === "parent" ? { adGroups: [{ ...groupRow, campaignId: "555" }] } : variation === "duplicate" ? { adGroups: [groupRow, groupRow] } : { adGroups: [groupRow], nextToken: "more" };
    const f = make({ response: ({ index }) => Response.json(index === 5 ? reply : responses[index - 1], { status: [2, 4].includes(index) ? 207 : 200 }) });
    expect(await deployCampaignPaused(f.input)).toMatchObject({ ok: true, value: { status: "unknown", references: { campaign: "456", group: "789" }, hierarchy: [campaignRow] } });
    expect(f.calls).toHaveLength(5);
  });
  it.each(["error", "mixed", "index", "malformed", "500", "timeout", "oversize"])("never retries a %s create outcome", async variation => {
    const f = make({ response: ({ index }) => {
      if (index !== 2) return Response.json(responses[index - 1]);
      if (variation === "timeout") throw new Error("fixture network uncertainty");
      if (variation === "oversize") return new Response("x".repeat(1048577), { status: 207 });
      const success = variation === "error" ? [] : [{ index: variation === "index" ? 1 : 0, campaignId: "456" }];
      return Response.json(variation === "malformed" ? {} : { campaigns: { success, error: ["fixture provider secret"] } }, { status: variation === "500" ? 500 : 207 });
    } });
    const result = await deployCampaignPaused(f.input);
    expect(result).toMatchObject({ ok: true, value: { status: "unknown", references: variation === "mixed" ? { campaign: "456" } : {} } });
    expect(f.calls).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain("fixture provider secret");
  });
  it.each(["dispatch", "acknowledged"] as const)("stops on a failed %s checkpoint and retains candidates", async phase => {
    const f = make({ checkpoint: point => point.phase !== phase });
    expect(await deployCampaignPaused(f.input)).toMatchObject({ ok: true, value: { status: "unknown", references: phase === "acknowledged" ? { campaign: "456" } : {} } });
    expect(f.calls).toHaveLength(phase === "dispatch" ? 1 : 2);
  });
  it("retains both parent IDs when a later create is uncertain", async () => {
    const f = make({ response: ({ index }) => { if (index === 6) throw new Error("lost ACK"); return Response.json(responses[index - 1], { status: [2, 4].includes(index) ? 207 : 200 }); } });
    expect(await deployCampaignPaused(f.input)).toMatchObject({ ok: true, value: { status: "unknown", references: { campaign: "456", group: "789" }, hierarchy: [campaignRow, groupRow] } });
    expect(f.calls).toHaveLength(6);
  });
  it("keeps the approved plan immutable across checkpoint awaits", async () => {
    const f = make({ checkpoint: () => { f.input.plan.campaign.budget.budget = 999; return true; } });
    expect(await deployCampaignPaused(f.input)).toMatchObject({ ok: true, value: { status: "acknowledged" } });
    expect(JSON.parse(String(f.calls[1]!.init.body)).campaigns[0].budget.budget).toBe(10.29);
  });
  it("rechecks admission after credential lookup and before creation", async () => {
    const f = make(); const access = f.dependencies.credentials.access;
    f.dependencies.credentials.access = async input => { const result = await access(input); if (f.state.credentialCalls === 2) f.state.admitted = false; return result; };
    expect(await deployCampaignPaused(f.input)).toMatchObject({ ok: true, value: { status: "unknown", references: {} } });
    expect(f.calls).toHaveLength(1);
  });
  it("retains the ID when an acknowledgement checkpoint throws", async () => {
    const f = make({ checkpoint: point => { if (point.phase === "acknowledged") throw new Error("fixture journal unavailable"); return true; } });
    expect(await deployCampaignPaused(f.input)).toMatchObject({ ok: true, value: { status: "unknown", references: { campaign: "456" } } });
    expect(f.calls).toHaveLength(2);
  });
  it("cancels before credentials, and after ACK retains the parent without another request", async () => {
    const abort = new AbortController(); abort.abort(); const cancelled = make();
    expect(await deployCampaignPaused(cancelled.input, { signal: abort.signal })).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(cancelled.state.credentialCalls).toBe(0); expect(cancelled.calls).toEqual([]); expect(cancelled.points).toEqual([]);
    const later = new AbortController(); const f = make({ checkpoint: point => { if (point.phase === "acknowledged") later.abort(); return true; } });
    expect(await deployCampaignPaused(f.input, { signal: later.signal })).toMatchObject({ ok: true, value: { status: "unknown", references: { campaign: "456" } } });
    expect(f.calls).toHaveLength(2);
  });
  it("rejects a changed final product while retaining all IDs", async () => {
    const f = make({ response: ({ index }) => Response.json(index === 7 ? { productAds: [{ ...adRow, sku: "other" }] } : responses[index - 1], { status: [2, 4, 6].includes(index) ? 207 : 200 }) });
    expect(await deployCampaignPaused(f.input)).toMatchObject({ ok: true, value: { status: "unknown", references: { campaign: "456", group: "789", ad: "999" }, hierarchy: [campaignRow, groupRow] } });
    expect(f.calls).toHaveLength(7);
  });
  it("uses the owning journal to deny a repeated dispatch without another create", async () => {
    const dispatched = new Set<string>(); const f = make({ checkpoint: point => {
      if (point.phase !== "dispatch") return true;
      if (dispatched.has(point.step)) return false;
      dispatched.add(point.step); return true;
    } });
    expect(await deployCampaignPaused(f.input)).toMatchObject({ ok: true, value: { status: "acknowledged" } });
    expect(await deployCampaignPaused(f.input)).toMatchObject({ ok: true, value: { status: "unknown", references: {} } });
    expect(f.points.filter(point => point.step === "campaign" && point.phase === "dispatch")).toHaveLength(2);
    expect(f.calls.filter(call => call.init.method === "POST" && !call.url.endsWith("/list"))).toHaveLength(3);
  });
  it("accepts explicit seller/vendor identities but exposes no activation or arbitrary request", () => {
    expect(campaignDeploymentPlanSchema.safeParse(plan).success).toBe(true);
    expect(campaignDeploymentPlanSchema.safeParse({ ...plan, ad: { ...plan.ad, product: { type: "vendor", asin: "B000000001" } } }).success).toBe(true);
    expect(campaignDeploymentPlanSchema.safeParse({ ...plan, ad: { ...plan.ad, sku: "bypass" } }).success).toBe(false);
  });
  it("supports the verified vendor ASIN payload without a seller SKU", async () => {
    const f = make({ response: ({ index }) => {
      const body = index === 1 ? [{ ...profile, accountInfo: { ...profile.accountInfo, type: "vendor" } }] : index === 7 ? { productAds: [{ campaignId: "456", adGroupId: "789", adId: "999", asin: "B000000001", state: "PAUSED" }] } : responses[index - 1];
      return Response.json(body, { status: [2, 4, 6].includes(index) ? 207 : 200 });
    } });
    f.input.plan.ad.product = { type: "vendor", asin: "B000000001" };
    expect(await deployCampaignPaused(f.input)).toMatchObject({ ok: true, value: { status: "acknowledged" } });
    expect(JSON.parse(String(f.calls[5]!.init.body))).toEqual({ productAds: [{ campaignId: "456", adGroupId: "789", asin: "B000000001", state: "PAUSED" }] });
  });
  it("keeps neutral translation unavailable until calendar semantics are evidenced", () => {
    expect(translateCampaign(translation)).toMatchObject({ ok: false, error: { code: "unavailable", retryable: false } });
    expect(translateCampaign({ ...translation, target: { ...translation.target, accountId: "124" } })).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(translateCampaign({ ...translation, campaign: { ...translation.campaign, audience: { countries: ["CA"] } } })).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(translateCampaign({ ...translation, campaign: { ...translation.campaign, audience: { countries: ["US"], searchTerms: ["unsupported"] } } })).toMatchObject({ ok: false, error: { code: "not_implemented" } });
  });
  it.each([
    ["2026-03-08T08:00:00Z", "2026-03-09T07:00:00Z"],
    ["2026-11-01T07:00:00Z", "2026-11-02T08:00:00Z"],
    ["2026-11-01T12:00:00Z", "2026-11-02T12:00:00Z"],
  ])("does not guess calendar boundaries for %s through %s", (start, end) => {
    const schedule = { timezone: "America/Los_Angeles", window: { start: Date.parse(start), end: Date.parse(end) } };
    expect(translateCampaign({ ...translation, campaign: { ...translation.campaign, schedule } })).toMatchObject({ ok: false, error: { code: "unavailable", retryable: false } });
  });
});

describe("Amazon saved-reference reconciliation", () => {
  const references = { campaign: "456", group: "789", ad: "999" };
  const reads = [[profile], { campaigns: [campaignRow] }, { adGroups: [groupRow] }, { productAds: [adRow] }];
  it("verifies the full saved hierarchy using only fixed read endpoints and no checkpoints", async () => {
    const f = make({ response: ({ index }) => Response.json(reads[index - 1]) });
    expect(await readCampaignDeployment({ ...f.input, references })).toEqual({ ok: true, value: { status: "acknowledged", references, entityIds: ["456", "789", "999"], hierarchy: [campaignRow, groupRow, adRow] } });
    expect(f.calls.map(call => [call.init.method, new URL(call.url).pathname])).toEqual([["GET", "/v2/profiles"], ["POST", "/sp/campaigns/list"], ["POST", "/sp/adGroups/list"], ["POST", "/sp/productAds/list"]]);
    expect(f.calls.slice(1).map(call => JSON.parse(String(call.init.body)))).toEqual([{ maxResults: 2, campaignIdFilter: { include: ["456"] } }, { maxResults: 2, adGroupIdFilter: { include: ["789"] } }, { maxResults: 2, adIdFilter: { include: ["999"] } }]);
    expect(f.points).toEqual([]);
  });
  it.each([{}, { campaign: "456" }, { campaign: "456", group: "789" }, { group: "789", ad: "999" }])("retains partial references without discovery or continuation: %j", async saved => {
    const f = make({ response: ({ index }) => Response.json(reads[index - 1]) });
    const count = saved.campaign ? saved.group ? 3 : 2 : 0;
    expect(await readCampaignDeployment({ ...f.input, references: saved })).toMatchObject({ ok: true, value: { status: "unknown", references: saved, entityIds: Object.values(saved), hierarchy: count ? [campaignRow, groupRow].slice(0, count - 1) : [] } });
    expect(f.calls).toHaveLength(count); expect(f.points).toEqual([]);
  });
  it.each(["missing", "duplicate", "pagination", "parent", "active", "timeout"])("stops at %s group readback and retains every saved ID", async variation => {
    const f = make({ response: ({ index }) => {
      if (index !== 3) return Response.json(reads[index - 1]);
      if (variation === "timeout") throw new Error("fixture-secret");
      const row = { ...groupRow, ...(variation === "parent" ? { campaignId: "555" } : {}), ...(variation === "active" ? { state: "ENABLED" } : {}) };
      return Response.json({ adGroups: variation === "missing" ? [] : variation === "duplicate" ? [row, row] : [row], ...(variation === "pagination" ? { nextToken: "more" } : {}) });
    } });
    const result = await readCampaignDeployment({ ...f.input, references });
    expect(result).toEqual({ ok: true, value: { status: "unknown", references, entityIds: ["456", "789", "999"], hierarchy: [campaignRow] } });
    expect(f.calls).toHaveLength(3); expect(f.points).toEqual([]); expect(JSON.stringify(result)).not.toContain("fixture-secret");
  });
  it("rejects malformed references before any effects", async () => {
    const f = make();
    expect(await readCampaignDeployment({ ...f.input, references: { ...references, ad: "invalid" } })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(f.state.credentialCalls).toBe(0); expect(f.calls).toEqual([]); expect(f.points).toEqual([]);
  });
  it.each(["scope", "profile"])("rejects foreign %s reconciliation before effects", async variation => {
    const f = make();
    if (variation === "scope") f.input.context = { ...context, scope: { ...context.scope, workspaceId: "other" } };
    else f.input.plan.profile.accountId = "124";
    expect(await readCampaignDeployment({ ...f.input, references })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(f.state.credentialCalls).toBe(0); expect(f.calls).toEqual([]); expect(f.points).toEqual([]);
  });
  it("retains saved IDs if admission is revoked during credential lookup", async () => {
    const f = make({ response: ({ index }) => Response.json(reads[index - 1]) }); const access = f.dependencies.credentials.access;
    f.dependencies.credentials.access = async input => { const result = await access(input); if (f.state.credentialCalls === 2) f.state.admitted = false; return result; };
    expect(await readCampaignDeployment({ ...f.input, references })).toMatchObject({ ok: true, value: { status: "unknown", references, hierarchy: [] } });
    expect(f.calls).toHaveLength(1); expect(f.points).toEqual([]);
  });
});

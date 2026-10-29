import { describe, expect, it } from "vitest";
import { campaignDeploymentPlanSchema, deployCampaignPaused, readCampaignDeployment, translateCampaign } from "../src/index.js";
import type { YandexDeploymentInput, YandexDraftPlan } from "../src/index.js";
import { account, configuration, context, denied, fixture, now } from "./fixtures.js";

// Independent expected wire fields; fixture responses never echo the request payload.
const campaign = { Name: "Traffic", StartDate: "2026-11-01", EndDate: "2026-11-08", TimeZone: "Europe/Moscow" as const,
  UnifiedCampaign: { BiddingStrategy: { Search: { BiddingStrategyType: "WB_MAXIMUM_CLICKS" as const, WbMaximumClicks: { WeeklySpendLimit: 123450000 } }, Network: { BiddingStrategyType: "SERVING_OFF" as const } } } };
const creative = { Titles: ["Fixture title"] as [string], Texts: ["Fixture body"] as [string], Href: "https://example.test/offer" };
const plan: YandexDraftPlan = { accountId: "123", clientLogin: "fixture-login", currency: "RUB", desiredStatus: "DRAFT", campaign,
  group: { Name: "Traffic", CampaignId: { from: "campaign" }, RegionIds: [225], UnifiedAdGroup: { OfferRetargeting: "NO" } }, ad: { AdGroupId: { from: "group" }, ResponsiveAd: creative } };
function translation(): { campaign: { name: string; objective: string; schedule: { window: { start: number; end: number }; timezone: string }; audience: { countries: string[]; searchTerms?: string[] }; creativeIds: string[]; creativeDigest: string }; target: { accountId: string; weeklyBudget?: { minorUnits: number; currency: string }; dailyBudget?: { minorUnits: number; currency: string } }; resolved: { accountId: string; clientLogin: string; currency: string; currencyExponent: number; creativeId: string; creativeDigest: string; responsiveAd: typeof creative; locations: { country: string; regionId: number }[] } } {
  return { campaign: { name: "Traffic", objective: "traffic", schedule: { window: { start: Date.parse("2026-11-01T00:00:00+03:00"), end: Date.parse("2026-11-08T00:00:00+03:00") }, timezone: "Europe/Moscow" }, audience: { countries: ["RU"] }, creativeIds: ["asset"], creativeDigest: "a".repeat(64) },
    target: { accountId: "123", weeklyBudget: { minorUnits: 12345, currency: "RUB" } },
    resolved: { accountId: "123", clientLogin: "fixture-login", currency: "RUB", currencyExponent: 2, creativeId: "asset", creativeDigest: "a".repeat(64), responsiveAd: structuredClone(creative), locations: [{ country: "RU", regionId: 225 }] } };
}
const rows = { campaigns: { ...campaign, Id: 456, Type: "UNIFIED_CAMPAIGN", Status: "DRAFT", State: "OFF" },
  adgroups: { Id: 567, Name: "Traffic", CampaignId: 456, RegionIds: [225], UnifiedAdGroup: { OfferRetargeting: "NO" } },
  ads: { Id: 678, CampaignId: 456, AdGroupId: 567, Status: "DRAFT", State: "OFF", ResponsiveAd: { Titles: [{ Title: "Fixture title", Status: "DRAFT" }], Texts: [{ Text: "Fixture body", Status: "DRAFT" }], Href: "https://example.test/offer" } } };
type Wire = { method: "get" | "add"; params: Record<string, unknown> };
const services: Record<string, string> = { campaign: "campaigns", group: "adgroups", ad: "ads" };
const collections: Record<string, string> = { campaigns: "Campaigns", adgroups: "AdGroups", ads: "Ads" };
const ids: Record<string, number> = { campaigns: 456, adgroups: 567, ads: 678 };
function deploymentFixture(required: { response?: (input: { service: string; body: Wire; call: number }) => Response | undefined; checkpoint?: YandexDeploymentInput["checkpoint"] } = {}) {
  const base = fixture();
  const calls: { service: string; body: Wire; init: RequestInit }[] = [];
  const checkpoints: Parameters<YandexDeploymentInput["checkpoint"]>[0][] = [];
  const intents = new Set<string>();
  const { clientLogin: _login, ...deploymentConfiguration } = base.dependencies.configuration;
  const dependencies: YandexDeploymentInput["dependencies"] = { ...base.dependencies, configuration: deploymentConfiguration, fetch: async (url, init) => {
    // Model the server's final guarded-fetch authority fence after credentials.
    if (!base.state.authorized || !base.state.admitted) throw new Error("fixture revoked");
    const service = String(url).split("/").at(-1)!;
    const body = JSON.parse(String(init?.body)) as Wire;
    calls.push({ service, body, init: init! });
    const override = required.response?.({ service, body, call: calls.length });
    if (override) return override;
    if (service === "clients") return Response.json({ result: { Clients: [account] } });
    if (body.method === "add") return Response.json({ result: { AddResults: [{ Id: ids[service] }] } });
    const key = collections[service]!;
    return Response.json({ result: { [key]: [rows[service as keyof typeof rows]] } });
  } };
  const input: YandexDeploymentInput = { context, operationId: "deployment", plan: structuredClone(plan), dependencies,
    async checkpoint(item) {
      checkpoints.push(item);
      if (required.checkpoint) return required.checkpoint(item);
      if (item.phase === "dispatch" && intents.has(item.step)) return denied({ code: "conflict" });
      if (item.phase === "dispatch") intents.add(item.step);
      return { ok: true, value: undefined };
    } };
  return { ...base, calls, checkpoints, input };
}
function receipt(required: { result: Awaited<ReturnType<typeof deployCampaignPaused>> }) {
  expect(required.result.ok).toBe(true);
  if (!required.result.ok) throw new Error("Expected receipt");
  return required.result.value;
}

describe("Yandex exact weekly translation", () => {
  it("keeps weekly micros and the API midnight interval exact, with fixed parent slots", () => {
    expect(translateCampaign(translation())).toEqual({ ok: true, value: plan });
    expect(campaignDeploymentPlanSchema.safeParse({ ...plan, desiredStatus: "ACTIVE" }).success).toBe(false);
  });
  it.each(["not-a-url", "https://", "https://user@example.test/offer", "https://:password@example.test/offer", "https://example.test/#fragment", "https://example.test/{id}"])("returns a typed failure for an invalid destination URL: %s", href => {
    const input = translation();
    input.resolved.responsiveAd.Href = href;
    expect(translateCampaign(input)).toMatchObject({ ok: false, error: { code: "not_implemented" } });
    expect(campaignDeploymentPlanSchema.safeParse({ ...plan, ad: { ...plan.ad, ResponsiveAd: input.resolved.responsiveAd } }).success).toBe(false);
  });
  it.each([
    (input: ReturnType<typeof translation>) => { input.target.dailyBudget = input.target.weeklyBudget; delete input.target.weeklyBudget; },
    (input: ReturnType<typeof translation>) => { input.target.dailyBudget = input.target.weeklyBudget; },
    (input: ReturnType<typeof translation>) => { input.campaign.objective = "sales"; },
    (input: ReturnType<typeof translation>) => { input.campaign.audience.searchTerms = ["fixture"]; },
    (input: ReturnType<typeof translation>) => { input.campaign.schedule.timezone = "UTC"; },
    (input: ReturnType<typeof translation>) => { input.campaign.schedule.window.end += 1; },
    (input: ReturnType<typeof translation>) => { input.campaign.schedule.window.start += 3600000; },
    (input: ReturnType<typeof translation>) => { input.resolved.responsiveAd.Titles = ["x".repeat(57)]; },
    (input: ReturnType<typeof translation>) => { input.resolved.responsiveAd.Href = "javascript:alert(1)"; },
    (input: ReturnType<typeof translation>) => { input.resolved.locations.push({ country: "RU", regionId: 225 }); },
    (input: ReturnType<typeof translation>) => { input.resolved.creativeDigest = "b".repeat(64); },
    (input: ReturnType<typeof translation>) => { input.resolved.currencyExponent = 0; },
    (input: ReturnType<typeof translation>) => { input.target.weeklyBudget!.minorUnits = Number.MAX_SAFE_INTEGER; },
  ])("rejects unsupported, ambiguous or mismatched metadata before effects (%#)", mutate => {
    const input = translation(); mutate(input); expect(translateCampaign(input).ok).toBe(false);
  });
});
describe("Yandex grouped DRAFT deployment", () => {
  it("decodes the saved credential bundle into token and Client-Login headers", async () => {
    const f = deploymentFixture();
    expect(receipt({ result: await deployCampaignPaused(f.input) }).status).toBe("acknowledged");
    expect(f.calls.every(call => new Headers(call.init.headers).get("Authorization") === "Bearer synthetic-secret")).toBe(true);
    expect(f.calls.every(call => new Headers(call.init.headers).get("Client-Login") === plan.clientLogin)).toBe(true);
  });
  it("rejects a credential login different from the frozen plan before fetch", async () => {
    const f = deploymentFixture();
    f.input.dependencies.credentials.access = async () => ({ ok: true, value: { accessToken: JSON.stringify({ accessToken: "synthetic-secret", clientLogin: "foreign-login" }) } });
    expect(await deployCampaignPaused(f.input)).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(f.calls).toHaveLength(0); expect(f.checkpoints).toHaveLength(0);
  });
  it("redacts malformed credential bundles and returns unauthenticated without egress", async () => {
    const f = deploymentFixture();
    f.input.dependencies.credentials.access = async () => ({ ok: true, value: { accessToken: JSON.stringify({ accessToken: "synthetic-secret" }) } });
    const result = await deployCampaignPaused(f.input);
    expect(result).toMatchObject({ ok: false, error: { code: "unauthenticated" } });
    expect(JSON.stringify(result)).not.toContain("synthetic-secret"); expect(f.calls).toHaveLength(0);
  });
  it("checkpoints three exact creates, verifies parents first and acknowledges DRAFT/OFF content", async () => {
    const f = deploymentFixture();
    const result = receipt({ result: await deployCampaignPaused(f.input) });
    expect(result).toMatchObject({ status: "acknowledged", references: { campaign: "456", group: "567", ad: "678" }, entityIds: ["456", "567", "678"] });
    expect(result.hierarchy).toHaveLength(3);
    expect(f.calls.map(item => item.service + "." + item.body.method)).toEqual(["clients.get", "campaigns.add", "campaigns.get", "adgroups.add", "adgroups.get", "ads.add", "ads.get", "campaigns.get", "adgroups.get", "ads.get"]);
    expect(f.calls.filter(item => item.body.method === "add").map(item => item.body.params)).toEqual([{ Campaigns: [campaign] }, { AdGroups: [{ ...plan.group, CampaignId: 456 }] }, { Ads: [{ ...plan.ad, AdGroupId: 567 }] }]);
    expect(f.checkpoints).toEqual(["campaign", "group", "ad"].flatMap((step, i) => [{ step, phase: "dispatch", references: Object.fromEntries(Object.entries(result.references).slice(0, i)) }, { step, phase: "acknowledged", references: Object.fromEntries(Object.entries(result.references).slice(0, i + 1)) }]));
    expect(f.calls.every(item => item.init.redirect === "error" && item.init.signal && new Headers(item.init.headers).get("Client-Login") === configuration.clientLogin)).toBe(true);
    expect(f.observations).toHaveLength(f.calls.length);
    expect(f.observations.every(item => item.runId === context.runId && item.traceId === context.traceId)).toBe(true);
  });
  it("denies unadmitted deployment and recovery before credentials or network", async () => {
    const f = deploymentFixture(); f.state.admitted = false;
    expect(await deployCampaignPaused(f.input)).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(await readCampaignDeployment({ ...f.input, references: { campaign: "456" } })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(f.credentialCalls).toEqual([]); expect(f.calls).toEqual([]); expect(f.checkpoints).toEqual([]);
  });
  it("returns unavailable when admission throws in deployment or recovery, without exposing the exception", async () => {
    const f = deploymentFixture();
    f.input.dependencies = { ...f.input.dependencies, admitted: () => { throw new Error("synthetic-secret"); } };
    const deployed = await deployCampaignPaused(f.input);
    const recovered = await readCampaignDeployment({ ...f.input, references: { campaign: "456" } });
    expect(deployed).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(recovered).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(JSON.stringify([deployed, recovered])).not.toContain("synthetic-secret");
    expect(f.credentialCalls).toEqual([]); expect(f.calls).toEqual([]); expect(f.checkpoints).toEqual([]);
  });
  it("rejects malformed plan URLs in deployment and recovery before credentials or network", async () => {
    const f = deploymentFixture();
    (f.input.plan as YandexDraftPlan).ad.ResponsiveAd.Href = "not-a-url";
    expect(await deployCampaignPaused(f.input)).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(await readCampaignDeployment({ ...f.input, references: { campaign: "456" } })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(f.credentialCalls).toEqual([]); expect(f.calls).toEqual([]); expect(f.checkpoints).toEqual([]);
  });
  it("denies foreign scope/plan, unsupported activation and oversized plans with zero egress", async () => {
    for (const replacement of [{ ...plan, accountId: "999" }, { ...plan, desiredStatus: "ON" }, { ...plan, extra: "x".repeat(65536) }]) {
      const f = deploymentFixture(); expect((await deployCampaignPaused({ ...f.input, plan: replacement })).ok).toBe(false); expect(f.credentialCalls).toEqual([]);
    }
    const f = deploymentFixture(); expect((await deployCampaignPaused({ ...f.input, context: { ...context, scope: { ...context.scope, ownerId: "other" } } })).ok).toBe(false); expect(f.calls).toEqual([]);
  });
  it.each(["admission", "authority", "expiry"])("rechecks %s after credential resolution", async change => {
    const f = deploymentFixture();
    f.input.dependencies.credentials.access = async () => { if (change === "admission") f.state.admitted = false; if (change === "authority") f.state.authorized = false; return { ok: true, value: { accessToken: JSON.stringify({ accessToken: "fixture", clientLogin: plan.clientLogin }), expiresAt: change === "expiry" ? now : now + 1000 } }; };
    const result = await deployCampaignPaused(f.input);
    if (change === "admission") expect(result).toMatchObject({ ok: false, error: { code: "forbidden" } });
    else expect(receipt({ result }).status).toBe("unknown");
    expect(f.calls).toEqual([]);
  });
  it.each(["campaign", "group", "ad"])("stops on an uncertain %s create, retaining earlier refs, with no resend", async step => {
    const service = services[step]!;
    const f = deploymentFixture({ response(input) { if (input.service === service && input.body.method === "add") throw new Error("synthetic-secret"); return undefined; } });
    const result = receipt({ result: await deployCampaignPaused(f.input) });
    expect(result.status).toBe("unknown"); expect(Object.keys(result.references)).toHaveLength(["campaign", "group", "ad"].indexOf(step));
    const count = f.calls.length;
    await readCampaignDeployment({ ...f.input, references: result.references });
    expect(f.calls.slice(count).every(item => item.body.method === "get")).toBe(true);
    await deployCampaignPaused(f.input);
    expect(f.calls.filter(item => item.service === service && item.body.method === "add")).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("synthetic-secret");
  });
  it.each(["campaign", "group", "ad"])("retains returned %s ID when its acknowledgement checkpoint fails", async step => {
    const f = deploymentFixture({ checkpoint: async item => item.step === step && item.phase === "acknowledged" ? denied() : { ok: true, value: undefined } });
    const result = receipt({ result: await deployCampaignPaused(f.input) });
    expect(result.status).toBe("unknown"); expect(Object.keys(result.references)).toHaveLength(["campaign", "group", "ad"].indexOf(step) + 1);
    expect(f.calls.filter(item => item.body.method === "add")).toHaveLength(Object.keys(result.references).length);
  });
  it.each(["campaign", "group", "ad"])("does not send %s when its dispatch checkpoint throws", async step => {
    const f = deploymentFixture({ checkpoint: async item => { if (item.step === step && item.phase === "dispatch") throw new Error("storage"); return { ok: true, value: undefined }; } });
    expect(receipt({ result: await deployCampaignPaused(f.input) }).status).toBe("unknown");
    expect(f.calls.filter(item => item.body.method === "add")).toHaveLength(["campaign", "group", "ad"].indexOf(step));
  });
  it.each([
    { service: "campaigns", row: { ...rows.campaigns, Status: "ACCEPTED" } },
    { service: "campaigns", row: { ...rows.campaigns, State: "ON" } },
    { service: "campaigns", row: { ...rows.campaigns, EndDate: "2026-11-09" } },
    { service: "campaigns", row: { ...rows.campaigns, UnifiedCampaign: { BiddingStrategy: { ...campaign.UnifiedCampaign.BiddingStrategy, Search: { BiddingStrategyType: "WB_MAXIMUM_CLICKS", WbMaximumClicks: { WeeklySpendLimit: 999 } } } } } },
    { service: "adgroups", row: { ...rows.adgroups, CampaignId: 999 } },
    { service: "adgroups", row: { ...rows.adgroups, RegionIds: [1] } },
    { service: "ads", row: { ...rows.ads, Status: "PREACCEPTED" } },
    { service: "ads", row: { ...rows.ads, CampaignId: 999 } },
    { service: "ads", row: { ...rows.ads, ResponsiveAd: { ...rows.ads.ResponsiveAd, Href: "https://other.test" } } },
  ])("stops on readback drift $service", async item => {
    const key = collections[item.service]!;
    const f = deploymentFixture({ response(input) { return input.service === item.service && input.body.method === "get" ? Response.json({ result: { [key]: [item.row] } }) : undefined; } });
    const result = receipt({ result: await deployCampaignPaused(f.input) }); expect(result.status).toBe("unknown");
    expect(f.calls.at(-1)?.service).toBe(item.service); expect(result.entityIds.length).toBeGreaterThan(0);
  });
  it.each([Response.json({ error: { error_code: 1, error_string: "secret" } }), new Response("bad JSON"), new Response("x".repeat(1048577)), Response.json({ result: { Clients: [{ ...account, ClientId: 999 }] } }), Response.json({ result: { Clients: [account, account] } })])("fails closed on tainted identity responses (%#)", async response => {
    const f = deploymentFixture({ response: () => response });
    expect(receipt({ result: await deployCampaignPaused(f.input) }).status).toBe("unknown"); expect(f.calls).toHaveLength(1); expect(f.checkpoints).toEqual([]);
  });
  it("recovers all known refs using get only, and never scans when no IDs are known", async () => {
    const f = deploymentFixture();
    expect(receipt({ result: await readCampaignDeployment({ ...f.input, references: { campaign: "456", group: "567", ad: "678" } }) }).status).toBe("acknowledged");
    expect(f.calls.every(item => item.body.method === "get")).toBe(true); expect(f.checkpoints).toEqual([]);
    const missing = deploymentFixture(); expect(receipt({ result: await readCampaignDeployment({ ...missing.input, references: {} }) }).status).toBe("unknown");
    expect(missing.calls.map(item => item.service)).toEqual(["clients"]);
  });
  it("takes a plan snapshot before credential lookup; cancellation prevents all egress", async () => {
    const f = deploymentFixture();
    f.input.dependencies.credentials.access = async () => { (f.input.plan as YandexDraftPlan).campaign.Name = "Changed"; return { ok: true, value: { accessToken: JSON.stringify({ accessToken: "fixture", clientLogin: plan.clientLogin }) } }; };
    expect(receipt({ result: await deployCampaignPaused(f.input) }).status).toBe("acknowledged");
    expect(f.calls[1]!.body.params).toEqual({ Campaigns: [campaign] });
    const cancelled = deploymentFixture(); const controller = new AbortController(); controller.abort();
    expect(receipt({ result: await deployCampaignPaused(cancelled.input, { signal: controller.signal }) }).status).toBe("unknown"); expect(cancelled.calls).toEqual([]);
  });
  it("retains a valid returned ID even when AddResults also contains malformed errors", async () => {
    const f = deploymentFixture({ response(input) { return input.service === "campaigns" && input.body.method === "add" ? Response.json({ result: { AddResults: [{ Id: 456, Errors: "bad" }] } }) : undefined; } });
    expect(receipt({ result: await deployCampaignPaused(f.input) })).toMatchObject({ status: "unknown", references: { campaign: "456" } });
    expect(f.checkpoints.at(-1)).toEqual({ step: "campaign", phase: "acknowledged", references: { campaign: "456" } }); expect(f.calls).toHaveLength(2);
  });
  it.each(["fetch", "body"])("uses the injected 15s deadline through %s and redacts abort failures", async phase => {
    const f = deploymentFixture(); const controller = new AbortController(); const deadlines: number[] = [];
    f.input.dependencies = { ...f.input.dependencies, createDeadline(input) { deadlines.push(input.milliseconds); return controller.signal; },
      async fetch(_url, init) {
        if (phase === "fetch") { controller.abort(); throw new Error("synthetic-secret"); }
        return new Response(new ReadableStream({ start(stream) { init!.signal!.addEventListener("abort", () => stream.error(new Error("synthetic-secret"))); controller.abort(); } }));
      } };
    const result = receipt({ result: await deployCampaignPaused(f.input) }); expect(result.status).toBe("unknown"); expect(deadlines).toEqual([15000]); expect(JSON.stringify(result)).not.toContain("synthetic-secret");
  });
  it("rechecks cancellation after credential lookup before invoking fetch", async () => {
    const f = deploymentFixture(); const controller = new AbortController();
    f.input.dependencies.credentials.access = async () => { controller.abort(); return { ok: true, value: { accessToken: JSON.stringify({ accessToken: "fixture", clientLogin: plan.clientLogin }) } }; };
    expect(receipt({ result: await deployCampaignPaused(f.input, { signal: controller.signal }) }).status).toBe("unknown"); expect(f.calls).toEqual([]);
  });
});

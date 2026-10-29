import { describe, expect, it } from "vitest";
import { pluginConfigurationSchema } from "@open-marketing/contracts";
import type { CampaignDeploymentRequired, Outcome, PluginCapabilityDependencies } from "@open-marketing/contracts";
import { campaignDeploymentPlanSchema, deployCampaignPaused, readCampaignDeployment } from "../src/index.js";
import { context, pageInfo } from "./fixtures.js";

const plan = { campaign: { kind: "create-campaign-paused", name: "Traffic", budget: 43.21 },
  adgroup: { kind: "create-adgroup-paused", name: "Traffic", campaignId: { from: "campaign" }, budget: 43.21, locationIds: ["6252001"], scheduleStart: "2026-10-13 00:00:00", scheduleEnd: "2026-10-15 00:00:00" },
  ad: { kind: "create-ad-paused", name: "Traffic", adgroupId: { from: "adgroup" }, adFormat: "SINGLE_IMAGE", identityType: "CUSTOMIZED_USER", identityId: "identity", imageIds: ["image"], text: "Visit us", landingPageUrl: "https://example.com/signup" } };
const ids = { campaign: "456", adgroup: "457", ad: "458" };
type Step = keyof typeof ids;

/** Compare recorded fetch URLs with the fixed vendor routes. */
function sentPaths(required: { sent: string[] }): string[] {
  return required.sent.map(value => new URL(value, "https://business-api.tiktok.com/open_api/v1.3/").pathname.replace("/open_api/v1.3/", ""));
}

/** Standard server dependencies exercise real egress with synthetic responses only. */
function setup() {
  const writes: { path: string; body: Readonly<Record<string, unknown>> }[] = [];
  const rows: Partial<Record<Step, Record<string, unknown>>> = {};
  const checkpoints: Parameters<CampaignDeploymentRequired["checkpoint"]>[0][] = [];
  const claims = new Set<string>();
  const state = { failPath: "", malformed: false, checkpointFailure: "", mutate: (_row: Record<string, unknown>) => {}, afterWrite: () => {} };
  const egress = { sent: [] as string[], fetchCalls: [] as { url: string; init?: RequestInit }[], credentialCalls: [] as { connectionId: string; accountId: string }[] };
  const dependencies: PluginCapabilityDependencies = {
    configuration: pluginConfigurationSchema.parse({ scope: context.scope, connectionId: "connection", accountId: "123", pluginDigest: "a".repeat(64), settings: {} }),
    credentials: { async access(input) { egress.credentialCalls.push(input); return { ok: true, value: { accessToken: "fixture-token", expiresAt: 1799999999999, secrets: { unrelated: "s3cret-fixture" } } }; } },
    clock: { now: () => 1790000000000 }, observer: { observe() {} }, wait: async () => ({ ok: true, value: undefined }),
    fetch: async (url, init) => {
      egress.sent.push(String(url)); egress.fetchCalls.push({ url: String(url), init });
      const input = { path: new URL(String(url)).pathname.replace("/open_api/v1.3/", ""), body: init?.method === "POST" ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined };
      if (input.path === state.failPath) return Response.json({ code: 1, data: {} });
      const step = input.path.split("/")[0] as Step;
      if (input.body) {
        writes.push({ path: input.path, body: input.body });
        const creative = (input.body.creatives as Record<string, unknown>[] | undefined)?.[0];
        rows[step] = { ...(creative ?? input.body), advertiser_id: "123", campaign_id: ids.campaign, ...(step !== "campaign" ? { adgroup_id: ids.adgroup } : {}), ...(step === "ad" ? { ad_id: ids.ad } : {}) };
        state.afterWrite();
        const acknowledgement: Record<Step, Record<string, unknown>> = { campaign: { campaign_id: ids.campaign }, adgroup: { adgroup_id: ids.adgroup }, ad: { ad_ids: [ids.ad] } };
        return Response.json({ code: 0, data: state.malformed ? { ad_ids: ["458", "459"] } : acknowledgement[step] });
      }
      const row = { ...rows[step] }; state.mutate(row);
      return Response.json({ code: 0, data: { list: [row], page_info: pageInfo } });
    },
  };
  const input: CampaignDeploymentRequired = { context, operationId: "operation", connectionId: "connection", accountId: "123", plan, dependencies, saved: { references: {}, record: null },
    async checkpoint(item: Parameters<CampaignDeploymentRequired["checkpoint"]>[0]): Promise<Outcome<void>> {
      checkpoints.push(structuredClone(item));
      const key = item.step + "." + item.phase;
      if (key === state.checkpointFailure || claims.has(key)) return { ok: false, error: { code: "conflict", message: "Fixture checkpoint rejected", retryable: false } };
      claims.add(key); return { ok: true, value: undefined };
    } };
  return { input, egress, state, writes, rows, checkpoints };
}
describe("paused deployment", () => {
  it("substitutes only acknowledged parents and verifies daily budget/end and flat disabled creative", async () => {
    const f = setup();
    expect(await deployCampaignPaused(f.input)).toMatchObject({ ok: true, value: { status: "acknowledged", state: "paused", references: ids, entityIds: ["456", "457", "458"], hierarchy: [{ operation_status: "DISABLE" }, { operation_status: "DISABLE" }, { operation_status: "DISABLE" }] } });
    expect(sentPaths(f.egress)).toEqual(["campaign/create/", "campaign/get/", "adgroup/create/", "adgroup/get/", "ad/create/", "ad/get/"]);
    expect(f.writes[0].body).toMatchObject({ advertiser_id: "123", objective_type: "TRAFFIC", budget_mode: "BUDGET_MODE_DAY", budget: 43.21, operation_status: "DISABLE" });
    expect(f.writes[1].body).toMatchObject({ campaign_id: "456", budget_mode: "BUDGET_MODE_DAY", budget: 43.21, promotion_type: "WEBSITE", placements: ["PLACEMENT_TIKTOK"], location_ids: ["6252001"], optimization_goal: "CLICK", billing_event: "CPC", bid_type: "BID_TYPE_NO_BID", pacing: "PACING_MODE_SMOOTH", schedule_type: "SCHEDULE_START_END", schedule_start_time: "2026-10-13 00:00:00", schedule_end_time: "2026-10-15 00:00:00", operation_status: "DISABLE" });
    expect(f.writes[2].body).toMatchObject({ advertiser_id: "123", adgroup_id: "457", creatives: [{ ad_format: "SINGLE_IMAGE", image_ids: ["image"], identity_type: "CUSTOMIZED_USER", identity_id: "identity", ad_text: "Visit us", landing_page_url: "https://example.com/signup", call_to_action: "LEARN_MORE", operation_status: "DISABLE" }] });
    expect(f.checkpoints.map(item => item.step + "." + item.phase)).toEqual(["campaign.dispatch", "campaign.acknowledged", "adgroup.dispatch", "adgroup.acknowledged", "ad.dispatch", "ad.acknowledged"]);
    const before = f.egress.sent.length;
    expect(await readCampaignDeployment({ ...f.input, saved: { references: ids, record: null } })).toMatchObject({ ok: true, value: { status: "acknowledged" } });
    expect(sentPaths(f.egress).slice(before)).toEqual(["campaign/get/", "adgroup/get/", "ad/get/"]);
    await deployCampaignPaused(f.input); expect(f.writes).toHaveLength(3);
  });
  it.each(["adgroup/create/", "ad/create/"])("retains parents after %s failure; reconciliation never repeats a POST", async failPath => {
    const f = setup(); f.state.failPath = failPath;
    const references: Record<string, string> = failPath === "ad/create/" ? { campaign: "456", adgroup: "457" } : { campaign: "456" };
    expect(await deployCampaignPaused(f.input)).toMatchObject({ ok: true, value: { status: "unknown", references } });
    const count = f.writes.length; f.state.failPath = "";
    expect(await readCampaignDeployment({ ...f.input, saved: { references, record: null } })).toMatchObject({ ok: true, value: { status: "unknown", references } });
    expect(f.writes).toHaveLength(count);
  });
  it.each(["campaign.acknowledged", "adgroup.acknowledged", "ad.acknowledged"])("retains candidate IDs when %s cannot persist", async checkpointFailure => {
    const f = setup(); f.state.checkpointFailure = checkpointFailure;
    const result = await deployCampaignPaused(f.input);
    expect(result).toMatchObject({ ok: true, value: { status: "unknown", references: { campaign: "456" } } });
    if (!result.ok) throw new Error("Expected receipt");
    const before = f.writes.length;
    await readCampaignDeployment({ ...f.input, saved: { references: Object.fromEntries(Object.entries(result.value.references)), record: null } });
    expect(f.writes).toHaveLength(before);
    expect(result.value.entityIds).toHaveLength(checkpointFailure.startsWith("campaign") ? 1 : checkpointFailure.startsWith("adgroup") ? 2 : 3);
  });
  it.each(["operation_status", "budget", "schedule_end_time", "advertiser_id", "campaign_id"])("stops before the ad on group %s mismatch", async field => {
    const f = setup();
    f.state.mutate = row => { if (row.adgroup_id) row[field] = field === "budget" ? 44 : "FROZEN"; };
    expect(await deployCampaignPaused(f.input)).toMatchObject({ ok: true, value: { status: "unknown", references: { campaign: "456", adgroup: "457" } } });
    expect(f.writes).toHaveLength(2);
  });
  it.each(["operation_status", "image_ids", "landing_page_url", "identity_id"])("requires matching flat ad %s on readback", async field => {
    const f = setup(); f.state.mutate = row => { if (row.ad_id) delete row[field]; };
    expect(await deployCampaignPaused(f.input)).toMatchObject({ ok: true, value: { status: "unknown", references: ids } });
    expect(f.writes).toHaveLength(3);
  });
  it("denies invalid complete plans and cancellation before credentials/network/checkpoints", async () => {
    const f = setup();
    for (const adgroup of [{ ...plan.adgroup, scheduleEnd: undefined }, { ...plan.adgroup, budgetMode: "BUDGET_MODE_DYNAMIC_DAILY_BUDGET" }, { ...plan.adgroup, budget: 99 }]) {
      expect(await deployCampaignPaused({ ...f.input, plan: { ...plan, adgroup } })).toMatchObject({ ok: false });
    }
    await deployCampaignPaused(f.input, { signal: AbortSignal.abort() });
    expect(f.egress.sent).toEqual([]); expect(f.egress.credentialCalls).toEqual([]); expect(f.checkpoints).toEqual([]);
  });
  it.each([
    { ...plan, campaign: { ...plan.campaign, budgetMode: "BUDGET_MODE_DYNAMIC_DAILY_BUDGET" } },
    { ...plan, adgroup: { ...plan.adgroup, budgetMode: "BUDGET_MODE_DYNAMIC_DAILY_BUDGET" } },
    { ...plan, campaign: { ...plan.campaign, budgetMode: "BUDGET_MODE_TOTAL" } },
    { ...plan, adgroup: { ...plan.adgroup, budgetMode: "BUDGET_MODE_TOTAL" } },
    { ...plan, campaign: { ...plan.campaign, objectiveType: "CONVERSIONS" } },
    { ...plan, ad: { ...plan.ad, adFormat: "CAROUSEL" } },
    { ...plan, ad: { ...plan.ad, identityType: "AUTH_CODE" } },
    { ...plan, ad: { ...plan.ad, landingPageUrl: undefined } },
    { ...plan, ad: { ...plan.ad, landingPageUrl: "" } },
    { ...plan, ad: { ...plan.ad, landingPageUrl: "not-a-url" } },
  ])("returns typed unsupported with no effects for an unsupported plan: %j", async unsupportedPlan => {
    const f = setup();
    const input = { ...f.input, plan: unsupportedPlan };
    expect(await deployCampaignPaused(input)).toMatchObject({ ok: false, error: { code: "not_implemented", retryable: false } });
    expect(await readCampaignDeployment({ ...input, saved: { references: ids, record: null } })).toMatchObject({ ok: false, error: { code: "not_implemented", retryable: false } });
    expect(f.egress.sent).toEqual([]); expect(f.egress.fetchCalls).toEqual([]);
    expect(f.egress.credentialCalls).toEqual([]); expect(f.checkpoints).toEqual([]);
  });
  it("keeps malformed deployment envelope errors distinct from unsupported plans", async () => {
    const f = setup();
    const unsupportedPlan = { ...plan, ad: { ...plan.ad, adFormat: "CAROUSEL" } };
    expect(await deployCampaignPaused({ ...f.input, accountId: "invalid", plan: unsupportedPlan })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(f.egress.sent).toEqual([]); expect(f.egress.credentialCalls).toEqual([]); expect(f.checkpoints).toEqual([]);
  });
  it("stops after cancellation or malformed acknowledgement without children", async () => {
    const f = setup(); const controller = new AbortController();
    f.state.afterWrite = () => controller.abort();
    expect(await deployCampaignPaused(f.input, { signal: controller.signal })).toMatchObject({ ok: true, value: { status: "unknown" } });
    expect(f.writes).toHaveLength(1);
    const malformed = setup(); malformed.state.malformed = true;
    expect(await deployCampaignPaused(malformed.input)).toMatchObject({ ok: true, value: { status: "unknown", entityIds: [] } });
    expect(malformed.writes).toHaveLength(1);
  });
});
it("rejects undeclared parent slots and unsupported lifetime/format/cover plans", () => {
  for (const changed of [ { ...plan, campaign: { ...plan.campaign, budgetMode: "BUDGET_MODE_TOTAL" } }, { ...plan, ad: { ...plan.ad, adFormat: "CAROUSEL" } }, { ...plan, ad: { ...plan.ad, imageIds: [] } }, { ...plan, adgroup: { ...plan.adgroup, campaignId: { from: "ad" } } } ]) expect(campaignDeploymentPlanSchema.safeParse(changed).success).toBe(false);
});

it("reconciles saved evidence and denies foreign configuration before checkpoints", async () => {
  const f = setup();
  await deployCampaignPaused(f.input);
  const before = f.egress.sent.length;
  expect(await deployCampaignPaused({ ...f.input, saved: { references: { campaign: "456" }, record: null } })).toMatchObject({ ok: true, value: { status: "unknown", references: { campaign: "456" } } });
  expect(f.egress.fetchCalls.slice(before).map(call => call.init?.method)).toEqual(["GET"]);
  const after = f.egress.sent.length;
  await deployCampaignPaused({ ...f.input, saved: { references: {}, record: { step: "campaign", phase: "dispatch" } } });
  expect(f.egress.sent).toHaveLength(after);
  const checkpoints = f.checkpoints.length;
  expect(await deployCampaignPaused({ ...f.input, dependencies: { ...f.input.dependencies, configuration: { ...f.input.dependencies.configuration, connectionId: "foreign" } } })).toMatchObject({ ok: false, error: { code: "forbidden" } });
  expect(f.checkpoints).toHaveLength(checkpoints); expect(f.egress.sent).toHaveLength(after);
});

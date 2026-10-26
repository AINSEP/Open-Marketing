import { describe, expect, it } from "vitest";
import type { Outcome } from "@open-marketing/contracts";
import { campaignDeploymentPlanSchema, deployCampaignPaused, readCampaignDeployment } from "../src/index.js";
import { context, fixture, pageInfo } from "./fixtures.js";

const plan = { campaign: { kind: "create-campaign-paused", name: "Traffic", budget: 43.21 },
  adgroup: { kind: "create-adgroup-paused", name: "Traffic", campaignId: { from: "campaign" }, budget: 43.21, locationIds: ["6252001"], scheduleStart: "2026-10-13 00:00:00", scheduleEnd: "2026-10-15 00:00:00" },
  ad: { kind: "create-ad-paused", name: "Traffic", adgroupId: { from: "adgroup" }, adFormat: "SINGLE_IMAGE", identityType: "CUSTOMIZED_USER", identityId: "identity", imageIds: ["image"], text: "Visit us", landingPageUrl: "https://example.com/signup" } };
const ids = { campaign: "456", adgroup: "457", ad: "458" };
type Step = keyof typeof ids;

/** Compare routes across memory paths and fetch URLs without changing exact URL recording. */
function sentPaths(required: { sent: string[] }): string[] {
  return required.sent.map(value => new URL(value, "https://business-api.tiktok.com/open_api/v1.3/").pathname.replace("/open_api/v1.3/", ""));
}

/** Same suite exercises the in-memory and real injected-fetch egress. Synthetic responses only. */
function setup(required: { kind: "memory" | "fetch" }) {
  const writes: { path: string; body: Readonly<Record<string, unknown>> }[] = [];
  const rows: Partial<Record<Step, Record<string, unknown>>> = {};
  const checkpoints: { step: string; phase: string; references: object }[] = [];
  const claims = new Set<string>();
  const state = { failPath: "", malformed: false, checkpointFailure: "", mutate: (_row: Record<string, unknown>) => {}, afterWrite: () => {} };
  const egress = fixture({ kind: required.kind, responseFor(input) {
    if (input.path === state.failPath) return { code: 1, data: {} };
    const step = input.path.split("/")[0] as Step;
    if (input.body) {
      writes.push({ path: input.path, body: input.body });
      const creative = (input.body.creatives as Record<string, unknown>[] | undefined)?.[0];
      rows[step] = { ...(creative ?? input.body), advertiser_id: "123", campaign_id: ids.campaign, ...(step !== "campaign" ? { adgroup_id: ids.adgroup } : {}), ...(step === "ad" ? { ad_id: ids.ad } : {}) };
      state.afterWrite();
      return { code: 0, data: state.malformed ? { ad_ids: ["458", "459"] } : step === "ad" ? { ad_ids: [ids.ad] } : { [step + "_id"]: ids[step] } };
    }
    const row = { ...rows[step] }; state.mutate(row);
    return { code: 0, data: { list: [row], page_info: pageInfo } };
  } });
  const input = { context, operationId: "operation", connectionId: "connection", accountId: "123", plan, dependencies: { admitted: true, egress: egress.egress },
    async checkpoint(item: { step: string; phase: string; references: object }): Promise<Outcome<void>> {
      checkpoints.push(structuredClone(item));
      const key = item.step + "." + item.phase;
      if (key === state.checkpointFailure || claims.has(key)) return { ok: false, error: { code: "conflict", message: "Fixture checkpoint rejected", retryable: false } };
      claims.add(key); return { ok: true, value: undefined };
    } };
  return { input, egress, state, writes, rows, checkpoints };
}
for (const kind of ["memory", "fetch"] as const) describe(kind + " paused deployment", () => {
  it("substitutes only acknowledged parents and verifies daily budget/end and flat disabled creative", async () => {
    const f = setup({ kind });
    expect(await deployCampaignPaused(f.input)).toMatchObject({ ok: true, value: { status: "acknowledged", references: ids, entityIds: ["456", "457", "458"], hierarchy: [{ operation_status: "DISABLE" }, { operation_status: "DISABLE" }, { operation_status: "DISABLE" }] } });
    expect(sentPaths(f.egress)).toEqual(["campaign/create/", "campaign/get/", "adgroup/create/", "adgroup/get/", "ad/create/", "ad/get/"]);
    expect(f.writes[0].body).toMatchObject({ advertiser_id: "123", objective_type: "TRAFFIC", budget_mode: "BUDGET_MODE_DAY", budget: 43.21, operation_status: "DISABLE" });
    expect(f.writes[1].body).toMatchObject({ campaign_id: "456", budget_mode: "BUDGET_MODE_DAY", budget: 43.21, promotion_type: "WEBSITE", placements: ["PLACEMENT_TIKTOK"], location_ids: ["6252001"], optimization_goal: "CLICK", billing_event: "CPC", bid_type: "BID_TYPE_NO_BID", pacing: "PACING_MODE_SMOOTH", schedule_type: "SCHEDULE_START_END", schedule_start_time: "2026-10-13 00:00:00", schedule_end_time: "2026-10-15 00:00:00", operation_status: "DISABLE" });
    expect(f.writes[2].body).toMatchObject({ advertiser_id: "123", adgroup_id: "457", creatives: [{ ad_format: "SINGLE_IMAGE", image_ids: ["image"], identity_type: "CUSTOMIZED_USER", identity_id: "identity", ad_text: "Visit us", landing_page_url: "https://example.com/signup", call_to_action: "LEARN_MORE", operation_status: "DISABLE" }] });
    expect(f.checkpoints.map(item => item.step + "." + item.phase)).toEqual(["campaign.dispatch", "campaign.acknowledged", "adgroup.dispatch", "adgroup.acknowledged", "ad.dispatch", "ad.acknowledged"]);
    const before = f.egress.sent.length;
    expect(await readCampaignDeployment({ ...f.input, references: ids })).toMatchObject({ ok: true, value: { status: "acknowledged" } });
    expect(sentPaths(f.egress).slice(before)).toEqual(["campaign/get/", "adgroup/get/", "ad/get/"]);
    await deployCampaignPaused(f.input); expect(f.writes).toHaveLength(3);
  });
  it.each(["adgroup/create/", "ad/create/"])("retains parents after %s failure; reconciliation never repeats a POST", async failPath => {
    const f = setup({ kind }); f.state.failPath = failPath;
    const references = failPath === "ad/create/" ? { campaign: "456", adgroup: "457" } : { campaign: "456" };
    expect(await deployCampaignPaused(f.input)).toMatchObject({ ok: true, value: { status: "unknown", references } });
    const count = f.writes.length; f.state.failPath = "";
    expect(await readCampaignDeployment({ ...f.input, references })).toMatchObject({ ok: true, value: { status: "unknown", references } });
    expect(f.writes).toHaveLength(count);
  });
  it.each(["campaign.acknowledged", "adgroup.acknowledged", "ad.acknowledged"])("retains candidate IDs when %s cannot persist", async checkpointFailure => {
    const f = setup({ kind }); f.state.checkpointFailure = checkpointFailure;
    const result = await deployCampaignPaused(f.input);
    expect(result).toMatchObject({ ok: true, value: { status: "unknown", references: { campaign: "456" } } });
    if (!result.ok) throw new Error("Expected receipt");
    const before = f.writes.length;
    await readCampaignDeployment({ ...f.input, references: result.value.references });
    expect(f.writes).toHaveLength(before);
    expect(result.value.entityIds).toHaveLength(checkpointFailure.startsWith("campaign") ? 1 : checkpointFailure.startsWith("adgroup") ? 2 : 3);
  });
  it.each(["operation_status", "budget", "schedule_end_time", "advertiser_id", "campaign_id"])("stops before the ad on group %s mismatch", async field => {
    const f = setup({ kind });
    f.state.mutate = row => { if (row.adgroup_id) row[field] = field === "budget" ? 44 : "FROZEN"; };
    expect(await deployCampaignPaused(f.input)).toMatchObject({ ok: true, value: { status: "unknown", references: { campaign: "456", adgroup: "457" } } });
    expect(f.writes).toHaveLength(2);
  });
  it.each(["operation_status", "image_ids", "landing_page_url", "identity_id"])("requires matching flat ad %s on readback", async field => {
    const f = setup({ kind }); f.state.mutate = row => { if (row.ad_id) delete row[field]; };
    expect(await deployCampaignPaused(f.input)).toMatchObject({ ok: true, value: { status: "unknown", references: ids } });
    expect(f.writes).toHaveLength(3);
  });
  it("denies admission, invalid complete plans and cancellation before credentials/network/checkpoints", async () => {
    const f = setup({ kind });
    expect(await deployCampaignPaused({ ...f.input, dependencies: { ...f.input.dependencies, admitted: false } })).toMatchObject({ ok: false, error: { code: "forbidden" } });
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
    const f = setup({ kind });
    const input = { ...f.input, plan: unsupportedPlan };
    expect(await deployCampaignPaused(input)).toMatchObject({ ok: false, error: { code: "not_implemented", retryable: false } });
    expect(await readCampaignDeployment({ ...input, references: ids })).toMatchObject({ ok: false, error: { code: "not_implemented", retryable: false } });
    expect(f.egress.sent).toEqual([]); expect(f.egress.fetchCalls).toEqual([]);
    expect(f.egress.credentialCalls).toEqual([]); expect(f.checkpoints).toEqual([]);
  });
  it("keeps malformed deployment envelope errors distinct from unsupported plans", async () => {
    const f = setup({ kind });
    const unsupportedPlan = { ...plan, ad: { ...plan.ad, adFormat: "CAROUSEL" } };
    expect(await deployCampaignPaused({ ...f.input, accountId: "invalid", plan: unsupportedPlan })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(f.egress.sent).toEqual([]); expect(f.egress.credentialCalls).toEqual([]); expect(f.checkpoints).toEqual([]);
  });
  it("stops after cancellation, admission withdrawal or malformed acknowledgement without children", async () => {
    const f = setup({ kind }); const controller = new AbortController();
    f.state.afterWrite = () => controller.abort();
    expect(await deployCampaignPaused(f.input, { signal: controller.signal })).toMatchObject({ ok: true, value: { status: "unknown" } });
    expect(f.writes).toHaveLength(1);
    const revoked = setup({ kind }); revoked.egress.state.onAccess = () => { revoked.input.dependencies.admitted = false; };
    await deployCampaignPaused(revoked.input); expect(revoked.writes).toEqual([]);
    const malformed = setup({ kind }); malformed.state.malformed = true;
    expect(await deployCampaignPaused(malformed.input)).toMatchObject({ ok: true, value: { status: "unknown", entityIds: [] } });
    expect(malformed.writes).toHaveLength(1);
  });
});
it("rejects undeclared parent slots and unsupported lifetime/format/cover plans", () => {
  for (const changed of [ { ...plan, campaign: { ...plan.campaign, budgetMode: "BUDGET_MODE_TOTAL" } }, { ...plan, ad: { ...plan.ad, adFormat: "CAROUSEL" } }, { ...plan, ad: { ...plan.ad, imageIds: [] } }, { ...plan, adgroup: { ...plan.adgroup, campaignId: { from: "ad" } } } ]) expect(campaignDeploymentPlanSchema.safeParse(changed).success).toBe(false);
});

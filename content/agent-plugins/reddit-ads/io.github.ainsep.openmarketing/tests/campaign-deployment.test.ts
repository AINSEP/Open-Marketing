import { describe, expect, it, vi } from "vitest";
import { campaignDeploymentPlanSchema, deployCampaignPaused, readCampaignDeployment, redditAdsTools, translateCampaign } from "../src/index.js";
import type { RedditInvocation } from "../src/index.js";
import { businessId, fixture, invocation, reportCommand } from "./fixtures.js";

/** R2 remains evidence-blocked. These exercise the real read boundary, not a deployment fake.
 * No claim about checkpoint ordering, vendor readback or successful creation is made here.
 */
describe("Reddit evidence-blocked launch boundary", () => {
  it.each(["create_campaign_paused", "create_ad_group_paused", "create_ad_paused", "deploy_campaign_paused", "read_campaign_deployment"])("rejects unsupported %s before credentials or egress", async kind => {
    const f = fixture();
    const input = { ...invocation(), command: { kind, configured_status: "PAUSED" } } as unknown as RedditInvocation;
    expect(await f.adapter.invoke(input)).toMatchObject({ ok: false, error: { code: "invalid_input", retryable: false } });
    expect(f.credentialCalls).toEqual([]);
    expect(f.calls).toEqual([]);
    expect(f.deadlineCalls).toEqual([]);
  });

  it.each([
    { ...reportCommand, plan: { campaign: { configured_status: "PAUSED" } } },
    { ...reportCommand, url: "https://ads-api.reddit.com/api/v3/ad_accounts/a2_fixture/campaigns" },
    { ...reportCommand, method: "POST", data: { configured_status: "PAUSED", objective: "CLICKS" } },
  ])("rejects write arguments attached to a valid read command: %j", async command => {
    const f = fixture();
    expect(await f.adapter.invoke({ ...invocation(), command })).toMatchObject({ ok: false, error: { code: "invalid_input", retryable: false } });
    expect(f.credentialCalls).toEqual([]);
    expect(f.calls).toEqual([]);
  });

  it("rejects a repeated launch envelope without consuming or changing saved references", async () => {
    const f = fixture();
    const references = { campaign: "579922433862993631", adGroup: "142154364526" };
    const input = { ...invocation(), plan: { configured_status: "PAUSED" }, references };
    const original = structuredClone(input);
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await f.adapter.invoke(input)).toMatchObject({ ok: false, error: { code: "invalid_input", retryable: false } });
    }
    expect(input).toEqual(original);
    expect(f.credentialCalls).toEqual([]);
    expect(f.calls).toEqual([]);
    // A rejected write envelope must not change the adapter's subsequent read behavior.
    expect(await f.adapter.invoke(invocation())).toMatchObject({ ok: true, value: { data: { businesses: [{ id: businessId, name: "Fixture business" }] } } });
    expect(f.credentialCalls).toEqual([{ connectionId: "connection", accountId: "a2_fixture" }]);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].url).toBe("https://ads-api.reddit.com/api/v3/me/businesses?page.size=100");
    expect(f.calls[0].init.method).toBe("GET");
  });

  it("advertises only the four existing read tools while launch evidence is incomplete", () => {
    expect(redditAdsTools.map(tool => ({ name: tool.name, effect: tool.effect }))).toEqual([
      { name: "list_businesses", effect: "read" },
      { name: "list_accounts", effect: "read" },
      { name: "list_campaigns", effect: "read" },
      { name: "report", effect: "read" },
    ]);
  });
});

/** These cover the explicit unavailable APIs, not a successful vendor workflow. */
describe("Reddit unavailable deployment APIs", () => {
  it.each([undefined, null, {}, { campaign: { configured_status: "PAUSED" } }, { campaign: { configured_status: "ACTIVE" } }])("admits no deployment plan: %j", plan => {
    expect(campaignDeploymentPlanSchema.safeParse(plan).success).toBe(false);
  });

  it("returns unavailable without translating caller-asserted vendor metadata", () => {
    const input = { campaign: { objective: "traffic" }, target: { accountId: "a2_fixture" }, resolved: { verified: true, funding_instrument_id: "synthetic-funding" } };
    const original = structuredClone(input);
    expect(translateCampaign(input)).toMatchObject({ ok: false, error: { code: "unavailable", retryable: false } });
    expect(input).toEqual(original);
  });

  it.each([true, false])("denies deployment without a checkpoint or credentials, admitted=%s", async admitted => {
    const f = fixture();
    f.state.admitted = admitted;
    const checkpoint = vi.fn(async () => ({ ok: true as const, value: undefined }));
    const input = { ...invocation(), plan: { configured_status: "PAUSED" }, dependencies: f.dependencies, checkpoint };
    expect(await deployCampaignPaused(input)).toMatchObject({ ok: false, error: { code: "unavailable", retryable: false } });
    expect(checkpoint).not.toHaveBeenCalled();
    expect(f.credentialCalls).toEqual([]);
    expect(f.deadlineCalls).toEqual([]);
    expect(f.calls).toEqual([]);
  });

  it.each([{}, { campaign: "579922433862993631" }, { campaign: "579922433862993631", adGroup: "142154364526", ad: "synthetic-ad" }])("retains caller-owned references while repeated reconciliation is unavailable: %j", async references => {
    const f = fixture();
    const original = structuredClone(references);
    const input = { ...invocation(), plan: { configured_status: "PAUSED" }, references: Object.freeze(references), dependencies: f.dependencies };
    const results = await Promise.all([readCampaignDeployment(input), readCampaignDeployment(input)]);
    expect(results).toEqual([
      { ok: false, error: { code: "unavailable", message: expect.any(String), retryable: false } },
      { ok: false, error: { code: "unavailable", message: expect.any(String), retryable: false } },
    ]);
    expect(references).toEqual(original);
    expect(f.credentialCalls).toEqual([]);
    expect(f.deadlineCalls).toEqual([]);
    expect(f.calls).toEqual([]);
  });
});

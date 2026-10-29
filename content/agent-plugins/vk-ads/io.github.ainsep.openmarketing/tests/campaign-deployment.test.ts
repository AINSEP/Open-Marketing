import { describe, expect, it, vi } from "vitest";
import { campaignDeploymentPlanSchema, createVkAdsAdapter, deployCampaignPaused, readCampaignDeployment, translateCampaign } from "../src/index.js";
import type { VkInvocation } from "../src/index.js";
import { fixture, invocation } from "./fixtures.js";

/** Evidence-hold safeguards through the real public adapter, not deployment acceptance.
 * Commands below are hostile/unregistered OM inputs, not verified VK request formats.
 * A future implementation must replace this hold with verified lifecycle cases.
 */
describe("VK R2 evidence hold", () => {
  it.each([
    "campaign_deploy_paused",
    "deploy_campaign_paused",
    "create_campaign_paused",
    "create_ad_group_paused",
    "create_ad_paused",
    "read_campaign_deployment",
  ])("rejects unverified %s before all I/O even when admitted", async kind => {
    const f = fixture();
    const input = { ...invocation(), command: { kind } } as unknown as VkInvocation;
    expect(await f.adapter.invoke(input)).toEqual({
      ok: false,
      error: { code: "invalid_input", message: "VK request invalid_input", retryable: false },
    });
    expect(f.credentials.access).not.toHaveBeenCalled();
    expect(f.credentials.save).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.deadline).not.toHaveBeenCalled();
    expect(f.clock.now).not.toHaveBeenCalled();
    expect(f.observer.observe).not.toHaveBeenCalled();
  });

  it("rejects an unverified launch command (plugin-local admission was removed; host guarded fetch owns it)", async () => {
    const f = fixture();
    const input = { ...invocation(), command: { kind: "campaign_deploy_paused" } } as unknown as VkInvocation;
    expect(await f.adapter.invoke(input)).toEqual({
      ok: false,
      error: { code: "invalid_input", message: "VK request invalid_input", retryable: false },
    });
    expect(f.credentials.access).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.deadline).not.toHaveBeenCalled();
  });

  it("does not turn repeated launch or recovery inputs into effects across adapter recreation", async () => {
    const f = fixture();
    const recreated = createVkAdsAdapter(f.dependencies);
    // Saved-looking references confer no authority and cannot enable guessed readback routes.
    const command = { kind: "read_campaign_deployment", references: { campaign: "456", group: "789" } };
    const input = { ...invocation(), command } as unknown as VkInvocation;
    for (const adapter of [f.adapter, recreated]) {
      expect(await adapter.invoke(input)).toEqual({
        ok: false,
        error: { code: "invalid_input", message: "VK request invalid_input", retryable: false },
      });
      const launch = { ...input, command: { kind: "campaign_deploy_paused" } } as unknown as VkInvocation;
      expect(await adapter.invoke(launch)).toEqual({
        ok: false,
        error: { code: "invalid_input", message: "VK request invalid_input", retryable: false },
      });
    }
    expect(f.credentials.access).not.toHaveBeenCalled();
    expect(f.credentials.save).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.deadline).not.toHaveBeenCalled();
  });
});

/** Public R2 boundaries fail closed, rather than asserting synthetic vendor acceptance. */
describe("VK unavailable deployment API", () => {
  it.each([undefined, {}, { campaign: { status: "blocked" }, group: {}, ad: {} }])("rejects every unverified plan: %j", plan => {
    expect(campaignDeploymentPlanSchema.safeParse(plan).success).toBe(false);
  });

  it("returns unavailable instead of inventing translation fields from resolved metadata", () => {
    const input = {
      campaign: { name: "Fixture campaign", objective: "traffic", creativeIds: ["asset"] },
      target: { accountId: "123", dailyBudget: { minorUnits: 10000, currency: "RUB" } },
      resolved: { packageId: "1", status: "blocked", timezone: "Europe/Moscow" },
    };
    const original = structuredClone(input);
    expect(translateCampaign(input)).toEqual({
      ok: false, error: { code: "unavailable", message: "VK campaign translation requires verified operation evidence", retryable: false },
    });
    expect(input).toEqual(original);
  });

  it.each([deployCampaignPaused, readCampaignDeployment])("returns unavailable without I/O or consuming saved references: %s", async operation => {
    const f = fixture();
    const checkpoint = vi.fn();
    const plan = { campaign: { status: "blocked" } };
    const references = { campaign: "456", group: "789" };
    const original = structuredClone({ plan, references });
    const input = { ...invocation(), plan, references, dependencies: f.dependencies, checkpoint };
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await operation(input)).toEqual({
        ok: false, error: { code: "unavailable", message: "VK request unavailable", retryable: false },
      });
    }
    expect({ plan, references }).toEqual(original);
    expect(checkpoint).not.toHaveBeenCalled();
    expect(f.credentials.access).not.toHaveBeenCalled();
    expect(f.credentials.save).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.deadline).not.toHaveBeenCalled();
    expect(f.clock.now).not.toHaveBeenCalled();
    expect(f.observer.observe).not.toHaveBeenCalled();
  });

  it.each([deployCampaignPaused, readCampaignDeployment])("returns cancellation, else unavailable: %s", async operation => {
    const f = fixture();
    f.state.admitted = false;
    const checkpoint = vi.fn();
    const input = { ...invocation(), plan: undefined, references: undefined, dependencies: f.dependencies, checkpoint };
    const controller = new AbortController();
    controller.abort();
    expect(await operation(input, { signal: controller.signal })).toEqual({
      ok: false, error: { code: "cancelled", message: "VK request cancelled", retryable: false },
    });
    expect(await operation(input)).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(checkpoint).not.toHaveBeenCalled();
    expect(f.credentials.access).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.deadline).not.toHaveBeenCalled();
  });

  it.each([deployCampaignPaused, readCampaignDeployment])("honors cancellation before the evidence hold: %s", async operation => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort();
    expect(await operation({ ...invocation(), plan: {}, references: {}, dependencies: f.dependencies, checkpoint: vi.fn() }, { signal: controller.signal })).toEqual({
      ok: false, error: { code: "cancelled", message: "VK request cancelled", retryable: false },
    });
    expect(f.credentials.access).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
  });
});

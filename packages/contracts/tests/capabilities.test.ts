import { expect, it } from "vitest";
import { capabilityCatalog, capabilityIdSchema, effectiveCapabilityEffects, reportMetricsInputSchema, campaignStatusInputSchema, campaignStatusOutputSchema, trackingTagInputSchema, trackingTagOutputSchema } from "../src/index.js";
import type { CapabilityId, CapabilityInput, EffectCategory, PluginCapability } from "../src/index.js";

it("owns immutable effect-set floors and returns fresh unions without lowering any floor", () => {
  const floors = { "report.metrics.v1": ["read"], "campaign.status.v1": ["read"], "tracking.tag.v1": ["read"], "campaign.validate.v1": ["read"],
    "campaign.deploy": ["write", "ad_spend"], "brand.extract.v1": ["read", "generation"], "organic.publish.v1": ["write"] };
  for (const capabilityId of capabilityIdSchema.options) {
    expect(capabilityCatalog[capabilityId].requiredEffects).toEqual(floors[capabilityId]);
    expect(Object.isFrozen(capabilityCatalog[capabilityId])).toBe(true);
    expect(Object.isFrozen(capabilityCatalog[capabilityId].requiredEffects)).toBe(true);
    const declaredEffects: EffectCategory[] = ["destructive", "conversion", "halt_stop", "read", "read"];
    const result = effectiveCapabilityEffects({ capabilityId, declaredEffects });
    expect(result.ok && result.value).toEqual([...new Set([...floors[capabilityId], ...declaredEffects])]);
    expect(result.ok && result.value).not.toBe(capabilityCatalog[capabilityId].requiredEffects);
    expect(declaredEffects).toHaveLength(5);
  }
  expect(Object.isFrozen(capabilityCatalog)).toBe(true);
  expect(effectiveCapabilityEffects({ capabilityId: "unknown" as CapabilityId, declaredEffects: [] })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  expect(effectiveCapabilityEffects({ capabilityId: "campaign.deploy", declaredEffects: ["spend" as EffectCategory] }).ok).toBe(false);
});
it("reserves later IDs without a callable payload schema or ABI", () => {
  for (const id of ["campaign.validate.v1", "campaign.deploy", "brand.extract.v1", "organic.publish.v1"] as const) {
    expect(capabilityCatalog[id].input).toBeNull(); expect(capabilityCatalog[id].output).toBeNull();
  }
  // @ts-expect-error Reserved IDs cannot be called through the P1 ABI.
  type Reserved = PluginCapability<"organic.publish.v1">;
  const input: CapabilityInput<"report.metrics.v1"> = { grain: "campaign", days: { start: "2026-10-01", end: "2026-10-02" } };
  expect(reportMetricsInputSchema.safeParse(input).success).toBe(true);
  expect(reportMetricsInputSchema.safeParse({ ...input, days: { start: "2026-10-02", end: "2026-10-01" } }).success).toBe(false);
});
it("bounds status and tracking payloads and rejects extra authority-bearing fields", () => {
  expect(campaignStatusInputSchema.safeParse({ vendorCampaignIds: ["a"] }).success).toBe(true);
  for (const ids of [[], ["a", "a"], Array(101).fill("a")]) expect(campaignStatusInputSchema.safeParse({ vendorCampaignIds: ids }).success).toBe(false);
  const row = { vendorCampaignId: "a", status: "disapproved", disapprovalDescriptions: ["Invalid destination"] };
  expect(campaignStatusOutputSchema.safeParse({ observedAt: 1, complete: true, campaigns: [row] }).success).toBe(true);
  expect(campaignStatusOutputSchema.safeParse({ observedAt: 1, complete: true, campaigns: [row, row] }).success).toBe(false);
  expect(campaignStatusOutputSchema.safeParse({ observedAt: 1, complete: true, campaigns: [{ ...row, disapprovalDescriptions: ["x".repeat(1001)] }] }).success).toBe(false);
  const input = { campaignKey: { pluginId: "ads", accountId: "a", vendorCampaignId: "c" }, destinationUrl: "https://example.test/" };
  expect(trackingTagInputSchema.safeParse(input).success).toBe(true);
  expect(trackingTagInputSchema.safeParse({ ...input, destinationUrl: "javascript:alert(1)" }).success).toBe(false);
  expect(trackingTagInputSchema.safeParse({ ...input, approved: true }).success).toBe(false);
  expect(trackingTagOutputSchema.safeParse({ snippet: "<script>inert fixture</script>", campaignUrlTemplate: "https://example.test/?ck={campaign_key}" }).success).toBe(true);
  expect(trackingTagOutputSchema.safeParse({ snippet: "x".repeat(32769), campaignUrlTemplate: "x" }).success).toBe(false);
});

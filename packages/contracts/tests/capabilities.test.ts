import { expect, it } from "vitest";
import { campaignValidateInputSchema, campaignValidateOutputSchema, campaignValidationEvidenceSchema, capabilityCatalog, capabilityIdSchema, effectiveCapabilityEffects, pluginConfigurationSchema, pluginConnectionConfigurationSchema, reportMetricsInputSchema, campaignStatusInputSchema, campaignStatusOutputSchema, trackingTagInputSchema, trackingTagOutputSchema } from "../src/index.js";
import type { CapabilityId, CallableCapabilityId, CapabilityInput, EffectCategory, PluginCapability, PluginCapabilitiesFactory, PluginCapabilityDependencies, PluginConnectionConfiguration } from "../src/index.js";

it("parses exactly the plugin configuration the server sends", () => {
  const configuration = { scope: { ownerId: "o", workspaceId: "w" }, connectionId: "c", accountId: "a", pluginDigest: "a".repeat(64), settings: { apiVersion: "v1" } };
  expect(pluginConfigurationSchema.parse(configuration)).toEqual(configuration);
  expect(pluginConfigurationSchema.safeParse({ ...configuration, currency: "USD" }).success).toBe(false);
  expect(pluginConfigurationSchema.safeParse({ ...configuration, settings: undefined }).success).toBe(false);
  const discovery = { ...configuration, accountId: null };
  expect(pluginConnectionConfigurationSchema.parse(discovery)).toEqual(discovery);
  for (const invalid of [configuration, { ...discovery, accountId: undefined }, { ...discovery, authority: true }]) expect(pluginConnectionConfigurationSchema.safeParse(invalid).success).toBe(false);
  expect(pluginConfigurationSchema.safeParse(discovery).success).toBe(false);
  // @ts-expect-error Default dependency credential access remains account-bound.
  const accountId: Parameters<PluginCapabilityDependencies["credentials"]["access"]>[0]["accountId"] = null;
  void accountId;
  const access: Parameters<PluginCapabilityDependencies<PluginConnectionConfiguration>["credentials"]["access"]>[0] = { connectionId: "c", accountId: null };
  expect(access.accountId).toBeNull();
});

it("types catalog-keyed factories without authority fields or reserved handlers", () => {
  const dependencies = {} as PluginCapabilityDependencies;
  const factory: PluginCapabilitiesFactory = () => ({
    "campaign.status.v1": async () => ({ ok: true, value: { observedAt: 1, complete: true, campaigns: [] } }),
  });
  // @ts-expect-error Authority remains server-owned and is absent from the plugin ABI.
  dependencies.checkAuthority;
  // @ts-expect-error Reserved capabilities have no executable handler contract.
  factory(dependencies)["brand.extract.v1"];
});

it("owns immutable effect-set floors and returns fresh unions without lowering any floor", () => {
  const floors = { "report.metrics.v1": ["read"], "campaign.status.v1": ["read"], "tracking.tag.v1": ["read"], "campaign.validate.v1": ["read"],
    "campaign.deploy": ["write", "ad_spend"], "campaign.halt-stop.v1": ["halt_stop"], "brand.extract.v1": ["read", "generation"], "organic.publish.v1": ["write"], "audience.member.add.v1": ["write"] };
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
it("types halt handlers separately from the catalog read map", () => {
  const reads: { [K in CallableCapabilityId]: PluginCapability<K> } = {
    "report.metrics.v1": async () => ({ ok: false, error: { code: "unavailable", message: "No fixture report", retryable: false } }),
    "campaign.status.v1": async () => ({ ok: true, value: { observedAt: 1, complete: true, campaigns: [] } }),
    "campaign.validate.v1": async () => ({ ok: true, value: { status: "validated" } }),
    "tracking.tag.v1": async () => ({ ok: true, value: { snippet: "", campaignUrlTemplate: "https://example.test" } }),
  };
  const stop: PluginCapability<"campaign.halt-stop.v1"> = async required => ({ ok: true, value: { status: "acknowledged", entityIds: required.input.entityIds } });
  const handlers: ReturnType<PluginCapabilitiesFactory> = { ...reads, "campaign.halt-stop.v1": stop };
  // @ts-expect-error Halt is callable only through the worker-specific contract, never the read union.
  const readId: CallableCapabilityId = "campaign.halt-stop.v1";
  expect(handlers["campaign.halt-stop.v1"]).toBe(stop);
  const catalog = capabilityCatalog["campaign.halt-stop.v1"];
  const request = { operationId: "op", scope: { ownerId: "o", workspaceId: "w" }, connectionId: "c", adAccountId: "a", entityIds: ["e"], action: "pause", haltId: "h", haltEpoch: 1, pluginDigest: "a".repeat(64), bindingId: "b", argumentsDigest: "b".repeat(64) };
  expect(catalog.input.parse(request)).toEqual(request);
  expect(catalog.input.safeParse({ ...request, action: "activate" }).success).toBe(false);
  expect(catalog.output.parse({ status: "acknowledged", entityIds: ["e"] }).status).toBe("acknowledged");
  expect(catalog.output.safeParse({ status: "acknowledged", entityIds: Array(101).fill("e") }).success).toBe(false);
});
it("reserves later IDs without a callable payload schema or ABI", () => {
  for (const id of ["campaign.deploy", "brand.extract.v1"] as const) {
    expect(capabilityCatalog[id].input).toBeNull(); expect(capabilityCatalog[id].output).toBeNull();
  }
  // @ts-expect-error Reserved IDs cannot be called through the P1 ABI.
  type Reserved = PluginCapability<"brand.extract.v1">;
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

it("preserves legacy campaign rows without rejection or budget evidence", () => {
  const output = { observedAt: 1, complete: true, campaigns: [{ vendorCampaignId: "a", status: "active", disapprovalDescriptions: [] }] };
  expect(campaignStatusOutputSchema.parse(output)).toEqual(output);
});
it("retains rejected-child evidence without changing active campaign status", () => {
  const output = { observedAt: 1, complete: true, campaigns: [{ vendorCampaignId: "a", status: "active", rejectedChildAds: 2, disapprovalDescriptions: ["Invalid destination"] }] };
  expect(campaignStatusOutputSchema.parse(output)).toEqual(output);
  output.campaigns[0].rejectedChildAds = 0;
  expect(campaignStatusOutputSchema.parse(output)).toEqual(output);
});
it.each([-1, 0.5])("rejects invalid rejected-child count %s", rejectedChildAds => {
  expect(campaignStatusOutputSchema.safeParse({ observedAt: 1, complete: true,
    campaigns: [{ vendorCampaignId: "a", status: "active", disapprovalDescriptions: [], rejectedChildAds }] }).success).toBe(false);
});
it("accepts explicit zero daily budgets and requires a valid flight for lifetime budgets", () => {
  const currentBudget = { kind: "daily", amountMicros: "0", currency: "USD" };
  const output = { observedAt: 1, complete: true, campaigns: [{ vendorCampaignId: "a", status: "active", disapprovalDescriptions: [], currentBudget }] };
  expect(campaignStatusOutputSchema.parse(output)).toEqual(output);
  const lifetime = { ...output, campaigns: [{ ...output.campaigns[0], currentBudget: { ...currentBudget, kind: "lifetime", flight: { start: 0, end: 10 } } }] };
  expect(campaignStatusOutputSchema.parse(lifetime)).toEqual(lifetime);
  expect(campaignStatusOutputSchema.safeParse({ ...output, campaigns: [{ ...output.campaigns[0], currentBudget: { ...currentBudget, kind: "lifetime" } }] }).success).toBe(false);
  lifetime.campaigns[0].currentBudget.flight.end = 0;
  expect(campaignStatusOutputSchema.safeParse(lifetime).success).toBe(false);
});
it.each([null, 1, "1.2"])("rejects invalid budget micros %s", amountMicros => {
  expect(campaignStatusOutputSchema.safeParse({ observedAt: 1, complete: true,
    campaigns: [{ vendorCampaignId: "a", status: "active", disapprovalDescriptions: [], currentBudget: { kind: "daily", amountMicros, currency: "USD" } }] }).success).toBe(false);
});
it("rejects malformed budget currency", () => {
  expect(campaignStatusOutputSchema.safeParse({ observedAt: 1, complete: true,
    campaigns: [{ vendorCampaignId: "a", status: "active", disapprovalDescriptions: [], currentBudget: { kind: "daily", amountMicros: "1", currency: "usd" } }] }).success).toBe(false);
});

it("validates exact-plan dry-run boundaries without accepting unsupported vendor results", () => {
  const input = { operationId: "op", plan: { name: "fixture" } };
  expect(campaignValidateInputSchema.parse(input)).toEqual(input);
  expect(campaignValidateInputSchema.safeParse({ ...input, admitted: true }).success).toBe(false);
  expect(campaignValidateOutputSchema.parse({ status: "validated" })).toEqual({ status: "validated" });
  expect(campaignValidateOutputSchema.safeParse({ status: "unsupported" }).success).toBe(false);
  const evidence = { pluginDigest: "a".repeat(64), schemaFingerprint: "b".repeat(64), argumentsDigest: "c".repeat(64), status: "validated", evidenceDigest: "d".repeat(64) };
  expect(campaignValidationEvidenceSchema.parse(evidence)).toEqual(evidence);
  expect(campaignValidationEvidenceSchema.safeParse({ ...evidence, evidenceDigest: "not-hex" }).success).toBe(false);
});

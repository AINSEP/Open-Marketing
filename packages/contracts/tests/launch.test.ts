import { expect, it } from "vitest";
import { neutralCampaignLaunchSchema, neutralCampaignRecordSchema, saveNeutralCampaignSchema } from "../src/index.js";
import { campaignDeploymentReceiptSchema } from "../src/index.js";
import type { CampaignDeploymentReceipt, CampaignDeploymentRequired } from "../src/index.js";

it("accepts paused/draft receipts and opaque checkpoints while rejecting active state", () => {
  const receipt: CampaignDeploymentReceipt = { status: "acknowledged", state: "paused", entityIds: ["e"], references: ["e"], checkpoint: { phase: "saved" } };
  expect(campaignDeploymentReceiptSchema.parse(receipt)).toEqual(receipt);
  expect(campaignDeploymentReceiptSchema.parse({ ...receipt, state: "draft", references: { campaign: "e" } }).references).toEqual({ campaign: "e" });
  expect(campaignDeploymentReceiptSchema.safeParse({ ...receipt, state: "active" }).success).toBe(false);
  const saved: CampaignDeploymentRequired["saved"] = { references: { campaign: "e" }, record: null };
  expect(saved.record).toBeNull();
  type RequiredInput<T extends CampaignDeploymentRequired> = T;
  // @ts-expect-error Both deploy and read require checkpoint persistence.
  type MissingCheckpoint = RequiredInput<Omit<CampaignDeploymentRequired, "checkpoint">>;
  // @ts-expect-error The latest opaque record is required alongside saved references.
  type MissingRecord = RequiredInput<Omit<CampaignDeploymentRequired, "saved"> & { saved: { references: Record<string, string> } }>;
});

function launch() {
  return { schemaVersion: 2, operationId: "op", name: "Local campaign", objective: "traffic", schedule: { window: { start: 1, end: 2 }, timezone: "UTC" },
    audience: { countries: ["US"], searchTerms: ["local shop"] }, ads: [{ creativeId: "creative", destinationUrl: "https://example.test/offer?x=1" }], creativeDigest: "a".repeat(64),
    targets: [{ pluginId: "ads", connectionId: "c", accountId: "a", dailyBudget: { minorUnits: 100, currency: "USD" }, expectedExposure: { minorUnits: 200, currency: "USD" } }] };
}
it("accepts v2 traffic/leads/sales, explicit destinations, postal and radius intent", () => {
  for (const objective of ["traffic", "leads", "sales"]) expect(neutralCampaignLaunchSchema.parse({ ...launch(), objective }).ads[0].destinationUrl).toBe(launch().ads[0].destinationUrl);
  for (const localTargeting of [{ kind: "postal", codes: ["90210"] }, { kind: "radius", latitude: 34, longitude: -118, radiusKm: 10 }])
    expect(neutralCampaignLaunchSchema.safeParse({ ...launch(), audience: { ...launch().audience, localTargeting } }).success).toBe(true);
  expect(neutralCampaignRecordSchema.safeParse({ scope: { ownerId: "o", workspaceId: "w" }, campaignId: "c", campaign: launch() }).success).toBe(true);
  const context = { scope: { ownerId: "o", workspaceId: "w" }, principal: { kind: "owner", ownerId: "o" }, correlationId: "c", traceId: "t" };
  expect(saveNeutralCampaignSchema.safeParse({ context, campaign: launch() }).success).toBe(true);
});
it("rejects v1, missing or unsafe destinations, duplicate ads/targets and invalid money/schedule", () => {
  const { schemaVersion, ads, ...v1 } = launch();
  for (const input of [{ ...v1, creativeIds: ["creative"] }, { ...launch(), schemaVersion: 1 }, { ...launch(), ads: [{ creativeId: "c" }] },
    { ...launch(), ads: [{ creativeId: "c", destinationUrl: "javascript:alert(1)" }] }, { ...launch(), ads: [...ads, ...ads] },
    { ...launch(), targets: [...launch().targets, ...launch().targets] }, { ...launch(), targets: [{ ...launch().targets[0], dailyBudget: { minorUnits: 0, currency: "USD" } }] },
    { ...launch(), targets: [{ ...launch().targets[0], expectedExposure: { minorUnits: 1, currency: "EUR" } }] },
    { ...launch(), schedule: { window: { start: 2, end: 1 }, timezone: "UTC" } }, { ...launch(), schedule: { ...launch().schedule, timezone: "bad/zone" } },
    { ...launch(), creativeDigest: "bad" }, { ...launch(), extra: true }]) expect(neutralCampaignLaunchSchema.safeParse(input).success).toBe(false);
});
it("retains country/search bounds and enforces local physical/postal constraints", () => {
  for (const audience of [{ countries: [] }, { countries: ["US", "US"] }, { countries: ["US"], searchTerms: ["Shop", "shop"] },
    { countries: ["US", "CA"], localTargeting: { kind: "postal", codes: ["90210"] } }, { countries: ["US"], localTargeting: { kind: "postal", codes: ["1", "1"] } },
    { countries: ["US"], localTargeting: { kind: "radius", latitude: 91, longitude: 0, radiusKm: 1 } },
    { countries: ["US"], localTargeting: { kind: "radius", latitude: 0, longitude: -181, radiusKm: 1 } },
    { countries: ["US"], localTargeting: { kind: "radius", latitude: 0, longitude: 0, radiusKm: 0 } }])
    expect(neutralCampaignLaunchSchema.safeParse({ ...launch(), audience }).success).toBe(false);
});
it("rejects cycles, BigInt and combined JSON above 64 KiB", () => {
  const cyclic = { ...launch(), cycle: {} }; cyclic.cycle = cyclic;
  expect(neutralCampaignLaunchSchema.safeParse(cyclic).success).toBe(false);
  expect(neutralCampaignLaunchSchema.safeParse({ ...launch(), operationId: 1n }).success).toBe(false);
  const input = { ...launch(), ads: Array.from({ length: 20 }, (_, index) => ({ creativeId: String(index), destinationUrl: "https://example.test/" + "界".repeat(1900) })) };
  expect(neutralCampaignLaunchSchema.safeParse(input).success).toBe(false);
});

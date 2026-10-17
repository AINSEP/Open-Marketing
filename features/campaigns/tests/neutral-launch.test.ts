import { describe, expect, it } from "vitest";
import { neutralCampaignLaunchSchema } from "../index.js";
import type { NeutralCampaignLaunch } from "../index.js";
import type { CampaignTranslationInput as MetaTranslationInput } from "../../../content/agent-plugins/meta-ads/io.github.ainsep.openmarketing/src/index.js";
import type { CampaignTranslationInput as LinkedInTranslationInput } from "../../../content/agent-plugins/linkedin-ads/io.github.ainsep.openmarketing/src/index.js";
import type { CampaignTranslationInput as TikTokTranslationInput } from "../../../content/agent-plugins/tiktok-ads/io.github.ainsep.openmarketing/src/index.js";
import type { CampaignTranslationInput as GoogleTranslationInput } from "../../../content/agent-plugins/google-ads/io.github.ainsep.openmarketing/src/index.js";

const launch: NeutralCampaignLaunch = {
  operationId: "launch", name: "Traffic", objective: "traffic",
  schedule: { window: { start: 1791849600000, end: 1792022400000 }, timezone: "UTC" },
  audience: { countries: ["US"] }, creativeIds: ["creative"], creativeDigest: "a".repeat(64),
  targets: [{ pluginId: "fixture", connectionId: "connection", accountId: "123", dailyBudget: { minorUnits: 4321, currency: "USD" }, expectedExposure: { minorUnits: 20000, currency: "USD" } }],
};

// Compile-time fixtures use the canonical type, so incompatible plugin input drift fails typecheck.
const translationInput = { campaign: launch, target: launch.targets[0], resolved: null };
const metaInput: MetaTranslationInput = translationInput;
const linkedinInput: LinkedInTranslationInput = translationInput;
const tiktokInput: TikTokTranslationInput = translationInput;
const googleInput: GoogleTranslationInput = translationInput;
void [metaInput, linkedinInput, tiktokInput, googleInput];

describe("neutral launch boundary", () => {
  it("preserves the neutral fixture without adding vendor data or authority", () => {
    expect(neutralCampaignLaunchSchema.parse(launch)).toEqual(launch);
  });
  it("accepts four distinct destinations and preserves unlike currencies without summing", () => {
    const targets = Array.from({ length: 4 }, (_, index) => ({ ...launch.targets[0], accountId: String(index + 1), dailyBudget: { minorUnits: 4321, currency: index === 0 ? "JPY" : "USD" }, expectedExposure: { minorUnits: 20000, currency: index === 0 ? "JPY" : "USD" } }));
    expect(neutralCampaignLaunchSchema.parse({ ...launch, targets }).targets).toEqual(targets);
    expect(neutralCampaignLaunchSchema.safeParse({ ...launch, targets: [...targets, targets[0]] }).success).toBe(false);
  });
  it.each([
    { targets: [] }, { targets: [launch.targets[0], launch.targets[0]] },
    { targets: [{ ...launch.targets[0], expectedExposure: { minorUnits: 1, currency: "EUR" } }] },
    { targets: [{ ...launch.targets[0], dailyBudget: { minorUnits: 0, currency: "USD" } }] },
    { targets: [{ ...launch.targets[0], dailyBudget: { minorUnits: Number.MAX_SAFE_INTEGER + 1, currency: "USD" } }] },
    { targets: [{ ...launch.targets[0], dailyBudget: { minorUnits: 1, currency: "usd" } }] },
    { schedule: { ...launch.schedule, timezone: "Made/Up" } },
    { schedule: { ...launch.schedule, window: { start: 1000, end: 1000 } } },
    { schedule: { ...launch.schedule, window: { start: 1000, end: Infinity } } },
    { creativeDigest: "missing" }, { creativeIds: ["creative", "creative"] },
    { creativeIds: [] }, { audience: { countries: Array(21).fill("US") } },
    { creativeIds: Array.from({ length: 21 }, (_, index) => String(index)) },
    { audience: { countries: ["US", "US"] } }, { audience: { countries: [] } },
    { audience: { countries: ["US"], searchTerms: ["Tools", "tools"] } },
    { objective: "sales" }, { approvalId: "not-authority" },
  ])("rejects invalid, ambiguous or authority-bearing input", change => {
    expect(neutralCampaignLaunchSchema.safeParse({ ...launch, ...change }).success).toBe(false);
  });
  it("bounds actual UTF-8 bytes as well as individual collections", () => {
    const searchTerms = Array.from({ length: 50 }, (_, index) => String(index).padStart(2, "0") + "😀".repeat(39));
    const ids = Array.from({ length: 20 }, (_, index) => String(index).padStart(2, "0") + "😀".repeat(127));
    expect(neutralCampaignLaunchSchema.safeParse({ ...launch, audience: { countries: ["US"], searchTerms }, creativeIds: ids }).success).toBe(true);
    const targets = Array.from({ length: 4 }, (_, index) => ({ ...launch.targets[0], pluginId: ids[index], connectionId: ids[index + 4], accountId: ids[index + 8] }));
    // An extra unknown large field must also reject before schema traversal.
    const oversized = neutralCampaignLaunchSchema.safeParse({ ...launch, targets, padding: "😀".repeat(17000) });
    expect(oversized.success).toBe(false);
    if (oversized.success) throw new Error("Expected byte limit rejection");
    expect(oversized.error.issues[0].message).toBe("Launch must be JSON of at most 64 KiB");
  });
  it("returns validation failure for cyclic/non-JSON input", () => {
    const cyclic: Record<string, unknown> = { ...launch }; cyclic.self = cyclic;
    expect(neutralCampaignLaunchSchema.safeParse(cyclic).success).toBe(false);
    expect(neutralCampaignLaunchSchema.safeParse(undefined).success).toBe(false);
    expect(neutralCampaignLaunchSchema.safeParse({ ...launch, operationId: 1n }).success).toBe(false);
  });
});

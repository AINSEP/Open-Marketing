import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { capabilityEnvelopeSchema } from "@open-marketing/contracts";
import { campaignDeploymentPlanSchema, tiktokDeploymentSchemaFingerprint, tiktokEventsSchemaFingerprint, tiktokStopSchemaFingerprint, tiktokTools } from "../src/index.js";

const root = new URL("../../", import.meta.url);
const capabilitySchema = capabilityEnvelopeSchema.omit({ pluginDigest: true });
const extensionSchema = z.strictObject({ version: z.literal(1), enabled: z.literal(false), admitted: z.literal(false), capabilities: z.array(capabilitySchema).length(13) });
const manifestSchema = z.strictObject({ $schema: z.literal("https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"), name: z.literal("tiktok-ads"), version: z.literal("0.1.0"), description: z.string(), license: z.literal("Apache-2.0"), extensions: z.strictObject({ "io.github.ainsep.openmarketing": extensionSchema }) });

function readJson(required: { path: string }): unknown {
  return JSON.parse(readFileSync(new URL(required.path, root), "utf8")) as unknown;
}

describe("packaged TikTok metadata", () => {
  it("uses Meta's portable v1.1 namespace and an empty server-loaded MCP configuration", () => {
    const manifest = manifestSchema.parse(readJson({ path: "plugin.json" }));
    expect(manifest.extensions["io.github.ainsep.openmarketing"]).toMatchObject({ version: 1, enabled: false, admitted: false });
    expect(readJson({ path: "mcp.json" })).toEqual({ $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json", mcpServers: {} });
  });
  it("declares ten tools and three backend capabilities, unadmitted, with actual schema fingerprints", () => {
    const manifest = manifestSchema.parse(readJson({ path: "plugin.json" }));
    const extension = manifest.extensions["io.github.ainsep.openmarketing"];
    const namespace = z.strictObject({ version: z.literal(1), admitted: z.literal(false), capabilities: z.array(capabilitySchema).length(13) }).parse(readJson({ path: "io.github.ainsep.openmarketing/capabilities.json" }));
    expect(namespace.capabilities).toEqual(extension.capabilities);
    expect(new Set(extension.capabilities.map(value => value.capabilityId)).size).toBe(13);
    expect(tiktokTools.map(value => value.name)).toEqual(["tiktok_ads.get_advertiser", "tiktok_ads.get_campaigns", "tiktok_ads.get_adgroups", "tiktok_ads.get_ads", "tiktok_ads.report", "tiktok_ads.create_campaign_paused", "tiktok_ads.create_adgroup_paused", "tiktok_ads.create_ad_paused", "tiktok_ads.activate_entity", "tiktok_ads.pause_entity"]);
    for (const [index, tool] of tiktokTools.entries()) {
      expect(extension.capabilities[index]).toMatchObject({ pluginId: "tiktok-ads", admitted: false, effects: tool.effects, schemaFingerprint: tool.schemaFingerprint });
    }
    expect(extension.capabilities[12]).toMatchObject({ capabilityId: "campaign.create-paused.v1", admitted: false, effects: ["write"], schemaFingerprint: tiktokDeploymentSchemaFingerprint });
    expect(campaignDeploymentPlanSchema.safeParse({}).success).toBe(false);
    expect(tiktokTools.slice(0, 5).map(tool => tool.effects)).toEqual(Array.from({ length: 5 }, () => ["read"]));
    expect(tiktokTools.slice(5).map(tool => tool.effects)).toEqual([["write"], ["write"], ["write"], ["ad_spend"], ["write"]]);
    expect(extension.capabilities.slice(10, 12)).toEqual([
      { capabilityId: "campaign.stop-only.v1", version: 1, pluginId: "tiktok-ads", admitted: false, effects: ["halt_stop"], schemaFingerprint: tiktokStopSchemaFingerprint },
      { capabilityId: "conversion.signup-trial.v1", version: 1, pluginId: "tiktok-ads", admitted: false, effects: ["conversion"], schemaFingerprint: tiktokEventsSchemaFingerprint },
    ]);
  });
  it("remains a separate inert plugin package, with no Jini link or vendor/chart SDK", () => {
    const pkg = z.object({ name: z.string(), sideEffects: z.boolean(), exports: z.record(z.string(), z.object({ types: z.string(), import: z.string() })), dependencies: z.record(z.string(), z.string()), devDependencies: z.record(z.string(), z.string()) }).parse(readJson({ path: "package.json" }));
    expect(pkg.name).toBe("@open-marketing-plugin/tiktok-ads"); expect(pkg.sideEffects).toBe(false);
    expect(pkg.exports).toEqual({ ".": { types: "./io.github.ainsep.openmarketing/src/index.ts", import: "./io.github.ainsep.openmarketing/dist/index.mjs" } });
    expect(pkg.dependencies).toEqual({ "@open-marketing/contracts": "workspace:*", zod: "4.1.13" });
    expect(pkg.devDependencies).toMatchObject({ typescript: "5.9.3", vitest: "3.2.4", esbuild: "0.25.12" });
  });
  it("records API version, dates, primary URLs and explicit unverified admission limitations", () => {
    const evidence = z.object({ apiVersion: z.literal("v1.3"), inspectedAt: z.literal("2026-10-13"), admission: z.literal("disabled-pending-host-admission"), endpoints: z.array(z.object({ path: z.string(), method: z.enum(["GET", "POST"]), apiVersion: z.literal("v1.3"), inspectedAt: z.literal("2026-10-13"), portalUrl: z.url(), sdkUrl: z.url().optional(), confirmedRequestFields: z.array(z.string()), unverified: z.array(z.string()).min(1) })).length(12), unverified: z.array(z.string()).min(1) }).parse(readJson({ path: "io.github.ainsep.openmarketing/evidence/primary-sources.json" }));
    const review = z.object({ pausedDeploymentReview: z.object({ inspectedAt: z.literal("2026-10-24"), apiVersion: z.literal("v1.3"), sources: z.array(z.url()).min(5), verified: z.array(z.string()).min(5) }) }).parse(readJson({ path: "io.github.ainsep.openmarketing/evidence/primary-sources.json" }));
    expect(review.pausedDeploymentReview.verified.join(" ")).toContain("FROZEN");
    expect(evidence.endpoints.map(value => value.path)).toEqual(["advertiser/info/", "campaign/get/", "adgroup/get/", "ad/get/", "report/integrated/get/", "campaign/create/", "adgroup/create/", "ad/create/", "campaign/status/update/", "adgroup/status/update/", "ad/status/update/", "event/track/"]);
    for (const endpoint of evidence.endpoints) {
      expect(new URL(endpoint.portalUrl).hostname).toBe("business-api.tiktok.com");
      if (endpoint.sdkUrl) expect(endpoint.sdkUrl).toMatch(/^https:\/\/github\.com\/tiktok\/tiktok-business-api-sdk\//);
    }
  });
});

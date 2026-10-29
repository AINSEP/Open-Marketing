import { tiktokSchemaFingerprints } from "../src/commands.js";
import { readFile as readCapabilityFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { capabilityEnvelopeSchema, pluginConfigurationSchema } from "@open-marketing/contracts";
import { createCapabilities, campaignDeploymentPlanSchema, tiktokDeploymentSchemaFingerprint, tiktokEventsSchemaFingerprint, tiktokStopSchemaFingerprint, tools } from "../src/index.js";

const root = new URL("../../", import.meta.url);
const capabilitySchema = capabilityEnvelopeSchema.omit({ pluginDigest: true });
const extensionSchema = z.strictObject({ conversionSettings: z.unknown().optional(), version: z.literal(1), enabled: z.literal(false), admitted: z.literal(false), capabilities: z.array(capabilitySchema).length(15), credentialCards: z.array(z.record(z.string(), z.unknown())).max(32), credentialAssets: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)) });
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
    const namespace = z.strictObject({ version: z.literal(1), admitted: z.literal(false), capabilities: z.array(capabilitySchema).length(15) }).parse(readJson({ path: "io.github.ainsep.openmarketing/capabilities.json" }));
    expect(namespace.capabilities).toEqual(extension.capabilities);
    expect(new Set(extension.capabilities.map(value => value.capabilityId)).size).toBe(15);
    expect(tools.map(value => value.name)).toEqual(["tiktok_ads.get_advertiser", "tiktok_ads.get_campaigns", "tiktok_ads.get_adgroups", "tiktok_ads.get_ads", "tiktok_ads.report", "tiktok_ads.create_campaign_paused", "tiktok_ads.create_adgroup_paused", "tiktok_ads.create_ad_paused", "tiktok_ads.activate_entity", "tiktok_ads.pause_entity"]);
    for (const [index, tool] of tools.entries()) {
      const kind = (tool.inputSchema.properties as { kind: { const: keyof typeof tiktokSchemaFingerprints } }).kind.const;
      expect(extension.capabilities[index]).toMatchObject({ pluginId: "tiktok-ads", admitted: false, effects: tool.effects, schemaFingerprint: tiktokSchemaFingerprints[kind] });
    }
    expect(extension.capabilities[12]).toMatchObject({ capabilityId: "campaign.create-paused.v1", admitted: false, effects: ["write"], schemaFingerprint: tiktokDeploymentSchemaFingerprint });
    expect(campaignDeploymentPlanSchema.safeParse({}).success).toBe(false);
    expect(tools.slice(0, 5).map(tool => tool.effects)).toEqual(Array.from({ length: 5 }, () => ["read"]));
    expect(tools.slice(5).map(tool => tool.effects)).toEqual([["write"], ["write"], ["write"], ["ad_spend"], ["write"]]);
    expect(extension.capabilities.slice(10, 12)).toEqual([
      { capabilityId: "campaign.stop-only.v1", version: 1, pluginId: "tiktok-ads", admitted: false, effects: ["halt_stop"], schemaFingerprint: tiktokStopSchemaFingerprint },
      { capabilityId: "conversion.signup-trial.v1", version: 1, pluginId: "tiktok-ads", admitted: false, effects: ["conversion"], schemaFingerprint: tiktokEventsSchemaFingerprint },
    ]);
  });
  it("remains a separate inert plugin package, with no Jini link or vendor/chart SDK", () => {
    const pkg = z.object({ name: z.string(), sideEffects: z.boolean(), exports: z.record(z.string(), z.object({ types: z.string(), import: z.string() })), dependencies: z.record(z.string(), z.string()) }).parse(readJson({ path: "package.json" }));
    expect(pkg.name).toBe("@open-marketing-plugin/tiktok-ads"); expect(pkg.sideEffects).toBe(false);
    expect(pkg.exports).toEqual({ ".": { types: "./io.github.ainsep.openmarketing/src/index.ts", import: "./io.github.ainsep.openmarketing/dist/index.mjs" } });
    expect(Object.keys(pkg.dependencies).sort()).toEqual(["@open-marketing/contracts", "zod"]);
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

it("declares canonical read capabilities without admitting or changing credentials", async () => {
  const root = new URL("../../", import.meta.url);
  const manifest = JSON.parse(await readCapabilityFile(new URL("plugin.json", root), "utf8"));
  const declaration = JSON.parse(await readCapabilityFile(new URL("io.github.ainsep.openmarketing/capabilities.json", root), "utf8"));
  const fingerprint = createHash("sha256").update(await readCapabilityFile(new URL("io.github.ainsep.openmarketing/src/capabilities.ts", root))).digest("hex");
  const unused = () => { throw new Error("Factory must perform no I/O"); };
  const handlers = createCapabilities({ configuration: pluginConfigurationSchema.parse({ scope: { ownerId: "owner", workspaceId: "workspace" }, connectionId: "connection", accountId: "123", pluginDigest: "a".repeat(64), settings: {} }), fetch: unused, credentials: { access: unused }, clock: { now: unused }, observer: { observe: unused }, wait: unused });
  const capabilities = declaration.capabilities.filter((value: { capabilityId: string }) => ["report.metrics.v1", "campaign.status.v1"].includes(value.capabilityId));
  expect(capabilities.map((value: { capabilityId: string }) => value.capabilityId)).toEqual(["report.metrics.v1", "campaign.status.v1"]);
  for (const entry of capabilities) {
    expect(handlers[entry.capabilityId as keyof typeof handlers]).toBeTypeOf("function");
    expect(entry).toMatchObject({ pluginId: "tiktok-ads", admitted: false, effects: ["read"], schemaFingerprint: fingerprint });
  }
  expect(manifest.extensions["io.github.ainsep.openmarketing"].capabilities).toEqual(declaration.capabilities);
  const evidence = JSON.parse(await readCapabilityFile(new URL("io.github.ainsep.openmarketing/evidence/primary-sources.json", root), "utf8"));
  expect(evidence.canonicalReadReview).toMatchObject({ checkedAt: "2026-10-26", liveVendorCalls: false });
});

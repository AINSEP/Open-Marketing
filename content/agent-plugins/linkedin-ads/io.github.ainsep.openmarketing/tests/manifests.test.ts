import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { capabilityEnvelopeSchema } from "@open-marketing/contracts";
import { linkedinAdsTools } from "../src/index.js";

const root = new URL("../../", import.meta.url);
/** Fixture reader consumes the files the plugin host actually installs. */
function readJson(required: { path: string }): unknown { return JSON.parse(readFileSync(new URL(required.path, root), "utf8")) as unknown; }
const capability = capabilityEnvelopeSchema.omit({ pluginDigest: true });
const manifestSchema = z.object({ $schema: z.literal("https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"), name: z.literal("linkedin-ads"), version: z.literal("0.1.0"), license: z.literal("Apache-2.0"), extensions: z.strictObject({ "io.github.ainsep.openmarketing": z.strictObject({ version: z.literal(1), enabled: z.literal(false), admitted: z.literal(false), capabilities: z.array(capability), credentialCards: z.array(z.record(z.string(), z.unknown())).max(32), credentialAssets: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)) }) }) });
/** Source file whose bytes back a capability's schema fingerprint. */
function fingerprintSource(required: { effect: string | undefined; capabilityId: string }): string {
  if (required.capabilityId === "campaign.create-draft.v1") return "campaign-deployment.ts";
  if (required.effect === "halt_stop") return "transport.ts";
  if (required.effect === "conversion") return "capi.ts";
  return required.capabilityId === "report.account-spend.v1" ? "reporting.ts" : "commands.ts";
}
describe("LinkedIn portable package", () => {
  it("uses the Meta layout, OM namespace and empty MCP map, with admission off", () => {
    const manifest = manifestSchema.parse(readJson({ path: "plugin.json" }));
    expect(readJson({ path: "mcp.json" })).toEqual({ $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json", mcpServers: {} });
    const capabilities = manifest.extensions["io.github.ainsep.openmarketing"].capabilities;
    expect(capabilities).toHaveLength(11);
    expect(capabilities.every(value => !value.admitted && value.pluginId === "linkedin-ads")).toBe(true);
    expect(new Set(capabilities.map(value => value.capabilityId)).size).toBe(11);
  });
  it("declares effects consistently with actual tool schemas, excluding backend stop from agent tools", () => {
    const manifest = manifestSchema.parse(readJson({ path: "plugin.json" }));
    const declaration = z.object({ admitted: z.literal(false), capabilities: z.array(capability), tools: z.array(z.strictObject({ name: z.string(), effects: z.array(z.string()), capabilityId: z.string() })), backendStop: z.strictObject({ capabilityId: z.literal("campaign.stop-only.v1"), effects: z.tuple([z.literal("halt_stop")]), agentTool: z.literal(false) }), backendConversion: z.strictObject({ capabilityId: z.literal("conversion.deliver.v1"), effects: z.tuple([z.literal("conversion")]), agentTool: z.literal(false) }) }).parse(readJson({ path: "io.github.ainsep.openmarketing/capabilities.json" }));
    expect(declaration.capabilities).toEqual(manifest.extensions["io.github.ainsep.openmarketing"].capabilities);
    expect(declaration.tools.map(tool => [tool.name, tool.effects])).toEqual(linkedinAdsTools.map(tool => [tool.name, [tool.effect]]));
    expect(declaration.tools.every(tool => declaration.capabilities.some(cap => cap.capabilityId === tool.capabilityId && JSON.stringify(cap.effects) === JSON.stringify(tool.effects)))).toBe(true);
    expect(declaration.tools.map(tool => tool.name)).not.toContain("stop");
    expect(declaration.tools.map(tool => tool.name)).not.toContain("deliver");
    expect(declaration.tools.map(tool => tool.name)).not.toContain("reconcile");
    expect(declaration.capabilities.find(cap => cap.capabilityId === declaration.backendConversion.capabilityId)?.effects).toEqual(["conversion"]);
  });
  it("keeps source-schema compatibility fingerprints current, without a plugin trust allowlist", () => {
    const manifest = manifestSchema.parse(readJson({ path: "plugin.json" }));
    for (const cap of manifest.extensions["io.github.ainsep.openmarketing"].capabilities) {
      const path = fingerprintSource({ effect: cap.effects[0], capabilityId: cap.capabilityId });
      const actual = createHash("sha256").update(readFileSync(new URL("io.github.ainsep.openmarketing/src/" + path, root))).digest("hex");
      expect(cap.schemaFingerprint).toBe(actual);
    }
  });
  it("keeps required dependencies and exposes the sole inert entry", () => {
    const pkg = z.object({ exports: z.record(z.string(), z.unknown()), dependencies: z.record(z.string(), z.string()), sideEffects: z.literal(false) }).parse(readJson({ path: "package.json" }));
    expect(Object.keys(pkg.exports)).toEqual(["."]);
    expect(Object.keys(pkg.dependencies).sort()).toEqual(["@open-marketing/contracts", "zod"]);
    expect(readFileSync(new URL("LICENSE", root), "utf8")).toContain("Apache License");
    expect(readFileSync(new URL("skills/linkedin-ads/SKILL.md", root), "utf8")).toContain("name: linkedin-ads");
  });
  it("records dated official endpoint, field and scope evidence without pretending fixtures establish vendor access", () => {
    const evidence = z.object({ checkedAt: z.literal("2026-10-13"), sources: z.array(z.object({ id: z.string(), status: z.literal("verified-documentation"), url: z.url(), apiVersion: z.string(), checkedAt: z.enum(["2026-10-13", "2026-10-24"]) })), unverified: z.array(z.object({ fact: z.string(), behavior: z.string() })), omBounds: z.strictObject({ requestBytes: z.literal(65536), responseBytes: z.literal(1048576), timeoutMs: z.literal(15000), maxPageSize: z.literal(100), maxIds: z.literal(100), retries: z.literal(0) }) }).parse(readJson({ path: "io.github.ainsep.openmarketing/evidence/primary-sources.json" }));
    expect(evidence.sources.every(source => new URL(source.url).hostname === "learn.microsoft.com")).toBe(true);
    expect(evidence.sources.map(source => source.id)).toEqual(expect.arrayContaining(["accounts", "groups", "campaigns", "creatives", "targeting", "version", "oauth", "refresh", "analytics", "analytics-schema", "conversions", "conversions-schema", "lead-forms", "lead-forms-schema"]));
    expect(evidence.unverified).toHaveLength(3);
    for (const source of evidence.sources) {
      const migration = ["version-202610", "creative-content-202610"].includes(source.id);
      expect(source.checkedAt).toBe(migration ? "2026-10-24" : "2026-10-13");
    }
    expect(evidence.sources.filter(source => source.apiVersion === "202610").map(source => source.id)).toEqual(["version-202610", "creative-content-202610"]);
  });
});

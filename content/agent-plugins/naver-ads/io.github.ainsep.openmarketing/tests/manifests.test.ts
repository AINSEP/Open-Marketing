import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { capabilityEnvelopeSchema } from "@open-marketing/contracts";
import { naverAdsTools } from "../src/index.js";

const root = new URL("../../", import.meta.url);
function read(required: { path: string }): unknown { return JSON.parse(readFileSync(new URL(required.path, root), "utf8")); }
const cap = capabilityEnvelopeSchema.omit({ pluginDigest: true });
const declarationSchema = z.object({ admitted: z.literal(false), capabilities: z.array(cap).length(4), tools: z.array(z.object({ name: z.string(), effects: z.array(z.literal("read")), capabilityId: z.string() })).length(3) });
describe("Naver portable package", () => {
  it("declares only implemented reads, with all admission flags off", () => {
    const manifest = z.object({ $schema: z.literal("https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"), name: z.literal("naver-ads"), license: z.literal("Apache-2.0"), extensions: z.strictObject({ "io.github.ainsep.openmarketing": z.object({ enabled: z.literal(false), admitted: z.literal(false), capabilities: z.array(cap) }) }) }).parse(read({ path: "plugin.json" }));
    const declaration = declarationSchema.parse(read({ path: "io.github.ainsep.openmarketing/capabilities.json" }));
    expect(declaration.capabilities).toEqual(manifest.extensions["io.github.ainsep.openmarketing"].capabilities);
    expect(declaration.tools.map(tool => [tool.name, tool.effects])).toEqual(naverAdsTools.map(tool => [tool.name, [tool.effect]]));
    for (const capability of declaration.capabilities) {
      expect(capability).toMatchObject({ pluginId: "naver-ads", admitted: false, effects: ["read"] });
      const sources = ["report.metrics.v1", "campaign.status.v1"].includes(capability.capabilityId) ? ["transport", "reporting"] : capability.capabilityId === "report.account-spend.v1" ? ["reporting"] : ["commands"];
      const bytes = sources.map(source => readFileSync(new URL("io.github.ainsep.openmarketing/src/" + source + ".ts", root)));
      expect(capability.schemaFingerprint).toBe(createHash("sha256").update(Buffer.concat(bytes)).digest("hex"));
    }
    expect(declaration.capabilities.slice(2).map(item => item.capabilityId)).toEqual(["report.metrics.v1", "campaign.status.v1"]);
    expect(declaration.tools.every(tool => declaration.capabilities.some(item => item.capabilityId === tool.capabilityId))).toBe(true);
    expect(read({ path: "mcp.json" })).toEqual({ $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json", mcpServers: {} });
  });
  it("keeps required dependencies and one public entry, with dated official evidence", () => {
    const pkg = z.object({ sideEffects: z.literal(false), exports: z.record(z.string(), z.unknown()), dependencies: z.record(z.string(), z.string()) }).parse(read({ path: "package.json" }));
    expect(Object.keys(pkg.exports)).toEqual(["."]);
    expect(Object.keys(pkg.dependencies).sort()).toEqual(["@open-marketing/contracts", "zod"]);
    const evidence = z.object({ checkedAt: z.literal("2026-10-26"), sources: z.array(z.object({ url: z.url(), quote: z.string().min(1) })).min(7), unverified: z.array(z.unknown()).min(1), blockedPages: z.array(z.string()).min(1) }).parse(read({ path: "io.github.ainsep.openmarketing/evidence/primary-sources.json" }));
    expect(evidence.sources.every(item => ["raw.githubusercontent.com", "github.com"].includes(new URL(item.url).hostname))).toBe(true);
    expect(readFileSync(new URL("LICENSE", root), "utf8")).toContain("Apache License");
    expect(readFileSync(new URL("skills/naver-ads/SKILL.md", root), "utf8")).toContain("name: naver-ads");
  });
});

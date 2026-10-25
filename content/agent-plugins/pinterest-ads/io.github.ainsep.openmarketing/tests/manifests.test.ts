import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { z } from "zod";
import { capabilityEnvelopeSchema } from "@open-marketing/contracts";
import { pinterestAdsTools } from "../src/index.js";

const root = new URL("../../", import.meta.url);
function json(required: { path: string }): unknown { return JSON.parse(readFileSync(new URL(required.path, root), "utf8")) as unknown; }
it("declares three read tools and internal paused/conversion capabilities, disabled and unadmitted", () => {
  const capability = capabilityEnvelopeSchema.omit({ pluginDigest: true });
  const envelope = z.object({ version: z.literal(1), admitted: z.literal(false), capabilities: z.array(capability) });
  const manifest = z.object({ name: z.literal("pinterest-ads"), license: z.literal("Apache-2.0"), extensions: z.object({ "io.github.ainsep.openmarketing": envelope.extend({ enabled: z.literal(false) }) }) }).parse(json({ path: "plugin.json" }));
  const declarations = envelope.extend({ tools: z.array(z.object({ name: z.string(), effects: z.array(z.string()), capabilityId: z.string() })) }).parse(json({ path: "io.github.ainsep.openmarketing/capabilities.json" }));
  expect(declarations.capabilities).toEqual(manifest.extensions["io.github.ainsep.openmarketing"].capabilities);
  expect(declarations.tools.map(tool => tool.name)).toEqual(["list_accounts", "list_campaigns", "report"]);
  expect(pinterestAdsTools.map(tool => [tool.name, tool.effect])).toEqual(declarations.tools.map(tool => [tool.name, tool.effects[0]]));
  const sources: Record<string, { file: string; effect: string }> = { "campaign.read.v1": { file: "commands.ts", effect: "read" }, "report.account-spend.v1": { file: "reporting.ts", effect: "read" }, "campaign.create-paused.v1": { file: "campaign-translation.ts", effect: "write" }, "conversion.deliver.v1": { file: "capi.ts", effect: "conversion" } };
  for (const cap of declarations.capabilities) {
    expect(cap).toMatchObject({ admitted: false, pluginId: "pinterest-ads", effects: [sources[cap.capabilityId].effect] });
    expect(cap.schemaFingerprint).toBe(createHash("sha256").update(readFileSync(new URL("io.github.ainsep.openmarketing/src/" + sources[cap.capabilityId].file, root))).digest("hex"));
  }
  expect(Object.keys(sources)).toEqual(declarations.capabilities.map(cap => cap.capabilityId));
  expect(json({ path: "io.github.ainsep.openmarketing/capabilities.json" })).toMatchObject({ deployment: { capabilityId: "campaign.create-paused.v1", admitted: false }, backendConversion: { agentTool: false, effects: ["conversion"] } });
  expect(json({ path: "mcp.json" })).toEqual({ $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json", mcpServers: {} });
});
it("keeps required dependencies and records official evidence plus unavailable auth", () => {
  const pkg = z.object({ dependencies: z.record(z.string(), z.string()), exports: z.record(z.string(), z.unknown()), sideEffects: z.literal(false) }).parse(json({ path: "package.json" }));
  expect(Object.keys(pkg.exports)).toEqual(["."]); expect(Object.keys(pkg.dependencies).sort()).toEqual(["@open-marketing/contracts", "zod"]);
  const evidence = z.object({ checkedAt: z.literal("2026-10-24"), sources: z.array(z.object({ url: z.url(), quote: z.string().min(1) })), unverified: z.object({ oauth: z.string(), endDateInclusivity: z.string() }) }).parse(json({ path: "io.github.ainsep.openmarketing/evidence/primary-sources.json" }));
  expect(evidence.sources.map(source => new URL(source.url).hostname)).toEqual(["raw.githubusercontent.com", ...Array<string>(5).fill("developers.pinterest.com")]);
  expect(evidence.unverified.endDateInclusivity).toContain("Reports unavailable before credential/gateway/network I/O");
  expect(readFileSync(new URL("LICENSE", root), "utf8")).toContain("Apache License");
});

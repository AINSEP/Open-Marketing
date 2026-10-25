import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { z } from "zod";
import { capabilityEnvelopeSchema } from "@open-marketing/contracts";
import { pinterestAdsTools } from "../src/index.js";

const root = new URL("../../", import.meta.url);
function json(required: { path: string }): unknown { return JSON.parse(readFileSync(new URL(required.path, root), "utf8")) as unknown; }
it("declares three read schemas including reserved reporting, disabled and unadmitted", () => {
  const capability = capabilityEnvelopeSchema.omit({ pluginDigest: true });
  const envelope = z.object({ version: z.literal(1), admitted: z.literal(false), capabilities: z.array(capability) });
  const manifest = z.object({ name: z.literal("pinterest-ads"), license: z.literal("Apache-2.0"), extensions: z.object({ "io.github.ainsep.openmarketing": envelope.extend({ enabled: z.literal(false) }) }) }).parse(json({ path: "plugin.json" }));
  const declarations = envelope.extend({ tools: z.array(z.object({ name: z.string(), effects: z.array(z.string()), capabilityId: z.string() })) }).parse(json({ path: "io.github.ainsep.openmarketing/capabilities.json" }));
  expect(declarations.capabilities).toEqual(manifest.extensions["io.github.ainsep.openmarketing"].capabilities);
  expect(declarations.tools.map(tool => tool.name)).toEqual(["list_accounts", "list_campaigns", "report"]);
  expect(pinterestAdsTools.map(tool => [tool.name, tool.effect])).toEqual(declarations.tools.map(tool => [tool.name, tool.effects[0]]));
  for (const cap of declarations.capabilities) {
    expect(cap).toMatchObject({ admitted: false, pluginId: "pinterest-ads", effects: ["read"] });
    const file = cap.capabilityId === "campaign.read.v1" ? "commands.ts" : "reporting.ts";
    expect(cap.schemaFingerprint).toBe(createHash("sha256").update(readFileSync(new URL("io.github.ainsep.openmarketing/src/" + file, root))).digest("hex"));
  }
  expect(json({ path: "mcp.json" })).toEqual({ $schema: "https://agent-plugins.org/schemas/1.1.0/mcp.schema.json", mcpServers: {} });
});
it("pins the existing toolchain and records official evidence plus unavailable auth", () => {
  const pkg = z.object({ dependencies: z.record(z.string(), z.string()), devDependencies: z.record(z.string(), z.string()), exports: z.record(z.string(), z.unknown()), sideEffects: z.literal(false) }).parse(json({ path: "package.json" }));
  expect(Object.keys(pkg.exports)).toEqual(["."]); expect(pkg.dependencies).toEqual({ "@open-marketing/contracts": "workspace:*", zod: "4.1.13" });
  expect(pkg.devDependencies).toEqual({ "@types/node": "24.10.1", esbuild: "0.25.12", typescript: "5.9.3", vitest: "3.2.4" });
  const evidence = z.object({ checkedAt: z.literal("2026-10-24"), sources: z.array(z.object({ url: z.url(), quote: z.string().min(1) })), unverified: z.object({ oauth: z.string(), endDateInclusivity: z.string() }) }).parse(json({ path: "io.github.ainsep.openmarketing/evidence/primary-sources.json" }));
  expect(evidence.sources.map(source => new URL(source.url).hostname)).toEqual(["raw.githubusercontent.com", "developers.pinterest.com", "developers.pinterest.com"]);
  expect(evidence.unverified.endDateInclusivity).toContain("Reports unavailable before credential/gateway/network I/O");
  expect(readFileSync(new URL("LICENSE", root), "utf8")).toContain("Apache License");
});

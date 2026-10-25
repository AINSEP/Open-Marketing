import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { z } from "zod";
import { expect, it } from "vitest";
import { capabilityEnvelopeSchema } from "@open-marketing/contracts";
import { kakaoAdsTools } from "../src/index.js";
const root = new URL("../../", import.meta.url);
function read(required: { path: string }): string { return readFileSync(new URL(required.path, root), "utf8"); }
function json(required: { path: string }): unknown { return JSON.parse(read(required)) as unknown; }
it("keeps portable metadata disabled, read-only and consistent with the public tools", () => {
  const cap = capabilityEnvelopeSchema.omit({ pluginDigest: true });
  const extension = z.object({ version: z.literal(1), enabled: z.literal(false), admitted: z.literal(false), capabilities: z.array(cap).length(2) });
  const manifest = z.object({ name: z.literal("kakao-ads"), license: z.literal("Apache-2.0"), extensions: z.object({ "io.github.ainsep.openmarketing": extension }) }).parse(json({ path: "plugin.json" }));
  const declared = z.object({ admitted: z.literal(false), capabilities: z.array(cap), tools: z.array(z.object({ name: z.string(), effects: z.array(z.literal("read")), capabilityId: z.string() })) }).parse(json({ path: "io.github.ainsep.openmarketing/capabilities.json" }));
  expect(declared.capabilities).toEqual(manifest.extensions["io.github.ainsep.openmarketing"].capabilities);
  expect(declared.tools.map(tool => [tool.name, tool.effects])).toEqual(kakaoAdsTools.map(tool => [tool.name, [tool.effect]]));
  for (const capability of declared.capabilities) {
    expect(capability).toMatchObject({ pluginId: "kakao-ads", admitted: false, effects: ["read"] });
    const source = capability.capabilityId === "report.account-spend.v1" ? "reporting.ts" : "commands.ts";
    expect(capability.schemaFingerprint).toBe(createHash("sha256").update(read({ path: "io.github.ainsep.openmarketing/src/" + source })).digest("hex"));
  }
  expect(declared.tools.every(tool => declared.capabilities.some(capability => capability.capabilityId === tool.capabilityId))).toBe(true);
  expect(json({ path: "mcp.json" })).toEqual({ $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json", mcpServers: {} });
  expect(json({ path: "package.json" })).toMatchObject({ sideEffects: false, dependencies: { "@open-marketing/contracts": "workspace:*", zod: "4.1.13" }, exports: { ".": { types: "./io.github.ainsep.openmarketing/src/index.ts", import: "./io.github.ainsep.openmarketing/dist/index.mjs" } } });
  const evidence = z.object({ checkedAt: z.literal("2026-10-24"), sources: z.array(z.object({ url: z.url(), quote: z.string().min(1), fact: z.string() })).min(6), unverified: z.array(z.string()).min(4), blockedPages: z.array(z.string()) }).parse(json({ path: "io.github.ainsep.openmarketing/evidence/primary-sources.json" }));
  expect(evidence.sources.every(source => ["developers.kakao.com", "devtalk.kakao.com"].includes(new URL(source.url).hostname))).toBe(true);
});

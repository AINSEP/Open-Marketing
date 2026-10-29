import { readFile as readCapabilityFile } from "node:fs/promises";
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
  const extension = z.object({ version: z.literal(1), enabled: z.literal(false), admitted: z.literal(false), capabilities: z.array(cap).length(3) });
  const manifest = z.object({ name: z.literal("kakao-ads"), license: z.literal("Apache-2.0"), extensions: z.object({ "io.github.ainsep.openmarketing": extension }) }).parse(json({ path: "plugin.json" }));
  const declared = z.object({ admitted: z.literal(false), capabilities: z.array(cap), tools: z.array(z.object({ name: z.string(), effects: z.array(z.literal("read")), capabilityId: z.string() })) }).parse(json({ path: "io.github.ainsep.openmarketing/capabilities.json" }));
  expect(declared.capabilities).toEqual(manifest.extensions["io.github.ainsep.openmarketing"].capabilities);
  expect(declared.tools.map(tool => [tool.name, tool.effects])).toEqual(kakaoAdsTools.map(tool => [tool.name, [tool.effect]]));
  for (const capability of declared.capabilities) {
    expect(capability).toMatchObject({ pluginId: "kakao-ads", admitted: false, effects: ["read"] });
    const source = ["report.metrics.v1", "campaign.status.v1"].includes(capability.capabilityId) ? "capabilities.ts" : capability.capabilityId === "report.account-spend.v1" ? "reporting.ts" : "commands.ts";
    expect(capability.schemaFingerprint).toBe(createHash("sha256").update(read({ path: "io.github.ainsep.openmarketing/src/" + source })).digest("hex"));
  }
  expect(declared.tools.every(tool => declared.capabilities.some(capability => capability.capabilityId === tool.capabilityId))).toBe(true);
  expect(json({ path: "mcp.json" })).toEqual({ $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json", mcpServers: {} });
  expect(json({ path: "package.json" })).toMatchObject({ sideEffects: false, exports: { ".": { types: "./io.github.ainsep.openmarketing/src/index.ts", import: "./io.github.ainsep.openmarketing/dist/index.mjs" } } });
  const pkg = z.object({ dependencies: z.record(z.string(), z.string()) }).parse(json({ path: "package.json" }));
  expect(Object.keys(pkg.dependencies).sort()).toEqual(["@open-marketing/contracts", "zod"]);
  const evidence = z.object({ checkedAt: z.literal("2026-10-24"), sources: z.array(z.object({ url: z.url(), quote: z.string().min(1), fact: z.string() })).min(6), unverified: z.array(z.string()).min(4), blockedPages: z.array(z.string()) }).parse(json({ path: "io.github.ainsep.openmarketing/evidence/primary-sources.json" }));
  expect(evidence.sources.every(source => ["developers.kakao.com", "devtalk.kakao.com"].includes(new URL(source.url).hostname))).toBe(true);
});

it("declares canonical read capabilities without admitting or changing credentials", async () => {
  const root = new URL("../../", import.meta.url);
  const manifest = JSON.parse(await readCapabilityFile(new URL("plugin.json", root), "utf8"));
  const declaration = JSON.parse(await readCapabilityFile(new URL("io.github.ainsep.openmarketing/capabilities.json", root), "utf8"));
  const fingerprint = createHash("sha256").update(await readCapabilityFile(new URL("io.github.ainsep.openmarketing/src/capabilities.ts", root))).digest("hex");
  const capabilities = declaration.capabilities.filter((value: { capabilityId: string }) => ["report.metrics.v1", "campaign.status.v1"].includes(value.capabilityId));
  expect(capabilities.map((value: { capabilityId: string }) => value.capabilityId)).toEqual(["campaign.status.v1"]);
  for (const entry of capabilities) expect(entry).toMatchObject({ pluginId: "kakao-ads", admitted: false, effects: ["read"], schemaFingerprint: fingerprint });
  expect(manifest.extensions["io.github.ainsep.openmarketing"].capabilities).toEqual(declaration.capabilities);
  const evidence = JSON.parse(await readCapabilityFile(new URL("io.github.ainsep.openmarketing/evidence/primary-sources.json", root), "utf8"));
  expect(evidence.canonicalReadReview).toMatchObject({ checkedAt: "2026-10-26", liveVendorCalls: false });
});

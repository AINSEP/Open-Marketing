import { readFile as readCapabilityFile } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { vkAdsTools } from "../src/index.js";

describe("VK read package", () => {
  it("advertises only verified account/campaign reads while all admission remains false", async () => {
    const root = new URL("../../", import.meta.url);
    const manifest = JSON.parse(await readFile(new URL("plugin.json", root), "utf8"));
    const capabilities = JSON.parse(await readFile(new URL("io.github.ainsep.openmarketing/capabilities.json", root), "utf8"));
    expect(manifest.extensions["io.github.ainsep.openmarketing"]).toEqual({ version: 1, enabled: false, admitted: false, capabilities: capabilities.capabilities, credentialCards: expect.any(Array), credentialAssets: expect.any(Object) });
    expect(capabilities.admitted).toBe(false);
    expect(capabilities.tools.map((tool: { name: string }) => tool.name)).toEqual(["list_accounts", "list_campaigns"]);
    expect(vkAdsTools.map(tool => [tool.name, tool.effect])).toEqual([["list_accounts", "read"], ["list_campaigns", "read"]]);
    const fingerprint = createHash("sha256").update(await readFile(new URL("io.github.ainsep.openmarketing/src/commands.ts", root))).digest("hex");
    expect(capabilities.capabilities).toHaveLength(1);
    for (const declaration of capabilities.capabilities) {

      expect(declaration).toMatchObject({ admitted: false, effects: ["read"], schemaFingerprint: fingerprint });
    }
    expect(JSON.parse(await readFile(new URL("mcp.json", root), "utf8")).mcpServers).toEqual({});
    const pkg = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
    expect(Object.keys(pkg.exports)).toEqual(["."]);
    expect(pkg.sideEffects).toBe(false);
  });
  it("labels source provenance and unresolved facts instead of treating fixtures as evidence", async () => {
    const evidence = JSON.parse(await readFile(new URL("../evidence/primary-sources.json", import.meta.url), "utf8"));
    expect(evidence.checkedAt).toBe("2026-10-24");
    expect(evidence.provenance).toContain("evidence-chrome.md");
    expect(evidence.unverified).toContain("statistics campaign mapping, monetary units/currency and timezone remain unavailable");
    expect(evidence.sources).toHaveLength(5);
    for (const source of evidence.sources) {
      expect(source.url).toMatch(/^https:\/\/ads\.vk\.ru\/en\/doc\/api\//);
      expect(source.quote).toBeTruthy();
    }
    expect(evidence.sources[4].unverified).toContain("spent currency/units");
    expect(evidence.sources[4].unverified).toContain("users/summary response envelope (items[].total.base)");
  });
});

it("omits unimplemented canonical declarations and the empty factory", async () => {
  const root = new URL("../../", import.meta.url);
  const manifest = JSON.parse(await readCapabilityFile(new URL("plugin.json", root), "utf8"));
  const declaration = JSON.parse(await readCapabilityFile(new URL("io.github.ainsep.openmarketing/capabilities.json", root), "utf8"));
  expect(declaration.capabilities.some((value: { capabilityId: string }) => ["report.metrics.v1", "campaign.status.v1"].includes(value.capabilityId))).toBe(false);
  expect(manifest.extensions["io.github.ainsep.openmarketing"].capabilities).toEqual(declaration.capabilities);
  expect(await import("../src/index.js")).not.toHaveProperty("createCapabilities");
});

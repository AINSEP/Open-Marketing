import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { vkAdsTools } from "../src/index.js";

describe("VK held package", () => {
  it("advertises no operations, MCP processes, OAuth or admitted capabilities", async () => {
    const root = new URL("../../", import.meta.url);
    const manifest = JSON.parse(await readFile(new URL("plugin.json", root), "utf8"));
    const capabilities = JSON.parse(await readFile(new URL("io.github.ainsep.openmarketing/capabilities.json", root), "utf8"));
    expect(manifest.extensions["io.github.ainsep.openmarketing"]).toEqual({ version: 1, enabled: false, admitted: false, capabilities: [] });
    expect(capabilities).toEqual({ version: 1, admitted: false, capabilities: [], tools: [] });
    expect(vkAdsTools).toEqual([]);
    expect(JSON.parse(await readFile(new URL("mcp.json", root), "utf8")).mcpServers).toEqual({});
    const pkg = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
    expect(Object.keys(pkg.exports)).toEqual(["."]);
    expect(pkg.sideEffects).toBe(false);
  });
  it("labels source provenance and unresolved facts instead of treating fixtures as evidence", async () => {
    const evidence = JSON.parse(await readFile(new URL("../evidence/primary-sources.json", import.meta.url), "utf8"));
    expect(evidence.checkedAt).toBe("2026-10-24");
    expect(evidence.provenance).toContain("evidence-chrome.md");
    expect(evidence.unverified).toContain("API origin in captured relative request examples");
    expect(evidence.sources).toHaveLength(5);
    for (const source of evidence.sources) {
      expect(source.url).toMatch(/^https:\/\/ads\.vk\.ru\/en\/doc\/api\//);
      expect(source.quote).toBeTruthy();
    }
    expect(evidence.sources[4].unverified).toContain("spent currency/units");
  });
});

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { capabilityEnvelopeSchema } from "@open-marketing/contracts";
import { redditAdsTools } from "../src/index.js";

const root = new URL("../../", import.meta.url);
/** Read installed-format artifacts, never generated copies or real credentials. */
function readJson(required: { path: string }) { return JSON.parse(readFileSync(new URL(required.path, root), "utf8")); }
describe("Reddit portable manifests", () => {
  it("ships disabled/unadmitted with only implemented read capabilities and an empty MCP map", () => {
    const manifest = readJson({ path: "plugin.json" }), extension = manifest.extensions["io.github.ainsep.openmarketing"];
    const metadata = readJson({ path: "io.github.ainsep.openmarketing/capabilities.json" });
    expect(manifest).toMatchObject({ $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "reddit-ads", version: "0.1.0", license: "Apache-2.0" });
    expect(extension).toMatchObject({ version: 1, enabled: false, admitted: false }); expect(metadata.admitted).toBe(false);
    expect(metadata.capabilities).toEqual(extension.capabilities);
    expect(extension.capabilities.map((cap: unknown) => capabilityEnvelopeSchema.omit({ pluginDigest: true }).parse(cap).capabilityId)).toEqual(["reddit_ads.list_businesses.v1", "report.account-spend.v1"]);
    for (const cap of extension.capabilities) {
      expect(cap).toMatchObject({ pluginId: "reddit-ads", admitted: false, effects: ["read"] });
      const source = cap.capabilityId === "report.account-spend.v1" ? "reporting.ts" : "commands.ts";
      expect(cap.schemaFingerprint).toBe(createHash("sha256").update(readFileSync(new URL("io.github.ainsep.openmarketing/src/" + source, root))).digest("hex"));
    }
    expect(metadata.tools.map((tool: { name: string; effects: string[] }) => [tool.name, tool.effects])).toEqual(redditAdsTools.map(tool => [tool.name, [tool.effect]]));
    expect(metadata.tools.filter((tool: { available?: boolean }) => tool.available === false).map((tool: { name: string }) => tool.name)).toEqual(["list_accounts", "list_campaigns"]);
    expect(readJson({ path: "mcp.json" })).toEqual({ $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json", mcpServers: {} });
  });
  it("retains required dependencies, one public entry and dated official evidence", () => {
    const pkg = readJson({ path: "package.json" });
    expect(pkg.sideEffects).toBe(false); expect(Object.keys(pkg.exports)).toEqual(["."]);
    expect(Object.keys(pkg.dependencies).sort()).toEqual(["@open-marketing/contracts", "zod"]);
    const evidence = readJson({ path: "io.github.ainsep.openmarketing/evidence/primary-sources.json" });
    expect(evidence.checkedAt).toBe("2026-10-24"); expect(evidence.blocked.length).toBeGreaterThan(0);
    expect(evidence.sources.every((source: { url: string; quote: string }) => ["ads-api.reddit.com", "github.com"].includes(new URL(source.url).hostname) && source.quote.length > 0)).toBe(true);
    expect(evidence.omBounds).toEqual({ requestBytes: 65536, responseBytes: 1048576, timeoutMs: 15000, maxPageSize: 100, maxWindowDays: 31, retries: 0 });
  });
});

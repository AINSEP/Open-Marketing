import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { capabilityEnvelopeSchema } from "@open-marketing/contracts";
import { xAdsTools } from "../src/index.js";

const root = new URL("../../", import.meta.url);
function readJson(required: { path: string }) { return JSON.parse(readFileSync(new URL(required.path, root), "utf8")) as unknown; }
const capability = capabilityEnvelopeSchema.omit({ pluginDigest: true });
describe("X portable R1 package", () => {
  it("defaults off, has no agent vendor MCP, and declares implemented reads only", () => {
    const manifest = z.object({ name: z.literal("x-ads"), extensions: z.object({ "io.github.ainsep.openmarketing": z.object({ enabled: z.literal(false), admitted: z.literal(false), capabilities: z.array(capability) }) }) }).parse(readJson({ path: "plugin.json" }));
    const declaration = z.object({ admitted: z.literal(false), capabilities: z.array(capability), tools: z.array(z.object({ name: z.string(), effects: z.array(z.literal("read")), capabilityId: z.string() })) }).parse(readJson({ path: "io.github.ainsep.openmarketing/capabilities.json" }));
    expect(readJson({ path: "mcp.json" })).toEqual({ $schema: "https://agent-plugins.org/schemas/1.1.0/mcp.schema.json", mcpServers: {} });
    expect(declaration.capabilities).toEqual(manifest.extensions["io.github.ainsep.openmarketing"].capabilities);
    expect(declaration.tools.map(tool => [tool.name, tool.effects])).toEqual(xAdsTools.map(tool => [tool.name, [tool.effect]]));
    expect(xAdsTools.map(tool => tool.name)).toEqual(["list_accounts", "list_campaigns", "report"]);
    for (const cap of declaration.capabilities) {
      expect(cap).toMatchObject({ pluginId: "x-ads", admitted: false, effects: ["read"] });
      const file = cap.capabilityId === "report.account-spend.v1" ? "reporting.ts" : "commands.ts";
      expect(cap.schemaFingerprint).toBe(createHash("sha256").update(readFileSync(new URL("io.github.ainsep.openmarketing/src/" + file, root))).digest("hex"));
    }
  });
  it("imports without fetching", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try { vi.resetModules(); await import("../src/index.js"); expect(fetchSpy).not.toHaveBeenCalled(); }
    finally { fetchSpy.mockRestore(); }
  });
});

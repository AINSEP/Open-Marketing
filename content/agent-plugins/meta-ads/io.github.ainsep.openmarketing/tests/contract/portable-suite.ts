import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Outcome } from "@open-marketing/contracts";
import { pluginDigest } from "../fixtures.js";

type Entry = { readonly path: string; readonly kind: "file" | "directory" | "symlink" | "hardlink"; readonly content?: string };
/** Composition injects @open-marketing/plugins.inspectPluginPackage through its PUBLIC entry.
 * This suite deliberately reuses the host validator rather than duplicating portable validation here.
 */
export interface PortableInspector { inspect(required: { package: { entries: readonly Entry[] }; digest: string }): Outcome<{ pluginId: string; extension: { namespace: string; capabilities: readonly { admitted: boolean }[] }; servers: Readonly<Record<string, unknown>>; diagnostics: readonly { code: string; path: string }[] }> }

/** Integrator suite entry; run in j09's harness with the actual public validator once host integration lands.
 * @example portableValidationSuite({ inspector: { inspect: inspectPluginPackage } })
 */
export function portableValidationSuite(required: { inspector: PortableInspector }): void {
  describe("Meta portable package on shared host validator", () => {
    const root = new URL("../../../", import.meta.url);
    const plugin = readFileSync(new URL("plugin.json", root), "utf8");
    const mcp = readFileSync(new URL("mcp.json", root), "utf8");
    const skill = readFileSync(new URL("skills/meta-ads/SKILL.md", root), "utf8");
    const entries: Entry[] = [{ path: "plugin.json", kind: "file", content: plugin }, { path: "mcp.json", kind: "file", content: mcp }, { path: "skills/meta-ads/SKILL.md", kind: "file", content: skill }];
    it("validates v1.1 and the exact OM namespace without granting admission", () => {
      const result = required.inspector.inspect({ package: { entries }, digest: pluginDigest });
      expect(result).toMatchObject({ ok: true, value: { pluginId: "meta-ads", extension: { namespace: "io.github.ainsep.openmarketing" }, servers: {}, diagnostics: [] } });
      if (result.ok) expect(result.value.extension.capabilities.every(capability => !capability.admitted)).toBe(true);
    });
    it("isolates unknown OM transport fields as an invalid server entry", () => {
      const unsafe = { $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json", mcpServers: { meta: { type: "streamable-http", url: "https://mcp.facebook.com/ads", authMode: "oauth", riskHints: ["read"] } } };
      const modified = entries.map(entry => entry.path === "mcp.json" ? { ...entry, content: JSON.stringify(unsafe) } : entry);
      const result = required.inspector.inspect({ package: { entries: modified }, digest: pluginDigest });
      expect(result.ok).toBe(true);
      if (result.ok) { expect(result.value.servers).toEqual({}); expect(result.value.diagnostics.length).toBeGreaterThan(0); }
    });
    it("rejects an unknown authority-bearing field in the OM extension", () => {
      const manifest = JSON.parse(plugin) as { extensions: Record<string, Record<string, unknown>> };
      manifest.extensions["io.github.ainsep.openmarketing"].alwaysAllowSpend = true;
      const modified = entries.map(entry => entry.path === "plugin.json" ? { ...entry, content: JSON.stringify(manifest) } : entry);
      expect(required.inspector.inspect({ package: { entries: modified }, digest: pluginDigest }).ok).toBe(false);
    });
  });
}

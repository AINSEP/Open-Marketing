import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { inspectPluginPackage } from "@open-marketing/plugins";
import { value } from "./fixtures.js";

const root = new URL("../../", import.meta.url);
const paths = ["plugin.json", "mcp.json", "NOTICE", "PROVENANCE.md", "LICENSE", "skills/higgsfield-media/SKILL.md",
  "skills/higgsfield-media/references/failure-modes.md", "skills/higgsfield-media/references/models-and-plan-gates.md",
  "io.github.ainsep.openmarketing/capabilities.json", "io.github.ainsep.openmarketing/status-capability.json",
  "io.github.ainsep.openmarketing/quote-capability.json", "io.github.ainsep.openmarketing/oauth-discovery.json"];
/** Real package bytes, inspected by the public host validator; not a duplicate spec validator. */
function packageFixture(required: { replace?: { path: string; content: string } } = {}) {
  return { entries: paths.map(path => ({ path, kind: "file" as const, content: required.replace?.path === path ? required.replace.content : readFileSync(new URL(path, root), "utf8") })) };
}

describe("portable package and OM namespace", () => {
  it("passes host v1.1 inspection, remains unadmitted and exports agent-safe guidance", () => {
    const inspected = value({ outcome: inspectPluginPackage({ package: packageFixture(), digest: "a".repeat(64) }) });
    expect(inspected.diagnostics).toEqual([]);
    expect(inspected.servers).toEqual({ higgsfield: { type: "streamable-http", url: "https://mcp.higgsfield.ai/mcp" } });
    expect(inspected.extension.capabilities.map(capability => capability.capabilityId).sort()).toEqual(["image-generation-quote.v1", "image-generation-status.v1", "image-generation.v1"]);
    expect(inspected.extension.capabilities.every(capability => capability.admitted === false)).toBe(true);
    expect(inspected.extension.capabilities.find(capability => capability.capabilityId === "image-generation.v1")?.effects).toEqual(["write", "generation"]);
    expect(JSON.stringify(inspected.agent)).not.toContain("mcp.higgsfield.ai");
    expect(JSON.stringify(inspected.agent)).not.toContain("oauth-discovery.json");
    expect(inspected.agent.skills[0].instructions).toContain("USD $10/day");
    expect(inspected.agent.skills[0].instructions).toContain("local timezone");
  });
  it("rejects OAuth fields in the closed server schema and policy fields in the OM namespace", () => {
    const mcp = JSON.parse(readFileSync(new URL("mcp.json", root), "utf8"));
    mcp.mcpServers.higgsfield.authMode = "oauth";
    const inspected = value({ outcome: inspectPluginPackage({ package: packageFixture({ replace: { path: "mcp.json", content: JSON.stringify(mcp) } }), digest: "a".repeat(64) }) });
    expect(inspected.servers).toEqual({});
    expect(inspected.diagnostics.length).toBeGreaterThan(0);
    const manifest = JSON.parse(readFileSync(new URL("plugin.json", root), "utf8"));
    manifest.extensions["io.github.ainsep.openmarketing"].confirmationPolicy = "always_allow";
    expect(inspectPluginPackage({ package: packageFixture({ replace: { path: "plugin.json", content: JSON.stringify(manifest) } }), digest: "a".repeat(64) })).toMatchObject({ ok: false });
  });
  it("retains copied-guidance attribution and marks pricing/OAuth fixtures as historical", () => {
    const notice = readFileSync(new URL("NOTICE", root), "utf8");
    const provenance = readFileSync(new URL("PROVENANCE.md", root), "utf8");
    expect(notice).toContain("Tovu");
    expect(provenance).toContain("96cdc66383ae3d8ea2791528f4e49f2e3102f11e");
    expect(provenance).toContain("No copied executable source");
    expect(JSON.parse(readFileSync(new URL("io.github.ainsep.openmarketing/oauth-discovery.json", root), "utf8"))).toMatchObject({ authMode: "oauth", pkce: "S256", verifiedCurrent: false });
  });
});

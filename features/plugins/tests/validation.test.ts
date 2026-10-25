import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { exportAgentPluginInstructions, inspectPluginPackage } from "../index.js";
import type { PluginPackage } from "../index.js";
import { capabilityFixture, descriptor, digest, packageFixture } from "./fixtures/plugin.js";

const mcpSchema = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";
const namespace = descriptor.namespace;

describe("portable v1.1 validation", () => {
  it("accepts metadata by JSON type and mixed separators, with no schema download", () => {
    const inspected = inspectPluginPackage({ digest, package: packageFixture({}, { manifest: {
      name: "a.-b", version: "release candidate", homepage: "documentation", repository: "repository",
      author: { name: "Owner", email: "contact", url: "homepage" }, license: "custom license", keywords: ["plugins"],
    } }) });
    expect(inspected).toMatchObject({ ok: true, value: { pluginId: "a.-b", version: "release candidate", extension: descriptor } });
  });

  it.each([
    { manifest: { name: "Bad" } }, { manifest: { name: "a--b" } }, { manifest: { name: "a..b" } },
    { manifest: { name: "" } }, { manifest: { author: "author" } }, { manifest: { author: { extra: true } } },
    { manifest: { description: 42 } }, { manifest: { keywords: "plugins" } },
    { manifest: { $schema: "https://example.com/plugin.schema.json" } },
  ])("rejects invalid core manifest $manifest", ({ manifest }) => {
    expect(inspectPluginPackage({ digest, package: packageFixture({}, { manifest }) })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });

  it("reports unknown fields/namespaces and invalid extension containers without interpreting them", () => {
    const unknown = inspectPluginPackage({ digest, package: packageFixture({}, { manifest: {
      commands: { unsafe: "execute" }, extensions: { "com.example.other": { enabled: true, spend: true } },
    } }) });
    expect(unknown).toMatchObject({ ok: true, value: { extension: descriptor, diagnostics: [
      { code: "ignored_manifest_field", path: "plugin.json:commands" },
      { code: "ignored_extension_namespace", path: "plugin.json:com.example.other" },
    ] } });
    const invalid = inspectPluginPackage({ digest, package: packageFixture({}, { manifest: { extensions: [] } }) });
    expect(invalid).toMatchObject({ ok: true, value: { extension: descriptor, diagnostics: [{ code: "ignored_invalid_extensions" }] } });
  });

  it.each([
    { extension: { version: 2 } }, { extension: { version: 1, writesAllowed: true } },
    { extension: { version: 1, servers: { missing: { authMode: "oauth" } } } },
    { extension: { version: 1, capabilities: [capabilityFixture({}), capabilityFixture({})] } },
    { extension: { version: 1, capabilities: [{ ...capabilityFixture({}), pluginId: "other" }] } },
  ])("rejects invalid OM extensions $extension", ({ extension }) => {
    expect(inspectPluginPackage({ digest, package: packageFixture({}, { manifest: { extensions: { [namespace]: extension } } }) })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });

  it("derives capability byte pins from the host and cannot inherit author admission", () => {
    const declaration = { ...capabilityFixture({}), pluginDigest: "f".repeat(64), admitted: true };
    const inspected = inspectPluginPackage({ digest, package: packageFixture({}, { manifest: { extensions: {
      [namespace]: { version: 1, enabled: true, admitted: true, capabilities: [declaration] },
    } } }) });
    expect(inspected).toMatchObject({ ok: true, value: { extension: { capabilities: [{ pluginDigest: digest, admitted: false, effects: ["read", "write", "ad_spend"] }] } } });
  });

  it("resolves bindings only inside OM's namespace and fingerprints binding bytes", () => {
    const capability = capabilityFixture({});
    const { pluginDigest: _pin, admitted: _authority, ...declaration } = capability;
    const content = JSON.stringify(declaration);
    const binding = `${namespace}/capabilities.json`;
    const plugin = packageFixture({}, { mcp: { $schema: mcpSchema, mcpServers: { demo: { type: "stdio", command: "node" } } },
      manifest: { extensions: { [namespace]: { version: 1, capabilities: { [capability.capabilityId]: { server: "demo", binding: `./${binding}` } } } } },
    });
    const inspected = inspectPluginPackage({ digest, package: { entries: [...plugin.entries, { path: binding, kind: "file", content }] } });
    expect(inspected).toMatchObject({ ok: true, value: { extension: { capabilities: [{
      ...capability, admitted: false, pluginDigest: digest, schemaFingerprint: createHash("sha256").update(content).digest("hex"),
    }] } } });
  });

  it.each([{ binding: "../escape.json" }, { binding: "./com.example.other/capabilities.json" }, { binding: `./${namespace}/missing.json` }])("rejects unsafe or missing binding $binding", ({ binding }) => {
    const plugin = packageFixture({}, { mcp: { $schema: mcpSchema, mcpServers: { demo: { type: "stdio", command: "node" } } },
      manifest: { extensions: { [namespace]: { version: 1, capabilities: { "image-generation.v1": { server: "demo", binding } } } } },
    });
    expect(inspectPluginPackage({ digest, package: plugin })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });

  it("isolates invalid server entries and keeps their valid sibling", () => {
    const inspected = inspectPluginPackage({ digest, package: packageFixture({}, { mcp: { $schema: mcpSchema, mcpServers: {
      valid: { type: "stdio", command: "node", args: ["../opaque-argument"], env: { MODE: "sandbox" }, cwd: "${PLUGIN_DATA}/cache" },
      unknownField: { type: "stdio", command: "node", authMode: "oauth" },
      reservedEnv: { type: "stdio", command: "node", env: { PLUGIN_ROOT: "/escape" } },
      credential: { type: "sse", url: "https://example.com/mcp", headers: { Authorization: "Bearer fixture" } },
      traversal: { type: "stdio", command: "./../escape" },
      headerInjection: { type: "sse", url: "https://example.com/mcp", headers: { "X-Fixture": "a\r\nb" } },
    } } }) });
    expect(inspected.ok).toBe(true);
    if (!inspected.ok) throw new Error("Expected valid manifest");
    expect(Object.keys(inspected.value.servers)).toEqual(["valid"]);
    expect(inspected.value.diagnostics).toHaveLength(5);
    expect(inspected.value.diagnostics.every(item => item.code === "invalid_server_entry")).toBe(true);
  });

  it.each([{ mcp: [] }, { mcp: { $schema: "unknown", mcpServers: {} } }, { mcp: { $schema: mcpSchema, mcpServers: [], extra: true } }])("invalid MCP roots disable only MCP", ({ mcp }) => {
    expect(inspectPluginPackage({ digest, package: packageFixture({}, { mcp, skills: true }) })).toMatchObject({ ok: true, value: {
      servers: {}, agent: { skills: [{ name: "demo" }] }, diagnostics: [{ code: "invalid_mcp_configuration" }],
    } });
  });

  it.each([
    { path: "../escape" }, { path: "/absolute" }, { path: "a/../../escape" }, { path: "C:\\escape" },
    { path: "%2e%2e/escape" }, { path: "a//escape" }, { path: "a/./escape" }, { path: "a\u0000b" },
  ])("rejects inventory escape $path", ({ path }) => {
    const plugin = packageFixture({});
    expect(inspectPluginPackage({ digest, package: { entries: [...plugin.entries, { path, kind: "file", content: "" }] } })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });

  it("rejects links, duplicate paths, missing content and excessive inventories", () => {
    const plugin = packageFixture({});
    const cases: PluginPackage[] = [
      { entries: [...plugin.entries, { path: "link", kind: "symlink" }] },
      { entries: [...plugin.entries, { path: "link", kind: "hardlink" }] },
      { entries: [...plugin.entries, ...plugin.entries] },
      { entries: [{ path: "plugin.json", kind: "file" }] },
      { entries: Array.from({ length: 4097 }, (_, index) => ({ path: `file-${index}`, kind: "file", content: "" })) },
    ];
    for (const invalid of cases) expect(inspectPluginPackage({ digest, package: invalid })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });

  it("reports wrong fixed component kinds without discarding the valid manifest", () => {
    const entries = [...packageFixture({}).entries, { path: "mcp.json", kind: "directory" as const }, { path: "skills", kind: "file" as const, content: "wrong kind" }];
    expect(inspectPluginPackage({ digest, package: { entries } })).toMatchObject({ ok: true, value: { servers: {}, agent: { skills: [] }, diagnostics: [
      { code: "invalid_mcp_configuration", path: "mcp.json" }, { code: "invalid_skills_directory", path: "skills" },
    ] } });
  });

  it("exports only safe instruction fields; invalid YAML and configuration-bearing skills are skipped", () => {
    const plugin = packageFixture({}, { skills: true, mcp: { $schema: mcpSchema, mcpServers: { remote: { type: "sse", url: "https://example.com/mcp" } } } });
    const entries: PluginPackage["entries"] = [...plugin.entries,
      { path: "skills/secret/SKILL.md", kind: "file", content: "---\nname: secret\ndescription: secret\n---\napi_key=fixture-secret" },
      { path: "skills/invalid/SKILL.md", kind: "file", content: "---\nname: invalid\nname: duplicate\ndescription: invalid\n---\nUse OM." },
      { path: "skills/config/SKILL.md", kind: "file", content: "---\nname: config\ndescription: config\n---\nmcpServers: remote" },
      { path: "skills/demo/nested/SKILL.md", kind: "file", content: "nested file is not a skill" },
    ];
    const inspected = inspectPluginPackage({ digest, package: { entries } });
    expect(inspected.ok).toBe(true);
    if (!inspected.ok) throw new Error("Expected valid manifest");
    const agent = exportAgentPluginInstructions({ inspection: inspected.value });
    expect(agent).toEqual({ pluginId: "demo", version: "1.2.3", skills: [{ name: "demo", description: "Demonstrate plugin instructions.", instructions: "Use the OM tools and honor server approvals." }] });
    expect(inspected.value.diagnostics.filter(item => item.code === "invalid_skill")).toHaveLength(3);
    expect(JSON.stringify(agent)).not.toMatch(/example\.com|mcpServers|fixture-secret/);
  });
});

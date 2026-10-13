import type { CallContext, CapabilityEnvelope } from "@open-marketing/contracts";
import type { InstalledPlugin, MemoryPluginPackage, PluginExtensionDescriptor, PluginPackage, PluginSource } from "../../index.js";

export const context: CallContext = { scope: { ownerId: "owner", workspaceId: "workspace" }, principal: { kind: "owner", ownerId: "owner" }, correlationId: "correlation", traceId: "trace", runId: "run" };
export const digest = "a".repeat(64);
export const source: PluginSource = { kind: "directory", location: "/fixtures/demo", expectedDigest: digest };
export const descriptor: PluginExtensionDescriptor = { namespace: "io.github.ainsep.openmarketing", version: 1, capabilities: [] };
export const plugin: InstalledPlugin = { pluginId: "demo", version: "1.2.3", digest, enabled: false, admitted: true };

/** Portable fixture is valid without OM extension or MCP; no production provider calls. */
export function packageFixture(_required: Record<string, never>, optional: { manifest?: Record<string, unknown>; mcp?: unknown; skills?: boolean } = {}): PluginPackage {
  const entries: PluginPackage["entries"][number][] = [{ path: "plugin.json", kind: "file", content: JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.1.0/plugin.schema.json", name: "demo", version: "1.2.3", ...optional.manifest }) }];
  if (optional.mcp !== undefined) entries.push({ path: "mcp.json", kind: "file", content: JSON.stringify(optional.mcp) });
  if (optional.skills) entries.push({ path: "skills/demo/SKILL.md", kind: "file", content: "---\nname: demo\ndescription: Demonstrate plugin instructions.\n---\nUse the OM tools and honor server approvals." });
  return { entries };
}
export function memoryFixture(_required: Record<string, never>, optional: { package?: PluginPackage; source?: PluginSource; trusted?: boolean; actualDigest?: string } = {}): MemoryPluginPackage {
  return { source: optional.source ?? source, actualDigest: optional.actualDigest ?? digest, package: optional.package ?? packageFixture({}), trusted: optional.trusted ?? true };
}
export function capabilityFixture(_required: Record<string, never>, optional: { schemaFingerprint?: string; admitted?: boolean } = {}): CapabilityEnvelope {
  return { capabilityId: "image-generation.v1", version: 1, pluginId: "demo", pluginDigest: digest, schemaFingerprint: optional.schemaFingerprint ?? "b".repeat(64), admitted: optional.admitted ?? true, effects: ["read", "write", "ad_spend"] };
}

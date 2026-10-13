import { z } from "zod";
import { digestSchema } from "@open-marketing/contracts";
import type { Outcome } from "@open-marketing/contracts";
import type { PluginPackage, PluginPackageInspection, PluginDiagnostic, PluginServer } from "./package-types.js";
import { manifestSchema, mcpSchema, OM_NAMESPACE, safePackagePath, serverSchema } from "./portable.js";
import { validateExtension } from "./extension.js";
import { inspectSkills } from "./skills.js";
import { failure, success } from "./results.js";

const entrySchema = z.strictObject({ path: z.string().max(4096), kind: z.enum(["file", "directory", "symlink", "hardlink"]), content: z.string().max(16 * 1024 * 1024).optional() });
const packageSchema = z.strictObject({ entries: z.array(entrySchema).max(4096) });
const knownManifestFields = new Set(["$schema", "name", "version", "description", "author", "homepage", "repository", "license", "keywords", "extensions"]);
type FileInventory = { files: Map<string, string>; seen: Set<string>; bytes: number };

/** Portable v1.1 inspection, with local schemas and explicit narrow failure boundaries.
 * Links/duplicate entries/escapes invalidate the package. Invalid MCP entries/skills are reported
 * individually; unknown extension namespaces are ignored. Invalid OM extension fails admission.
 * @example inspectPluginPackage({ package: { entries }, digest: verifiedDigest })
 * @complexity O(n+b) time/space, capped at 4096 entries, 16 MiB/file, 64 MiB total.
 */
export function inspectPluginPackage(required: { package: PluginPackage; digest: string }): Outcome<PluginPackageInspection> {
  if (!digestSchema.safeParse(required.digest).success) return failure({ code: "invalid_input", message: "Plugin digest pin is invalid" });
  const collected = collectFiles({ package: required.package });
  if (!collected.ok) return collected;
  const diagnostics: PluginDiagnostic[] = [];
  const manifest = readObject({ content: collected.value.get("plugin.json") });
  if (!manifest.ok) return manifest;
  const parsed = manifestSchema.safeParse(manifest.value);
  if (!parsed.success) return failure({ code: "invalid_input", message: "Invalid or unsupported portable plugin manifest" });
  reportUnknown({ value: manifest.value, diagnostics });
  const servers = inspectServers({ files: collected.value, diagnostics, exists: required.package.entries.some(entry => entry.path === "mcp.json") });
  const value = namespaceValue({ manifest: manifest.value, diagnostics });
  const extension = validateExtension({ value, pluginId: parsed.data.name, digest: required.digest, files: collected.value, servers: new Set(Object.keys(servers)) });
  if (!extension.ok) return extension;
  const version = parsed.data.version ?? "";
  const agent = { pluginId: parsed.data.name, version, skills: inspectSkills({ files: collected.value, diagnostics }) };
  return success({ value: { pluginId: parsed.data.name, version, extension: extension.value, servers, agent, diagnostics } });
}

/** Entry validation runs before JSON/YAML parsing. No links are followed. @complexity O(n+b) time/space. */
function collectFiles(required: { package: PluginPackage }): Outcome<ReadonlyMap<string, string>> {
  const parsed = packageSchema.safeParse(required.package);
  if (!parsed.success) return failure({ code: "invalid_input", message: "Invalid or oversized package inventory" });
  const inventory: FileInventory = { files: new Map(), seen: new Set(), bytes: 0 };
  for (const entry of parsed.data.entries) {
    const collected = collectEntry({ entry, inventory });
    if (!collected.ok) return collected;
  }
  return success({ value: inventory.files });
}

/** Local inventory mutation happens only after path checks; all files consume the byte budget.
 * @complexity O(b) time for content size, O(1) map/set operations plus content storage.
 */
function collectEntry(required: { entry: PluginPackage["entries"][number]; inventory: FileInventory }): Outcome<void> {
  const { entry, inventory } = required;
  if (unsafeEntry({ entry, seen: inventory.seen })) return failure({ code: "invalid_input", message: "Unsafe, linked or duplicate package entry" });
  inventory.seen.add(entry.path);
  if (entry.kind === "directory") return success({ value: undefined });
  if (entry.content === undefined) return failure({ code: "invalid_input", message: "Package file content is missing" });
  const bytes = Buffer.byteLength(entry.content);
  inventory.bytes += bytes;
  if (bytes > 16 * 1024 * 1024 || inventory.bytes > 64 * 1024 * 1024) return failure({ code: "limit_exceeded", message: "Package byte limit exceeded" });
  inventory.files.set(entry.path, entry.content);
  return success({ value: undefined });
}

/** JSON objects only; raw parse errors/content never leave the boundary. @complexity O(b). */
function unsafeEntry(required: { entry: PluginPackage["entries"][number]; seen: ReadonlySet<string> }): boolean {
  return !safePackagePath({ path: required.entry.path }) || required.seen.has(required.entry.path) || required.entry.kind === "symlink" || required.entry.kind === "hardlink";
}

function readObject(required: { content: string | undefined }): Outcome<Record<string, unknown>> {
  if (required.content === undefined) return failure({ code: "invalid_input", message: "Required package JSON file is missing" });
  try {
    const parsed = z.record(z.string(), z.unknown()).safeParse(JSON.parse(required.content));
    if (!parsed.success) return failure({ code: "invalid_input", message: "Package JSON must be an object" });
    return success({ value: parsed.data });
  } catch { return failure({ code: "invalid_input", message: "Package JSON is malformed" }); }
}

/** v1.1 unknown manifest fields are inert; report their names only. @complexity O(n). */
function reportUnknown(required: { value: Record<string, unknown>; diagnostics: PluginDiagnostic[] }): void {
  for (const key of Object.keys(required.value)) {
    if (!knownManifestFields.has(key)) required.diagnostics.push({ code: "ignored_manifest_field", path: `plugin.json:${key.slice(0,256)}` });
  }
}

/** Unknown namespaces are ignored without interpreting their values. @complexity O(n). */
function namespaceValue(required: { manifest: Record<string, unknown>; diagnostics: PluginDiagnostic[] }): unknown {
  const extensions = required.manifest.extensions;
  if (extensions === undefined) return undefined;
  const parsed = z.record(z.string(), z.unknown()).safeParse(extensions);
  if (!parsed.success) {
    required.diagnostics.push({ code: "ignored_invalid_extensions", path: "plugin.json:extensions" });
    return undefined;
  }
  for (const namespace of Object.keys(parsed.data)) {
    if (namespace !== OM_NAMESPACE) required.diagnostics.push({ code: "ignored_extension_namespace", path: `plugin.json:${namespace.slice(0,256)}` });
  }
  return parsed.data[OM_NAMESPACE];
}

/** Malformed/unsupported MCP disables MCP; individual server failures don't discard valid peers. @complexity O(n+b). */
function inspectServers(required: { files: ReadonlyMap<string, string>; diagnostics: PluginDiagnostic[]; exists: boolean }): Record<string, PluginServer> {
  if (!required.exists) return {};
  const object = readObject({ content: required.files.get("mcp.json") });
  if (!object.ok) return invalidMcp(required);
  const parsed = mcpSchema.safeParse(object.value);
  if (!parsed.success || Object.keys(parsed.data.mcpServers).length > 128) return invalidMcp(required);
  const servers: Record<string, PluginServer> = Object.create(null);
  for (const [serverId, value] of Object.entries(parsed.data.mcpServers)) {
    const server = serverSchema.safeParse(value);
    if (server.success) servers[serverId] = server.data;
    else required.diagnostics.push({ code: "invalid_server_entry", path: `mcp.json:${serverId}` });
  }
  return servers;
}

function invalidMcp(required: { diagnostics: PluginDiagnostic[] }): Record<string, PluginServer> {
  required.diagnostics.push({ code: "invalid_mcp_configuration", path: "mcp.json" });
  return {};
}

/** Agent export reconstructs an allowlist; server configuration is never part of it. @complexity O(n+b). */
export function exportAgentPluginInstructions(required: { inspection: PluginPackageInspection }): PluginPackageInspection["agent"] {
  const agent = required.inspection.agent;
  return { pluginId: agent.pluginId, version: agent.version, skills: agent.skills.map(skill => ({ name: skill.name, description: skill.description, instructions: skill.instructions })) };
}

import { z } from "zod";
import type { PluginServer } from "./package-types.js";

/** Locally supported schema IDs; runtime loading never downloads schemas. */
export const PLUGIN_SCHEMA = "https://agent-plugins.org/schemas/1.1.0/plugin.schema.json";
export const MCP_SCHEMA = "https://agent-plugins.org/schemas/1.1.0/mcp.schema.json";
export const OM_NAMESPACE = "io.github.ainsep.openmarketing";
const text = z.string().max(65536);
/** Portable name allows mixed separators but excludes doubled same separators. */
export const pluginNameSchema = z.string().min(1).max(64).regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/)
  .refine(value => !value.includes("--") && !value.includes(".."));
/** Unknown manifest fields are stripped with diagnostics by inspection, per portable rules. */
export const manifestSchema = z.object({
  $schema: z.literal(PLUGIN_SCHEMA), name: pluginNameSchema, version: text.optional(), description: text.optional(),
  author: z.strictObject({ name: text.optional(), email: text.optional(), url: text.optional() }).optional(),
  homepage: text.optional(), repository: text.optional(), license: text.optional(), keywords: z.array(text).max(256).optional(),
});
/** Plugin-relative path allowlist also rejects Windows/encoded traversal. @complexity O(n) time, O(n) space. */
export function safePackagePath(required: { path: string }): boolean {
  const path = required.path;
  if (path.length === 0 || path.length > 4096) return false;
  if (/^[/]|[\\:%\u0000-\u001f]/.test(path)) return false;
  return path.split("/").every(segment => segment.length > 0 && segment !== "." && segment !== "..");
}

/** Single executable token; no shell interpolation. @complexity O(n). */
function commandAllowed(required: { command: string }): boolean {
  if (required.command.startsWith("./")) return safePackagePath({ path: required.command.slice(2) });
  return /^[a-zA-Z0-9_.+-]+$/.test(required.command);
}

/** Working directories stay under plugin/data roots; filesystem adapter checks symlinks. @complexity O(n). */
export function cwdAllowed(required: { cwd: string }): boolean {
  if (required.cwd === "${PLUGIN_ROOT}" || required.cwd === "${PLUGIN_DATA}" || required.cwd === "./") return true;
  const relative = required.cwd.replace(/^(?:\.\/|\$\{PLUGIN_ROOT\}\/|\$\{PLUGIN_DATA\}\/)/, "");
  if (relative === required.cwd) return false;
  return safePackagePath({ path: relative });
}

/** HTTPS remote endpoints, loopback-only HTTP, no credentials/fragment/placeholders. @complexity O(n). */
function endpointAllowed(required: { url: string }): boolean {
  try {
    const url = new URL(required.url);
    if (url.username || url.password || url.hash || required.url.includes("${")) return false;
    if (url.protocol === "https:") return true;
    if (url.protocol !== "http:") return false;
    return url.hostname === "localhost" || url.hostname === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(url.hostname);
  } catch { return false; }
}

/** Fixed config is visible package data; credentials and reserved env entries are invalid. @complexity O(n). */
function environmentAllowed(required: { env: Record<string, string> }): boolean {
  return Object.keys(required.env).every(key => !/^(PLUGIN_ROOT|PLUGIN_DATA)$/i.test(key) && !/(secret|password|token|api.?key|credential)/i.test(key));
}

/** Header names are case-insensitive, unique tokens; authorization is host-owned. @complexity O(n). */
function headersAllowed(required: { headers: Record<string, string> }): boolean {
  const seen = new Set<string>();
  return Object.entries(required.headers).every(([name, value]) => {
    const lower = name.toLowerCase();
    if (seen.has(lower) || !/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(lower)) return false;
    if (/[^\t\x20-\x7e\x80-\xff]/.test(value) || /(authorization|cookie|token|api.?key|secret)/i.test(lower)) return false;
    seen.add(lower);
    return true;
  });
}

const dictionary = z.record(z.string().max(256), z.string().max(8192));
const stdioSchema = z.strictObject({
  type: z.literal("stdio"), command: z.string().min(1).max(4096).refine(command => commandAllowed({ command })),
  args: z.array(z.string().max(8192)).max(128).optional(),
  env: dictionary.refine(env => environmentAllowed({ env })).optional(),
  cwd: z.string().max(4096).refine(cwd => cwdAllowed({ cwd })).optional(),
});
const remoteSchema = z.strictObject({
  type: z.enum(["streamable-http", "sse"]), url: z.string().max(8192).refine(url => endpointAllowed({ url })),
  headers: dictionary.refine(headers => headersAllowed({ headers })).optional(),
});
export const serverSchema: z.ZodType<PluginServer> = z.union([stdioSchema, remoteSchema]);
/** Top-level config errors disable MCP only; callers report server failures individually. */
export const mcpSchema = z.strictObject({ $schema: z.literal(MCP_SCHEMA), mcpServers: z.record(z.string().min(1).max(256), z.unknown()) });

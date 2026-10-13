import path from "node:path";
import type { CallOptions, Outcome } from "@open-marketing/contracts";
import { parseBoundary } from "@open-marketing/contracts";
import type { AgentPluginLayoutPort } from "./ports.js";
import type { PluginPackage, PluginPackageEntry, PluginPackageInspection } from "./package-types.js";
import { inspectPluginPackage } from "./validation.js";
import { sourceSchema } from "./schemas.js";
import { attempt, failure, success } from "./results.js";
import { safePackagePath } from "./portable.js";

/** Injected filesystem preserves bounded reads and uses non-following file handles.
 * Host wrappers around node:fs enforce maxBytes/maxEntries during reads, not after allocation.
 */
export type PluginFilesystem = {
  realpath(required: { path: string }): Promise<string>;
  lstat(required: { path: string }): Promise<{ kind: "file" | "directory" | "symlink" | "other"; size: number }>;
  readdir(required: { path: string; maxEntries: number }): Promise<readonly string[]>;
  readFile(required: { path: string; maxBytes: number }): Promise<Uint8Array>;
};
type Directory = { absolute: string; relative: string; depth: number };
type Walk = { entries: PluginPackageEntry[]; pending: Directory[]; bytes: number };

/** Real filesystem adapter; absolute source directory must remain under the configured root.
 * Archive preview is injected from Jini's safe reader; this feature never writes/extracts archives.
 * @example createFilesystemAgentPluginLayout({ filesystem, allowedRoot })
 * @complexity O(n+b) time/space; 4096 entries, depth 32, 16 MiB/file, 64 MiB total.
 */
export function createFilesystemAgentPluginLayout(required: {
  filesystem: PluginFilesystem; allowedRoot: string;
  readArchive?: (required: { source: import("./types.js").PluginSource }, optional?: CallOptions) => Promise<Outcome<PluginPackage>>;
}): AgentPluginLayoutPort & {
  inspect(required: { source: import("./types.js").PluginSource }, optional?: CallOptions): Promise<Outcome<PluginPackageInspection>>;
} {
  /** Source snapshots must be immutable for the full validate/trust/install operation. @complexity O(n+b). */
  async function inspect(input: { source: import("./types.js").PluginSource }, options?: CallOptions): Promise<Outcome<PluginPackageInspection>> {
    const source = parseBoundary({ schema: sourceSchema, input: input.source });
    if (!source.ok) return source;
    if (options?.signal?.aborted) return failure({ code: "cancelled", message: "Plugin inspection cancelled" });
    return attempt({ run: async () => {
      if (source.value.kind === "archive") {
        if (!required.readArchive) return failure({ code: "unavailable", message: "Jini archive preview adapter is required" });
        const loaded = await required.readArchive({ source: source.value }, options);
        if (!loaded.ok) return loaded;
        return inspectPluginPackage({ package: loaded.value, digest: source.value.expectedDigest });
      }
      const loaded = await readDirectory({ filesystem: required.filesystem, allowedRoot: required.allowedRoot, location: source.value.location }, options);
      if (!loaded.ok) return loaded;
      return inspectPluginPackage({ package: loaded.value, digest: source.value.expectedDigest });
    } });
  }
  return { inspect, async validate(input, options) {
    const result = await inspect(input, options);
    if (!result.ok) return result;
    return success({ value: result.value.extension });
  } };
}

/** realpath containment is checked for every entry, before bounded reads. @complexity O(n+b). */
async function readDirectory(required: { filesystem: PluginFilesystem; allowedRoot: string; location: string }, options?: CallOptions): Promise<Outcome<PluginPackage>> {
  if (!path.isAbsolute(required.location) || !path.isAbsolute(required.allowedRoot)) return failure({ code: "invalid_input", message: "Plugin directory roots must be absolute" });
  const allowedRoot = await required.filesystem.realpath({ path: required.allowedRoot });
  const root = await required.filesystem.realpath({ path: required.location });
  if (!contained({ root: allowedRoot, candidate: root })) return failure({ code: "forbidden", message: "Plugin source escapes the allowed root" });
  const walk: Walk = { entries: [], pending: [{ absolute: root, relative: "", depth: 0 }], bytes: 0 };
  while (walk.pending.length) {
    const read = await readChildren({ filesystem: required.filesystem, root, walk, directory: walk.pending.pop()! }, options);
    if (!read.ok) return read;
  }
  return success({ value: { entries: walk.entries } });
}

/** Bounded directory batch; mutates only the operation's local inventory. @complexity O(n+b).
 * Filesystem calls are sequential per entry so byte/entry budgets are enforced before the next read.
 */
async function readChildren(required: { filesystem: PluginFilesystem; root: string; walk: Walk; directory: Directory }, options?: CallOptions): Promise<Outcome<void>> {
  if (required.directory.depth > 32) return failure({ code: "limit_exceeded", message: "Plugin directory nesting limit exceeded" });
  if (options?.signal?.aborted) return failure({ code: "cancelled", message: "Plugin inspection cancelled" });
  const names = await required.filesystem.readdir({ path: required.directory.absolute, maxEntries: 4096 - required.walk.entries.length });
  for (const name of names) {
    const entry = await readEntry({ ...required, name, count: required.walk.entries.length }, options);
    if (!entry.ok) return entry;
    required.walk.entries.push(entry.value.entry);
    required.walk.bytes += entry.value.bytes;
    if (required.walk.bytes > 64 * 1024 * 1024) return failure({ code: "limit_exceeded", message: "Plugin directory byte limit exceeded" });
    if (entry.value.entry.kind === "directory") required.walk.pending.push({ absolute: entry.value.absolute, relative: entry.value.entry.path, depth: required.directory.depth + 1 });
  }
  return success({ value: undefined });
}

/** Reject links/unsupported kinds before reading; lexical and disk containment both apply. @complexity O(b). */
async function readEntry(required: {
  filesystem: PluginFilesystem; root: string; directory: { absolute: string; relative: string }; name: string; count: number;
}, options?: CallOptions): Promise<Outcome<{ entry: PluginPackageEntry; bytes: number; absolute: string }>> {
  if (options?.signal?.aborted) return failure({ code: "cancelled", message: "Plugin inspection cancelled" });
  if (required.count >= 4096) return failure({ code: "limit_exceeded", message: "Plugin entry limit exceeded" });
  if (!safePackagePath({ path: required.name }) || required.name.includes("/")) return failure({ code: "invalid_input", message: "Unsafe filesystem entry name" });
  const relative = [required.directory.relative, required.name].filter(Boolean).join("/");
  const absolute = path.join(required.directory.absolute, required.name);
  const stat = await required.filesystem.lstat({ path: absolute });
  if (stat.kind === "symlink" || stat.kind === "other") return failure({ code: "invalid_input", message: "Plugin links and special files are rejected" });
  const real = await required.filesystem.realpath({ path: absolute });
  if (!contained({ root: required.root, candidate: real })) return failure({ code: "forbidden", message: "Filesystem entry escapes plugin root" });
  if (stat.kind === "directory") return success({ value: { entry: { path: relative, kind: "directory" }, bytes: 0, absolute } });
  return readRegularFile({ filesystem: required.filesystem, stat, relative, absolute });
}

/** Refuse oversized/invalid metadata and recheck observed bytes after the bounded, non-following read.
 * @complexity O(b) time/space for b <=16 MiB.
 */
async function readRegularFile(required: { filesystem: PluginFilesystem; stat: { size: number }; relative: string; absolute: string }): Promise<Outcome<{ entry: PluginPackageEntry; bytes: number; absolute: string }>> {
  if (!Number.isSafeInteger(required.stat.size) || required.stat.size < 0 || required.stat.size > 16 * 1024 * 1024) return failure({ code: "limit_exceeded", message: "Plugin file size is invalid or oversized" });
  const bytes = await required.filesystem.readFile({ path: required.absolute, maxBytes: 16 * 1024 * 1024 });
  if (bytes.byteLength > 16 * 1024 * 1024) return failure({ code: "limit_exceeded", message: "Plugin file grew beyond limit" });
  return success({ value: { entry: { path: required.relative, kind: "file", content: Buffer.from(bytes).toString("utf8") }, bytes: bytes.byteLength, absolute: required.absolute } });
}

/** Path.relative avoids sibling-prefix and Windows-volume mistakes. @complexity O(n). */
function contained(required: { root: string; candidate: string }): boolean {
  const relative = path.relative(required.root, required.candidate);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

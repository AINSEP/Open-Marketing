import { createHash } from "node:crypto";
import type { AgentPluginArchiveEntry, AgentPluginArchiveReaderPort } from "@jini-ai/agent-plugins/lifecycle";
import { parseBoundary } from "@open-marketing/contracts";
import type { CallOptions, Outcome } from "@open-marketing/contracts";
import type { PluginPackage, PluginPackageEntry } from "./package-types.js";
import type { PluginSource } from "./types.js";
import { sourceSchema } from "./schemas.js";
import { safePackagePath } from "./portable.js";
import { attempt, failure, success } from "./results.js";

const ARCHIVE_BYTES = 32 * 1024 * 1024;
const FILE_BYTES = 16 * 1024 * 1024;
const PACKAGE_BYTES = 64 * 1024 * 1024;
type Inventory = { entries: PluginPackageEntry[]; seen: Set<string>; bytes: number };

/** Projects Jini's public streaming archive reader into the OM inspection boundary.
 * Verifies a copied archive before opening entries; never extracts or executes anything.
 * readArchive must bound allocation during reads; the reader must bound decompression buffers
 * and await durations. The host supplies cancellation/deadlines through CallOptions.
 * @returns Typed digest, path, link, cancellation and resource failures; opaque errors are redacted.
 * @example createJiniArchivePackageReader({ archiveReader, readArchive })
 * @complexity O(n+b) time/space: <=4096 entries, 32 MiB archive, 16 MiB/file, 64 MiB package.
 */
export function createJiniArchivePackageReader(required: {
  archiveReader: AgentPluginArchiveReaderPort;
  readArchive(required: { location: string; maxBytes: number }, optional?: CallOptions): Promise<Uint8Array>;
}): (required: { source: PluginSource }, optional?: CallOptions) => Promise<Outcome<PluginPackage>> {
  return async (input, options) => {
    const parsed = parseBoundary({ schema: sourceSchema, input: input.source });
    if (!parsed.ok) return parsed;
    if (parsed.value.kind !== "archive") return failure({ code: "invalid_input", message: "Archive reader requires an archive source" });
    if (options?.signal?.aborted) return failure({ code: "cancelled", message: "Archive inspection cancelled" });
    return attempt({ run: async () => {
      const bytes = await required.readArchive({ location: parsed.value.location, maxBytes: ARCHIVE_BYTES }, options);
      if (bytes.byteLength > ARCHIVE_BYTES) return failure({ code: "limit_exceeded", message: "Plugin archive exceeds 32 MiB" });
      if (options?.signal?.aborted) return failure({ code: "cancelled", message: "Archive inspection cancelled" });
      const archive = Uint8Array.from(bytes);
      if (createHash("sha256").update(archive).digest("hex") !== parsed.value.expectedDigest) return failure({ code: "forbidden", message: "Plugin archive digest mismatch" });
      return collectArchive({ archive, archiveReader: required.archiveReader }, options);
    } });
  };
}

/** One bounded inventory pass; links and duplicate normalized paths fail before their streams open.
 * @complexity O(n+b) time/space within the published reader's streaming ABI.
 */
async function collectArchive(required: { archive: Uint8Array; archiveReader: AgentPluginArchiveReaderPort }, options?: CallOptions): Promise<Outcome<PluginPackage>> {
  const inventory: Inventory = { entries: [], seen: new Set(), bytes: 0 };
  for await (const entry of required.archiveReader.entries({ archive: required.archive })) {
    if (options?.signal?.aborted) return failure({ code: "cancelled", message: "Archive inspection cancelled" });
    if (inventory.entries.length >= 4096) return failure({ code: "limit_exceeded", message: "Plugin entry limit exceeded" });
    const collected = await collectEntry({ entry, inventory }, options);
    if (!collected.ok) return collected;
    inventory.entries.push(collected.value);
  }
  return success({ value: { entries: inventory.entries } });
}

/** Directory archive suffixes are canonicalized once; every other path must already be relative.
 * Shared size accounting includes all files, even ignored components. @complexity O(b) time/space.
 */
async function collectEntry(required: { entry: AgentPluginArchiveEntry; inventory: Inventory }, options?: CallOptions): Promise<Outcome<PluginPackageEntry>> {
  const entry = required.entry;
  const path = entry.kind === "directory" ? entry.entryPath.replace(/\/$/, "") : entry.entryPath;
  if (!safePackagePath({ path }) || required.inventory.seen.has(path)) return failure({ code: "invalid_input", message: "Unsafe or duplicate archive path" });
  required.inventory.seen.add(path);
  if (entry.kind === "directory") return success({ value: { path, kind: "directory" } });
  if (entry.kind !== "file") return failure({ code: "invalid_input", message: "Archive links and special files are rejected" });
  if (entry.declaredSize !== undefined && (!Number.isSafeInteger(entry.declaredSize) || entry.declaredSize < 0 || entry.declaredSize > FILE_BYTES)) {
    return failure({ code: "limit_exceeded", message: "Invalid or oversized archive file" });
  }
  const content = await readContent({ entry, inventory: required.inventory }, options);
  if (!content.ok) return content;
  return success({ value: { path, kind: "file", content: content.value } });
}

/** Count observed bytes before copying chunks; dishonest declared sizes cannot expand the budget.
 * Reader buffers are host-owned. @complexity O(b) time/space, b <=16 MiB/file and <=64 MiB/package.
 */
async function readContent(required: { entry: Extract<AgentPluginArchiveEntry, { kind: "file" }>; inventory: Inventory }, options?: CallOptions): Promise<Outcome<string>> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  let count = 0;
  for await (const chunk of required.entry.openReadStream({})) {
    if (options?.signal?.aborted) return failure({ code: "cancelled", message: "Archive inspection cancelled" });
    const accepted = checkChunk({ chunk, count: ++count });
    if (!accepted.ok) return accepted;
    size += chunk.byteLength;
    required.inventory.bytes += chunk.byteLength;
    if (size > FILE_BYTES || required.inventory.bytes > PACKAGE_BYTES) return failure({ code: "limit_exceeded", message: "Expanded plugin byte limit exceeded" });
    chunks.push(Uint8Array.from(chunk));
  }
  return success({ value: Buffer.concat(chunks, size).toString("utf8") });
}

/** Cap stream bookkeeping even for empty/tiny chunks; no file effects. @complexity O(1). */
function checkChunk(required: { chunk: unknown; count: number }): Outcome<void> {
  if (!(required.chunk instanceof Uint8Array)) return failure({ code: "invalid_input", message: "Invalid archive stream chunk" });
  if (required.count > 65536) return failure({ code: "limit_exceeded", message: "Archive file chunk limit exceeded" });
  return success({ value: undefined });
}

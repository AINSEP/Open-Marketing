import { constants } from "node:fs";
import { mkdtemp, mkdir, open, readdir, lstat, realpath, readFile, writeFile, rename, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll } from "vitest";
import type { PluginFilesystem, PluginPackage } from "../../index.js";
const temporaryRoots: string[] = [];
afterAll(async () => { await Promise.all(temporaryRoots.map(root => rm(root, { recursive: true, force: true }))); });

/** Native fs is constructed in test composition only; production receives this shape by injection. */
export function nativeFilesystem(_required: Record<string, never>): PluginFilesystem {
  return {
    realpath: async input => realpath(input.path),
    async lstat(input) {
      const stat = await lstat(input.path);
      return { kind: classify({ stat }), size: stat.size };
    },
    async readdir(input) {
      const entries = await readdir(input.path);
      if (entries.length > input.maxEntries) throw new RangeError("directory entry limit");
      return entries;
    },
    readFile: boundedRead,
  };
}
function classify(required: { stat: Awaited<ReturnType<typeof lstat>> }): "file" | "directory" | "symlink" | "other" {
  if (required.stat.isSymbolicLink()) return "symlink";
  if (required.stat.isFile()) return "file";
  if (required.stat.isDirectory()) return "directory";
  return "other";
}
async function boundedRead(required: { path: string; maxBytes: number }): Promise<Uint8Array> {
  const handle = await open(required.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const bytes = Buffer.alloc(required.maxBytes + 1);
  let offset = 0;
  try {
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, null);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    if (offset > required.maxBytes) throw new RangeError("file byte limit");
    return bytes.subarray(0, offset);
  } finally { await handle.close(); }
}
export async function temporaryDirectory(_required: Record<string, never>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "om-plugins-"));
  temporaryRoots.push(root);
  return root;
}
export async function writePackage(required: { root: string; package: PluginPackage }): Promise<void> {
  for (const entry of required.package.entries) {
    const destination = path.join(required.root, entry.path);
    if (entry.kind === "directory") { await mkdir(destination, { recursive: true }); continue; }
    if (entry.kind !== "file") throw new Error("fixture helper writes regular files only");
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, entry.content ?? "");
  }
}
/** Opaque scope keys map to hashed filenames; write+rename provides single-record atomicity. */
export function atomicFiles(required: { root: string }) {
  function filename(input: { key: string }): string { return path.join(required.root, createHash("sha256").update(input.key).digest("hex") + ".json"); }
  return {
    async read(input: { key: string; maxBytes: number }): Promise<string | null> {
      try { return Buffer.from(await boundedRead({ path: filename(input), maxBytes: input.maxBytes })).toString("utf8"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    },
    async writeAtomic(input: { key: string; content: string }): Promise<void> {
      const file = filename(input);
      await writeFile(file + ".tmp", input.content, { mode: 0o600 });
      await rename(file + ".tmp", file);
    },
    async remove(input: { key: string }): Promise<void> { await rm(filename(input), { force: true }); },
  };
}
export { readFile, writeFile };

/** Read-only folder upload adapter; server/Jini owns package interpretation and installation. */
import { constants } from 'node:fs';
import type * as fs from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { addonUploadSchema } from '@open-marketing/contracts';
import type { AddonUpload } from '@open-marketing/contracts';
import type { AddonCliFiles } from './addons.js';

type Filesystem = Pick<typeof fs, 'lstat' | 'realpath' | 'opendir' | 'open'>;
type Scan = { directories: string[]; files: { path: string; base64: string }[]; entries: number; bytes: number };
const maxBytes = 33554432;

/** Bind native or temporary-fixture filesystem effects without reading at construction.
 * @example const addonFiles = createFolderReader({ fs });
 * @returns The existing CLI upload port; failures throw to its redacted typed boundary.
 * @complexity O(entries + bytes), <=8192 entries, <=4096 files, depth <=16, <=32 MiB.
 */
export function createFolderReader(required: { fs: Filesystem }): AddonCliFiles {
  return { readFolder: input => readFolder({ ...input, fs: required.fs }) };
}

/** Resolve one explicit local root, rejecting links and non-directories before scanning.
 * Abort/deadline rejects the entire upload; no partial files are submitted and no files are written.
 */
async function readFolder(required: { fs: Filesystem; path: string; signal: AbortSignal }): Promise<AddonUpload> {
  required.signal.throwIfAborted();
  const path = resolve(required.path);
  const stat = await required.fs.lstat(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Upload root must be a directory');
  const root = await required.fs.realpath(path);
  const scan: Scan = { directories: [''], files: [], entries: 0, bytes: 0 };
  for (let index = 0; index < scan.directories.length; index++) {
    await readDirectory({ ...required, root, relative: scan.directories[index], scan });
  }
  required.signal.throwIfAborted();
  return addonUploadSchema.parse({ kind: 'files', files: scan.files.toSorted((left, right) => left.path.localeCompare(right.path)) });
}

/** Iterate entries incrementally so huge/empty directory trees hit the same entry cap as files. */
async function readDirectory(required: { fs: Filesystem; root: string; relative: string; signal: AbortSignal; scan: Scan }): Promise<void> {
  required.signal.throwIfAborted();
  const path = join(required.root, required.relative);
  if (await required.fs.realpath(path) !== path) throw new Error('Upload directory link refused');
  const directory = await required.fs.opendir(path);
  for await (const entry of directory) {
    required.signal.throwIfAborted();
    required.scan.entries++;
    if (required.scan.entries > 8192) throw new RangeError('Upload entry cap');
    const relative = required.relative ? required.relative + '/' + entry.name : entry.name;
    await readEntry({ ...required, relative });
  }
}

/** Reject special files/links and bound both traversal depth and retained file count. */
async function readEntry(required: { fs: Filesystem; root: string; relative: string; signal: AbortSignal; scan: Scan }): Promise<void> {
  if (required.relative.split('/').length > 16) throw new RangeError('Upload depth cap');
  const path = join(required.root, required.relative);
  const stat = await required.fs.lstat(path);
  if (stat.isSymbolicLink()) throw new Error('Upload link refused');
  if (stat.isDirectory()) { required.scan.directories.push(required.relative); return; }
  if (!stat.isFile()) throw new Error('Upload special file refused');
  if (required.scan.files.length >= 4096) throw new RangeError('Upload file cap');
  const bytes = await readFile({ ...required, path });
  required.scan.bytes += bytes.byteLength;
  required.scan.files.push({ path: required.relative, base64: bytes.toString('base64') });
}

/** NOFOLLOW and bounded reads also reject a file replaced/grown after the directory scan.
 * @complexity O(file bytes), at most the remaining aggregate allowance plus one rejection byte.
 */
async function readFile(required: { fs: Filesystem; path: string; signal: AbortSignal; scan: Scan }): Promise<Buffer> {
  required.signal.throwIfAborted();
  const file = await required.fs.open(required.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maxBytes - required.scan.bytes) throw new RangeError('Upload byte cap or non-file');
    const chunks: Buffer[] = [];
    let size = 0;
    while (true) {
      required.signal.throwIfAborted();
      const buffer = Buffer.alloc(Math.min(65536, maxBytes - required.scan.bytes - size + 1));
      const read = await file.read(buffer, 0, buffer.byteLength, null);
      if (!read.bytesRead) return Buffer.concat(chunks, size);
      size += read.bytesRead;
      if (size + required.scan.bytes > maxBytes) throw new RangeError('Upload byte cap');
      chunks.push(buffer.subarray(0, read.bytesRead));
    }
  } finally { await file.close(); }
}

/** One bounded binary ingress for executable plugins, agent plugins and standalone skills. */
import { createHash } from 'node:crypto';
import { addonUploadSchema, parseBoundary } from '@open-marketing/contracts';
import type { AddonKind, AddonUpload, CallOptions, Outcome } from '@open-marketing/contracts';
import { validateSkillPath } from '@jini-ai/agentic/skills/install';
import type { ArchiveReaderPort } from '@jini-ai/agentic/skills/install';
import type { AgentPluginArchiveReaderPort } from '@jini-ai/agent-plugins/lifecycle';

export type AddonFiles = ReadonlyMap<string, Uint8Array>;
export type DecodedAddon = { kind: AddonKind; files: AddonFiles; revision: string };
const MAX_BYTES = 33554432;

/** Decode once, detect exactly one package root, and retain binary bytes unchanged.
 * The injected Jini reader owns ZIP parsing; this pass rejects duplicates, links and expansion bombs.
 * @example await decodeAddonUpload({ upload, archiveReader });
 * @complexity O(bytes + paths log paths), <=32 MiB expanded, <=4096 files, <=16 MiB/file.
 */
export async function decodeAddonUpload(required: { upload: AddonUpload; archiveReader: ArchiveReaderPort }, optional?: CallOptions): Promise<Outcome<DecodedAddon>> {
    const parsed = parseBoundary({ schema: addonUploadSchema, input: required.upload });
    if (!parsed.ok) return parsed;
    if (optional?.signal?.aborted) return uploadFailure({ code: 'cancelled' });
    try {
        const files = parsed.value.kind === 'files' ? decodeFiles({ upload: parsed.value })
            : await decodeArchive({ bytes: Buffer.from(parsed.value.base64, 'base64'), archiveReader: required.archiveReader }, optional);
        return detectAddonRoot({ files });
    } catch { return uploadFailure({ code: 'invalid_input' }); }
}

function decodeFiles(required: { upload: Extract<AddonUpload, { kind: 'files' }> }): Map<string, Uint8Array> {
    const files = new Map<string, Uint8Array>();
    for (const file of required.upload.files) appendFile({ files, path: file.path, bytes: Buffer.from(file.base64, 'base64') });
    return files;
}

/** Always close the ZIP, including early size/path refusals. Directory entries count toward the cap. */
async function decodeArchive(required: { bytes: Uint8Array; archiveReader: ArchiveReaderPort }, optional?: CallOptions): Promise<Map<string, Uint8Array>> {
    const archive = await required.archiveReader.open({ bytes: required.bytes });
    const files = new Map<string, Uint8Array>();
    let entries = 0;
    let total = 0;
    const seen = new Set<string>();
    try {
        for await (const entry of archive.entries) {
            if (++entries > 4096 || optional?.signal?.aborted) throw new RangeError('Archive refused');
            const path = entry.kind === 'directory' ? entry.path.replace(/\/$/, '') : entry.path;
            validateSkillPath({ filePath: path });
            if (seen.has(path) || entry.kind === 'other') throw new RangeError('Archive refused');
            seen.add(path);
            if (entry.kind === 'directory') continue;
            const bytes = await readEntry({ entry, remaining: MAX_BYTES - total }, optional);
            total += bytes.byteLength;
            appendFile({ files, path, bytes });
        }
        return files;
    } finally { archive.close({}); }
}

/** Observed bytes and chunk counts, rather than ZIP metadata, bound retained memory. */
async function readEntry(required: { entry: import('@jini-ai/agentic/skills/install').ArchiveEntry; remaining: number }, optional?: CallOptions): Promise<Buffer> {
    if (!Number.isSafeInteger(required.entry.size) || required.entry.size > Math.min(16777216, required.remaining)) throw new RangeError('Archive refused');
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of required.entry.read({})) {
        size += chunk.byteLength;
        if (size > Math.min(16777216, required.remaining) || chunks.length >= 65536 || optional?.signal?.aborted) throw new RangeError('Archive refused');
        chunks.push(Uint8Array.from(chunk));
    }
    if (size !== required.entry.size) throw new RangeError('Archive size mismatch');
    return Buffer.concat(chunks, size);
}

function appendFile(required: { files: Map<string, Uint8Array>; path: string; bytes: Uint8Array }): void {
    validateSkillPath({ filePath: required.path });
    if (required.files.has(required.path) || required.bytes.byteLength > 16777216) throw new RangeError('Upload refused');
    required.files.set(required.path, required.bytes);
}

/** A containing folder is accepted; nested skills inside an agent plugin are not separate roots.
 * Ambiguous executable/agent markers and unrelated sibling files are refused before publication.
 */
function detectAddonRoot(required: { files: Map<string, Uint8Array> }): Outcome<DecodedAddon> {
    const markers = [...required.files.keys()].filter(path => /(^|\/)(jini\.plugin\.json|plugin\.json)$/.test(path));
    const candidates = markers.length ? markers : [...required.files.keys()].filter(path => /(^|\/)SKILL\.md$/.test(path));
    if (candidates.length !== 1) return uploadFailure({ code: 'invalid_input' });
    const marker = candidates[0];
    const prefix = marker.slice(0, marker.lastIndexOf('/') + 1);
    if ([...required.files.keys()].some(path => !path.startsWith(prefix))) return uploadFailure({ code: 'invalid_input' });
    const files = new Map([...required.files].map(([path, bytes]) => [path.slice(prefix.length), bytes]));
    const kind = marker.endsWith('jini.plugin.json') ? 'plugin' : marker.endsWith('plugin.json') ? 'agent-plugin' : 'skill';
    const hash = createHash('sha256');
    for (const path of [...files.keys()].sort()) {
        hash.update(JSON.stringify([path, files.get(path)!.byteLength]));
        hash.update(files.get(path)!);
    }
    return { ok: true, value: { kind, files, revision: hash.digest('hex') } };
}

/** Narrow Jini archive ABI wrapper over already validated bytes; no second ZIP implementation.
 * Agentic's reader is used once for all formats; Jini agent install can iterate this snapshot twice.
 * @example const reader = addonAgentArchiveReader({ files });
 */
export function addonAgentArchiveReader(required: { files: AddonFiles }): AgentPluginArchiveReaderPort {
    return { async *entries() {
        for (const [entryPath, bytes] of required.files) yield { kind: 'file' as const, entryPath, declaredSize: bytes.byteLength,
            async *openReadStream() { yield bytes; } };
    } };
}

function uploadFailure(required: { code: 'invalid_input' | 'cancelled' }): Outcome<never> {
    return { ok: false, error: { code: required.code, message: 'Invalid or ambiguous add-on upload', retryable: false } };
}

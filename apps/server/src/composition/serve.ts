#!/usr/bin/env node
import { parseDocument } from 'yaml';
import { createNodeAddonEffects } from './addons.js';
import { createNodeFederationEffects } from './addon-federation-node.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
/** Explicit Node executable. Importing this module does not open files, databases or listeners. */
import Database from 'better-sqlite3';
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { ClockPort, ObserverPort, Outcome } from '@open-marketing/contracts';
import type { KeyringConfiguration } from '@open-marketing/credentials';
import { z } from 'zod';
import { bootServer, type BootedServer, type ServerBootIo } from './index.js';
import { localFailure, localStateRoot, readLocalFile, type LocalFilesystem } from './local-auth.js';
/** Load a verified snapshot URL's default export; import errors propagate and plugin cost is unbounded. */ export async function loadAddonModule(required: { moduleUrl: string }): Promise<unknown> { return (await import(required.moduleUrl)).default as unknown; }

/** Bind standard Node effects for boot and its real temporary-file integration test.
 * Paths are supplied by composition, independent of cwd; no resource is opened by this factory.
 * @example const io = createNodeBootIo({ projectRoot, studioRoot, ready });
 */
export function createNodeBootIo(required: { projectRoot: string; studioRoot: string; ready: ServerBootIo['ready'] }): ServerBootIo {
    return { ...required, fs, createServer, openSqlite: ({ path }) => new Database(path),
        randomToken: () => randomBytes(32).toString('hex'),
        addonEffects: input => createNodeAddonEffects({ ...input, loadModule: loadAddonModule }),
        addonYaml: { read: readAddonYaml },
        addonFederation: createNodeFederationEffects({ fetch, stdio: input => new StdioClientTransport(input) }),
        loadCredentialMaster: input => loadCredentialMaster({ ...input, fs, randomToken: () => randomBytes(32).toString('hex') }),
        schedule: ({ callback, delayMs }) => { const timer = setTimeout(callback, delayMs); return () => clearTimeout(timer); } };
}

/** Explicit host key loading: a configured 32-byte hex master or a private per-state-root key file.
 * A missing file is created exclusively with 0600; malformed/insecure existing files fail closed.
 * No key is read or provisioned before a credential operation. Keys/errors never reach logs.
 * @example await loadCredentialMaster({ configuration, fs, randomToken });
 * @complexity O(1), <=65 file bytes and at most one exclusive creation; no retained key cache.
 */
export async function loadCredentialMaster(required: {
    configuration: KeyringConfiguration; masterHex?: string; fs: LocalFilesystem;
    randomToken: (required: Record<string, never>) => string;
}): Promise<Outcome<Uint8Array>> {
    try {
        if (required.masterHex !== undefined) return parseMaster({ hex: required.masterHex });
        const existing = await readMasterIfPresent(required);
        if (existing) return existing;
        await createMaster(required);
        return await readMaster(required);
    } catch { return localFailure({ message: 'Credential encryption key unavailable or invalid' }); }
}

/** A missing key file yields undefined so the caller provisions one; other errors propagate. */
async function readMasterIfPresent(required: { fs: LocalFilesystem; configuration: KeyringConfiguration }): Promise<Outcome<Uint8Array> | undefined> {
    try { return await readMaster(required); }
    catch (error) {
        if (!z.object({ code: z.literal('ENOENT') }).safeParse(error).success) throw error;
        return undefined;
    }
}

/** Exact hex validation produces fixed-size key bytes; invalid material is never echoed. */
function parseMaster(required: { hex: string }): Outcome<Uint8Array> {
    const parsed = z.string().regex(/^[a-f0-9]{64}$/).safeParse(required.hex);
    if (!parsed.success) return localFailure({ code: 'invalid_input', message: 'Invalid credential encryption key' });
    return { ok: true, value: new Uint8Array(Buffer.from(parsed.data, 'hex')) };
}

/** Bound private-file read rejects symlinks/permissions without altering existing key material. */
async function readMaster(required: { fs: LocalFilesystem; configuration: KeyringConfiguration }): Promise<Outcome<Uint8Array>> {
    const bytes = await readLocalFile({ fs: required.fs, path: required.configuration.keyFilePath, maxBytes: 64, private: true });
    return parseMaster({ hex: bytes.toString('utf8') });
}

/** Concurrent provisioning keeps the winner's bytes; errors other than EEXIST propagate. */
async function createMaster(required: { fs: LocalFilesystem; configuration: KeyringConfiguration; randomToken: (required: Record<string, never>) => string }): Promise<void> {
    const hex = required.randomToken({});
    const parsed = parseMaster({ hex });
    if (!parsed.ok) throw new RangeError('Invalid injected key entropy');
    try {
        const file = await required.fs.open(required.configuration.keyFilePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { await file.chmod(0o600); await file.writeFile(hex, 'utf8'); }
        finally { await file.close(); }
    } catch (error) {
        if (!z.object({ code: z.literal('EEXIST') }).safeParse(error).success) throw error;
    }
}

/** Own process lifetime, installing signals before boot so shutdown during startup still cleans up.
 * Time/randomness/stdout/process access is limited to this executable composition boundary.
 */
async function main(): Promise<void> {
    const clock: ClockPort = { now: () => Date.now() };
    const ids = { next: () => randomUUID() };
    const observer: ObserverPort = { observe(event) { process.stderr.write(JSON.stringify({ timestamp: clock.now({}), service: 'om-server', ...event }) + '\n'); } };
    let stopping = false;
    let owned: BootedServer | undefined;
    /** Node signal ABI; duplicate signals share the idempotent resource stop. */
    async function stop(): Promise<void> {
        stopping = true;
        if (!owned) return;
        const result = await owned.stop({});
        if (!result.ok) { process.stderr.write(result.error.message + '\n'); process.exitCode = 1; }
        process.off('SIGTERM', onSignal);
        process.off('SIGINT', onSignal);
    }
    function onSignal() { void stop(); }
    process.on('SIGTERM', onSignal);
    process.on('SIGINT', onSignal);
    const io = createNodeBootIo({ projectRoot: fileURLToPath(new URL('../../../../', import.meta.url)),
        studioRoot: fileURLToPath(new URL('../../../studio/dist/', import.meta.url)), ready(value) {
            if (stopping) throw new Error('Startup cancelled');
            process.stdout.write('OM_READY ' + JSON.stringify(value) + '\n');
        } });
    const result = await bootServer({ env: { ...process.env, OM_STATE_ROOT: localStateRoot({ env: process.env, home: homedir() }),
        OM_TIMEZONE: process.env.OM_TIMEZONE ?? Intl.DateTimeFormat().resolvedOptions().timeZone }, io, clock, ids, observer });
    if (!result.ok) {
        process.off('SIGTERM', onSignal);
        process.off('SIGINT', onSignal);
        process.stderr.write(result.error.message + '\n');
        process.exitCode = 1;
        return;
    }
    owned = result.value;
    if (stopping) await stop();
}

// Node 24.2's entry-point flag also works through the package's symlinked om bin.
if (import.meta.main) {
    void main().catch(() => { process.stderr.write('Local server executable failed\n'); process.exitCode = 1; });
}

/** Safe bounded skill frontmatter parser. No custom tags, duplicate keys, or alias expansion.
 * @example readAddonYaml({ yaml: 'name: sample\ndescription: Sample skill' });
 * @throws On oversized/invalid YAML; the add-on boundary returns a redacted typed failure.
 * @complexity O(b) parsing, b<=64 KiB; aliases are refused during conversion.
 */
export function readAddonYaml(required: { yaml: string }): unknown {
    if (Buffer.byteLength(required.yaml, 'utf8') > 65536) throw new RangeError('Skill YAML exceeds 64 KiB');
    const document = parseDocument(required.yaml, { schema: 'core', uniqueKeys: true, strict: true, resolveKnownTags: false });
    if (document.errors.length || document.warnings.length) throw new Error('Invalid skill YAML');
    return document.toJS({ maxAliasCount: 0 }) as unknown;
}

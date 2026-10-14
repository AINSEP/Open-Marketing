#!/usr/bin/env node
/** Node binding for the existing HTTP-only owner CLI. Import is inert; no feature/DB access. */
import * as fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline/promises';
import type { Readable, Writable } from 'node:stream';
import type { Outcome } from '@open-marketing/contracts';
import { runOmCli, type CliRuntime } from '../cli/index.js';
import { terminalText } from '../cli/http.js';
import { createFolderReader } from '../cli/folder.js';
import { localFailure, localStateRoot, readLocalEndpoint, readLocalOwner, type LocalFilesystem } from './local-auth.js';

/** Prefer explicit configuration; otherwise discover the local server/token from the same root.
 * A local credential is never sent to a non-loopback configured origin without an explicit token.
 * @example await loadCliEnvironment({ env, fs, home });
 * @returns Configured owner-client env or a typed private-file/authority failure.
 * @complexity O(1), two files of at most 4096 bytes each; no network or database calls.
 */
export async function loadCliEnvironment(required: {
    env: Readonly<Record<string, string | undefined>>; fs: LocalFilesystem; home: string;
}): Promise<Outcome<Readonly<Record<string, string | undefined>>>> {
    const stateRoot = localStateRoot(required);
    let serverUrl = required.env.OM_SERVER_URL;
    if (!serverUrl) {
        const endpoint = await readLocalEndpoint({ fs: required.fs, stateRoot });
        if (!endpoint.ok) return endpoint;
        serverUrl = endpoint.value;
    }
    let token = required.env.OM_OWNER_TOKEN;
    if (!token) {
        try {
            const url = new URL(serverUrl);
            if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password) {
                return localFailure({ code: 'unauthenticated', message: 'An explicit OM_OWNER_TOKEN is required for a remote server' });
            }
        } catch { return localFailure({ code: 'invalid_input', message: 'Invalid OM_SERVER_URL' }); }
        const owner = await readLocalOwner({ fs: required.fs, stateRoot });
        if (!owner.ok) return owner;
        token = owner.value.token;
    }
    return { ok: true, value: { ...required.env, OM_SERVER_URL: serverUrl, OM_OWNER_TOKEN: token } };
}

/** Bounded stream chunks; CLI enforces total UTF-8/64 KiB cap and disposes the deadline.
 * Abort interrupts file/stdin reads. Native stream errors reach the existing typed CLI boundary.
 */
async function* readPrompt(required: { path: string; signal: AbortSignal; stdin: Readable }): AsyncIterable<Uint8Array> {
    const stream = required.path === '-' ? required.stdin : createReadStream(required.path, { highWaterMark: 8192, signal: required.signal });
    function abort() { stream.destroy(new Error('Prompt read cancelled')); }
    required.signal.addEventListener('abort', abort, { once: true });
    try {
        if (required.signal.aborted) abort();
        for await (const chunk of stream) yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    } finally {
        required.signal.removeEventListener('abort', abort);
        if (required.path !== '-') stream.destroy();
    }
}

/** Native terminal confirmation: exactly "yes" records the displayed choice; non-TTY denies. */
async function confirmOwner(required: { input: NodeJS.ReadStream; output: Writable }): Promise<boolean> {
    if (!required.input.isTTY) return false;
    const terminal = createInterface({ input: required.input, output: required.output });
    try { return (await terminal.question('Record this exact approval answer? Type yes: ')).trim() === 'yes'; }
    finally { terminal.close(); }
}

/** Bind injected Node effects once. Native fetch/streams/timer callbacks intentionally retain ABIs. */
function createRuntime(required: { env: Readonly<Record<string, string | undefined>>; signal: AbortSignal }): CliRuntime {
    return {
        env: required.env, signal: required.signal, fetch, ids: { next: () => randomUUID() }, clock: { now: () => Date.now() },
        stdout: { write: ({ text }) => { process.stdout.write(text); } },
        stderr: { write: ({ text }) => { process.stderr.write(text); } },
        readPrompt: input => readPrompt({ ...input, signal: AbortSignal.any([input.signal, required.signal]), stdin: process.stdin }),
        addonFiles: createFolderReader({ fs }),
        confirm: () => confirmOwner({ input: process.stdin, output: process.stderr }),
        deadline: { create({ timeoutMs }) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            return { signal: controller.signal, dispose: () => clearTimeout(timer) };
        } },
    };
}

/** Help remains available without a running server or credential file. Failed commands exit nonzero. */
async function main(): Promise<void> {
    const argv = process.argv.slice(2);
    const help = argv.length === 0 || argv[0] === 'help' || argv.includes('--help');
    const environment = help ? { ok: true as const, value: process.env }
        : await loadCliEnvironment({ env: process.env, fs, home: homedir() });
    if (!environment.ok) {
        if (argv.includes('--json')) process.stdout.write(JSON.stringify(environment) + '\n');
        else process.stderr.write(terminalText({ text: environment.error.message }) + '\n');
        process.exitCode = 1;
        return;
    }
    const controller = new AbortController();
    function interrupt() { controller.abort(); }
    process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
    try {
        const result = await runOmCli({ argv, runtime: createRuntime({ env: environment.value, signal: controller.signal }) });
        if (!result.ok) process.exitCode = 1;
    } finally { process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt); }
}

// Node 24.2's entry-point flag also works through the package's symlinked om bin.
if (import.meta.main) {
    void main().catch(() => { process.stderr.write('Owner CLI executable failed\n'); process.exitCode = 1; });
}

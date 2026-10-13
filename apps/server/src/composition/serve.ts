#!/usr/bin/env node
/** Explicit Node executable. Importing this module does not open files, databases or listeners. */
import Database from 'better-sqlite3';
import * as fs from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { ClockPort, ObserverPort } from '@open-marketing/contracts';
import { bootServer, type BootedServer, type ServerBootIo } from './index.js';
import { localStateRoot } from './local-auth.js';

/** Bind standard Node effects for boot and its real temporary-file integration test.
 * Paths are supplied by composition, independent of cwd; no resource is opened by this factory.
 * @example const io = createNodeBootIo({ projectRoot, studioRoot, ready });
 */
export function createNodeBootIo(required: { projectRoot: string; studioRoot: string; ready: ServerBootIo['ready'] }): ServerBootIo {
    return { ...required, fs, createServer, openSqlite: ({ path }) => new Database(path),
        randomToken: () => randomBytes(32).toString('hex'),
        schedule: ({ callback, delayMs }) => { const timer = setTimeout(callback, delayMs); return () => clearTimeout(timer); } };
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
    const result = await bootServer({ env: { ...process.env, OM_STATE_ROOT: localStateRoot({ env: process.env, home: homedir() }) }, io, clock, ids, observer });
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

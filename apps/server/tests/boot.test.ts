/** Written-only I1 integration coverage; the Coordinator builds public dist exports before execution. */
import { request as httpRequest } from 'node:http';
import { expect, it } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { ClockPort, ObserverEvent } from '@open-marketing/contracts';
import { bootServer, type BootedServer, type ServerBootIo } from '../src/composition/index.js';
import { createNodeBootIo } from '../src/composition/serve.js';
import { loadCliEnvironment } from '../src/composition/cli.js';
import { bindServerDatabase } from '../src/composition/database.js';
import { readLocalOwner } from '../src/composition/local-auth.js';
import { runOmCli } from '../src/cli/index.js';
import { createNodeHttpListener, serveStudioAsset } from '../src/inbound/http.js';
import { migrationManifest } from '../src/composition/migrations.js';

/** Real native SQLite/HTTP/filesystem, owned temporary assets/state, deterministic injected time. */
async function createFixture(_required: Record<string, never>) {
    const directory = await fs.mkdtemp(join(tmpdir(), 'om-i1-'));
    const stateRoot = join(directory, 'state');
    const studioRoot = join(directory, 'studio');
    await fs.mkdir(studioRoot);
    await fs.mkdir(join(studioRoot, 'assets'));
    await fs.writeFile(join(studioRoot, 'index.html'), '<!doctype html><title>OM fixture studio</title>');
    await fs.writeFile(join(studioRoot, 'assets', 'app.js'), 'console.log("fixture")');
    let now = 1000;
    const clock: ClockPort = { now: () => now };
    const handles: Database.Database[] = [];
    const servers: BootedServer[] = [];
    const ready: string[] = [];
    const events: ObserverEvent[] = [];
    const observer = { observe: (event: ObserverEvent) => { events.push(event); } };
    const ids = { next: () => randomUUID() };
    const nativeIo = createNodeBootIo({ projectRoot: fileURLToPath(new URL('../../../', import.meta.url)), studioRoot,
        ready: value => { ready.push('OM_READY ' + JSON.stringify(value)); } });
    const io: ServerBootIo = { ...nativeIo, openSqlite(input) { const native = nativeIo.openSqlite(input); handles.push(native); return native; } };
    return { directory, stateRoot, studioRoot, handles, ready, events, ids, clock, observer, io,
        advance({ milliseconds }: { milliseconds: number }) { now += milliseconds; },
        async start(input: { env?: Record<string, string | undefined>; io?: Partial<ServerBootIo> }) {
            const result = await bootServer({ env: { OM_STATE_ROOT: stateRoot, ...input.env }, io: { ...io, ...input.io }, clock, ids, observer });
            if (result.ok) servers.push(result.value);
            return result;
        },
        async close() {
            for (const server of servers) await server.stop({});
            for (const handle of handles) if (handle.open) handle.close();
            await fs.rm(directory, { recursive: true, force: true });
        },
    };
}

it('boots on SQLite, serves built studio, publishes desktop readiness and shares CLI discovery', async () => {
    const fixture = await createFixture({});
    try {
        const result = await fixture.start({});
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error(result.error.message);
        expect(fixture.ready).toEqual(['OM_READY ' + JSON.stringify({ studioUrl: result.value.studioUrl })]);
        const url = new URL(result.value.studioUrl);
        const origin = url.origin;
        expect(url.hostname).toBe('127.0.0.1');
        expect(Number(url.port)).toBeGreaterThan(0);
        const native = fixture.handles[0];
        expect(native.pragma('foreign_keys', { simple: true })).toBe(1);
        expect(native.pragma('busy_timeout', { simple: true })).toBe(5000);
        expect(native.prepare('SELECT version FROM om_schema_migrations ORDER BY version').all()).toEqual(Array.from({ length: 18 }, (_, index) => ({ version: index + 1 })));
        for (const table of ['contact_subject', 'web_event', 'privacy_request']) {
            expect(native.prepare('SELECT name FROM sqlite_master WHERE name=?').get(table)).toEqual({ name: table });
        }
        expect((await fetch(origin + '/health')).status).toBe(200);
        expect((await fetch(origin + '/health', { headers: { 'x-correlation-id': 'fixture-correlation', 'x-trace-id': 'fixture-trace' } })).status).toBe(200);
        expect(fixture.events).toContainEqual({ operation: 'server.http.request', outcome: '200', correlationId: 'fixture-correlation', traceId: 'fixture-trace' });
        expect((await fetch(origin + '/api/status')).status).toBe(401);
        expect((await fetch(origin + '/')).status).toBe(401);
        const bootstrap = await fetch(result.value.studioUrl, { redirect: 'manual' });
        expect(bootstrap.status).toBe(303);
        expect(bootstrap.headers.get('location')).toBe('/');
        const cookieHeader = bootstrap.headers.get('set-cookie') ?? '';
        expect(cookieHeader).toContain('HttpOnly');
        expect(cookieHeader).toContain('SameSite=Strict');
        const cookie = cookieHeader.split(';')[0];
        expect((await fetch(result.value.studioUrl, { redirect: 'manual' })).status).toBe(401);
        const studio = await fetch(origin + '/', { headers: { cookie } });
        expect(studio.headers.get('content-type')).toContain('text/html');
        expect(await studio.text()).toContain('OM fixture studio');
        expect(await (await fetch(origin + '/assets/app.js', { headers: { cookie } })).text()).toBe('console.log("fixture")');
        const configured = await loadCliEnvironment({ env: { OM_STATE_ROOT: fixture.stateRoot }, fs, home: fixture.directory });
        expect(configured.ok).toBe(true);
        if (!configured.ok) throw new Error(configured.error.message);
        expect(configured.value.OM_SERVER_URL).toBe(origin);
        const output: string[] = [];
        const cli = await runOmCli({ argv: ['status', '--json'], runtime: {
            env: configured.value, fetch, ids: fixture.ids, clock: fixture.clock,
            deadline: { create: () => ({ signal: AbortSignal.timeout(15000), dispose() {} }) },
            stdout: { write: ({ text }) => { output.push(text); } }, stderr: { write() {} },
            confirm: async () => false, readPrompt: async function* () {},
        } });
        expect(cli.ok).toBe(true);
        expect(JSON.parse(output.join(''))).toEqual({ ok: true, value: { ready: true, mode: 'local' } });
        expect((await fs.stat(join(fixture.stateRoot, 'owner.json'))).mode & 0o777).toBe(0o600);
        expect(fixture.events.some(event => event.operation === 'server.db.query' && event.outcome === 'succeeded')).toBe(true);
        expect(JSON.stringify(fixture.events)).not.toContain(configured.value.OM_OWNER_TOKEN);
        expect(await result.value.stop({})).toEqual({ ok: true, value: undefined });
        expect(await result.value.stop({})).toEqual({ ok: true, value: undefined });
        expect(native.open).toBe(false);
        await expect(fetch(origin + '/health')).rejects.toThrow();
    } finally { await fixture.close(); }
});

it('restarts without migration drift or owner/workspace changes; isolated roots reject each other', async () => {
    const fixture = await createFixture({});
    try {
        const first = await fixture.start({});
        if (!first.ok) throw new Error(first.error.message);
        const credentials = await readLocalOwner({ fs, stateRoot: fixture.stateRoot });
        if (!credentials.ok) throw new Error(credentials.error.message);
        await first.value.stop({});
        const restarted = await fixture.start({});
        if (!restarted.ok) throw new Error(restarted.error.message);
        expect(await readLocalOwner({ fs, stateRoot: fixture.stateRoot })).toEqual(credentials);
        expect(fixture.handles[1].prepare('SELECT * FROM workspace').all()).toEqual([{ owner_id: credentials.value.ownerId, workspace_id: credentials.value.workspaceId }]);
        expect(fixture.handles[1].prepare('SELECT COUNT(*) AS count FROM om_schema_migrations').get()).toEqual({ count: 18 });
        const otherRoot = join(fixture.directory, 'other-state');
        const other = await fixture.start({ env: { OM_STATE_ROOT: otherRoot } });
        if (!other.ok) throw new Error(other.error.message);
        const otherCredentials = await readLocalOwner({ fs, stateRoot: otherRoot });
        if (!otherCredentials.ok) throw new Error(otherCredentials.error.message);
        expect(otherCredentials.value.token).not.toBe(credentials.value.token);
        expect(otherCredentials.value.workspaceId).not.toBe(credentials.value.workspaceId);
        const firstBootstrap = await fetch(restarted.value.studioUrl, { redirect: 'manual' });
        const otherBootstrap = await fetch(other.value.studioUrl, { redirect: 'manual' });
        const firstCookie = firstBootstrap.headers.get('set-cookie')?.split(';')[0];
        const otherCookie = otherBootstrap.headers.get('set-cookie')?.split(';')[0];
        expect(firstCookie).toBeTruthy();
        expect(otherCookie).toBeTruthy();
        expect(firstCookie?.split('=')[0]).not.toBe(otherCookie?.split('=')[0]);
        const sharedBrowserCookies = `${firstCookie}; ${otherCookie}`;
        expect((await fetch(new URL('/api/status', restarted.value.studioUrl), { headers: { cookie: sharedBrowserCookies } })).status).toBe(200);
        expect((await fetch(new URL('/api/status', other.value.studioUrl), { headers: { cookie: sharedBrowserCookies } })).status).toBe(200);
        const wrongOwner = await fetch(new URL('/api/status', other.value.studioUrl), { headers: { authorization: 'Bearer ' + credentials.value.token } });
        expect(wrongOwner.status).toBe(401);
        expect(fixture.handles[2].prepare('SELECT * FROM workspace').all()).toEqual([{ owner_id: otherCredentials.value.ownerId, workspace_id: otherCredentials.value.workspaceId }]);
    } finally { await fixture.close(); }
});

it('rejects bad configuration, unavailable assets and failed migrations without readiness or leaked handles', async () => {
    const fixture = await createFixture({});
    try {
        for (const env of [{ OM_MODE: 'production' }, { OM_HOST: '0.0.0.0' }, { OM_STATE_ROOT: 'relative' }, { OM_PORT: '65536' }]) {
            expect((await fixture.start({ env })).ok).toBe(false);
        }
        expect(fixture.handles).toHaveLength(0);
        expect((await fixture.start({ io: { studioRoot: join(fixture.directory, 'missing') } })).ok).toBe(false);
        expect(fixture.handles).toHaveLength(0);
        const brokenRoot = join(fixture.directory, 'broken-project');
        for (const entry of migrationManifest) {
            const destination = join(brokenRoot, entry.path);
            await fs.mkdir(join(destination, '..'), { recursive: true });
            await fs.writeFile(destination, entry.version === 16 ? 'BROKEN SQL;' : await fs.readFile(join(fixture.io.projectRoot, entry.path)));
        }
        const broken = await fixture.start({ io: { projectRoot: brokenRoot } });
        expect(broken.ok).toBe(false);
        expect(fixture.ready).toHaveLength(0);
        expect(fixture.handles[0].open).toBe(false);
        const probe = new Database(join(fixture.stateRoot, 'om.sqlite'));
        try { expect(probe.prepare("SELECT name FROM sqlite_master WHERE name='workspace'").all()).toEqual([]); }
        finally { probe.close(); }
    } finally { await fixture.close(); }
});

it('authenticates before body reads, enforces Host/Origin and expiry, and leaves local effects unavailable', async () => {
    const fixture = await createFixture({});
    try {
        const result = await fixture.start({});
        if (!result.ok) throw new Error(result.error.message);
        const origin = new URL(result.value.studioUrl).origin;
        const malformed = await fetch(origin + '/api/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json' });
        expect(malformed.status).toBe(401);
        expect((await malformed.json()).error.code).toBe('unauthenticated');
        expect(await statusWithHost({ url: origin + '/health', host: 'evil.example' })).toBe(403);
        const owner = await readLocalOwner({ fs, stateRoot: fixture.stateRoot });
        if (!owner.ok) throw new Error(owner.error.message);
        const cookie = `om_owner_${new URL(origin).port}=` + owner.value.token;
        expect((await fetch(origin + '/api/runs', { method: 'POST', headers: { cookie, origin: 'https://evil.example' }, body: 'bad' })).status).toBe(403);
        expect((await fetch(origin + '/api/runs', { method: 'POST', headers: { cookie }, body: 'bad' })).status).toBe(403);
        expect((await fetch(origin + '/api/status', { headers: { cookie, authorization: 'Basic invalid' } })).status).toBe(401);
        const effect = await fetch(origin + '/api/runs', { method: 'POST', headers: { authorization: 'Bearer ' + owner.value.token }, body: 'bad' });
        expect(effect.status).toBe(400);
        expect((await effect.json()).error.code).toBe('invalid_input');
        fixture.advance({ milliseconds: 60000 });
        expect((await fetch(result.value.studioUrl, { redirect: 'manual' })).status).toBe(401);
        expect((await fetch(origin + '/api/status', { headers: { cookie } })).status).toBe(200);
        expect((await fetch(origin + '/api/status', { headers: { cookie: cookie + '; ' + cookie } })).status).toBe(401);
    } finally { await fixture.close(); }
});

it('does not read static traversal, sensitive files or symlinks outside built studio', async () => {
    const fixture = await createFixture({});
    try {
        await fs.writeFile(join(fixture.directory, 'outside.js'), 'private fixture data');
        await fs.symlink(join(fixture.directory, 'outside.js'), join(fixture.studioRoot, 'assets', 'escape.js'));
        for (const path of ['/assets/%2e%2e/%2e%2e/outside.js', '/assets/escape.js', '/owner.json', '/assets/%00.js', '/assets/%5c..%5coutside.js']) {
            const response = await serveStudioAsset({ request: { method: 'GET', path }, fs, studioRoot: fixture.studioRoot });
            expect(response.status).toBeGreaterThanOrEqual(400);
            expect(JSON.stringify(response.body)).not.toContain('private fixture data');
        }
    } finally { await fixture.close(); }
});

it('workspace transaction adapter joins supplied sessions, rolls back denials and reports overlapping work as busy', async () => {
    const fixture = await createFixture({});
    const native = new Database(':memory:');
    try {
        const database = bindServerDatabase({ native, observer: fixture.observer, context: {
            scope: { ownerId: 'fixture-owner', workspaceId: randomUUID() }, principal: { kind: 'owner', ownerId: 'fixture-owner' }, correlationId: 'test-correlation', traceId: 'test-trace',
        } });
        native.exec('CREATE TABLE probe (value INTEGER)');
        const denied = await database.workspace.transaction({ run: async session => {
            await session.query({ text: 'INSERT INTO probe VALUES ($1)', values: [1] });
            return { ok: false as const, error: { code: 'conflict' as const, message: 'fixture rejection', retryable: false } };
        } });
        expect(denied.ok).toBe(false);
        expect(native.prepare('SELECT * FROM probe').all()).toEqual([]);
        await database.unit.transaction({ work: async ({ session }) => {
            await session.transaction({ work: async ({ session: joined }) => {
                expect(joined).toBe(session);
                await joined.query({ text: 'INSERT INTO probe VALUES ($1)', values: [2] });
            } });
            await expect(database.workspace.query({ text: 'SELECT * FROM probe' })).rejects.toMatchObject({ code: 'connect_failed' });
        } });
        expect(native.prepare('SELECT * FROM probe').all()).toEqual([{ value: 2 }]);
    } finally { native.close(); await fixture.close(); }
});

it('CLI refuses to send a state-root token to a remote origin and rejects non-private credentials', async () => {
    const fixture = await createFixture({});
    try {
        const result = await fixture.start({});
        if (!result.ok) throw new Error(result.error.message);
        const remote = await loadCliEnvironment({ env: { OM_STATE_ROOT: fixture.stateRoot, OM_SERVER_URL: 'https://example.test' }, fs, home: fixture.directory });
        expect(remote).toMatchObject({ ok: false, error: { code: 'unauthenticated' } });
        await fs.chmod(join(fixture.stateRoot, 'owner.json'), 0o644);
        expect((await loadCliEnvironment({ env: { OM_STATE_ROOT: fixture.stateRoot }, fs, home: fixture.directory })).ok).toBe(false);
        const before = fixture.ready.length;
        expect((await fixture.start({})).ok).toBe(false);
        expect(fixture.ready).toHaveLength(before);
    } finally { await fixture.close(); }
});

it('bind/readiness failures close SQLite and never publish another readiness line', async () => {
    const fixture = await createFixture({});
    try {
        const first = await fixture.start({});
        if (!first.ok) throw new Error(first.error.message);
        const port = new URL(first.value.studioUrl).port;
        const occupied = await fixture.start({ env: { OM_PORT: port, OM_STATE_ROOT: join(fixture.directory, 'occupied') } });
        expect(occupied.ok).toBe(false);
        expect(fixture.handles[1].open).toBe(false);
        expect(fixture.ready).toHaveLength(1);
        const failedReady = await fixture.start({ env: { OM_STATE_ROOT: join(fixture.directory, 'failed-ready') }, io: { ready() { throw new Error('Injected stdout failure'); } } });
        expect(failedReady.ok).toBe(false);
        expect(fixture.handles[2].open).toBe(false);
        expect(fixture.ready).toHaveLength(1);
        expect((await fetch(new URL('/health', first.value.studioUrl))).status).toBe(200);
    } finally { await fixture.close(); }
});

it('bounded lazy JSON transport validates bodies only when the authenticated handler asks', async () => {
    const fixture = await createFixture({});
    let reads = 0;
    const listener = createNodeHttpListener({ host: '127.0.0.1', port: 0, effects: fixture.io, ids: fixture.ids, observer: fixture.observer });
    try {
        const started = await listener.start({ handle: async request => {
            if (request.authorization !== 'Bearer fixture') return { status: 401, body: { ok: false } };
            reads++;
            const body = await request.readBody?.({});
            return { status: body?.ok ? 200 : 400, body };
        } });
        expect(started.ok).toBe(true);
        const origin = listener.origin({});
        if (!origin) throw new Error('Listener not bound');
        const endpoint = origin + '/fixture';
        expect((await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'invalid' })).status).toBe(401);
        expect(reads).toBe(0);
        const headers = { authorization: 'Bearer fixture', 'content-type': 'application/json' };
        const valid = await fetch(endpoint, { method: 'POST', headers, body: '{"fixture":true}' });
        expect(await valid.json()).toEqual({ ok: true, value: { fixture: true } });
        const malformed = await fetch(endpoint, { method: 'POST', headers, body: 'invalid' });
        expect((await malformed.json()).error.code).toBe('invalid_input');
        const oversized = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ value: 'x'.repeat(131072) }) });
        expect((await oversized.json()).error.code).toBe('limit_exceeded');
        expect((await fetch(endpoint + '?x=1&x=2', { headers })).status).toBe(400);
    } finally { await listener.stop({}); await fixture.close(); }
});

/** fetch() forbids overriding Host, so spoofed-Host checks use node:http directly. */
function statusWithHost(required: { url: string; host: string }): Promise<number | undefined> {
    return new Promise((resolve, reject) => {
        const request = httpRequest(required.url, { headers: { host: required.host } }, response => { response.resume(); resolve(response.statusCode); });
        request.on('error', reject);
        request.end();
    });
}

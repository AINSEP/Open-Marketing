/** Written-only D4 fixtures: actual Jini admission and retained-byte HTTP boundaries, no vendors. */
import * as fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, expect, it, vi } from 'vitest';
import { createPluginContributionRegistry, InMemoryPluginActivationRepo } from '@jini-ai/plugins/host';
import type { AdmittedBrowserProvider, PluginDiscoveryRecord, PluginManifest } from '@jini-ai/plugins/host';
import { admitBrowserProviderAssets, verifyPluginSnapshotIntegrity, snapshotSitePluginPackage, snapshotPluginModuleGraph } from '@jini-ai/plugins/host/node';
import type { CallContext } from '@open-marketing/contracts';
import type { CredentialSqlPort } from '@open-marketing/credentials';
import { createChartAssets, handleChartAssetRequest } from '../src/inbound/chart-assets.js';
import type { ExecutablePluginHostDependencies } from '../src/plugin-host.js';
import { createExecutablePluginHost, executablePackageRoot, retainOmChartProviders } from '../src/plugin-host.js';
import { executableHostPorts, bindServerAddons, createNodeAddonEffects } from '../src/composition/addons.js';
import Database from 'better-sqlite3';
import { bootServer, type BootedServer } from '../src/composition/index.js';
import { createNodeBootIo } from '../src/composition/serve.js';
import { removeStateRoot } from './state-root.js';

const context: CallContext = { scope: { ownerId: 'fixture-owner', workspaceId: 'fixture-workspace' },
    principal: { kind: 'owner', ownerId: 'fixture-owner' }, correlationId: 'fixture-correlation', traceId: 'fixture-trace' };
const observer = { observe: vi.fn() };
beforeEach(() => observer.observe.mockClear());
const javascript = 'export function mount(){return {update(){},destroy(){}}}';
const stylesheet = '.fixture { color: var(--om-text); }';
const digest = (required: { text: string }) => 'sha256-' + createHash('sha256').update(required.text).digest('hex');

async function packageFixture() {
    const root = await fs.mkdtemp(join(tmpdir(), 'om-charts-d4-'));
    const pluginRoot = join(root, 'fixture-charts', '1.0.0');
    await fs.mkdir(join(pluginRoot, 'client'), { recursive: true });
    await fs.mkdir(join(pluginRoot, 'server'));
    const entry = 'export default {definition:{setup(){}}};';
    const manifest: PluginManifest = { id: 'fixture-charts', name: 'Fixture charts', version: '1.0.0', sdkRange: '^1.0.0',
        engine: 1, tier: 'tier-3', capabilities: [], hooks: [], fields: [],
        browserProviders: [{ id: 'uploaded.example', kind: 'chart', contractVersion: 1, kinds: ['bar', 'line'], javascript: 'client/provider.js', stylesheet: 'client/styles.css' }],
        integrity: { 'client/provider.js': digest({ text: javascript }), 'client/styles.css': digest({ text: stylesheet }), 'server/index.mjs': digest({ text: entry }) } };
    await Promise.all(Object.entries({ 'jini.plugin.json': JSON.stringify(manifest), 'client/provider.js': javascript, 'client/styles.css': stylesheet, 'server/index.mjs': entry })
        .map(([path, content]) => fs.writeFile(join(pluginRoot, path), content)));
    const record: PluginDiscoveryRecord = { id: manifest.id, name: manifest.name, version: manifest.version, source: 'site', status: 'valid', errors: [], manifest };
    const approval = { pluginId: manifest.id, version: manifest.version, browserProviders: manifest.browserProviders!, integrity: manifest.integrity };
    return { root, pluginRoot, manifest, record, approval, async dispose() { await fs.rm(root, { recursive: true, force: true }); await fs.rm(root + '-runtime', { recursive: true, force: true }); } };
}

/** OM retains uploads without relabeling source; Jini still verifies complete package bytes. */
async function admittedFixture(required: Awaited<ReturnType<typeof packageFixture>>): Promise<readonly AdmittedBrowserProvider[]> {
    return retainOmChartProviders({ pluginId: required.manifest.id, manifest: required.manifest,
        files: await snapshotSitePluginPackage({ sourceDir: required.pluginRoot }) });
}

/** Shared native snapshot adapter for fixture packages, with executable evaluation replaced. */
function fixtureHost(required: { fixture: Awaited<ReturnType<typeof packageFixture>>; imports: ReturnType<typeof vi.fn> }) {
    const charts = createChartAssets({});
    const activations = new InMemoryPluginActivationRepo({});
    const registry = createPluginContributionRegistry({});
    const host = createExecutablePluginHost({ host: executableHostPorts({}), installDir: required.fixture.root, activations,
        registry, browserProviders: charts,
        tierPolicy: { siteErrors: () => [], checkInstall() {}, allowLoad: () => true, execution: 'in-process' },
        clock: { nowMs: () => 1000 }, verifyDigest: async ({ absoluteFilePath }) => digest({ text: await fs.readFile(absoluteFilePath, 'utf8') }),
        snapshotVerified: async input => {
            const entryPath = await snapshotPluginModuleGraph({ pluginRoot: executablePackageRoot(input), manifest: input.manifest });
            return { entryPath, files: await snapshotSitePluginPackage({ sourceDir: executablePackageRoot({ entryPath }) }) };
        },
        importVerified: required.imports, async removeBytes() {},
        coreDeps: { getCurrentEntry: () => ({ workspaceId: 'fixture-workspace', ext: {} }), writeExtField() {}, attachFilter() {} } });
    const addon = { id: required.fixture.manifest.id, kind: 'plugin' as const, name: required.fixture.manifest.name, description: '', version: '1.0.0', revision: 'r1', enabled: false };
    return { host, charts, activations, registry, addon };
}

it('admits enabled uploads through OM while Jini still rejects their browser source, and cleans up on disable', async () => {
    const f = await packageFixture();
    try {
        expect(await admitBrowserProviderAssets({ record: f.record, manifest: f.manifest, pluginRoot: f.pluginRoot, approvals: [f.approval] }))
            .toEqual({ admitted: false, reason: 'BROWSER_PROVIDER_FORBIDDEN' });
        const imports = vi.fn<ExecutablePluginHostDependencies['importVerified']>(async () => ({ definition: { setup() {} } }));
        const { host, charts, activations, registry, addon } = fixtureHost({ fixture: f, imports });
        expect(charts.list({})).toEqual({ providers: [] });
        await host.setEnabled({ context, addon, enabled: true });
        expect(imports).toHaveBeenCalledTimes(1);
        expect(imports.mock.calls[0][0]).toMatchObject({ manifest: f.manifest });
        expect(charts.list({}).providers).toMatchObject([{ id: 'uploaded.example' }]);
        expect((await activations.getActivation({ workspaceId: context.scope.workspaceId, pluginId: addon.id }))?.enabled).toBe(true);
        expect(JSON.parse(await fs.readFile(join(f.pluginRoot, 'jini.plugin.json'), 'utf8'))).toEqual(f.manifest);
        await host.setEnabled({ context, addon, enabled: false });
        expect(charts.list({})).toEqual({ providers: [] });
        expect(registry.list({})).toEqual([]);
    } finally { await f.dispose(); }
});

it.each(['integrity', 'SDK', 'setup'])('failed %s checks expose no chart assets or contributions', async failure => {
    const f = await packageFixture();
    try {
        const imports = vi.fn<ExecutablePluginHostDependencies['importVerified']>(async () => ({ definition: { setup() { throw new Error('fixture setup failure'); } } }));
        const { host, charts, activations, registry, addon } = fixtureHost({ fixture: f, imports });
        if (failure === 'integrity') await fs.writeFile(join(f.pluginRoot, 'client/provider.js'), 'corrupt');
        if (failure === 'SDK') await fs.writeFile(join(f.pluginRoot, 'jini.plugin.json'), JSON.stringify({ ...f.manifest, sdkRange: '^9.0.0' }));
        await expect(host.setEnabled({ context, addon, enabled: true })).rejects.toThrow();
        expect(imports).toHaveBeenCalledTimes(failure === 'setup' ? 1 : 0);
        expect(charts.list({})).toEqual({ providers: [] });
        expect(registry.list({})).toEqual([]);
        expect((await activations.getActivation({ workspaceId: context.scope.workspaceId, pluginId: addon.id }))?.enabled).not.toBe(true);
    } finally { await f.dispose(); }
});

it('serves retained declared bytes by digest, then closes inventory and assets on disable', async () => {
    const f = await packageFixture();
    try {
        const charts = createChartAssets({});
        charts.replace({ pluginId: f.manifest.id, providers: await admittedFixture(f) });
        const descriptor = charts.list({}).providers[0];
        expect(descriptor).toMatchObject({ id: 'uploaded.example', pluginId: 'fixture-charts', kinds: ['bar', 'line'], contractVersion: 1 });
        const request = (input: { path: string }) => handleChartAssetRequest({ context, charts, observer, request: { method: 'GET', path: input.path } });
        expect(await request({ path: '/api/addons/v1/chart-providers' })).toMatchObject({ status: 200, body: { ok: true, value: { providers: [descriptor] } } });
        await fs.writeFile(join(f.pluginRoot, 'client/provider.js'), 'changed after admission');
        const served = await request({ path: descriptor.javascript });
        expect(served).toMatchObject({ status: 200, contentType: 'text/javascript', headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
        expect(Buffer.from(served.body as Uint8Array).toString()).toBe(javascript);
        (served.body as Buffer).fill(0);
        expect(Buffer.from((await request({ path: descriptor.javascript })).body as Uint8Array).toString()).toBe(javascript);
        expect(await request({ path: descriptor.stylesheet! })).toMatchObject({ status: 200, contentType: 'text/css' });
        expect((await request({ path: descriptor.javascript.replace(/provider\.js$/, 'index.mjs') })).status).toBe(404);
        charts.remove({ pluginId: f.manifest.id });
        expect(charts.list({})).toEqual({ providers: [] });
        expect((await request({ path: descriptor.javascript })).status).toBe(404);
        expect((await request({ path: descriptor.stylesheet! })).status).toBe(404);
    } finally { await f.dispose(); }
});

it('retains independent byte copies from Buffer snapshots and rejects malformed declarations', async () => {
    const f = await packageFixture();
    try {
        const files = await snapshotSitePluginPackage({ sourceDir: f.pluginRoot });
        const providers = retainOmChartProviders({ pluginId: f.manifest.id, manifest: f.manifest, files });
        files.get('client/provider.js')!.fill(0);
        const asset = providers[0].assets[0];
        const first = asset.readBytes({});
        expect(Buffer.from(first).toString()).toBe(javascript);
        first.fill(0);
        expect(Buffer.from(asset.readBytes({})).toString()).toBe(javascript);
        expect(() => retainOmChartProviders({ pluginId: f.manifest.id, files,
            manifest: { ...f.manifest, browserProviders: [{ ...f.manifest.browserProviders![0], javascript: '../outside.js' }] } })).toThrow('Invalid chart declarations');
    } finally { await f.dispose(); }
});

it('rejects corrupt admission and atomic duplicate/mixed-invalid replacement without leaking assets', async () => {
    const f = await packageFixture();
    try {
        const providers = await admittedFixture(f); const charts = createChartAssets({});
        charts.replace({ pluginId: f.manifest.id, providers });
        const before = charts.list({});
        expect(() => charts.replace({ pluginId: f.manifest.id, providers: [...providers, ...providers] })).toThrow('Duplicate');
        const corrupt: AdmittedBrowserProvider = { ...providers[0], assets: providers[0].assets.map(asset => ({ ...asset, readBytes: () => new Uint8Array([1]) })) };
        expect(() => charts.replace({ pluginId: f.manifest.id, providers: [providers[0], corrupt] })).toThrow('integrity');
        expect(charts.list({})).toEqual(before);
        expect(() => charts.replace({ pluginId: 'other-plugin', providers })).toThrow('identity');
        expect(() => charts.replace({ pluginId: f.manifest.id, providers: Array.from({ length: 101 }, () => providers[0]) })).toThrow('cap');
        await fs.writeFile(join(f.pluginRoot, 'client/styles.css'), 'corrupt');
        await expect(admittedFixture(f)).rejects.toThrow('changed');
        charts.dispose({}); expect(charts.list({})).toEqual({ providers: [] });
    } finally { await f.dispose(); }
});

it('checks owner metadata and rejects query/encoded/traversal/POST targets without reading a body', async () => {
    const charts = createChartAssets({}); const readBody = vi.fn();
    const request = { method: 'GET' as const, path: '/api/addons/v1/chart-providers', readBody };
    const denied = await handleChartAssetRequest({ charts, observer, request,
        context: { ...context, principal: { kind: 'owner', ownerId: 'other-owner' } } });
    expect(denied.status).toBe(403); expect(readBody).not.toHaveBeenCalled();
    const invalid = await handleChartAssetRequest({ charts, observer, request, context: {} as CallContext });
    expect(invalid.status).toBe(400);
    expect((await handleChartAssetRequest({ charts, observer, context, request: { ...request, method: 'POST' } })).status).toBe(400);
    expect((await handleChartAssetRequest({ charts, observer, context, request: { ...request, query: { unknown: 'value' } } })).status).toBe(400);
    for (const path of ['/api/addons/v1/chart-assets/' + 'a'.repeat(64) + '/%2e%2e', '/api/addons/v1/chart-assets/' + 'a'.repeat(64) + '/../server/index.mjs']) {
        expect((await handleChartAssetRequest({ charts, observer, context, request: { ...request, path } })).status).toBe(404);
    }
    expect(observer.observe).toHaveBeenCalledWith(expect.objectContaining({ operation: 'addons.charts.read', traceId: context.traceId, correlationId: context.correlationId }));
});

it('bounds aggregate retained bytes across providers before publishing a replacement', async () => {
    const f = await packageFixture();
    try {
        const providers = await admittedFixture(f); const charts = createChartAssets({});
        charts.replace({ pluginId: f.manifest.id, providers }); const before = charts.list({});
        const bytes = new Uint8Array(16777216);
        const asset = { path: 'client/provider.js', contentType: 'text/javascript' as const,
            digest: 'sha256-' + createHash('sha256').update(bytes).digest('hex'), readBytes: () => bytes };
        const oversized = ['one', 'two', 'three'].map(id => ({ ...providers[0],
            declaration: { ...providers[0].declaration, id: 'fixture.' + id, stylesheet: undefined }, assets: [asset] }));
        expect(() => charts.replace({ pluginId: f.manifest.id, providers: oversized })).toThrow('byte cap');
        expect(charts.list({})).toEqual(before);
    } finally { await f.dispose(); }
});

it('packages the unchanged standalone bundle with canonical names and complete integrity', async () => {
    const sourceDir = fileURLToPath(new URL('../../../content/plugins/charts-recharts/0.1.0/', import.meta.url));
    const files = await snapshotSitePluginPackage({ sourceDir });
    const manifest = JSON.parse(Buffer.from(files.get('jini.plugin.json')!).toString()) as PluginManifest;
    expect(manifest.extensions).toEqual({ 'io.github.ainsep.openmarketing': { id: 'openmarketing/charts-recharts' } });
    expect([...files.keys()].sort()).toEqual(['NOTICE', 'client/provider.js', 'client/styles.css', 'jini.plugin.json', 'server/index.mjs']);
    expect(() => verifyPluginSnapshotIntegrity({ files, integrity: manifest.integrity })).not.toThrow();
    expect(files.get('client/provider.js')?.byteLength).toBe(628868);
    expect(manifest.integrity['client/provider.js']).toBe('sha256-29d351dee2b2c4239f2e1d9891495b9e533fb4fec3767027146fdbc109135f3d');
    expect(Buffer.from(files.get('server/index.mjs')!).toString()).not.toContain('import');
});

it('seeds the chart plugin through the installer, disabled, and preserves the installed revision on restart', async () => {
    const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'om-chart-seed-')));
    const native = new Database(':memory:');
    let binding: ReturnType<typeof bindServerAddons> | undefined;
    try {
        native.exec(await fs.readFile(new URL('../migrations/0002_addons.sql', import.meta.url), 'utf8'));
        const db: CredentialSqlPort = { async query<Row extends Record<string, unknown>>(input: { text: string; values?: unknown[] }) {
            const statement = native.prepare(input.text);
            const parameters = Object.fromEntries((input.values ?? []).map((entry, index) => [String(index + 1), entry]));
            if (statement.reader) { const rows = statement.all(parameters) as Row[]; return { rows, rowCount: rows.length }; }
            return { rows: [], rowCount: statement.run(parameters).changes };
        } };
        const clock = { now: () => 1000 }; const loadModule = vi.fn(async () => ({ definition: { setup() {} } }));
        const effects = createNodeAddonEffects({ clock, ids: { next: () => 'fixture-id' }, loadModule });
        const dependencies = { context, db, stateRoot: root, projectRoot: root, clock, effects, observer,
            yamlReader: { read({ yaml }: { yaml: string }) { return JSON.parse(yaml); } }, sessions: { async reload() {}, async close() {} } };
        await fs.mkdir(join(root, 'content/plugins'), { recursive: true });
        await fs.cp(new URL('../../../content/plugins/charts-recharts/0.1.0/', import.meta.url), join(root, 'content/plugins/charts-recharts/0.1.0'), { recursive: true });
        binding = bindServerAddons(dependencies);
        expect(await binding.start()).toEqual({ ok: true, value: undefined });
        const initial = await binding.addons.list({ context, query: { kind: 'plugin', limit: 100 } });
        expect(initial).toMatchObject({ ok: true, value: { items: [{ id: 'charts-recharts', enabled: false, version: '0.1.0' }] } });
        expect(loadModule).not.toHaveBeenCalled();
        expect(binding.charts.list({})).toEqual({ providers: [] });
        expect((await binding.handleChartRequest({ context: { ...context, scope: { ...context.scope, workspaceId: 'other-workspace' } },
            request: { method: 'GET', path: '/api/addons/v1/chart-providers' } })).status).toBe(403);
        await binding.dispose();
        binding = bindServerAddons(dependencies);
        expect(await binding.start()).toEqual({ ok: true, value: undefined });
        expect(await binding.addons.list({ context, query: { kind: 'plugin', limit: 100 } })).toEqual(initial);
        expect(loadModule).not.toHaveBeenCalled();
        expect(await binding.addons.setEnabled({ context, request: { kind: 'plugin', id: 'charts-recharts', enabled: true } })).toMatchObject({ ok: true, value: { enabled: true } });
        const enabled = binding.charts.list({});
        expect(enabled.providers).toMatchObject([{ id: 'plugin.recharts' }]);
        const asset = enabled.providers[0].javascript;
        expect((await binding.handleChartRequest({ context, request: { method: 'GET', path: asset } })).status).toBe(200);
        await binding.dispose();
        binding = bindServerAddons(dependencies);
        expect(await binding.start()).toEqual({ ok: true, value: undefined });
        expect(binding.charts.list({})).toEqual(enabled);
        expect(loadModule).toHaveBeenCalledTimes(2);
        expect(await binding.addons.setEnabled({ context, request: { kind: 'plugin', id: 'charts-recharts', enabled: false } })).toMatchObject({ ok: true });
        expect((await binding.handleChartRequest({ context, request: { method: 'GET', path: asset } })).status).toBe(404);
    } finally { await binding?.dispose(); native.close(); await removeStateRoot({ path: root }); }
});

it('dispatches chart inventory/assets through real boot owner authentication and enable/disable', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'om-chart-http-'));
    let server: BootedServer | undefined;
    try {
        const studioRoot = join(root, 'studio');
        await fs.mkdir(studioRoot);
        await fs.writeFile(join(studioRoot, 'index.html'), '<html><head></head><body>fixture</body></html>');
        const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));
        const result = await bootServer({ env: { OM_STATE_ROOT: join(root, 'state') },
            io: createNodeBootIo({ projectRoot, studioRoot, ready() {} }), clock: { now: () => 1000 }, ids: { next: () => randomUUID() }, observer });
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error(result.error.message);
        server = result.value;
        const origin = new URL(server.studioUrl).origin;
        const path = '/api/addons/v1/chart-providers';
        expect((await fetch(origin + path)).status).toBe(401);
        const bootstrap = await fetch(server.studioUrl, { redirect: 'manual' });
        const cookie = bootstrap.headers.get('set-cookie')!.split(';')[0];
        const headers = { cookie, origin, 'content-type': 'application/json' };
        expect((await fetch(origin + path, { headers: { ...headers, origin: 'https://foreign.invalid' } })).status).toBe(403);
        expect(await (await fetch(origin + path, { headers })).json()).toEqual({ ok: true, value: { providers: [] } });
        const enable = (input: { enabled: boolean }) => fetch(origin + '/api/addons/v1/set-enabled', { method: 'POST', headers,
            body: JSON.stringify({ kind: 'plugin', id: 'charts-recharts', enabled: input.enabled }) });
        expect((await enable({ enabled: true })).status).toBe(200);
        const inventory = await (await fetch(origin + path, { headers })).json();
        const descriptor = inventory.value.providers[0];
        expect(descriptor).toMatchObject({ id: 'plugin.recharts', kinds: ['bar', 'line', 'pie'] });
        expect((await fetch(origin + descriptor.javascript)).status).toBe(401);
        const asset = await fetch(origin + descriptor.javascript, { headers });
        expect(asset.status).toBe(200);
        expect(asset.headers.get('content-type')).toContain('text/javascript');
        expect('sha256-' + createHash('sha256').update(Buffer.from(await asset.arrayBuffer())).digest('hex')).toBe('sha256-' + descriptor.digest);
        expect((await enable({ enabled: false })).status).toBe(200);
        expect((await fetch(origin + descriptor.javascript, { headers })).status).toBe(404);
        expect(await (await fetch(origin + path, { headers })).json()).toEqual({ ok: true, value: { providers: [] } });
    } finally { await server?.stop({}); await removeStateRoot({ path: root }); }
});

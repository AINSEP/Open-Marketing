/** D2 written-only fixtures: native SQLite and published Jini hosts; no vendors or real credentials. */
import { readFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { removeStateRoot } from './state-root.js';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, it, vi } from 'vitest';
import type { AddonKind, AddonSummary, AddonUpload, AppError, CallContext, Outcome, ObserverPort } from '@open-marketing/contracts';
import type { CredentialSqlPort } from '@open-marketing/credentials';
import { bindServerAddons, createNodeAddonEffects } from '../src/composition/addons.js';
import { loadAddonModule } from '../src/composition/serve.js';
import { addonBoundary, createSqlAddonRepository } from '../src/addons.js';
import type { AddonRepository } from '../src/addons.js';
import { decodeAddonUpload } from '../src/addon-upload.js';
import { handleAddonRequest } from '../src/inbound/addons.js';
import type { ExternalMcpConnection } from '../src/external-mcp.js';

export const context: CallContext = { scope: { ownerId: 'fixture-owner', workspaceId: 'fixture-workspace' },
    principal: { kind: 'owner', ownerId: 'fixture-owner' }, correlationId: 'fixture-correlation', traceId: 'fixture-trace' };
export function value<T>(required: { result: Outcome<T> }): T {
    if (!required.result.ok) throw new Error(required.result.error.code);
    return required.result.value;
}
const markdown = '---\n{"name":"fixture-skill","description":"Fixture instructions"}\n---\nFixture-only instructions.';

it.each<AppError>([
    { code: 'unavailable', message: 'Tool outcome unknown; reconcile before another attempt', retryable: false },
    { code: 'conflict', message: 'Fixture conflict permits retry', retryable: true },
])('preserves structured boundary failures ($code, retryable=$retryable)', async error => {
    const observer = { observe: vi.fn() };
    const result = await addonBoundary({ context, dependencies: { observer }, operation: 'fixture.write',
        run: async () => ({ ok: false, error }) });
    expect(result).toEqual({ ok: false, error });
    expect(observer.observe).toHaveBeenCalledWith({ operation: 'fixture.write', outcome: error.code,
        correlationId: context.correlationId, traceId: context.traceId, runId: context.runId });
});

it('maps unstructured boundary throws to the redacted retryable default', async () => {
    const result = await addonBoundary({ context, dependencies: { observer: { observe: vi.fn() } }, operation: 'fixture.write',
        run: async () => { throw new Error('fixture-secret'); } });
    expect(result).toEqual({ ok: false, error: { code: 'unavailable', message: 'Add-on operation unavailable or denied', retryable: true } });
});

export function upload(required: { kind: AddonKind; spend?: boolean; version?: string }): AddonUpload {
    const files: Record<string, string> = required.kind === 'skill' ? { 'SKILL.md': markdown } : agentFiles({ spend: required.spend });
    if (required.kind === 'plugin') {
        const code = 'export default {definition:{setup(sdk){sdk.tools.add({name:"report",description:"Fixture report",inputSchema:{type:"object"},handler(){return {fixture:true}}})}}};';
        const manifest = { id: 'fixture-plugin', name: 'Fixture plugin', version: required.version ?? '1.0.0', sdkRange: '^1.0.0', engine: 1, tier: 'tier-3',
            capabilities: required.spend ? ['tools.register', 'ad_spend'] : ['tools.register'], hooks: [], fields: [],
            contributes: { tools: ['report'] }, integrity: { 'server/index.mjs': 'sha256-' + createHash('sha256').update(code).digest('hex') } };
        return filesUpload({ files: { 'jini.plugin.json': JSON.stringify(manifest), 'server/index.mjs': code } });
    }
    return filesUpload({ files });
}

function agentFiles(required: { spend?: boolean }): Record<string, string> {
    return { 'plugin.json': JSON.stringify({ $schema: 'https://agent-plugins.org/schemas/1.1.0/plugin.schema.json', name: 'fixture-agent', version: '1.0.0',
        description: 'Fixture agent package', extensions: { 'io.github.ainsep.openmarketing': { capabilities: [{ effects: required.spend ? ['ad_spend', 'future_effect'] : ['read'] }] } } }),
        'skills/fixture-skill/SKILL.md': markdown, 'mcp.json': JSON.stringify({ $schema: 'https://agent-plugins.org/schemas/1.1.0/mcp.schema.json', mcpServers: {} }) };
}
function filesUpload(required: { files: Record<string, string> }): AddonUpload {
    return { kind: 'files', files: Object.entries(required.files).map(([path, content]) => ({ path, base64: Buffer.from(content).toString('base64') })) };
}

/** Native and memory adapters below run the same repository contract when the Coordinator runs tests. */
export function sqlFixture(_required: Record<string, never>) {
    const native = new Database(':memory:');
    native.exec(readFileSync(new URL('../migrations/0002_addons.sql', import.meta.url), 'utf8'));
    const db: CredentialSqlPort = { async query<Row extends Record<string, unknown>>(input: { text: string; values?: unknown[] }) {
        const statement = native.prepare(input.text);
        const parameters = Object.fromEntries((input.values ?? []).map((entry, index) => [String(index + 1), entry]));
        if (statement.reader) { const rows = statement.all(parameters) as Row[]; return { rows, rowCount: rows.length }; }
        return { rows: [], rowCount: statement.run(parameters).changes };
    } };
    return { native, db };
}

export async function fixture(_required: Record<string, never>) {
    const { native, db } = sqlFixture({});
    const root = await fs.mkdtemp(join(tmpdir(), 'om-addons-d2-'));
    await fs.mkdir(join(root, 'content/agent-plugins'), { recursive: true });
    let id = 0;
    const events: unknown[] = [];
    const sessionEvents: string[] = [];
    const observer: ObserverPort = { observe(event) { events.push(event); } };
    const clock = { now: () => 1000 };
    const effects = createNodeAddonEffects({ clock, ids: { next: () => 'fixture-id-' + ++id }, loadModule: loadAddonModule });
    const sessions = { async reload(input: { connection: ExternalMcpConnection }) { sessionEvents.push('reload:' + input.connection.connectionId); },
        async close(input: { connectionId: string }) { sessionEvents.push('close:' + input.connectionId); } };
    const dependencies = { context, db, stateRoot: root, projectRoot: root, clock, effects, observer,
        yamlReader: { read({ yaml }: { yaml: string }) { return JSON.parse(yaml); } }, sessions };
    const binding = bindServerAddons(dependencies);
    return { root, native, db, dependencies, binding, events, sessionEvents,
        async dispose() { await binding.dispose(); native.close(); await removeStateRoot({ path: root }); } };
}


for (const kind of ['plugin', 'agent-plugin', 'skill'] as const) {
    it('installs ' + kind + ' disabled, reinstalls after disable, and removes its source', async () => {
        const f = await fixture({});
        try {
            const request = { kind, upload: upload({ kind }) };
            const installed = value({ result: await f.binding.addons.install({ context, request }) });
            expect(installed).toMatchObject({ kind, enabled: false });
            const enabled = value({ result: await f.binding.addons.setEnabled({ context, request: { kind, id: installed.id, enabled: true } }) });
            expect(enabled.enabled).toBe(true);
            expect(value({ result: await f.binding.addons.install({ context, request }) })).toEqual(enabled);
            const disabled = value({ result: await f.binding.addons.setEnabled({ context, request: { kind, id: installed.id, enabled: false } }) });
            expect(disabled.enabled).toBe(false);
            expect(value({ result: await f.binding.addons.install({ context, request }) })).toEqual(disabled);
            value({ result: await f.binding.addons.setEnabled({ context, request: { kind, id: installed.id, enabled: true } }) });
            expect(await f.binding.addons.uninstall({ context, request: { kind, id: installed.id } })).toMatchObject({ ok: true, value: { removed: true } });
            expect(value({ result: await f.binding.addons.list({ context, query: { limit: 100 } }) }).items).toEqual([]);
            expect(await f.binding.addons.describe({ context, kind, id: installed.id, revision: installed.revision })).toMatchObject({ ok: false });
        } finally { await f.dispose(); }
    });
}

it('installs a different executable-plugin version after disable and replays that version', async () => {
    const f = await fixture({});
    try {
        const installed = value({ result: await f.binding.addons.install({ context, request: { upload: upload({ kind: 'plugin' }) } }) });
        value({ result: await f.binding.addons.setEnabled({ context, request: { kind: 'plugin', id: installed.id, enabled: true } }) });
        value({ result: await f.binding.addons.setEnabled({ context, request: { kind: 'plugin', id: installed.id, enabled: false } }) });
        const request = { upload: upload({ kind: 'plugin', version: '1.1.0' }) };
        const upgraded = value({ result: await f.binding.addons.install({ context, request }) });
        expect(upgraded).toMatchObject({ id: installed.id, version: '1.1.0', enabled: false });
        expect(upgraded.revision).not.toBe(installed.revision);
        expect(value({ result: await f.binding.addons.install({ context, request }) })).toEqual(upgraded);
        expect(value({ result: await f.binding.addons.list({ context, query: { limit: 100 } }) }).items).toEqual([upgraded]);
        value({ result: await f.binding.addons.setEnabled({ context, request: { kind: 'plugin', id: installed.id, enabled: true } }) });
        expect(f.binding.registry.list({})[0].tools[0].name).toBe('report');
    } finally { await f.dispose(); }
});

it('refuses changed bytes at an installed executable-plugin version after disable', async () => {
    const f = await fixture({});
    try {
        const request = { upload: upload({ kind: 'plugin' }) };
        const installed = value({ result: await f.binding.addons.install({ context, request }) });
        value({ result: await f.binding.addons.setEnabled({ context, request: { kind: 'plugin', id: installed.id, enabled: false } }) });
        expect(await f.binding.addons.install({ context, request: { upload: upload({ kind: 'plugin', spend: true }) } }))
            .toMatchObject({ ok: false, error: { code: 'unavailable' } });
        expect(value({ result: await f.binding.addons.list({ context, query: { limit: 100 } }) }).items).toEqual([installed]);
        expect(value({ result: await f.binding.addons.install({ context, request }) })).toEqual(installed);
    } finally { await f.dispose(); }
});

it('loads executable contributions through the injected loader only after enable', async () => {
    const f = await fixture({});
    const loaded: string[] = [];
    const effects = createNodeAddonEffects({ clock: f.dependencies.clock, ids: { next: () => 'loader-fixture' },
        async loadModule(input) { loaded.push(input.moduleUrl); return loadAddonModule(input); } });
    const binding = bindServerAddons({ ...f.dependencies, effects });
    try {
        const installed = value({ result: await binding.addons.install({ context, request: { upload: upload({ kind: 'plugin' }) } }) });
        expect(loaded).toEqual([]);
        value({ result: await binding.addons.setEnabled({ context, request: { kind: 'plugin', id: installed.id, enabled: true } }) });
        expect(loaded).toHaveLength(1);
        expect(binding.registry.list({})[0].tools[0].name).toBe('report');
    } finally {
        await binding.dispose();
        await f.dispose();
    }
});

it('restores executable contributions and retains standalone activation across binding restart', async () => {
    const f = await fixture({});
    try {
        for (const kind of ['plugin', 'skill'] as const) {
            const installed = value({ result: await f.binding.addons.install({ context, request: { upload: upload({ kind }) } }) });
            value({ result: await f.binding.addons.setEnabled({ context, request: { kind, id: installed.id, enabled: true } }) });
        }
        value({ result: await f.binding.dispose() });
        const restarted = bindServerAddons(f.dependencies);
        value({ result: await restarted.start() });
        const listed = value({ result: await restarted.addons.list({ context, query: { limit: 100 } }) });
        expect(listed.items.every(row => row.enabled)).toBe(true);
        expect(restarted.registry.list({})[0].tools[0].name).toBe('report');
        value({ result: await restarted.dispose() });
    } finally { await f.dispose(); }
});

it('seeds bundled agent plugins disabled and preserves an operator disable across restart', async () => {
    const f = await fixture({});
    try {
        const source = join(f.root, 'content/agent-plugins/fixture-agent');
        for (const [path, content] of Object.entries(agentFiles({}))) {
            await fs.mkdir(join(source, path, '..'), { recursive: true });
            await fs.writeFile(join(source, path), content);
        }
        value({ result: await f.binding.start() });
        expect(value({ result: await f.binding.addons.list({ context, query: { limit: 100 } }) }).items[0].enabled).toBe(false);
        value({ result: await f.binding.addons.setEnabled({ context, request: { kind: 'agent-plugin', id: 'fixture-agent', enabled: true } }) });
        value({ result: await f.binding.addons.setEnabled({ context, request: { kind: 'agent-plugin', id: 'fixture-agent', enabled: false } }) });
        value({ result: await bindServerAddons(f.dependencies).start() });
        expect(value({ result: await f.binding.addons.list({ context, query: { limit: 100 } }) }).items[0].enabled).toBe(false);
        expect(f.sessionEvents.some(event => event.startsWith('reload:'))).toBe(false);
    } finally { await f.dispose(); }
});

/** Write only temporary package fixtures; referenced paths remain literal manifest data. */
async function writeBundledFixture(required: { root: string; files: Record<string, string | Uint8Array> }): Promise<string> {
    const source = join(required.root, 'content/agent-plugins/fixture-agent');
    for (const [path, content] of Object.entries(required.files)) {
        await fs.mkdir(join(source, path, '..'), { recursive: true });
        await fs.writeFile(join(source, path), content);
    }
    return source;
}

/** Discover the actual published snapshot rather than relying on a test-owned layout formula. */
async function bundledSnapshot(required: { root: string }): Promise<string> {
    const addonsRoot = join(required.root, 'addons');
    const path = (await fs.readdir(addonsRoot, { recursive: true })).find(path => path.endsWith('/plugin.json'));
    if (!path) throw new Error('Fixture snapshot missing');
    return join(addonsRoot, path, '..');
}

it('seeds portable content and declared bindings, excluding dependency and build trees', async () => {
    const f = await fixture({});
    try {
        const files = agentFiles({});
        const manifest = JSON.parse(files['plugin.json']);
        manifest.extensions['io.github.ainsep.openmarketing'].capabilities = {
            'fixture-read': { binding: './io.github.ainsep.openmarketing/bindings/read.json' },
        };
        const bindingPath = 'io.github.ainsep.openmarketing/bindings/read.json';
        const binaryPath = 'skills/fixture-skill/references/asset.bin';
        const source = await writeBundledFixture({ root: f.root, files: { ...files, 'plugin.json': JSON.stringify(manifest),
            [bindingPath]: '{"effects":["read"]}', [binaryPath]: Uint8Array.from([0, 255, 1]),
            LICENSE: 'Fixture license', NOTICE: 'Fixture notice', 'package.json': '{}',
            'io.github.ainsep.openmarketing/src/index.ts': 'development-only',
            'io.github.ainsep.openmarketing/undeclared.json': '{}',
        } });
        const artifacts = ['node_modules', 'dist', 'build', '.git', '.cache', '.turbo', '.vite', 'coverage'];
        for (const directory of artifacts) {
            for (const prefix of ['', 'skills/fixture-skill/']) {
                // A copied marker would make the upload ambiguous; a walked link would fail closed.
                await fs.mkdir(join(source, prefix, directory), { recursive: true });
                await fs.writeFile(join(source, prefix, directory, 'plugin.json'), '{}');
                await fs.symlink('/outside-fixture', join(source, prefix, directory, 'link'));
            }
        }
        await fs.writeFile(join(source, 'skills/fixture-skill/build.tsbuildinfo'), 'cache');
        value({ result: await f.binding.start() });
        const snapshot = await bundledSnapshot({ root: f.root });
        expect((await fs.readdir(snapshot, { recursive: true })).sort()).toEqual([
            'LICENSE', 'NOTICE', 'plugin.json', 'mcp.json', 'skills', 'skills/fixture-skill', 'skills/fixture-skill/SKILL.md',
            'skills/fixture-skill/references', binaryPath, 'io.github.ainsep.openmarketing',
            'io.github.ainsep.openmarketing/bindings', bindingPath,
        ].sort());
        expect(await fs.readFile(join(snapshot, binaryPath))).toEqual(Buffer.from([0, 255, 1]));
        expect(await fs.readFile(join(snapshot, bindingPath), 'utf8')).toBe('{"effects":["read"]}');
        expect((await fs.stat(snapshot)).mode & 0o222).toBe(0);
        const addon = value({ result: await f.binding.addons.list({ context, query: { limit: 100 } }) }).items[0];
        expect(addon).toMatchObject({ id: 'fixture-agent', enabled: false });
        value({ result: await f.binding.addons.setEnabled({ context, request: { kind: 'agent-plugin', id: addon.id, enabled: true } }) });
        expect(value({ result: await f.binding.addons.describe({ context, kind: 'agent-plugin', id: addon.id, revision: addon.revision }) }).effects).toContain('read');
    } finally { await f.dispose(); }
});

it('skips extraction on unchanged restart and snapshots only changed package content', async () => {
    const f = await fixture({});
    // Instrument the injected copy, preserving the native overloads and all real filesystem effects.
    const filesystem = { ...f.dependencies.effects.filesystem };
    const mkdtemp = vi.spyOn(filesystem, 'mkdtemp');
    const dependencies = { ...f.dependencies, effects: { ...f.dependencies.effects,
        filesystem } };
    try {
        const source = await writeBundledFixture({ root: f.root, files: { ...agentFiles({}), 'node_modules/ignored.txt': 'first' } });
        value({ result: await bindServerAddons(dependencies).start() });
        expect(mkdtemp).toHaveBeenCalled();
        const first = value({ result: await f.binding.addons.list({ context, query: { limit: 100 } }) }).items[0];
        const snapshot = await bundledSnapshot({ root: f.root });
        mkdtemp.mockClear();
        await fs.writeFile(join(source, 'node_modules/ignored.txt'), 'changed development artifact');
        value({ result: await bindServerAddons(dependencies).start() });
        expect(mkdtemp).not.toHaveBeenCalled();
        expect(value({ result: await f.binding.addons.list({ context, query: { limit: 100 } }) }).items[0]).toEqual(first);
        expect(await bundledSnapshot({ root: f.root })).toBe(snapshot);
        expect(await fs.readFile(join(snapshot, 'skills/fixture-skill/SKILL.md'), 'utf8')).toBe(markdown);
        await fs.writeFile(join(source, 'skills/fixture-skill/SKILL.md'), markdown + '\nUpdated fixture.');
        value({ result: await bindServerAddons(dependencies).start() });
        expect(mkdtemp).toHaveBeenCalled();
        const updated = value({ result: await f.binding.addons.list({ context, query: { limit: 100 } }) }).items[0];
        expect(updated.revision).not.toBe(first.revision);
        expect(updated.enabled).toBe(false);
        expect(await fs.readFile(join(snapshot, '..', updated.revision, 'skills/fixture-skill/SKILL.md'), 'utf8')).toBe(markdown + '\nUpdated fixture.');
    } finally { mkdtemp.mockRestore(); await f.dispose(); }
});

it('recreates a missing digest snapshot while keeping the same catalog revision', async () => {
    const f = await fixture({});
    try {
        await writeBundledFixture({ root: f.root, files: agentFiles({}) });
        value({ result: await f.binding.start() });
        const first = value({ result: await f.binding.addons.list({ context, query: { limit: 100 } }) }).items[0];
        const snapshot = await bundledSnapshot({ root: f.root });
        await removeStateRoot({ path: snapshot });
        value({ result: await bindServerAddons(f.dependencies).start() });
        expect(value({ result: await f.binding.addons.list({ context, query: { limit: 100 } }) }).items[0]).toEqual(first);
        expect(await fs.readFile(join(snapshot, 'skills/fixture-skill/SKILL.md'), 'utf8')).toBe(markdown);
    } finally { await f.dispose(); }
});

it.each(['../outside.json', './node_modules/binding.json', './dist/binding.json', './.git/binding.json', './missing.json'])('fails boot on invalid or missing declared binding %s', async binding => {
    const f = await fixture({});
    try {
        const files = agentFiles({});
        const manifest = JSON.parse(files['plugin.json']);
        manifest.extensions['io.github.ainsep.openmarketing'].capabilities = { 'fixture-read': { binding } };
        await writeBundledFixture({ root: f.root, files: { ...files, 'plugin.json': JSON.stringify(manifest) } });
        expect(await f.binding.start()).toMatchObject({ ok: false });
        expect(value({ result: await f.binding.addons.list({ context, query: { limit: 100 } }) }).items).toEqual([]);
    } finally { await f.dispose(); }
});

it('removes frozen state and leaves symlink targets untouched, including repeated cleanup', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'om-frozen-cleanup-'));
    const state = join(root, 'state');
    const outside = join(root, 'outside');
    try {
        await fs.mkdir(join(state, 'snapshot'), { recursive: true });
        await fs.mkdir(outside);
        await fs.writeFile(join(state, 'snapshot/plugin.json'), '{}', { mode: 0o444 });
        await fs.writeFile(join(outside, 'keep.txt'), 'untouched');
        await fs.symlink(outside, join(state, 'external'));
        for (const path of [state, join(state, 'snapshot'), outside]) await fs.chmod(path, 0o555);
        await removeStateRoot({ path: state });
        await expect(fs.stat(state)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await fs.readFile(join(outside, 'keep.txt'), 'utf8')).toBe('untouched');
        expect((await fs.stat(outside)).mode & 0o222).toBe(0);
        await expect(removeStateRoot({ path: state })).resolves.toBeUndefined();
    } finally { await removeStateRoot({ path: root }); }
});

it('rejects wrong-kind and ambiguous root uploads before any package publication', async () => {
    const f = await fixture({});
    try {
        const agent = upload({ kind: 'agent-plugin' });
        expect(await f.binding.addons.install({ context, request: { kind: 'skill', upload: agent } })).toMatchObject({ ok: false });
        const ambiguous = filesUpload({ files: { 'plugin.json': '{}', 'jini.plugin.json': '{}' } });
        expect(await f.binding.addons.install({ context, request: { upload: ambiguous } })).toMatchObject({ ok: false });
        expect(value({ result: await f.binding.addons.list({ context, query: { limit: 100 } }) }).items).toEqual([]);
    } finally { await f.dispose(); }
});

it('refuses changed-byte installs and crosses neither owner nor workspace storage', async () => {
    const f = await fixture({});
    try {
        value({ result: await f.binding.addons.install({ context, request: { upload: upload({ kind: 'agent-plugin' }) } }) });
        expect(await f.binding.addons.install({ context, request: { upload: upload({ kind: 'agent-plugin', spend: true }) } })).toMatchObject({ ok: false, error: { code: 'conflict' } });
        expect(await f.binding.addons.list({ context: { ...context, scope: { ...context.scope, ownerId: 'another-owner' } }, query: { limit: 100 } })).toMatchObject({ ok: false });
    } finally { await f.dispose(); }
});

/** ZIP and folder transports share identical detection; strict ZIP decoding is Jini-owned. */
it('uses the injected archive reader, retains binary assets and always closes the ZIP', async () => {
    const binary = new Uint8Array([0, 255, 128]);
    let closed = false;
    const reader = { async open() { return { entries: (async function* () {
        yield { kind: 'file' as const, path: 'folder/jini.plugin.json', size: 2, async *read() { yield Buffer.from('{}'); } };
        yield { kind: 'file' as const, path: 'folder/client/asset.bin', size: 3, async *read() { yield binary; } };
    })(), close() { closed = true; } }; } };
    const result = value({ result: await decodeAddonUpload({ upload: { kind: 'zip', base64: 'AAAA' }, archiveReader: reader }) });
    expect(result.kind).toBe('plugin');
    expect([...result.files.get('client/asset.bin')!]).toEqual([...binary]);
    expect(closed).toBe(true);
});

it('rejects duplicate normalized ZIP paths, links and observed expansion overflow and closes each archive', async () => {
    for (const attack of ['duplicate', 'link', 'overflow'] as const) {
        let closed = false;
        const reader = { async open() { return { entries: (async function* () {
            yield { kind: 'file' as const, path: 'SKILL.md', size: 1, async *read() { yield Buffer.from('a'); } };
            yield { kind: attack === 'link' ? 'other' as const : 'file' as const,
                path: attack === 'duplicate' ? 'SKILL.md' : 'other.bin', size: 1,
                async *read() { yield new Uint8Array(16777217); } };
        })(), close() { closed = true; } }; } };
        expect(await decodeAddonUpload({ upload: { kind: 'zip', base64: 'AAAA' }, archiveReader: reader })).toMatchObject({ ok: false });
        expect(closed).toBe(true);
    }
});

it('authenticates before reading the large install body and rejects plaintext management fields', async () => {
    const f = await fixture({});
    let reads = 0;
    try {
        const request = { method: 'POST' as const, path: '/api/addons/v1/install', async readBody() { reads++; return { ok: true as const, value: { upload: upload({ kind: 'skill' }) } }; } };
        expect((await handleAddonRequest({ request, context: { ...context, principal: { kind: 'service', serviceId: 'fixture' } }, addons: f.binding.addons })).status).toBe(403);
        expect(reads).toBe(0);
        expect((await handleAddonRequest({ request, context, addons: f.binding.addons })).status).toBe(200);
        expect((await handleAddonRequest({ request: { method: 'POST', path: '/api/addons/v1/set-enabled', body: { kind: 'skill', id: 'fixture-skill', enabled: true, plaintext: 'fixture-secret' } }, context, addons: f.binding.addons })).status).toBe(400);
        expect(JSON.stringify(f.events)).not.toContain('fixture-secret');
    } finally { await f.dispose(); }
});

it('failed enable removes partial contributions and leaves durable activation disabled', async () => {
    const f = await fixture({});
    try {
        const installed = value({ result: await f.binding.addons.install({ context, request: { upload: upload({ kind: 'plugin' }) } }) });
        const effects = { ...f.dependencies.effects, async importModule() { return { definition: { setup() { throw new Error('fixture-secret'); } } }; } };
        const failed = bindServerAddons({ ...f.dependencies, effects });
        expect(await failed.addons.setEnabled({ context, request: { kind: 'plugin', id: installed.id, enabled: true } })).toMatchObject({ ok: false });
        expect(failed.registry.list({})).toEqual([]);
        expect(value({ result: await failed.addons.list({ context, query: { limit: 100 } }) }).items[0].enabled).toBe(false);
        expect(JSON.stringify(f.events)).not.toContain('fixture-secret');
    } finally { await f.dispose(); }
});

/** The same repository assertions target memory and real SQLite, including scope separation. */
for (const adapter of ['memory', 'sqlite'] as const) {
    it(adapter + ' catalog preserves revision/activation, isolates scope and removes rows', async () => {
        const sql = sqlFixture({});
        const rows = new Map<string, AddonSummary>();
        const key = (input: { context: CallContext; kind?: string; id?: string }) => JSON.stringify([input.context.scope, input.kind, input.id]);
        const memory: AddonRepository = { async list(input) { return [...rows].filter(([name]) => name.startsWith(JSON.stringify([input.context.scope]).slice(0, -1))).map(([, row]) => row); },
            async save(input) { rows.set(key({ ...input, kind: input.addon.kind, id: input.addon.id }), input.addon); }, async remove(input) { rows.delete(key(input)); } };
        const repo = adapter === 'memory' ? memory : createSqlAddonRepository({ db: sql.db });
        try {
            const addon: AddonSummary = { id: 'fixture', kind: 'skill', name: 'Fixture', version: '1', description: '', enabled: false, revision: 'revision1' };
            await repo.save({ context, addon });
            await repo.save({ context, addon: { ...addon, enabled: true } });
            expect(await repo.list({ context })).toEqual([{ ...addon, enabled: true }]);
            expect(await repo.list({ context: { ...context, scope: { ...context.scope, ownerId: 'other' } } })).toEqual([]);
            await repo.remove({ context, kind: addon.kind, id: addon.id });
            expect(await repo.list({ context })).toEqual([]);
        } finally { sql.native.close(); }
    });
}

// Deterministic fixture ZIPs, generated with Python's standard zipfile; regular files only.
const zipFixtures = {
    "plugin": "UEsDBBQAAAAIAAAATl2rAucl4AAAAE4BAAAQAAAAamluaS5wbHVnaW4uanNvbkWOQW7DIBBFr2Kxrl1jih33AD1At1UqDTB2JnHAAlylinz3ApHSFfr/vY/mzsiw94pNdIubx3pdtpkse6mYhStm8vEg1T/5QR/I2Qx50zZt7oK5fIKdy+L72aJNk9zxFCKhzzi/tchYwwqKFkpNSOSLReeW0HicKcQkH5Nzcu5SYA4T4WKeSTsbPaktlvX9sS7/eFydj+y4J4tsxNlT/C1OQJ/OfyVr8NZcz1ln4QSd7GujWqkn4Fz2CvuuM+agQQqtlOgHMXXAtRG9keMoBz2pEQ+gxwHkiJ3iGt7Yvv8BUEsDBBQAAAAIAAAATl2Q3//2gQAAAKMAAAAQAAAAc2VydmVyL2luZGV4Lm1qczXNQQoDIQwF0KuIK4VhDmD3vUBPYE2GsXVUYoQpwbvXtnSRz4fPI3jWQqwAN98TK5kl5sixZCcNuVfT4GllxsqlpLZ6ACPZH+g04cfqBbAFivWL9DWe3AnVf4y5dr6FHQ/vhF91unJ/YGA9lt1nSEjGCs1XlJVsP+2YOo4x7LzLG1BLAQIUAxQAAAAIAAAATl2rAucl4AAAAE4BAAAQAAAAAAAAAAAAAACAgQAAAABqaW5pLnBsdWdpbi5qc29uUEsBAhQDFAAAAAgAAABOXZDf//aBAAAAowAAABAAAAAAAAAAAAAAAICBDgEAAHNlcnZlci9pbmRleC5tanNQSwUGAAAAAAIAAgB8AAAAvQEAAAAA",
    "agent-plugin": "UEsDBBQAAAAIAAAATl3lUUgwdAAAAJ4AAAALAAAAcGx1Z2luLmpzb24tjEEOgzAMBL8SWT0WG648gH9EwQ1pIUSxQZWq/r0J6W01u7MfuIlbeLMwGlhUk4xE1nPULq2HD1Fwz57aRmjAAXtqDTaIT9kj3A1Eu3F9eYS3Hpm766UWJ2cJZVO6YmNf2czickj651NzzOWYZN2rJPj+AFBLAwQUAAAACAAAAE5duOhxDkkAAABgAAAAHQAAAHNraWxscy9maXh0dXJlLXNraWxsL1NLSUxMLm1k09XV5apWykvMTVWyUkrLrCgpLUrVLc7OzMlR0lFKSS1OLsosKMnMzwPKukFkFTLzikuKSpNBosVKtVy6QBOgUrr5eTmVKPJ6AFBLAwQUAAAACAAAAE5dEM3JJ1AAAABYAAAACAAAAG1jcC5qc29uq1ZSKU7OSM1NVLJSUMooKSkottLXT0xPzSvRLcgpTc/MK9bLL0rXh6gp1jfUM9Qz0M9NLtCDiOhlFefnKekoKAGFglOLylKLioEGVdfWAgBQSwECFAMUAAAACAAAAE5d5VFIMHQAAACeAAAACwAAAAAAAAAAAAAAgIEAAAAAcGx1Z2luLmpzb25QSwECFAMUAAAACAAAAE5duOhxDkkAAABgAAAAHQAAAAAAAAAAAAAAgIGdAAAAc2tpbGxzL2ZpeHR1cmUtc2tpbGwvU0tJTEwubWRQSwECFAMUAAAACAAAAE5dEM3JJ1AAAABYAAAACAAAAAAAAAAAAAAAgIEhAQAAbWNwLmpzb25QSwUGAAAAAAMAAwC6AAAAlwEAAAAA",
    "skill": "UEsDBBQAAAAIAAAATl246HEOSQAAAGAAAAAIAAAAU0tJTEwubWTT1dXlqlbKS8xNVbJSSsusKCktStUtzs7MyVHSUUpJLU4uyiwoyczPA8q6QWQVMvOKS4pKk0GixUq1XLpAE6BSuvl5OZUo8noAUEsBAhQDFAAAAAgAAABOXbjocQ5JAAAAYAAAAAgAAAAAAAAAAAAAAICBAAAAAFNLSUxMLm1kUEsFBgAAAAABAAEANgAAAG8AAAAAAA=="
} as const;

for (const kind of ['plugin', 'agent-plugin', 'skill'] as const) {
    it('installs a real yauzl-decoded ' + kind + ' ZIP through the same upload flow', async () => {
        const f = await fixture({});
        try {
            const installed = value({ result: await f.binding.addons.install({ context, request: { upload: { kind: 'zip', base64: zipFixtures[kind] } } }) });
            expect(installed).toMatchObject({ kind, enabled: false });
        } finally { await f.dispose(); }
    });
}

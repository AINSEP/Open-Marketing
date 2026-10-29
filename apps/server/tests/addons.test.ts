/** D2 written-only fixtures: native SQLite and published Jini hosts; no vendors or real credentials. */
import { readFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { removeStateRoot } from './state-root.js';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, it, vi } from 'vitest';
import { createAgentPluginLayout } from '@jini-ai/agent-plugins/lifecycle';
import type { ArchiveEntry, ArchiveReaderPort } from '@jini-ai/agentic/skills/install';
import type { AddonKind, AddonSummary, AddonUpload, AppError, CallContext, Outcome, ObserverPort } from '@open-marketing/contracts';
import type { CredentialSqlPort } from '@open-marketing/credentials';
import { bindServerAddons, createNodeAddonEffects } from '../src/composition/addons.js';
import { loadAddonModule } from '../src/composition/serve.js';
import { createSqlAddonRepository } from '../src/addons.js';
import { addonBoundary, createMemoryPluginRepo, createPluginService } from '@open-marketing/plugins';
import type { AddonPackageAdapter } from '@open-marketing/plugins';
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
    return { 'plugin.json': JSON.stringify({ $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json', name: 'fixture-agent', version: '1.0.0',
        description: 'Fixture agent package', extensions: { 'io.github.ainsep.openmarketing': { capabilities: [{ effects: required.spend ? ['ad_spend', 'future_effect'] : ['read'] }] } } }),
        'skills/fixture-skill/SKILL.md': markdown, 'mcp.json': JSON.stringify({ $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json', mcpServers: {} }) };
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
        audit: { async record() { return { ok: true as const, value: undefined }; } },
        async runningJobs() { return { ok: true as const, value: 0 }; },
        yamlReader: { read({ yaml }: { yaml: string }) { return JSON.parse(yaml); } }, sessions };
    const binding = bindServerAddons(dependencies);
    return { root, native, db, dependencies, binding, events, sessionEvents,
        async dispose() { await binding.dispose(); native.close(); await removeStateRoot({ path: root }); } };
}


/** Fixture package boundary runs the same service scenarios as the composed Jini adapters. */
function fixtureService(required: { f: Awaited<ReturnType<typeof fixture>>; kind: AddonKind }) {
    const backend: AddonPackageAdapter = {
        async prepare(input) { return { summary: { id: 'fixture-' + required.kind, kind: required.kind, name: 'Fixture', version: '1.0.0', description: '', enabled: false, revision: input.revision }, async commit() {} }; },
        async setEnabled() {}, async remove() {}, async describe() { return { instructions: 'fixture' }; },
    };
    return createPluginService({ repo: createMemoryPluginRepo({}), packages: { plugin: backend, 'agent-plugin': backend, skill: backend },
        ids: { next: () => required.f.dependencies.effects.ids.newId() }, audit: required.f.dependencies.audit, runningJobs: required.f.dependencies.runningJobs, observer: required.f.dependencies.observer,
        decodeUpload: (input, options) => decodeAddonUpload({ ...input, archiveReader: required.f.dependencies.effects.archiveReader }, options) });
}

for (const kind of ['plugin', 'agent-plugin', 'skill'] as const) {
    for (const adapter of ['fixture', 'composed'] as const) it(adapter + ' installs ' + kind + ' disabled, reinstalls after disable, and removes its source', async () => {
        const f = await fixture({});
        const service = adapter === 'composed' ? f.binding.addons : fixtureService({ f, kind });
        try {
            const request = { kind, upload: upload({ kind }) };
            const installed = value({ result: await service.install({ context, request }) });
            expect(installed).toMatchObject({ kind, enabled: false });
            const enabled = value({ result: await service.setEnabled({ context, request: { kind, id: installed.id, enabled: true } }) });
            expect(enabled.enabled).toBe(true);
            expect(value({ result: await service.install({ context, request }) })).toEqual(enabled);
            const disabled = value({ result: await service.setEnabled({ context, request: { kind, id: installed.id, enabled: false } }) });
            expect(disabled.enabled).toBe(false);
            expect(value({ result: await service.install({ context, request }) })).toEqual(disabled);
            value({ result: await service.setEnabled({ context, request: { kind, id: installed.id, enabled: true } }) });
            expect(await service.uninstall({ context, request: { kind, id: installed.id } })).toMatchObject({ ok: true, value: { removed: true } });
            expect(value({ result: await service.list({ context, query: { limit: 100 } }) }).items).toEqual([]);
            expect(await service.describe({ context, kind, id: installed.id, revision: installed.revision })).toMatchObject({ ok: false });
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
            .toMatchObject({ ok: false, error: { code: 'conflict' } });
        expect(value({ result: await f.binding.addons.list({ context, query: { limit: 100 } }) }).items).toEqual([installed]);
        expect(value({ result: await f.binding.addons.install({ context, request }) })).toEqual(installed);
    } finally { await f.dispose(); }
});

it('refuses changed installed skills before closing the enabled runtime', async () => {
    const f = await fixture({});
    try {
        const installed = value({ result: await f.binding.addons.install({ context, request: { upload: upload({ kind: 'skill' }) } }) });
        const enabled = value({ result: await f.binding.addons.setEnabled({ context, request: { kind: 'skill', id: installed.id, enabled: true } }) });
        const replacement = filesUpload({ files: { 'SKILL.md': markdown + '\nChanged instructions.' } });
        expect(await f.binding.addons.install({ context, request: { upload: replacement } })).toMatchObject({ ok: false, error: { code: 'conflict' } });
        expect(value({ result: await f.binding.addons.list({ context, query: { limit: 100 } }) }).items).toEqual([enabled]);
        expect(value({ result: await f.binding.addons.describe({ context, kind: 'skill', id: installed.id, revision: installed.revision, skill: 'fixture-skill' }) }).instructions).toBe(markdown);
    } finally { await f.dispose(); }
});

it('refuses bundled Agent Plugin replacement before closing the enabled runtime', async () => {
    const f = await fixture({});
    try {
        await writeBundledFixture({ root: f.root, files: agentFiles({}) });
        value({ result: await f.binding.start() });
        const installed = value({ result: await f.binding.addons.list({ context, query: { limit: 100 } }) }).items[0];
        expect(await f.binding.readOAuthMetadata({ context, pluginId: installed.id })).toEqual({ ok: true, value: null });
        const enabled = value({ result: await f.binding.addons.setEnabled({ context, request: { kind: 'agent-plugin', id: installed.id, enabled: true } }) });
        expect(await f.binding.addons.install({ context, request: { upload: upload({ kind: 'agent-plugin', spend: true }) } })).toMatchObject({ ok: false, error: { code: 'conflict' } });
        expect(value({ result: await f.binding.addons.list({ context, query: { limit: 100 } }) }).items).toEqual([enabled]);
        expect(value({ result: await f.binding.addons.describe({ context, kind: 'agent-plugin', id: installed.id, revision: installed.revision, skill: 'fixture-skill' }) }).instructions).toBe(markdown);
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

it.each([true, false])('seeds enabled model-only data without capabilities.json and preserves admission %s', async admitted => {
    const f = await fixture({});
    try {
        const manifest = { $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',  name: 'fixture-agent', version: '1.0.0', description: 'Fixture models',
            extensions: { 'io.github.ainsep.openmarketing': { version: 1, provides: ['model'], enabled: true, admitted, capabilities: {},
                modelProvider: { protocol: 'openai', endpoint: 'https://models.example.test', label: 'Fixture models',
                    models: [{ id: 'fixture-model', label: 'Fixture model', efforts: [] }] } } } };
        await writeBundledFixture({ root: f.root, files: { 'plugin.json': JSON.stringify(manifest) } });
        value({ result: await f.binding.start() });
        expect(value({ result: await f.binding.addons.list({ context, query: { limit: 100 } }) }).items[0]).toMatchObject({ enabled: true });
        expect(await f.binding.agentPluginState({ context, pluginId: 'fixture-agent' }))
            .toMatchObject({ enabled: true, admitted, capabilities: [], metadata: manifest.extensions['io.github.ainsep.openmarketing'] });
    } finally { await f.dispose(); }
});

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
            'io.github.ainsep.openmarketing/oauth.json': '{"fixture":true}',
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
            'io.github.ainsep.openmarketing/oauth.json',
        ].sort());
        expect(await fs.readFile(join(snapshot, binaryPath))).toEqual(Buffer.from([0, 255, 1]));
        expect(await fs.readFile(join(snapshot, bindingPath), 'utf8')).toBe('{"effects":["read"]}');
        expect((await fs.stat(snapshot)).mode & 0o222).toBe(0);
        const addon = value({ result: await f.binding.addons.list({ context, query: { limit: 100 } }) }).items[0];
        expect(addon).toMatchObject({ id: 'fixture-agent', enabled: false });
        expect(value({ result: await f.binding.readOAuthMetadata({ context, pluginId: addon.id }) })).toBe('{"fixture":true}');
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

it('replaces changed agent-plugin bytes disabled and crosses neither owner nor workspace storage', async () => {
    const f = await fixture({});
    try {
        value({ result: await f.binding.addons.install({ context, request: { upload: upload({ kind: 'agent-plugin' }) } }) });
        expect(await f.binding.addons.install({ context, request: { upload: upload({ kind: 'agent-plugin', spend: true }) } })).toMatchObject({ ok: true, value: { enabled: false } });
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

/** A valid skill marker followed by caller-supplied entries; closure state belongs to each reader.
 * @complexity O(n) iteration for n supplied entries, O(1) iterator state; no ZIP encoding or I/O.
 */
function stubArchive(required: { entries: ArchiveEntry[] }) {
    let closed = false;
    const reader: ArchiveReaderPort = { async open() { return { entries: (async function* () {
        yield { kind: 'file' as const, path: 'SKILL.md', size: Buffer.byteLength(markdown), async *read() { yield Buffer.from(markdown); } };
        yield* required.entries;
    })(), close() { closed = true; } }; } };
    return { reader, closed: () => closed };
}

it('refuses ZIP traversal before installation and closes the archive', async () => {
    const f = await fixture({});
    const archive = stubArchive({ entries: [{ kind: 'file', path: '../x', size: 1, async *read() { yield Buffer.from('x'); } }] });
    const binding = bindServerAddons({ ...f.dependencies, effects: { ...f.dependencies.effects, archiveReader: archive.reader } });
    try {
        // Covers the entry-path and appendFile path guards together, before Jini installation.
        expect(await binding.addons.install({ context, request: { upload: { kind: 'zip', base64: 'AAAA' } } })).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
        expect(value({ result: await binding.addons.list({ context, query: { limit: 100 } }) }).items).toEqual([]);
        expect(archive.closed()).toBe(true);
    } finally { await binding.dispose(); await f.dispose(); }
});

it('accepts 4096 ZIP entries and refuses 4097 before installation, counting directories', async () => {
    const f = await fixture({});
    const entries: ArchiveEntry[] = Array.from({ length: 4096 }, (_, index) => ({ kind: 'directory', path: 'd' + index + '/', size: 0, async *read() {} }));
    const archive = stubArchive({ entries });
    const binding = bindServerAddons({ ...f.dependencies, effects: { ...f.dependencies.effects, archiveReader: archive.reader } });
    try {
        const control = stubArchive({ entries: entries.slice(0, -1) });
        expect(await decodeAddonUpload({ upload: { kind: 'zip', base64: 'AAAA' }, archiveReader: control.reader })).toMatchObject({ ok: true });
        expect(await binding.addons.install({ context, request: { upload: { kind: 'zip', base64: 'AAAA' } } })).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
        expect(value({ result: await binding.addons.list({ context, query: { limit: 100 } }) }).items).toEqual([]);
        expect(archive.closed()).toBe(true);
    } finally { await binding.dispose(); await f.dispose(); }
});

it('refuses ZIP expansion over 32 MiB before installation with each file within 16 MiB', async () => {
    const f = await fixture({});
    const chunk = new Uint8Array(1048576);
    const read = vi.fn(async function* () { for (let index = 0; index < 16; index++) yield chunk; });
    const archive = stubArchive({ entries: ['a.bin', 'b.bin'].map(path => ({ kind: 'file', path, size: 16777216, read })) });
    const binding = bindServerAddons({ ...f.dependencies, effects: { ...f.dependencies.effects, archiveReader: archive.reader } });
    try {
        // SKILL.md plus a.bin leave less than 16 MiB; b.bin must be refused before its read.
        expect(await binding.addons.install({ context, request: { upload: { kind: 'zip', base64: 'AAAA' } } })).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
        expect(read).toHaveBeenCalledTimes(1);
        expect(value({ result: await binding.addons.list({ context, query: { limit: 100 } }) }).items).toEqual([]);
        expect(archive.closed()).toBe(true);
    } finally { await binding.dispose(); await f.dispose(); }
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
        const repo = adapter === 'memory' ? createMemoryPluginRepo({}) : createSqlAddonRepository({ db: sql.db });
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

it.each(['plugin', 'agent-plugin', 'skill'] as const)('real %s adapter retains bytes during activity and job-start races', async kind => {
    const f = await fixture({}); let count = 1; let reads = 0; let race = false;
    const binding = bindServerAddons({ ...f.dependencies, async runningJobs() {
        reads++; return { ok: true, value: race && reads > 1 ? 1 : count };
    } });
    try {
        const installed = value({ result: await binding.addons.install({ context, request: { upload: upload({ kind }) } }) });
        value({ result: await binding.addons.setEnabled({ context, request: { kind, id: installed.id, enabled: true } }) });
        const request = { kind, id: installed.id };
        expect(await binding.addons.uninstall({ context, request })).toMatchObject({ ok: false, error: { code: 'conflict' } });
        expect(value({ result: await binding.addons.describe({ context, kind, id: installed.id, revision: installed.revision, skill: 'fixture-skill' }) })).toBeDefined();
        count = 0; reads = 0; race = true;
        expect(await binding.addons.uninstall({ context, request })).toMatchObject({ ok: false, error: { code: 'conflict' } });
        expect(value({ result: await binding.addons.list({ context, query: { limit: 100 } }) }).items[0]).toMatchObject({ enabled: false, revision: installed.revision });
        race = false;
        expect(await binding.addons.uninstall({ context, request })).toMatchObject({ ok: true });
    } finally { await binding.dispose(); await f.dispose(); }
});

it('real composition refuses audit failure before package effects or closing an enabled runtime', async () => {
    const f = await fixture({}); let reject = true;
    const operations: string[] = [];
    const binding = bindServerAddons({ ...f.dependencies, audit: { async record(input) {
        operations.push(input.operation);
        return reject ? { ok: false, error: { code: 'unavailable', message: 'Audit unavailable', retryable: false } } : { ok: true, value: undefined };
    } } });
    try {
        const request = { upload: upload({ kind: 'plugin' }) };
        expect(await binding.addons.install({ context, request })).toMatchObject({ ok: false });
        expect(value({ result: await binding.addons.list({ context, query: { limit: 100 } }) }).items).toEqual([]);
        reject = false;
        const installed = value({ result: await binding.addons.install({ context, request }) });
        value({ result: await binding.addons.setEnabled({ context, request: { kind: 'plugin', id: installed.id, enabled: true } }) });
        reject = true;
        expect(await binding.addons.uninstall({ context, request: { kind: 'plugin', id: installed.id } })).toMatchObject({ ok: false });
        expect(binding.registry.list({})).toHaveLength(1);
        expect(operations).toEqual(['install.requested', 'install.requested', 'install.completed', 'enable.requested', 'uninstall.requested']);
    } finally { await binding.dispose(); await f.dispose(); }
});

it('Jini replacement pins the resolved old package and publishes the new revision disabled', async () => {
    const f = await fixture({});
    try {
        const first = value({ result: await f.binding.addons.install({ context, request: { upload: upload({ kind: 'agent-plugin' }) } }) });
        value({ result: await f.binding.addons.setEnabled({ context, request: { kind: 'agent-plugin', id: first.id, enabled: true } }) });
        const replacement = value({ result: await f.binding.addons.install({ context, request: { upload: upload({ kind: 'agent-plugin', spend: true }) } }) });
        expect(replacement).toMatchObject({ id: first.id, enabled: false }); expect(replacement.revision).not.toBe(first.revision);
        expect(await f.binding.addons.describe({ context, kind: first.kind, id: first.id, revision: first.revision })).toMatchObject({ ok: false });
        value({ result: await f.binding.addons.setEnabled({ context, request: { kind: 'agent-plugin', id: first.id, enabled: true } }) });
        expect(value({ result: await f.binding.addons.describe({ context, kind: first.kind, id: first.id, revision: replacement.revision }) }).effects).toContain('ad_spend');
    } finally { await f.dispose(); }
});

it('files a committed Agent Plugin update journal at startup before accepting another revision', async () => {
    const f = await fixture({});
    const restarted = bindServerAddons(f.dependencies);
    try {
        const installed = value({ result: await f.binding.addons.install({ context, request: { upload: upload({ kind: 'agent-plugin' }) } }) });
        const scopeId = createHash('sha256').update(JSON.stringify([context.scope.ownerId, context.scope.workspaceId])).digest('hex');
        const layout = createAgentPluginLayout({ root: join(f.root, 'addons', scopeId, 'agent-plugins') });
        const pluginRoot = layout.forWorkspace({ workspaceId: scopeId }).pluginRootDir({ pluginId: installed.id });
        const journalPath = join(pluginRoot, 'update-journal.json');
        const journal = { schemaVersion: 1, pluginId: installed.id, actor: 'fixture-owner', enabled: false,
            fromDigest: 'a'.repeat(64), toDigest: createHash('sha256').update(Buffer.from(installed.revision, 'hex')).digest('hex'),
            transactionId: 'fixture-interrupted-update', startedAt: '2026-10-27T00:00:00.000Z', state: 'committed' };
        await fs.writeFile(journalPath, JSON.stringify(journal));
        value({ result: await f.binding.dispose() });
        value({ result: await restarted.start() });
        // Mutation also settles committed journals in Jini: assert boot recovery before any upload.
        await expect(fs.readFile(journalPath)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(JSON.parse(await fs.readFile(join(pluginRoot, 'update-history', journal.transactionId + '.json'), 'utf8'))).toEqual(journal);
        expect(await restarted.addons.install({ context, request: { upload: upload({ kind: 'agent-plugin', spend: true }) } }))
            .toMatchObject({ ok: true, value: { id: installed.id, enabled: false } });
    } finally { await restarted.dispose(); await f.dispose(); }
});

it('failed catalog disable still closes real executable resources before returning', async () => {
    const f = await fixture({});
    try {
        const installed = value({ result: await f.binding.addons.install({ context, request: { upload: upload({ kind: 'plugin' }) } }) });
        value({ result: await f.binding.addons.setEnabled({ context, request: { kind: 'plugin', id: installed.id, enabled: true } }) });
        f.native.exec("CREATE TRIGGER refuse_catalog_save BEFORE UPDATE ON addon_package BEGIN SELECT RAISE(ABORT, 'fixture failure'); END");
        expect(await f.binding.addons.setEnabled({ context, request: { kind: 'plugin', id: installed.id, enabled: false } })).toMatchObject({ ok: false, error: { retryable: false } });
        expect(f.binding.registry.list({})).toEqual([]);
    } finally { await f.dispose(); }
});


it('merges scoped conversion settings into live plugin metadata without disabling state on a corrupt override', async () => {
    const f = await fixture({}); const pluginId = 'fixture-agent';
    f.native.exec(readFileSync(new URL('../migrations/0006_alerts.sql', import.meta.url), 'utf8'));
    const metadata = { version: 1, provides: ['model'], enabled: true, admitted: false, capabilities: {},
        conversionSettings: { fields: [{ name: 'target', label: 'Target', kind: 'string', format: 'decimal-id' }] },
        modelProvider: { protocol: 'openai', endpoint: 'https://models.example.test', label: 'Fixture', models: [{ id: 'fixture', label: 'Fixture', efforts: [] }] } };
    try {
        await writeBundledFixture({ root: f.root, files: { 'plugin.json': JSON.stringify({ $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',  name: pluginId, version: '1.0.0', description: 'Fixture', extensions: { 'io.github.ainsep.openmarketing': metadata } }) } });
        value({ result: await f.binding.start() });
        const write = f.native.prepare('INSERT INTO om_owner_settings VALUES (?,?,?,?) ON CONFLICT(owner_id,workspace_id,key) DO UPDATE SET value_json=excluded.value_json');
        write.run(context.scope.ownerId, context.scope.workspaceId, 'conversion-settings.' + pluginId, JSON.stringify({ target: '123' }));
        expect(await f.binding.agentPluginState({ context, pluginId })).toMatchObject({ enabled: true, admitted: false, metadata: { ...metadata, conversionConfiguration: { target: '123' } } });
        for (const values of [{ unexpected: '123' }, { target: '-1' }, 'corrupt-shape']) {
            write.run(context.scope.ownerId, context.scope.workspaceId, 'conversion-settings.' + pluginId, JSON.stringify(values));
            const state = await f.binding.agentPluginState({ context, pluginId });
            expect(state).not.toBeNull(); expect(state!.metadata).toEqual(metadata);
        }
        write.run(context.scope.ownerId, context.scope.workspaceId, 'conversion-settings.' + pluginId, '{}');
        expect(await f.binding.agentPluginState({ context, pluginId })).toMatchObject({ metadata: { conversionConfiguration: {} } });
    } finally { await f.dispose(); }
});

/** Written-only tool-source and MCP-store fixtures. The assistant still owns policy dispatch. */
import { expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import type { CredentialSqlPort } from '@open-marketing/credentials';
import { createCredentialService, createMemoryCredentialRepo, createMemorySecretSealer, createMemoryCredentialLock,
    createMemoryCredentialAudit, createMemoryCredentialBroker, createMemoryKeyring, createMemoryOAuthClient } from '@open-marketing/credentials';
import { createIntegrations } from '../src/integrations.js';
import { parseCredentialCardManifest } from '../src/integration-credential-cards.js';
import { bindServerAddons, createNodeAddonEffects } from '../src/composition/addons.js';
import { loadAddonModule } from '../src/composition/serve.js';
import { addonManagementTools, addonToolSchemas, integrationConnectHelp, invokeAddonManagementTool, invokeAddonTool, loadAddonToolSources, readAddonCatalog } from '../src/addon-tools.js';
import { createExternalMcpStore } from '../src/external-mcp.js';
import type { ExternalMcpConnection } from '../src/external-mcp.js';
import type { AddonToolDependencies } from '../src/addon-tools.js';
import { createPluginService } from '@open-marketing/plugins';
import type { AddonRepository, AddonPackageAdapter } from '@open-marketing/plugins';
import type { AddonKind, AddonUpload, Outcome, AddonSummary, CallContext, ObserverPort } from '@open-marketing/contracts';

const context: CallContext = { scope: { ownerId: 'fixture-owner', workspaceId: 'fixture-workspace' },
    principal: { kind: 'owner', ownerId: 'fixture-owner' }, correlationId: 'fixture-correlation', traceId: 'fixture-trace' };
function value<T>(required: { result: Outcome<T> }): T {
    if (!required.result.ok) throw new Error(required.result.error.code);
    return required.result.value;
}
const markdown = '---\n{"name":"fixture-skill","description":"Fixture instructions"}\n---\nFixture-only instructions.';

function upload(required: { kind: AddonKind; spend?: boolean }): AddonUpload {
    const files: Record<string, string> = required.kind === 'skill' ? { 'SKILL.md': markdown } : agentFiles({ spend: required.spend });
    if (required.kind === 'plugin') {
        const code = 'export default {definition:{setup(sdk){sdk.tools.add({name:"report",description:"Fixture report",inputSchema:{type:"object"},handler(){return {fixture:true}}})}}};';
        const manifest = { id: 'fixture-plugin', name: 'Fixture plugin', version: '1.0.0', sdkRange: '^1.0.0', engine: 1, tier: 'tier-3',
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

/** Inert fixture ABI: installation/discovery must never invoke the factory. */
function capabilityFiles(): Record<string, string> {
    const files = agentFiles({});
    const manifest = JSON.parse(files['plugin.json']);
    manifest.extensions['io.github.ainsep.openmarketing'].admitted = true;
    return { ...files, 'plugin.json': JSON.stringify(manifest),
        'io.github.ainsep.openmarketing/capabilities.json': JSON.stringify({ admitted: true,
            capabilities: [{ capabilityId: 'campaign.status.v1', version: 1, pluginId: 'fixture-agent', schemaFingerprint: 'b'.repeat(64), effects: ['read'], admitted: true }] }),
        'io.github.ainsep.openmarketing/dist/index.mjs': 'export function createCapabilities() { throw new Error("discovery must be inert"); }' };
}

it('resolves uploaded capability declarations and entry from the current installed package', async () => {
    const f = await fixture({});
    try {
        const addon = value({ result: await f.binding.addons.install({ context, request: { upload: filesUpload({ files: capabilityFiles() }) } }) });
        expect(await f.binding.agentPluginState({ context, pluginId: addon.id })).toBeNull();
        value({ result: await f.binding.addons.setEnabled({ context, request: { kind: addon.kind, id: addon.id, enabled: true } }) });
        let catalogReads = 0;
        const query = f.db.query.bind(f.db);
        f.db.query = async <Row extends Record<string, unknown>>(input: { text: string; values?: unknown[] }) => {
            if (input.text.includes('FROM addon_package')) catalogReads++;
            return query<Row>(input);
        };
        const state = await f.binding.agentPluginState({ context, pluginId: addon.id });
        expect(catalogReads).toBe(1);
        expect(state).toMatchObject({ enabled: true, bundled: false, admitted: true,
            capabilities: [{ capabilityId: 'campaign.status.v1', version: 1, pluginId: 'fixture-agent', schemaFingerprint: 'b'.repeat(64), effects: ['read'], admitted: true }] });
        expect(state?.entryUrl).toContain('/addons/');
        expect(await fs.readFile(fileURLToPath(state!.entryUrl!), 'utf8')).toBe(capabilityFiles()['io.github.ainsep.openmarketing/dist/index.mjs']);
        expect(value({ result: await f.binding.addons.list({ context, query: { kind: 'agent-plugin', limit: 100 } }) }).items).toContainEqual(expect.objectContaining({ id: addon.id, enabled: true }));
        // An old installed directory cannot stand in for a missing current catalog revision.
        f.native.prepare('UPDATE addon_package SET summary=? WHERE addon_id=?').run(JSON.stringify({ ...addon, enabled: true, revision: '0'.repeat(64) }), addon.id);
        await expect(f.binding.agentPluginState({ context, pluginId: addon.id })).rejects.toThrow();
        f.native.prepare('UPDATE addon_package SET summary=? WHERE addon_id=?').run(JSON.stringify({ ...addon, enabled: true }), addon.id);
        value({ result: await f.binding.addons.setEnabled({ context, request: { kind: addon.kind, id: addon.id, enabled: false } }) });
        expect(await f.binding.agentPluginState({ context, pluginId: addon.id })).toBeNull();
    } finally { await f.dispose(); }
});

it('seeds the existing runtime entry with bundled metadata without copying other build artifacts', async () => {
    const f = await fixture({});
    try {
        const source = join(f.root, 'content/agent-plugins/fixture-agent');
        const files = { ...capabilityFiles(), 'io.github.ainsep.openmarketing/dist/cache.txt': 'do not copy' };
        for (const [path, content] of Object.entries(files)) {
            await fs.mkdir(join(source, path, '..'), { recursive: true });
            await fs.writeFile(join(source, path), content);
        }
        value({ result: await f.binding.start() });
        value({ result: await f.binding.addons.setEnabled({ context, request: { kind: 'agent-plugin', id: 'fixture-agent', enabled: true } }) });
        const state = await f.binding.agentPluginState({ context, pluginId: 'fixture-agent' });
        expect(state).toMatchObject({ bundled: true, admitted: true });
        expect(await fs.readFile(fileURLToPath(state!.entryUrl!), 'utf8')).toContain('createCapabilities');
        await expect(fs.access(join(fileURLToPath(state!.entryUrl!), '..', 'cache.txt'))).rejects.toThrow();
    } finally { await f.dispose(); }
});

/** Native and memory adapters below run the same repository contract when the Coordinator runs tests. */
function sqlFixture(_required: Record<string, never>) {
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

async function fixture(_required: Record<string, never>) {
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
        async dispose() { await binding.dispose(); native.close(); await unfreeze({ path: root }); await fs.rm(root, { recursive: true, force: true }); } };
}

async function unfreeze(required: { path: string }): Promise<void> {
    await fs.chmod(required.path, 0o700);
    for (const entry of await fs.readdir(required.path, { withFileTypes: true })) {
        if (entry.isDirectory()) await unfreeze({ path: join(required.path, entry.name) });
    }
}


it('exports exactly six management tools and supplies a secret-free connect pointer', () => {
    expect(addonManagementTools.map(tool => tool.name)).toEqual(['addons_list', 'addons_install', 'addons_set_enabled', 'addons_uninstall', 'integrations_list', 'integrations_disconnect']);
    expect(addonManagementTools.find(tool => tool.name === 'addons_uninstall')?.effects).toEqual(['destructive']);
    expect(integrationConnectHelp).toEqual({ page: '/addons/integrations', cli: 'om integrations connect --token-stdin' });
    expect(JSON.stringify(addonManagementTools)).not.toContain('plaintext');
});

function tools(required: { addons: AddonToolDependencies['addons'] }): AddonToolDependencies {
    return { ...required, observer: { observe() {} }, integrations: {
        async list() { return { ok: true, value: { items: [], cursor: null } }; },
        async disconnect() { return { ok: true, value: { pluginId: 'fixture', connectionId: 'fixture', status: 'disconnected' } }; },
    } };
}

it('rejects the removed developer-token tool and schema', async () => {
    const f = await fixture({}); const dependencies = tools({ addons: f.binding.addons });
    try {
        expect(addonToolSchemas).not.toHaveProperty('integrations_developer_token_status');
        expect(await invokeAddonManagementTool({ context, dependencies, name: 'integrations_developer_token_status', input: { pluginId: 'fixture-plugin' } })).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    } finally { await f.dispose(); }
});

it('returns plugin-secret status through the real operation without exposing secret values', async () => {
    const pluginId = 'fixture-plugin'; const sentinel = 'W4_SECRET_STATUS_SENTINEL_1028';
    const repo = createMemoryCredentialRepo({}); const sealer = createMemorySecretSealer({});
    const locks = createMemoryCredentialLock({}); const audit = createMemoryCredentialAudit({});
    const clock = { now: () => 1000 }; const events: unknown[] = [];
    const observer: ObserverPort = { observe(event) { events.push(event); } };
    const service = createCredentialService({ repo, sealer, locks, audit, clock,
        keyring: createMemoryKeyring({}), oauth: createMemoryOAuthClient({ clock, sealer }) });
    const real = createIntegrations({ repo, sealer, locks, audit, service, observer,
        db: { async query() { return { rows: [], rowCount: 0 }; } }, oauthProviders: new Map(),
        broker: createMemoryCredentialBroker({ repo, sealer, locks, audit }),
        async readCredentialCards(input) {
            return parseCredentialCardManifest({ pluginId: input.pluginId, raw: JSON.stringify({ name: input.pluginId,
                extensions: { 'io.github.ainsep.openmarketing': { credentialCards: [{ target: 'fixture-card', title: 'Fixture',
                    label: 'Save', category: 'Integration', intro: 'Fixture credentials.', usedFor: ['Fixture operation'],
                    helpUrl: 'https://fixture.example/help', helpLabel: 'Help', baseUrl: 'https://fixture.example',
                    saveKind: 'plugin-secret', secretFields: [{ name: 'fixtureSecret', label: 'Secret', required: true }] }] } } }) });
        } });
    const dependencies = tools({ addons: { list: vi.fn(), install: vi.fn(), setEnabled: vi.fn(), uninstall: vi.fn(), describe: vi.fn() } });
    dependencies.observer = observer;
    dependencies.integrations.pluginSecretStatus = real.pluginSecretStatus;
    const saved = await real.setPluginSecret({ context, request: { pluginId, values: { fixtureSecret: sentinel } } });
    expect(saved).toEqual({ ok: true, value: { configured: true } });
    // Dispatcher-authorized agent calls must retain scope/trace while adapting the owner principal.
    const agent: CallContext = { ...context, runId: 'fixture-run', principal: { kind: 'agent', runId: 'fixture-run', agentInstanceId: 'fixture-agent' } };
    const status = await invokeAddonManagementTool({ context: agent, dependencies, name: 'integrations_plugin_secret_status', input: { pluginId } });
    expect(status).toEqual({ ok: true, value: { configured: true } });
    const rejected = await invokeAddonManagementTool({ context: agent, dependencies, name: 'integrations_plugin_secret_status', input: { pluginId, values: { fixtureSecret: sentinel } } });
    expect(rejected).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    expect(JSON.stringify([saved, status, rejected, events, audit.entries({})])).not.toContain(sentinel);
});

it('discovers read-only instructions even for spend contributions and loads them on selection', async () => {
    const f = await fixture({});
    try {
        const addon = value({ result: await f.binding.addons.install({ context, request: { upload: upload({ kind: 'agent-plugin', spend: true }) } }) });
        const dependencies = tools({ addons: f.binding.addons });
        expect(value({ result: await loadAddonToolSources({ context, dependencies }) })).toEqual([]);
        value({ result: await f.binding.addons.setEnabled({ context, request: { kind: addon.kind, id: addon.id, enabled: true } }) });
        const sources = value({ result: await loadAddonToolSources({ context, dependencies }) });
        expect(sources).toHaveLength(1);
        expect(sources[0].effects).toEqual(['read']);
        expect(sources[0].name).toBe(sources[0].id);
        expect(JSON.stringify(sources)).not.toContain('Fixture-only instructions');
        expect(JSON.stringify(sources)).not.toContain(f.root);
        const selected = value({ result: await invokeAddonTool({ context, dependencies, sourceId: sources[0].id, revision: addon.revision, input: { skill: 'fixture-skill' } }) });
        expect(selected).toMatchObject({ instructions: expect.stringContaining('Fixture-only instructions') });
        value({ result: await f.binding.addons.setEnabled({ context, request: { kind: addon.kind, id: addon.id, enabled: false } }) });
        expect(await invokeAddonTool({ context, dependencies, sourceId: sources[0].id, revision: addon.revision, input: {} })).toMatchObject({ ok: false, error: { code: 'conflict' } });
        expect(value({ result: await loadAddonToolSources({ context, dependencies }) })).toEqual([]);
    } finally { await f.dispose(); }
});

it('rejects stale source revisions and removed skill selections', async () => {
    const f = await fixture({});
    try {
        const addon = value({ result: await f.binding.addons.install({ context, request: { upload: upload({ kind: 'skill' }) } }) });
        value({ result: await f.binding.addons.setEnabled({ context, request: { kind: addon.kind, id: addon.id, enabled: true } }) });
        const dependencies = tools({ addons: f.binding.addons });
        const source = value({ result: await loadAddonToolSources({ context, dependencies }) })[0];
        expect(await invokeAddonTool({ context, dependencies, sourceId: source.id, revision: 'stale', input: {} })).toMatchObject({ ok: false, error: { code: 'conflict' } });
        value({ result: await f.binding.addons.uninstall({ context, request: { kind: addon.kind, id: addon.id } }) });
        expect(await invokeAddonTool({ context, dependencies, sourceId: source.id, revision: source.revision, input: {} })).toMatchObject({ ok: false });
    } finally { await f.dispose(); }
});

it('management tools use the same lifecycle and never execute contribution handlers during disclosure', async () => {
    const f = await fixture({});
    try {
        const dependencies = tools({ addons: f.binding.addons });
        const addon = value({ result: await invokeAddonManagementTool({ context, dependencies, name: 'addons_install', input: { upload: upload({ kind: 'plugin' }) } }) }) as AddonSummary;
        value({ result: await invokeAddonManagementTool({ context, dependencies, name: 'addons_set_enabled', input: { kind: addon.kind, id: addon.id, enabled: true } }) });
        const source = value({ result: await loadAddonToolSources({ context, dependencies }) })[0];
        expect(source.effects).toEqual(['read']);
        const described = value({ result: await invokeAddonTool({ context, dependencies, sourceId: source.id, revision: source.revision, input: {} }) });
        expect(described).toMatchObject({ tools: [{ name: 'report' }] });
        expect(described).not.toHaveProperty('fixture');
        expect(await invokeAddonManagementTool({ context, dependencies, name: 'integrations_connect', input: {} })).toEqual({ ok: true, value: integrationConnectHelp });
        expect(await invokeAddonManagementTool({ context, dependencies, name: 'integrations_disconnect', input: { connectionId: 'fixture', plaintext: 'fixture-secret' } })).toMatchObject({ ok: false });
        value({ result: await invokeAddonManagementTool({ context, dependencies, name: 'addons_uninstall', input: { kind: addon.kind, id: addon.id } }) });
    } finally { await f.dispose(); }
});

it('rechecks activation after an instruction read that races disable', async () => {
    let enabled = true;
    const addon: AddonSummary = { kind: 'skill', id: 'fixture', name: 'Fixture', description: '', version: '1', revision: 'r1', enabled: true };
    const repo: AddonRepository = { async list() { return [{ ...addon, enabled }]; }, async save(input) { enabled = input.addon.enabled; }, async remove() { enabled = false; } };
    const backend: AddonPackageAdapter = { async prepare() { throw new Error('unused'); }, async remove() {}, async setEnabled() {},
        async describe() { enabled = false; return { instructions: 'must never escape' }; } };
    const addons = createPluginService({ repo, packages: { plugin: backend, 'agent-plugin': backend, skill: backend }, observer: { observe() {} }, ids: { next: () => 'fixture-operation' },
        decodeUpload: async () => { throw new Error('unused'); }, audit: { async record() { return { ok: true, value: undefined }; } }, runningJobs: async () => ({ ok: true, value: 0 }) });
    expect(await addons.describe({ context, kind: addon.kind, id: addon.id, revision: addon.revision, skill: addon.id })).toMatchObject({ ok: false, error: { code: 'conflict' } });
});

function connection(required: { id: string; enabled?: boolean }): ExternalMcpConnection {
    return { connectionId: required.id, pluginId: 'fixture-plugin', revision: 'r1', enabled: required.enabled ?? false,
        server: { type: 'streamable-http', url: 'https://fixture.example.invalid/mcp' } };
}

it('manual and plugin MCP configuration use one persistent store and isolate owners', async () => {
    const f = sqlFixture({});
    const sessions = { async reload() {}, async close() {} };
    const dependencies = { db: f.db, observer: { observe() {} }, sessions };
    try {
        const store = createExternalMcpStore(dependencies);
        value({ result: await store.save({ context, connection: { ...connection({ id: 'manual' }), pluginId: null } }) });
        value({ result: await store.provision({ context, pluginId: 'fixture-plugin', revision: 'r1', configuration: { $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json', mcpServers: { fixture: { type: 'stdio', command: 'fixture-only', args: [] } } } }) });
        const restarted = createExternalMcpStore(dependencies);
        const rows = value({ result: await restarted.list({ context }) });
        expect(rows.map(row => row.pluginId)).toEqual(['fixture-plugin', null]);
        expect(rows.every(row => !row.enabled)).toBe(true);
        expect(value({ result: await restarted.list({ context: { ...context, scope: { ...context.scope, ownerId: 'other' } } }) })).toEqual([]);
        value({ result: await restarted.removePlugin({ context, pluginId: 'fixture-plugin' }) });
        expect(value({ result: await restarted.list({ context }) }).map(row => row.connectionId)).toEqual(['manual']);
    } finally { f.native.close(); }
});

it('a second MCP enable failure closes the first session and persists every row disabled', async () => {
    const f = sqlFixture({});
    const active = new Set<string>();
    const store = createExternalMcpStore({ db: f.db, observer: { observe() {} }, sessions: {
        async reload({ connection }) { if (connection.connectionId === 'b') throw new Error('fixture-secret'); active.add(connection.connectionId); },
        async close({ connectionId }) { active.delete(connectionId); },
    } });
    try {
        for (const id of ['a', 'b']) value({ result: await store.save({ context, connection: connection({ id }) }) });
        const result = await store.setPluginEnabled({ context, pluginId: 'fixture-plugin', enabled: true });
        expect(result).toMatchObject({ ok: false });
        expect(JSON.stringify(result)).not.toContain('fixture-secret');
        expect(active.size).toBe(0);
        expect(value({ result: await store.list({ context }) }).every(row => !row.enabled)).toBe(true);
    } finally { f.native.close(); }
});

it('rejects invalid MCP transports before changing any rows', async () => {
    const f = sqlFixture({});
    const store = createExternalMcpStore({ db: f.db, observer: { observe() {} }, sessions: { async reload() {}, async close() {} } });
    try {
        expect(await store.provision({ context, pluginId: 'fixture-plugin', revision: 'r1', configuration: { $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json', mcpServers: { bad: { type: 'unsupported' } } } })).toMatchObject({ ok: false });
        expect(value({ result: await store.list({ context }) })).toEqual([]);
    } finally { f.native.close(); }
});

it('refuses a repeated catalog cursor after exactly two page calls', async () => {
    const list = vi.fn(async () => ({ ok: true as const, value: { items: [], cursor: 'repeat' } }));
    expect(await readAddonCatalog({ context, addons: { list } })).toMatchObject({ ok: false, error: { code: 'limit_exceeded' } });
    expect(list).toHaveBeenCalledTimes(2);
});

it('refuses an eleven-page catalog without requesting page eleven and accepts a terminal tenth page', async () => {
    let pages = 0;
    const list = vi.fn(async () => ({ ok: true as const, value: { items: [], cursor: 'page-' + ++pages } }));
    expect(await readAddonCatalog({ context, addons: { list } })).toMatchObject({ ok: false, error: { code: 'limit_exceeded' } });
    expect(list).toHaveBeenCalledTimes(10);
    pages = 0;
    const bounded = vi.fn(async () => ({ ok: true as const, value: { items: [], cursor: ++pages === 10 ? null : 'page-' + pages } }));
    expect(await readAddonCatalog({ context, addons: { list: bounded } })).toEqual({ ok: true, value: [] });
    expect(bounded).toHaveBeenCalledTimes(10);
});

it('checks cancellation before page reads, including before the first call', async () => {
    const controller = new AbortController(); controller.abort();
    const list = vi.fn(async () => ({ ok: true as const, value: { items: [], cursor: null } }));
    expect(await readAddonCatalog({ context, addons: { list } }, { signal: controller.signal })).toMatchObject({ ok: false, error: { code: 'cancelled' } });
    expect(list).not.toHaveBeenCalled();
    const betweenPages = new AbortController();
    const aborting = vi.fn(async () => { betweenPages.abort(); return { ok: true as const, value: { items: [], cursor: 'next' } }; });
    expect(await readAddonCatalog({ context, addons: { list: aborting } }, { signal: betweenPages.signal })).toMatchObject({ ok: false, error: { code: 'cancelled' } });
    expect(aborting).toHaveBeenCalledTimes(1);
});

it('forwards the kind/options and preserves the catalog receiver across pages', async () => {
    const first: AddonSummary = { kind: 'agent-plugin', id: 'first', name: 'First', description: '', version: '1', revision: 'r1', enabled: true };
    const second = { ...first, id: 'second', enabled: false };
    const options = { signal: new AbortController().signal };
    const addons = { pages: 0, list: vi.fn(async function (this: { pages: number }) {
        return { ok: true as const, value: ++this.pages === 1 ? { items: [first], cursor: 'next' } : { items: [second], cursor: null } };
    }) };
    expect(await readAddonCatalog({ context, addons, kind: 'agent-plugin' }, options)).toEqual({ ok: true, value: [first, second] });
    expect(addons.pages).toBe(2);
    expect(addons.list).toHaveBeenNthCalledWith(1, { context, query: { kind: 'agent-plugin', limit: 100, cursor: undefined } }, options);
    expect(addons.list).toHaveBeenNthCalledWith(2, { context, query: { kind: 'agent-plugin', limit: 100, cursor: 'next' } }, options);
    const failure = { ok: false as const, error: { code: 'unavailable' as const, message: 'Fixture failure', retryable: true } };
    expect(await readAddonCatalog({ context, addons: { list: async () => failure } })).toEqual(failure);
});

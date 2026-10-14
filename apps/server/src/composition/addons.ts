/** Independent add-on composition; boot integration is sequenced by the Coordinator. */
import * as fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { createAgentPluginLayout, createAgentPluginLifecycle, parseAgentPluginManifest } from '@jini-ai/agent-plugins/lifecycle';
import type { AgentPluginLayout, AgentPluginLifecycleRequired, InstalledAgentPlugin } from '@jini-ai/agent-plugins/lifecycle';
import { createNodeAgentPluginEffects } from '@jini-ai/agent-plugins/lifecycle/node';
import { createNodeSkillFilesystem, createSkillInstaller, createSkillLayout, createYauzlSkillArchiveReader, validateSkillMarkdown, validateSkillPath } from '@jini-ai/agentic/skills/install';
import type { SkillZipSdkPort, YamlReaderPort } from '@jini-ai/agentic/skills/install';
import { createPluginContributionRegistry } from '@jini-ai/plugins/host';
import type { DefinedPlugin, ManifestHostPorts, PluginActivationRepoPort, PluginTierPolicy } from '@jini-ai/plugins/host';
import { snapshotPluginModuleGraph, snapshotSitePluginPackage } from '@jini-ai/plugins/host/node';
import type { AddonSummary, CallContext, ClockPort, IdPort, ObserverPort, Outcome } from '@open-marketing/contracts';
import type { CredentialSqlPort } from '@open-marketing/credentials';
import { addonSummarySchema, boundedJsonSchema } from '@open-marketing/contracts';
import { createAddons, createSqlAddonRepository, addonBoundary, addonFailure } from '../addons.js';
import type { AddonDescription, AddonPackageAdapter, PreparedAddon } from '../addons.js';
import { addonAgentArchiveReader, decodeAddonUpload } from '../addon-upload.js';
import type { AddonFiles } from '../addon-upload.js';
import { createExecutablePluginHost, executablePackageRoot } from '../plugin-host.js';
import { createExternalMcpStore } from '../external-mcp.js';
import type { ExternalMcpSessions } from '../external-mcp.js';
import { createChartAssets, handleChartAssetRequest } from '../inbound/chart-assets.js';
import type { HttpRequest } from '../ports.js';

/** Native effects are created ONLY here; tests inject temporary roots/readers/clock/ids.
 * YAML and executable module loading are supplied by composition; no new dependency is installed.
 * The loader receives a verified snapshot URL and returns its default export; errors propagate to Jini.
 * @example createNodeAddonEffects({ clock, ids, loadModule });
 * @complexity Constant adapter work; evaluated plugin code has owner-defined cost.
 */
export function createNodeAddonEffects(required: { clock: ClockPort; ids: IdPort; loadModule(required: { moduleUrl: string }): Promise<unknown> }) {
    const native = createNodeAgentPluginEffects({}, { filesystem: fs });
    const yauzl = createRequire(import.meta.url)('yauzl') as SkillZipSdkPort;
    return { ...native, filesystem: fs, skillFilesystem: createNodeSkillFilesystem({}),
        archiveReader: createYauzlSkillArchiveReader({ yauzl }),
        clock: { ...native.clock, nowMs: () => required.clock.now({}), monotonicMs: () => required.clock.now({}) },
        ids: { ...native.ids, newId: () => required.ids.next({}) },
        importModule: (input: { entryPath: string }) => required.loadModule({ moduleUrl: pathToFileURL(input.entryPath).href }) };
}
export type AddonEffects = ReturnType<typeof createNodeAddonEffects>;

/** One binding per authenticated owner/workspace. The hash binds both identity fields into paths.
 * No filesystem/network work at construction. start explicitly seeds disabled bundled packages
 * and restores persisted operator choices; dispose closes runtimes without changing those choices.
 * @example const binding = bindServerAddons({ context, db, stateRoot, projectRoot, clock, effects, observer, yamlReader, sessions });
 * @complexity <=1000 catalog entries, <=100 MCP rows; no vendor calls on disabled bundled load.
 */
export function bindServerAddons(required: { context: CallContext; db: CredentialSqlPort; stateRoot: string; projectRoot: string;
    clock: ClockPort; effects: AddonEffects; observer: ObserverPort; yamlReader: YamlReaderPort; sessions: ExternalMcpSessions }) {
    const scopeId = scopeKey({ context: required.context });
    const root = join(required.stateRoot, 'addons', scopeId);
    const repo = createSqlAddonRepository({ db: required.db });
    const registry = createPluginContributionRegistry({});
    const charts = createChartAssets({});
    const externalMcp = createExternalMcpStore(required);
    const layout = createAgentPluginLayout({ root: join(root, 'agent-plugins') });
    const world = layout.forWorkspace({ workspaceId: scopeId });
    const provisioning: AgentPluginLifecycleRequired['mcpProvisioning'] = {
        async provision({ installed }) { await provisionInstalled({ installed }); },
        async setEnabled({ pluginId, enabled }) { checked({ result: await externalMcp.setPluginEnabled({ context: required.context, pluginId, enabled }) }); },
        async remove({ pluginId }) { checked({ result: await externalMcp.removePlugin({ context: required.context, pluginId }) }); },
        async notifyRosterChanged() { /* Source discovery reads the current catalog; no second registry. */ },
    };
    const lifecycle = createAgentPluginLifecycle({ ...required.effects, layout, productName: 'Open Marketing', extensionNamespace: 'io.github.ainsep.openmarketing',
        seededEnabledPluginIds: new Set(), retiredBundledPlugins: new Map(), bundledArchiveMagic: 'OM_AGENT_PLUGIN_ARCHIVE_V1', deliveryMode: 'pointer',
        formatPluginToolPointer: ({ pluginId }) => 'Describe the installed add-on ' + pluginId,
        mcpProvisioning: provisioning, fetch: async () => { throw new Error('Remote installs unavailable'); },
        outboundGuard: { async assertAllowed() { throw new Error('Remote installs unavailable'); } } });
    const skillLayout = createSkillLayout({ root: join(root, 'skills'), stagingRoot: join(root, 'skill-staging'), workspaceDirectory: 'workspaces', stateFileName: '.om-skill.json' });
    const skillInstaller = createSkillInstaller({ layout: skillLayout, filesystem: required.effects.skillFilesystem,
        archiveReader: required.effects.archiveReader, yamlReader: required.yamlReader, ids: { next: () => required.effects.ids.newId() },
        toolId: ({ name }) => 'skill_' + name, fetch: async () => { throw new Error('Remote installs unavailable'); },
        toolSourceLoader: { async load() {
            const location = skillLayout.resolve({ workspaceId: scopeId });
            await required.effects.skillFilesystem.mkdir({ path: location.workspaceRoot });
            const entries = await required.effects.filesystem.readdir(location.workspaceRoot, { withFileTypes: true });
            if (entries.length > 1000) throw new RangeError('Skill catalog cap');
            const sources = [];
            for (const entry of entries) {
                if (!entry.isDirectory()) continue;
                const directory = join(location.workspaceRoot, entry.name);
                const bytes = await required.effects.skillFilesystem.readFile({ path: join(directory, 'SKILL.md'), maxBytes: 65536 });
                const metadata = validateSkillMarkdown({ markdown: Buffer.from(bytes).toString('utf8'), yamlReader: required.yamlReader });
                if (metadata.name !== entry.name) throw new Error('Skill directory mismatch');
                sources.push({ id: 'skill_' + metadata.name, skillName: metadata.name, description: metadata.description, directory: entry.name });
            }
            return sources;
        } } });
    const activations = activationRepository({ db: required.db, context: required.context });
    const packages = {
        plugin: createExecutablePluginHost({ host: executableHostPorts({}), installDir: join(root, 'plugins'), activations, registry,
            browserProviders: charts,
            tierPolicy: executableTierPolicy({}), clock: required.effects.clock,
            coreDeps: { getCurrentEntry: () => ({ workspaceId: scopeId, ext: {} }),
                writeExtField() { throw new Error('No content operation is active'); }, attachFilter() { throw new Error('No content hooks are mounted'); } },
            verifyDigest: async ({ absoluteFilePath }) => 'sha256-' + createHash('sha256').update(await required.effects.filesystem.readFile(absoluteFilePath)).digest('hex'),
            snapshotVerified: async input => {
                const entryPath = await snapshotPluginModuleGraph({ pluginRoot: executablePackageRoot(input), manifest: input.manifest });
                return { entryPath, files: await snapshotSitePluginPackage({ sourceDir: executablePackageRoot({ entryPath }) }) };
            },
            importVerified: input => required.effects.importModule({ entryPath: input.entryPath }),
            removeBytes: async ({ pluginId }) => { await required.effects.filesystem.rm(join(root, 'plugins', pluginId), { recursive: true, force: true }); } }),
        'agent-plugin': agentAdapter(),
        skill: skillAdapter(),
    };
    // A binding cannot operate on another owner's catalog while retaining this scope's byte paths.
    const scopedRepo = { list: async (input: { context: CallContext }) => { assertScope(input); return repo.list(input); },
        save: async (input: Parameters<typeof repo.save>[0]) => { assertScope(input); await repo.save(input); },
        remove: async (input: Parameters<typeof repo.remove>[0]) => { assertScope(input); await repo.remove(input); } };
    const addons = createAddons({ repo: scopedRepo, packages, archiveReader: required.effects.archiveReader, observer: required.observer });
    return { addons, externalMcp, registry, charts,
        // Coordinator selects this only after the existing owner cookie/origin authentication.
        async handleChartRequest(input: { request: HttpRequest; context: CallContext }) {
            try { assertScope(input); }
            catch { return { status: 403, body: addonFailure({ code: 'forbidden' }) }; }
            return handleChartAssetRequest({ ...input, charts, observer: required.observer });
        },
        start: () => addonBoundary({ context: required.context, dependencies: required, operation: 'addons.start', run: async () => {
            await seedChartPlugin();
            await seedBundledAgentPlugins({ lifecycle, layout, workspaceId: scopeId, effects: required.effects,
                sourceRoot: join(required.projectRoot, 'content', 'agent-plugins') });
            const installed = await lifecycle.listInstalledPlugins({ workspaceRoot: world.root });
            const activation = await lifecycle.readAgentPluginActivations({ workspaceRoot: world.root });
            for (const plugin of installed) await seedSummary({ plugin, enabled: activation.plugins[plugin.pluginId]?.enabled === true });
            for (const addon of await repo.list({ context: required.context })) await restore({ addon });
            return { ok: true, value: undefined };
        } }),
        dispose: () => addonBoundary({ context: required.context, dependencies: required, operation: 'addons.dispose', run: async () => {
            charts.dispose({});
            for (const contributions of registry.list({})) registry.detach({ pluginId: contributions.pluginId });
            return externalMcp.dispose({ context: required.context });
        } }),
    };

    /** Seed the artifact disabled through the ordinary installer. Existing operator packages win.
     * There is no source/trust relabeling; enabling remains subject to the published Jini loader.
     * @complexity <=5 files/32 MiB, using the same no-follow reader and upload caps as Agent Plugins.
     */
    async function seedChartPlugin(): Promise<void> {
        const previous = await repo.list({ context: required.context });
        if (previous.some(row => row.kind === 'plugin' && row.id === 'charts-recharts')) return;
        const sourceDir = join(required.projectRoot, 'content', 'plugins', 'charts-recharts', '0.1.0');
        const entries = await bundledSourceEntries({ effects: required.effects, path: sourceDir });
        if (!entries.length) return;
        const scan: BundledScan = { files: new Map(), bytes: 0, entries: 0 };
        for (const path of ['jini.plugin.json', 'client/provider.js', 'client/styles.css', 'server/index.mjs', 'NOTICE']) {
            await readBundledPath({ effects: required.effects, sourceDir, path, scan });
        }
        checked({ result: await addons.install({ context: required.context, request: { kind: 'plugin', upload: { kind: 'files',
            files: [...scan.files].map(([path, content]) => ({ path, base64: Buffer.from(content).toString('base64') })) } } }) });
    }

    function assertScope(input: { context: CallContext }): void {
        if (scopeKey(input) !== scopeId) throw new Error('Add-on scope mismatch');
    }

    /** Jini resolves immutable packages; metadata and skills never expose their package roots. */
    async function installedPlugin(input: { id: string }): Promise<InstalledAgentPlugin> {
        const installed = await lifecycle.listInstalledPlugins({ workspaceRoot: world.root });
        const found = installed.find(plugin => plugin.pluginId === input.id);
        if (!found) throw new Error('Agent plugin missing');
        return found;
    }

    async function provisionInstalled(input: { installed: InstalledAgentPlugin }): Promise<void> {
        if (!input.installed.files.includes('mcp.json')) return;
        const text = await lifecycle.readTrustedPluginFile({ plugin: input.installed, filename: 'mcp.json' });
        checked({ result: await externalMcp.provision({ context: required.context, pluginId: input.installed.pluginId,
            revision: input.installed.archiveDigest, configuration: JSON.parse(text) }) });
    }

    function agentAdapter(): AddonPackageAdapter {
        return {
            async prepare(input): Promise<PreparedAddon> {
                const manifest = parseAgentPluginManifest({ value: JSON.parse(Buffer.from(input.files.get('plugin.json')!).toString('utf8')) }, { identityNamespace: 'io.github.ainsep.openmarketing' });
                if (!manifest.ok) throw new Error('Invalid agent plugin');
                const archive = Buffer.from(input.revision, 'hex');
                const args = { archive, expectedSha256: createHash('sha256').update(archive).digest('hex'), archiveReader: addonAgentArchiveReader(input), layout, workspaceId: scopeId };
                // Preview owns Jini's full format/identity validation, including bounded staging cleanup.
                const preview = await lifecycle.installAgentPlugin(args, { previewOnly: true });
                const summary = agentSummary({ plugin: preview, enabled: false, revision: input.revision });
                return { summary, async commit() {
                    const installed = await lifecycle.installAgentPlugin(args);
                    await lifecycle.setAgentPluginEnabled({ workspaceId: scopeId, pluginId: installed.pluginId, enabled: false, actor: actorId({ context: input.context }) });
                    await provisionInstalled({ installed });
                } };
            },
            async setEnabled(input) {
                if (!input.enabled) checked({ result: await externalMcp.setPluginEnabled({ context: input.context, pluginId: input.addon.id, enabled: false }) });
                const installed = await installedPlugin({ id: input.addon.id });
                await lifecycle.setAgentPluginEnabled({ workspaceId: scopeId, pluginId: input.addon.id, enabled: input.enabled, actor: actorId({ context: input.context }) });
                if (input.enabled) {
                    await provisionInstalled({ installed });
                    checked({ result: await externalMcp.setPluginEnabled({ context: input.context, pluginId: input.addon.id, enabled: true }) });
                }
            },
            async remove(input) {
                await lifecycle.uninstallAgentPlugin({ layout, workspaceId: scopeId, pluginId: input.addon.id });
                checked({ result: await externalMcp.removePlugin({ context: input.context, pluginId: input.addon.id }) });
            },
            async describe(input) {
                const activation = await lifecycle.resolveAgentPluginActivation({ workspaceRoot: world.root, pluginId: input.addon.id });
                if (activation.verdict !== 'active') throw new Error('Agent plugin inactive');
                const plugin = await installedPlugin({ id: input.addon.id });
                const manifest = JSON.parse(await lifecycle.readTrustedPluginFile({ plugin, filename: 'plugin.json' }));
                const effects = await agentEffects({ plugin, manifest });
                const skills = plugin.skills.map(skill => ({ name: skill.name, description: 'Load instructions for ' + skill.name }));
                if (!input.skill) return { effects, skills };
                const skill = plugin.skills.find(row => row.name === input.skill);
                if (!skill) throw new Error('Skill missing');
                return { effects, instructions: await lifecycle.readInstalledSkillMarkdown({ packageRoot: plugin.packageRoot, skillPath: skill.skillPath }), skills };
            },
        };
    }

    /** Manifest capabilities can point at effects in separate JSON files; retain financial effects.
     * Reads only retained JSON metadata, never backend JS or full skill instructions.
     */
    async function agentEffects(input: { plugin: InstalledAgentPlugin; manifest: unknown }): Promise<unknown[]> {
        const effects = readDeclaredEffects({ value: input.manifest });
        const metadata = input.plugin.files.filter(path => path.endsWith('/capabilities.json') || /\/bindings\/[^/]+\.json$/.test(path));
        if (metadata.length > 100) throw new RangeError('Capability metadata cap');
        for (const filename of metadata) effects.push(...readDeclaredEffects({ value: JSON.parse(await lifecycle.readTrustedPluginFile({ plugin: input.plugin, filename })) }));
        return effects;
    }

    function skillAdapter(): AddonPackageAdapter {
        return {
            async prepare(input) {
                const files = [...input.files].map(([path, bytes]) => ({ path, contentBase64: Buffer.from(bytes).toString('base64') }));
                const prepared = await skillInstaller.prepareSkillInstall({ workspaceId: scopeId, files });
                return { summary: { id: prepared.toolId, kind: 'skill', name: prepared.name, description: prepared.description,
                    version: '1', enabled: false, revision: input.revision }, async commit() {
                    await skillInstaller.commitSkillInstall({ workspaceId: scopeId, prepared });
                    // Jini's standalone installer defaults on; OM catalog is closed until this disable completes.
                    await skillInstaller.setSkillEnabled({ workspaceId: scopeId, toolId: prepared.toolId, enabled: false });
                } };
            },
            async setEnabled(input) { await skillInstaller.setSkillEnabled({ workspaceId: scopeId, toolId: input.addon.id, enabled: input.enabled }); },
            async remove(input) { await skillInstaller.uninstallSkill({ workspaceId: scopeId, toolId: input.addon.id }); },
            async describe(input): Promise<AddonDescription> {
                if (!input.skill) return { effects: ['write'] };
                const skill = (await skillInstaller.listManagedSkills({ workspaceId: scopeId })).find(row => row.toolId === input.addon.id);
                if (!skill?.enabled) throw new Error('Skill disabled');
                const location = skillLayout.resolve({ workspaceId: scopeId });
                const bytes = await required.effects.skillFilesystem.readFile({ path: join(location.workspaceRoot, skill.name, 'SKILL.md'), maxBytes: 65536 });
                return { effects: ['write'], instructions: Buffer.from(bytes).toString('utf8') };
            },
        };
    }

    async function seedSummary(input: { plugin: InstalledAgentPlugin; enabled: boolean }): Promise<void> {
        const previous = (await repo.list({ context: required.context })).find(row => row.kind === 'agent-plugin' && row.id === input.plugin.pluginId);
        if (previous && !await lifecycle.isAgentPluginRecordedAsBundled({ workspaceRoot: world.root, pluginId: input.plugin.pluginId })) return;
        if (previous?.revision === input.plugin.archiveDigest) return;
        await provisionInstalled({ installed: input.plugin });
        await repo.save({ context: required.context, addon: agentSummary({ ...input, enabled: previous?.enabled ?? input.enabled, revision: input.plugin.archiveDigest }) });
    }

    /** Boot restores enabled runtimes; a failed restore closes catalog authority and reports failure. */
    async function restore(input: { addon: AddonSummary }): Promise<void> {
        try { await packages[input.addon.kind].setEnabled({ context: required.context, ...input, enabled: input.addon.enabled }); }
        catch {
            await repo.save({ context: required.context, addon: { ...input.addon, enabled: false } });
            await packages[input.addon.kind].setEnabled({ context: required.context, addon: input.addon, enabled: false });
            throw new Error('Add-on restore failed');
        }
    }
}

type AgentPluginLifecycle = ReturnType<typeof createAgentPluginLifecycle>;
type BundledScan = { files: Map<string, Uint8Array>; bytes: number; entries: number };
const bundledExtensionSchema = z.object({ capabilities: z.union([
    z.array(z.unknown()), z.record(z.string(), z.object({ binding: z.string().optional() }).passthrough()),
]).optional() }).passthrough();
const bundledArtifacts = new Set(['node_modules', 'dist', 'build', '.git', '.cache', '.turbo', '.vite', 'coverage']);

/** Removable host workaround for Jini 0.4.6's whole-tree packing and extraction-before-dedup.
 * Retains Jini migration, activation and digest-ledger ownership. An unchanged snapshot is indexed
 * before the installer is called, so restart performs no staging extraction or snapshot copying.
 * Errors reach addons.start's typed boundary; disabled-by-default and operator choices are preserved.
 * @complexity O(selected source bytes + files log files), <=1000 packages, <=32 MiB/package.
 */
async function seedBundledAgentPlugins(required: { lifecycle: AgentPluginLifecycle; layout: AgentPluginLayout;
    workspaceId: string; sourceRoot: string; effects: AddonEffects }): Promise<void> {
    const world = required.layout.forWorkspace({ workspaceId: required.workspaceId });
    const migration = await required.lifecycle.migratePluginLayout({ workspaceId: required.workspaceId });
    if (!migration.complete) throw new Error('Bundled plugin layout migration incomplete');
    await required.lifecycle.assertAgentPluginActivationsWritable({ workspaceRoot: world.root });
    const entries = await bundledSourceEntries({ effects: required.effects, path: required.sourceRoot });
    if (entries.length > 1000) throw new RangeError('Bundled plugin catalog cap');
    const seeded: { pluginId: string; archiveDigest: string }[] = [];
    for (const entry of entries.filter(entry => entry.isDirectory() && !isBundledArtifact({ name: entry.name }))) {
        const source = await readBundledPackage({ effects: required.effects, sourceDir: join(required.sourceRoot, entry.name) });
        if (!source) continue;
        const archive = Buffer.from(source.revision, 'hex');
        const archiveDigest = createHash('sha256').update(archive).digest('hex');
        const packagesDir = world.pluginPackagesDir({ pluginId: source.pluginId });
        const packageRoot = await required.lifecycle.assertContainedOnDisk({ packageRoot: world.root,
            entryPath: relative(world.root, join(packagesDir, archiveDigest)) });
        if (await required.lifecycle.isInstalledDigestPresent({ packagesDir, archiveDigest })) {
            await required.lifecycle.indexInstalledRoot({ packageRoot, archiveDigest });
        } else {
            await required.lifecycle.installAgentPlugin({ archive, expectedSha256: archiveDigest,
                archiveReader: addonAgentArchiveReader(source), layout: required.layout, workspaceId: required.workspaceId });
        }
        await required.lifecycle.recordBundledAgentPluginIfAbsent({ workspaceRoot: world.root, pluginId: source.pluginId }, { enabled: false });
        seeded.push({ pluginId: source.pluginId, archiveDigest });
    }
    await required.lifecycle.recordBundledAgentPluginDigests({ workspaceRoot: world.root, seeded });
}

/** Builds a bounded upload from portable package content, excluding development source/output.
 * Agent Plugins declare skills by layout and extra capability files by manifest bindings.
 * LICENSE/NOTICE accompany redistributed package bytes. The existing upload decoder owns hashing.
 */
async function readBundledPackage(required: { effects: AddonEffects; sourceDir: string }) {
    const sourceDir = await required.effects.filesystem.realpath(required.sourceDir);
    const entries = await required.effects.filesystem.readdir(sourceDir, { withFileTypes: true });
    if (!entries.some(entry => entry.name === 'plugin.json')) return undefined;
    const bytes = await required.effects.skillFilesystem.readFile({ path: join(sourceDir, 'plugin.json'), maxBytes: 65536 });
    const manifest = parseAgentPluginManifest({ value: boundedJsonSchema.parse(JSON.parse(Buffer.from(bytes).toString('utf8'))) },
        { identityNamespace: 'io.github.ainsep.openmarketing' });
    if (!manifest.ok) throw new Error('Invalid bundled plugin manifest');
    const paths = new Set(entries.filter(entry => ['plugin.json', 'mcp.json', 'skills', 'LICENSE', 'NOTICE'].includes(entry.name)).map(entry => entry.name));
    for (const path of bundledBindings({ value: manifest.manifest.extensions?.['io.github.ainsep.openmarketing'] })) paths.add(path);
    const scan: BundledScan = { files: new Map(), bytes: 0, entries: 0 };
    for (const path of paths) await readBundledPath({ ...required, sourceDir, path, scan });
    const decoded = checked({ result: await decodeAddonUpload({ archiveReader: required.effects.archiveReader, upload: { kind: 'files',
        files: [...scan.files].map(([path, content]) => ({ path, base64: Buffer.from(content).toString('base64') })) } }) });
    return { ...decoded, pluginId: manifest.manifest.name };
}

/** Only validated, package-relative binding paths are copied; caches cannot be declared back in. */
function bundledBindings(required: { value: unknown }): string[] {
    const extension = bundledExtensionSchema.parse(required.value ?? {});
    if (!extension.capabilities || Array.isArray(extension.capabilities)) return [];
    const paths: string[] = [];
    for (const capability of Object.values(extension.capabilities)) {
        if (!capability.binding) continue;
        const path = capability.binding.replace(/^\.\//, '');
        validateSkillPath({ filePath: path });
        if (path.split('/').some(name => isBundledArtifact({ name }))) throw new Error('Bundled binding points to build/dependency artifacts');
        paths.push(path);
    }
    return paths;
}

/** Read selected files with Jini's no-follow bounded reader; skip caches inside skill trees.
 * Links and special files fail closed. Directory depth, entries, files and retained bytes are capped.
 */
async function readBundledPath(required: { effects: AddonEffects; sourceDir: string; path: string; scan: BundledScan }): Promise<void> {
    validateSkillPath({ filePath: required.path });
    if (++required.scan.entries > 8192 || required.path.split('/').length > 16) throw new RangeError('Bundled plugin traversal cap');
    const path = join(required.sourceDir, required.path);
    if (await required.effects.filesystem.realpath(path) !== path) throw new Error('Bundled plugin link refused');
    const stat = await required.effects.skillFilesystem.lstat({ path });
    if (stat.kind === 'directory') {
        await readBundledDirectory(required);
        return;
    }
    if (stat.kind !== 'file') throw new Error('Bundled plugin special file refused');
    if (required.scan.files.has(required.path)) return;
    if (required.scan.files.size >= 2048) throw new RangeError('Bundled plugin file cap');
    const bytes = await required.effects.skillFilesystem.readFile({ path, maxBytes: Math.min(16777216, 33554432 - required.scan.bytes) });
    required.scan.bytes += bytes.byteLength;
    required.scan.files.set(required.path, bytes);
}

/** Filter before traversal so dependency/build trees are never read or copied. */
async function readBundledDirectory(required: { effects: AddonEffects; sourceDir: string; path: string; scan: BundledScan }): Promise<void> {
    const entries = await required.effects.filesystem.readdir(join(required.sourceDir, required.path), { withFileTypes: true });
    if (entries.length + required.scan.entries > 8192) throw new RangeError('Bundled plugin entry cap');
    for (const entry of entries) {
        if (!isBundledArtifact({ name: entry.name })) await readBundledPath({ ...required, path: required.path + '/' + entry.name });
    }
}

function isBundledArtifact(required: { name: string }): boolean {
    return bundledArtifacts.has(required.name) || required.name.endsWith('.tsbuildinfo');
}

/** No bundled directory is a legitimate build; other read failures remain explicit boot failures. */
async function bundledSourceEntries(required: { effects: AddonEffects; path: string }): Promise<Dirent[]> {
    try { return await required.effects.filesystem.readdir(required.path, { withFileTypes: true }); }
    catch (error) {
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return [];
        throw error;
    }
}

function scopeKey(required: { context: CallContext }): string {
    return createHash('sha256').update(JSON.stringify([required.context.scope.ownerId, required.context.scope.workspaceId])).digest('hex');
}
function checked<T>(required: { result: Outcome<T> }): T {
    if (!required.result.ok) throw new Error('Add-on adapter failed');
    return required.result.value;
}
function actorId(required: { context: CallContext }): string {
    return required.context.principal.kind === 'owner' ? required.context.principal.ownerId : required.context.correlationId;
}
function agentSummary(required: { plugin: InstalledAgentPlugin; enabled: boolean; revision: string }): AddonSummary {
    return addonSummarySchema.parse({ id: required.plugin.pluginId, kind: 'agent-plugin', name: required.plugin.displayName ?? required.plugin.pluginId,
        description: required.plugin.description ?? '', version: required.plugin.version ?? '1', enabled: required.enabled, revision: required.revision });
}

/** Bound metadata traversal preserves declared ad_spend; missing/unknown declarations remain write. */
function readDeclaredEffects(required: { value: unknown }): unknown[] {
    const value = boundedJsonSchema.parse(required.value);
    const effects: unknown[] = [];
    const pending: unknown[] = [value];
    while (pending.length) {
        const entry = pending.pop();
        if (Array.isArray(entry)) { pending.push(...entry); continue; }
        if (!entry || typeof entry !== 'object') continue;
        const record = entry as Record<string, unknown>;
        if (Array.isArray(record.effects)) effects.push(...record.effects);
        pending.push(...Object.entries(record).filter(([key]) => key !== 'effects').map(([, item]) => item));
    }
    return effects.length ? effects : ['write'];
}

/** Canonical self-contained plugin ABI; no unpublished @jini-ai/plugin-sdk dependency. */
export function executableHostPorts(_required: Record<string, never>): ManifestHostPorts {
    return { identityNamespace: 'io.github.ainsep.openmarketing', coreOwnerName: 'Open Marketing',
        capabilityVocabulary: ['content.read', 'content.extend', 'hooks.attach', 'http.route.register', 'tools.register', 'render.contribute', 'read', 'write', 'destructive', 'ad_spend', 'generation', 'conversion'],
        pluginSdkBinding: { hookIds: [], beforeSaveHook: 'beforeSave', hookSemantics: {}, runtimeSdkVersion: '1.0.0',
            readDefinedPlugin({ moduleValue }) {
                const parsed = z.object({ default: z.object({ definition: z.object({ setup: z.custom<DefinedPlugin['definition']['setup']>(value => typeof value === 'function') }) }) }).safeParse(moduleValue);
                return parsed.success ? parsed.data.default : null;
            }, buildSdk: ({ sdk }) => sdk, definePlugin: definition => ({ definition }) },
        declarativeContentTypes: { validateManifest: () => ({ errors: [] }), parse: ({ value }) => ({ decls: [], errors: Array.isArray(value) && value.length ? [{ code: 'CONTENT_TYPES_UNAVAILABLE', file: null, message: 'No content-type host is mounted' }] : [] }),
            async plan() { return { conflicts: [], items: [] }; }, async apply() { throw new Error('Content types unavailable'); } } };
}

function executableTierPolicy(_required: Record<string, never>): PluginTierPolicy {
    return { siteErrors: () => [], checkInstall() {}, allowLoad: () => true, execution: 'in-process' };
}

/** Foreign Jini repository ABI is bound to one host workspace; reads validate persisted row shape. */
function activationRepository(required: { db: CredentialSqlPort; context: CallContext }): PluginActivationRepoPort {
    const workspaceId = required.context.scope.workspaceId;
    function assertWorkspace(input: { workspaceId: string }): void { if (input.workspaceId !== workspaceId) throw new Error('Activation scope mismatch'); }
    return {
        async getActivation(input) { assertWorkspace(input); return (await this.listAll({})).find(row => row.pluginId === input.pluginId) ?? null; },
        async save(record) {
            assertWorkspace(record);
            await required.db.query({ text: 'INSERT INTO addon_plugin_activation (workspace_id,plugin_id,version,enabled,updated_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT(workspace_id,plugin_id) DO UPDATE SET version=excluded.version,enabled=excluded.enabled,updated_at=excluded.updated_at',
                values: [workspaceId, record.pluginId, record.version, Number(record.enabled), record.updatedAt] });
        },
        async deleteActivation(input) { assertWorkspace(input); await required.db.query({ text: 'DELETE FROM addon_plugin_activation WHERE workspace_id=$1 AND plugin_id=$2', values: [workspaceId, input.pluginId] }); },
        async listAll() {
            const result = await required.db.query({ text: 'SELECT plugin_id,version,enabled,updated_at FROM addon_plugin_activation WHERE workspace_id=$1 LIMIT 1001', values: [workspaceId] });
            if (result.rows.length > 1000) throw new RangeError('Activation cap');
            return result.rows.map(row => ({ pluginId: z.string().parse(row.plugin_id), workspaceId, version: z.string().parse(row.version),
                enabled: z.union([z.literal(0), z.literal(1)]).parse(row.enabled) === 1, updatedAt: z.string().parse(row.updated_at) }));
        },
    };
}

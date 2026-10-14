/** Thin executable host: published Jini installation, discovery, claims, loader and contributions. */
import { createPluginContributionCapture, PluginConflictError, pluginCapabilitySet, resolvePluginConflicts,
    setPluginEnabled, uninstallPlugin } from '@jini-ai/plugins/host';
import type { CapabilityScopedSdkCoreDeps, ManifestHostPorts, PluginActivationRepoPort,
    PluginContributionRegistry, PluginDiscoveryRecord, PluginManifest, PluginSdk, PluginTierPolicy } from '@jini-ai/plugins/host';
import { discoverPlugins, installSitePlugin, loadPlugin, previewSitePluginInstall, siteEntryPath } from '@jini-ai/plugins/host/node';
import type { VerifyDigestPort } from '@jini-ai/plugins/host';
import type { CallContext } from '@open-marketing/contracts';
import type { AddonPackageAdapter } from './addons.js';
import { addonToolEffectsSchema } from '@open-marketing/contracts';
import { dirname } from 'node:path';
import type { AddonFiles } from './addon-upload.js';

export interface ExecutablePluginHostDependencies {
    host: ManifestHostPorts; installDir: string; activations: PluginActivationRepoPort;
    registry: PluginContributionRegistry; tierPolicy: PluginTierPolicy; clock: { nowMs(): number };
    verifyDigest: VerifyDigestPort;
    importVerified(required: { entryPath: string; manifest: PluginManifest }): Promise<unknown>;
    removeBytes(required: { pluginId: string }): Promise<void>;
    coreDeps: Omit<CapabilityScopedSdkCoreDeps, 'contributions'>;
}

/** Installation never imports code. Enable uses fresh discovery and Jini's shared claim owner.
 * Browser-provider approval is supplied in D4; D2 leaves Jini's loader unchanged.
 * @example const packages = createExecutablePluginHost({ host, installDir, activations, registry, ...effects });
 * @complexity Bounded package bytes plus Jini's claim checks; arbitrary plugin setup is owner-unrestricted.
 */
export function createExecutablePluginHost(required: ExecutablePluginHostDependencies): AddonPackageAdapter {
    const discover = () => discoverPlugins({ ...required.host, installDir: required.installDir, builtIns: [], tierPolicy: required.tierPolicy });
    const conflicts = async (input: { manifest: PluginManifest }) => {
        const discovery = await discover();
        const activations = await required.activations.listAll({});
        return resolvePluginConflicts({ ...required.host, workspaceId: activations[0]?.workspaceId ?? '', discovery: [...discovery,
            { id: input.manifest.id, name: input.manifest.name, version: input.manifest.version, source: 'site', status: 'valid', errors: [], manifest: input.manifest }], activations,
            coreClaims: [{ kind: 'route', key: '/api/addons/*', mode: 'exclusive' }] }, { candidateId: input.manifest.id }).get(input.manifest.id) ?? [];
    };
    return {
        async prepare(input) {
            const archiveReader = async () => new Map(input.files);
            const deps = { ...required.host, installDir: required.installDir, builtInIds: [], archiveReader,
                tierPolicy: required.tierPolicy, repo: required.activations, conflicts };
            const archive = new Uint8Array([0]); // Retained files are the reader input; no second ZIP parser.
            const preview = await previewSitePluginInstall({ archive, deps });
            return { summary: { id: preview.id, kind: 'plugin', name: preview.name, description: '',
                version: preview.version, enabled: false, revision: input.revision },
                async commit() { await installSitePlugin({ archive, deps, expectedDigest: preview.digest }); } };
        },
        async setEnabled(input) {
            const discovery = await discover();
            const record = discovery.find(row => row.id === input.addon.id);
            if (input.enabled) await assertClaims({ record, context: input.context, discovery });
            // Unregister immediately, even when persistence or Jini's disable callback fails.
            if (!input.enabled) required.registry.detach({ pluginId: input.addon.id });
            await setPluginEnabled({ input: { workspaceId: input.context.scope.workspaceId, pluginId: input.addon.id, enabled: input.enabled },
                deps: { clock: required.clock, repo: required.activations, discovery,
                    onEnabled: async () => { await enable({ record: record! }); },
                    onDisabled: pluginId => required.registry.detach({ pluginId }) } });
        },
        async remove(input) {
            await uninstallPlugin({ input: { pluginId: input.addon.id, workspaceId: input.context.scope.workspaceId,
                at: new Date(required.clock.nowMs()).toISOString(), actor: { principalId: principalId({ context: input.context }) } },
                deps: { repo: required.activations, discovery: await discover(), remove: async ({ id }) => {
                    await required.removeBytes({ pluginId: id }); return { ok: true, version: null };
                } } });
            await required.activations.deleteActivation({ workspaceId: input.context.scope.workspaceId, pluginId: input.addon.id });
        },
        async describe(input) {
            const activation = await required.activations.getActivation({ workspaceId: input.context.scope.workspaceId, pluginId: input.addon.id });
            if (!activation?.enabled || activation.version !== input.addon.version) throw new Error('Plugin inactive');
            const record = (await discover()).find(row => row.id === input.addon.id);
            if (!record?.manifest || record.status !== 'valid') throw new Error('Plugin unavailable');
            const manifest = record.manifest;
            const contributions = required.registry.list({}).find(row => row.pluginId === input.addon.id);
            return { effects: executableEffects({ manifest }),
                tools: contributions?.tools.map(tool => ({ name: tool.name, description: tool.description,
                    inputSchema: tool.inputSchema, effects: executableEffects({ manifest }) })) ?? [] };
        },
    };

    async function assertClaims(input: { record?: PluginDiscoveryRecord; context: CallContext; discovery: readonly PluginDiscoveryRecord[] }): Promise<void> {
        if (!input.record?.manifest) throw new Error('Invalid plugin');
        const found = resolvePluginConflicts({ ...required.host, workspaceId: input.context.scope.workspaceId, discovery: input.discovery,
            activations: await required.activations.listAll({}), coreClaims: [{ kind: 'route', key: '/api/addons/*', mode: 'exclusive' }] }, { candidateId: input.record.id });
        const conflicts = found.get(input.record.id) ?? [];
        if (conflicts.length) throw new PluginConflictError({ pluginId: input.record.id, conflicts });
    }

    /** Loader owns integrity -> SDK range -> import -> setup; capture/registry own cleanup. */
    async function enable(input: { record: PluginDiscoveryRecord }): Promise<void> {
        const manifest = input.record.manifest!;
        const capture = createPluginContributionCapture({ manifest });
        let sdk: PluginSdk | undefined;
        const binding = { ...required.host.pluginSdkBinding, buildSdk(value: { sdk: PluginSdk }) {
            sdk = required.host.pluginSdkBinding.buildSdk(value); return sdk;
        } };
        const entryPath = siteEntryPath({ installDir: required.installDir, id: input.record.id, version: input.record.version });
        try {
            const result = await loadPlugin({ record: input.record, manifest, entryPath, pluginSdkBinding: binding,
                verifyDigest: required.verifyDigest, tierPolicy: required.tierPolicy,
                importModule: async () => ({ exported: await required.importVerified({ entryPath, manifest }) }),
                coreDeps: { ...required.coreDeps, contributions: capture } });
            if (!result.loaded) throw new Error('Plugin load failed');
            if (sdk) required.registry.replace({ contributions: capture.seal({ sdk }) });
        } catch {
            required.registry.detach({ pluginId: input.record.id });
            throw new Error('Plugin enable failed');
        }
    }
}

/** Unknown runtime capabilities never imply read. Known financial/destructive effects survive. */
function executableEffects(required: { manifest: PluginManifest }): string[] {
    return [...new Set(pluginCapabilitySet({ manifest: required.manifest }).flatMap(capability => addonToolEffectsSchema.parse([capability.replace(/^capability:/, '')])))];
}

function principalId(required: { context: CallContext }): string {
    const principal = required.context.principal;
    switch (principal.kind) {
        case 'owner': return principal.ownerId;
        case 'agent': return principal.runId;
        case 'service': return principal.serviceId;
    }
}

/** Importer helper input: Jini snapshots the exact module graph in server composition. */
export function executablePackageRoot(required: { entryPath: string }): string { return dirname(dirname(required.entryPath)); }

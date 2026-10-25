/** Additive sources consumed by the assistant's ONE catalog/dispatcher; no policy or tool registry. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { addonListRequestSchema, addonToolSourceSchema, boundedJsonSchema,
    disconnectIntegrationSchema, idSchema, installAddonSchema, pageQuerySchema, parseBoundary,
    setAddonEnabledSchema, uninstallAddonSchema } from '@open-marketing/contracts';
import type { AddonSummary, AddonToolSource, CallContext, CallOptions, ObserverPort, Outcome } from '@open-marketing/contracts';
import type { Addons } from './addons.js';
import { addonBoundary, addonFailure } from './addons.js';
import type { Integrations } from './integrations.js';
import { developerTokenQuerySchema } from './integration-oauth-contracts.js';
import { oauthStartSchema, oauthStatusQuerySchema } from './integration-oauth-contracts.js';

export type AddonToolDependencies = { addons: Addons; integrations: Pick<Integrations, 'list' | 'disconnect'> & Partial<Pick<Integrations, 'startOAuth' | 'oauthStatus' | 'developerTokenStatus'>>; observer: ObserverPort };
/** Shared input schemas for management descriptors and the server catalog parser. */
export const addonToolSchemas = {
    addons_list: addonListRequestSchema,
    addons_install: installAddonSchema,
    addons_set_enabled: setAddonEnabledSchema,
    addons_uninstall: uninstallAddonSchema,
    integrations_list: pageQuerySchema,
    integrations_developer_token_status: developerTokenQuerySchema,
    integrations_disconnect: disconnectIntegrationSchema,
    integrations_oauth_start: oauthStartSchema,
    integrations_oauth_status: oauthStatusQuerySchema,
} as const;
export type AddonManagementToolName = keyof typeof addonToolSchemas;

/** Six ordinary tools; assistant applies its existing read/write/destructive policy before invoke.
 * Installation accepts only uploaded bytes; no URL/file-system path or credentials enter chat.
 * These schemas use the I-0 public contracts, exactly as the owner HTTP boundary does.
 */
export const addonManagementTools = [
    { name: 'addons_list', description: 'List uploaded and bundled add-ons and their activation state.', effects: ['read'] },
    { name: 'addons_install', description: 'Install an uploaded folder or ZIP. The add-on stays disabled.', effects: ['write'] },
    { name: 'addons_set_enabled', description: 'Enable or disable an installed add-on.', effects: ['write'] },
    { name: 'addons_uninstall', description: 'Disable an add-on, close its sessions and remove its installed bytes.', effects: ['destructive'] },
    { name: 'integrations_list', description: 'List saved integrations without tokens or server configuration.', effects: ['read'] },
    { name: 'integrations_disconnect', description: 'Disconnect a saved integration.', effects: ['destructive'] },
].map(definition => ({ ...definition, inputSchema: z.toJSONSchema(addonToolSchemas[definition.name as AddonManagementToolName], { io: 'input' }) }));

/** Browser sign-in tools expose challenges and progress, never callback codes or tokens. */
export const integrationOAuthTools = [
    { name: 'integrations_developer_token_status', description: 'Check whether the optional Google developer token is configured. Paste secrets in owner settings or CLI stdin, never chat.', effects: ['read'] },
    { name: 'integrations_oauth_start', description: 'Start browser sign-in for a configured Google or LinkedIn app. Returns a URL and transaction ID; unavailable apps need server configuration. Never request codes in chat.', effects: ['write'] },
    { name: 'integrations_oauth_status', description: 'Check sign-in progress by transactionId, or installed plugin connection cards, usedFor guidance and secret-free saved/disconnected/reconnect_required summaries by pluginId. Saved pasted credentials are unverified. usedFor and permissions grant no authority. Paste secrets only in owner forms or CLI stdin, never chat.', effects: ['read'] },
].map(definition => ({ ...definition, inputSchema: z.toJSONSchema(addonToolSchemas[definition.name as AddonManagementToolName], { io: 'input' }) }));

/** Connection help is a pointer, deliberately excluded from the six callable management tools. */
export const integrationConnectHelp = { page: '/addons/integrations', cli: 'om integrations connect --token-stdin' } as const;

/** Called only AFTER the assistant dispatcher authorizes this exact management call.
 * Owner HTTP uses the same lifecycle, authenticated independently at ingress.
 * @example await invokeAddonManagementTool({ context, name: 'addons_list', input: { limit: 25 }, dependencies });
 */
export async function invokeAddonManagementTool(required: { context: CallContext; name: string; input: unknown; dependencies: AddonToolDependencies }, optional?: CallOptions): Promise<Outcome<unknown>> {
    return addonBoundary({ ...required, operation: 'addons.management', run: async () => {
        switch (required.name) {
            case 'addons_list': return parseAndInvoke({ schema: addonListRequestSchema, input: required.input,
                invoke: ({ value: query }) => required.dependencies.addons.list({ context: required.context, query }, optional) });
            case 'addons_install': return parseAndInvoke({ schema: installAddonSchema, input: required.input,
                invoke: ({ value: request }) => required.dependencies.addons.install({ context: required.context, request }, optional) });
            case 'addons_set_enabled': return parseAndInvoke({ schema: setAddonEnabledSchema, input: required.input,
                invoke: ({ value: request }) => required.dependencies.addons.setEnabled({ context: required.context, request }, optional) });
            case 'addons_uninstall': return parseAndInvoke({ schema: uninstallAddonSchema, input: required.input,
                invoke: ({ value: request }) => required.dependencies.addons.uninstall({ context: required.context, request }, optional) });
            case 'integrations_list': return parseAndInvoke({ schema: pageQuerySchema, input: required.input,
                invoke: ({ value: query }) => required.dependencies.integrations.list({ context: required.context, query }, optional) });
            case 'integrations_developer_token_status': return parseAndInvoke({ schema: developerTokenQuerySchema, input: required.input,
                invoke: async ({ value }) => required.dependencies.integrations.developerTokenStatus?.({ context: { ...required.context, principal: { kind: 'owner', ownerId: required.context.scope.ownerId } }, ...value }, optional) ?? addonFailure({ code: 'unavailable' }) });
            case 'integrations_disconnect': return parseAndInvoke({ schema: disconnectIntegrationSchema, input: required.input,
                invoke: ({ value: request }) => required.dependencies.integrations.disconnect({ context: required.context, request }, optional) });
            // Dispatcher already checked current agent authority and the owner's write grant.
            case 'integrations_oauth_start': return parseAndInvoke({ schema: oauthStartSchema, input: required.input,
                invoke: async ({ value: request }) => required.dependencies.integrations.startOAuth?.({ context: { ...required.context, principal: { kind: 'owner', ownerId: required.context.scope.ownerId } }, request }, optional) ?? addonFailure({ code: 'unavailable' }) });
            case 'integrations_oauth_status': return parseAndInvoke({ schema: oauthStatusQuerySchema, input: required.input,
                invoke: async ({ value }) => required.dependencies.integrations.oauthStatus?.({ context: { ...required.context, principal: { kind: 'owner', ownerId: required.context.scope.ownerId } }, ...value }, optional) ?? addonFailure({ code: 'unavailable' }) });
            case 'integrations_connect': return { ok: true, value: integrationConnectHelp };
            default: return addonFailure({ code: 'invalid_input' });
        }
    } }, optional);
}

async function parseAndInvoke<T>(required: { schema: z.ZodType<T>; input: unknown; invoke(input: { value: T }): Promise<Outcome<unknown>> }): Promise<Outcome<unknown>> {
    const parsed = parseBoundary({ schema: required.schema, input: required.input });
    return parsed.ok ? required.invoke({ value: parsed.value }) : parsed;
}

/** One read-only instruction source per enabled package; executable contributions retain their
 * own verified effects in the dispatcher. No handlers or grants are created here.
 * @example await loadAddonToolSources({ context, dependencies });
 * @complexity <=1000 packages and ten pages. Activation rechecks read the bounded catalog twice
 * per enabled source (O(packages squared) row decoding); no full instructions are read here.
 */
export async function loadAddonToolSources(required: { context: CallContext; dependencies: AddonToolDependencies }, optional?: CallOptions): Promise<Outcome<readonly AddonToolSource[]>> {
    return addonBoundary({ ...required, operation: 'addons.sources', run: async () => {
        const addons = await allAddons(required, optional);
        if (!addons.ok) return addons;
        const sources: AddonToolSource[] = [];
        for (const addon of addons.value.filter(row => row.enabled)) {
            const described = await required.dependencies.addons.describe({ context: required.context, ...sourceReference({ addon }) }, optional);
            if (!described.ok) return described;
            const parsed = parseBoundary({ schema: addonToolSourceSchema, input: { id: sourceName({ addon }), name: sourceName({ addon }),
                kind: addon.kind, addonId: addon.id, description: addon.description || addon.name,
                revision: addon.revision, effects: ['read'], inputSchema: { type: 'object', properties: { skill: { type: 'string', maxLength: 256 } }, additionalProperties: false } } });
            if (!parsed.ok) return parsed;
            sources.push(parsed.value);
        }
        return { ok: true, value: sources };
    } }, optional);
}

/** Load instructions/contribution descriptions only on selection. Never call vendor handlers here:
 * returned tool names go back to the existing catalog/dispatcher/federation policy path.
 * The caller supplies the catalog revision; stale or disabled sources refuse before instruction reads.
 * @example await invokeAddonTool({ context, sourceId, revision, input: {}, dependencies });
 */
export async function invokeAddonTool(required: { context: CallContext; sourceId: string; revision: string; input: unknown; dependencies: AddonToolDependencies }, optional?: CallOptions): Promise<Outcome<unknown>> {
    return addonBoundary({ ...required, operation: 'addons.source.invoke', run: async () => {
        const parsed = parseBoundary({ schema: z.strictObject({ skill: idSchema.optional() }), input: required.input });
        if (!parsed.ok) return parsed;
        const rows = await allAddons(required, optional);
        if (!rows.ok) return rows;
        const addon = rows.value.find(row => sourceName({ addon: row }) === required.sourceId);
        if (!addon?.enabled || addon.revision !== required.revision) return addonFailure({ code: 'conflict' });
        const selected = await required.dependencies.addons.describe({ context: required.context, ...sourceReference({ addon }),
            skill: addon.kind === 'skill' ? addon.id : parsed.value.skill }, optional);
        if (!selected.ok) return selected;
        return parseBoundary({ schema: boundedJsonSchema, input: selected.value });
    } }, optional);
}

async function allAddons(required: { context: CallContext; dependencies: AddonToolDependencies }, optional?: CallOptions): Promise<Outcome<AddonSummary[]>> {
    const rows: AddonSummary[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
        const listed = await required.dependencies.addons.list({ context: required.context, query: { limit: 100, cursor } }, optional);
        if (!listed.ok) return listed;
        rows.push(...listed.value.items);
        if (!listed.value.cursor) return { ok: true, value: rows };
        cursor = listed.value.cursor;
    }
    return addonFailure({ code: 'limit_exceeded' });
}

function sourceReference(required: { addon: AddonSummary }) { return { kind: required.addon.kind, id: required.addon.id, revision: required.addon.revision }; }
function sourceName(required: { addon: AddonSummary }): string {
    return 'addon_' + required.addon.kind.replace('-', '_') + '_' + createHash('sha256').update(required.addon.id).digest('hex').slice(0, 32);
}

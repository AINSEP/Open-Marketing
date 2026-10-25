/** Built-in help data, independent of optional playbook activation. No vendor calls. */
import { z } from 'zod';
import { addonListSchema, boundedJsonSchema, callContextSchema, chartProviderListSchema, generationAllowanceSettingsSchema,
    idSchema, integrationListSchema, parseBoundary, scopeSchema } from '@open-marketing/contracts';
import type { CallContext, IdPort, Outcome } from '@open-marketing/contracts';
import type { OmTools, OmToolDefinition } from './om-tools.js';
import { localFailure } from './composition/local-auth.js';

const topicId = z.enum(['workspaces', 'creative', 'media', 'campaigns', 'measurement', 'contacts', 'forms-events', 'integrations', 'addons', 'safety', 'settings', 'build-agent-plugin']);
const topicSchema = z.strictObject({ id: topicId, title: z.string().min(1).max(120), summary: z.string().min(1).max(400), explanation: z.string().min(1).max(6000) });
const catalogSchema = boundedJsonSchema.pipe(z.strictObject({ version: idSchema, topics: topicSchema.array().min(1).max(12) })
    .refine(catalog => new Set(catalog.topics.map(topic => topic.id)).size === catalog.topics.length, 'Duplicate topic IDs'));
/** Identity never comes from guide input. @example { operation: 'explain', topic: 'creative' } */
export const siteGuideInputSchema = z.discriminatedUnion('operation', [
    z.strictObject({ operation: z.literal('overview') }),
    z.strictObject({ operation: z.literal('explain'), topic: topicId }),
]);
const factSchema = z.discriminatedUnion('status', [
    z.strictObject({ tool: idSchema, status: z.literal('available'), data: boundedJsonSchema, truncated: z.boolean() }),
    z.strictObject({ tool: idSchema, status: z.literal('unavailable') }),
]);
type Fact = z.infer<typeof factSchema>;
const capabilitySchema = z.strictObject({ tool: idSchema, status: z.enum(['connected', 'unavailable']) });
const resultSchema = boundedJsonSchema.pipe(z.discriminatedUnion('operation', [
    z.strictObject({ version: idSchema, operation: z.literal('overview'), topics: topicSchema.omit({ explanation: true }).array().max(12) }),
    z.strictObject({ version: idSchema, operation: z.literal('explain'), topic: topicSchema,
        capabilities: capabilitySchema.array().max(20), facts: factSchema.array().max(3) }),
]));

// Fixed help pointers, never plugin contributions or a permission registry.
const topicTools: Record<z.infer<typeof topicId>, readonly string[]> = {
    workspaces: ['om_workspace_current', 'om_workspaces_list', 'om_account_binding_get'],
    creative: ['om_creative_generate', 'om_creative_status', 'om_creative_cancel', 'om_allowance_get'],
    media: ['om_media_list', 'om_media_import', 'om_media_crop', 'om_media_record_provenance'],
    campaigns: ['om_campaign_save_local', 'om_campaign_get_local', 'om_campaign_propose_launch', 'om_campaign_deploy_paused', 'om_campaign_reconcile_deployment'],
    measurement: ['om_measure_create_link', 'om_measure_report_cac'],
    contacts: ['om_contacts_resolve', 'om_contacts_upsert', 'om_contacts_merge', 'om_privacy_request_erasure', 'om_privacy_status'],
    'forms-events': ['om_forms_publish', 'om_forms_preview', 'om_forms_submissions', 'om_web_events_snippet', 'om_web_events_touches', 'om_web_events_bind_visitor'],
    integrations: ['integrations_list', 'integrations_oauth_start', 'integrations_oauth_status', 'integrations_disconnect'],
    addons: ['addons_list', 'addons_install', 'addons_set_enabled', 'addons_uninstall', 'om_chart_providers_list'],
    safety: ['om_safety_status', 'om_halt_account', 'om_allowance_get'],
    settings: ['om_assistant_settings_get', 'om_assistant_settings_set', 'om_allowance_get', 'om_allowance_set', 'page.navigate'],
    'build-agent-plugin': ['addons_install', 'addons_set_enabled'],
};
const factReads: Partial<Record<z.infer<typeof topicId>, readonly string[]>> = {
    workspaces: ['om_workspace_current'], creative: ['om_allowance_get'], settings: ['om_allowance_get'],
    integrations: ['integrations_list'], addons: ['addons_list', 'om_chart_providers_list'], media: ['om_media_list'],
};
type GuideRequest = { context: CallContext; input: unknown; catalog: unknown; tools: OmTools; ids: IdPort;
    definitions(required: { context: CallContext }): Promise<Outcome<readonly OmToolDefinition[]>>;
    authorize(required: { context: CallContext }): Outcome<void> };

/** Parse help, read a single topic's fixed projections, then recheck current authority.
 * Missing/invalid help fails independently of server boot; no raw adapter errors escape.
 * @returns Validated overview/explanation or typed input, authority or availability failure.
 * @example await runOmSiteGuide({ context, input: { operation: 'overview' }, catalog, tools, ids, definitions, authorize });
 * @complexity O(c + d) time/space, c <=64 KiB catalog, d <=1100 definitions; <=3 one-page reads.
 */
export async function runOmSiteGuide(required: GuideRequest, options: { signal?: AbortSignal } = {}): Promise<Outcome<unknown>> {
    const context = parseBoundary({ schema: callContextSchema, input: required.context });
    if (!context.ok) return context;
    const authority = required.authorize({ context: context.value });
    if (!authority.ok) return authority;
    if (options.signal?.aborted) return localFailure({ code: 'cancelled', message: 'Guide read cancelled' });
    const input = parseBoundary({ schema: siteGuideInputSchema, input: required.input });
    if (!input.ok) return input;
    const catalog = catalogSchema.safeParse(required.catalog);
    if (!catalog.success) return localFailure({ message: 'Site guide catalog unavailable' });
    const definitions = await required.definitions({ context: context.value });
    if (!definitions.ok) return localFailure({ message: 'Guide capabilities unavailable' });
    const currentAuthority = required.authorize({ context: context.value });
    if (!currentAuthority.ok) return currentAuthority;
    if (options.signal?.aborted) return localFailure({ code: 'cancelled', message: 'Guide read cancelled' });
    const visibleDefinitions = definitions.value.filter(tool => tool.policy !== 'internal');
    const topics = visibleTopics({ topics: catalog.data.topics, definitions: visibleDefinitions });
    if (input.value.operation === 'overview') return parseBoundary({ schema: resultSchema, input: {
        version: catalog.data.version, operation: 'overview', topics: topics.map(({ id, title, summary }) => ({ id, title, summary })) } });
    const selectedTopic = input.value.topic;
    const topic = topics.find(topic => topic.id === selectedTopic);
    if (!topic) return localFailure({ code: 'invalid_input', message: 'Unknown guide topic' });
    return explain({ ...required, topic, version: catalog.data.version, visibleDefinitions }, options);
}

/** Hide topics without visible actions and omit sentences pointing at hidden tools.
 * Pure projection of the fixed catalog; unavailable visible bindings remain discoverable.
 * @complexity O(d + c) time/space for <=1100 definitions and <=64 KiB catalog text.
 */
function visibleTopics(required: { topics: z.infer<typeof topicSchema>[]; definitions: readonly OmToolDefinition[] }): z.infer<typeof topicSchema>[] {
    const names = new Set(required.definitions.map(tool => tool.name));
    return required.topics.filter(topic => topicTools[topic.id].some(name => names.has(name)))
        .map(topic => ({ ...topic, summary: visibleText({ text: topic.summary, names }) || topic.title,
            explanation: visibleText({ text: topic.explanation, names }) || 'Discover the visible tools below for current capabilities.' }));
}

/** Sentence-level omission keeps hidden action pointers out of otherwise visible topics.
 * Tool IDs contain no sentence-separating whitespace; fixed prose is not an authority source.
 * @complexity O(text bytes) time/space; bounded by the validated catalog.
 */
function visibleText(required: { text: string; names: ReadonlySet<string> }): string {
    return required.text.split(/(?<=[.!?])\s+/u).filter(sentence =>
        (sentence.match(/\b(?:om_[a-z_]+|addons_[a-z_]+|integrations_[a-z_]+|page\.[a-z_]+)\b/gu) ?? [])
            .every(name => required.names.has(name))).join(' ');
}

/** Catalog membership is only a binding hint, never proof of vendor readiness or execution. */
async function explain(required: GuideRequest & { topic: z.infer<typeof topicSchema>; version: string; visibleDefinitions: readonly OmToolDefinition[] }, options: { signal?: AbortSignal }): Promise<Outcome<unknown>> {
    const capabilities = required.visibleDefinitions.filter(tool => topicTools[required.topic.id].includes(tool.name))
        .map(tool => ({ tool: tool.name, status: bindingStatus({ tool }) }));
    const facts: Fact[] = [];
    const reads = (factReads[required.topic.id] ?? []).filter(name => required.visibleDefinitions.some(tool => tool.name === name));
    for (const tool of reads) {
        const authority = required.authorize({ context: required.context });
        if (!authority.ok) return authority;
        facts.push(await readFact({ ...required, tool, definitions: required.visibleDefinitions }, options));
    }
    const authority = required.authorize({ context: required.context });
    if (!authority.ok) return authority;
    if (options.signal?.aborted) return localFailure({ code: 'cancelled', message: 'Guide read cancelled' });
    return parseBoundary({ schema: resultSchema, input: { version: required.version, operation: 'explain', topic: required.topic, capabilities, facts } });
}

/** Financial metadata without its safety binding remains unavailable; reasons are never echoed. */
function bindingStatus({ tool }: { tool: OmToolDefinition }): 'connected' | 'unavailable' {
    if (tool.unavailableReason || tool.policy === 'internal') return 'unavailable';
    if ((tool.policy === 'generation' || tool.policy === 'spend') && (!tool.safety || !tool.prepareEffect)) return 'unavailable';
    return 'connected';
}

/** Fresh operation IDs avoid replaying stale read results. Dispatch retains scoped policy,
 * cancellation, observation and the existing 64-KiB result bound; no vendor probes or writes.
 */
async function readFact(required: Omit<GuideRequest, 'definitions'> & { tool: string; definitions: readonly OmToolDefinition[] }, options: { signal?: AbortSignal }): Promise<Fact> {
    const unavailable: Fact = { tool: required.tool, status: 'unavailable' };
    const definition = required.definitions.find(tool => tool.name === required.tool);
    if (!definition || definition.policy !== 'read' || definition.effects.length === 0 || definition.effects.some(effect => effect !== 'read') || definition.unavailableReason) return unavailable;
    const input: Record<string, number> = ['addons_list', 'integrations_list', 'om_media_list'].includes(required.tool) ? { limit: 5 } : {};
    const result = await required.tools.dispatch({ context: required.context,
        call: { name: required.tool, input, operationId: required.ids.next({}) }, signal: options.signal });
    if (!result.ok || result.value.status !== 'completed') return unavailable;
    const projected = projectFact({ tool: required.tool, value: result.value.output, context: required.context });
    if (!projected) return unavailable;
    const fact = factSchema.safeParse({ tool: required.tool, status: 'available', ...projected });
    return fact.success ? fact.data : unavailable;
}

/** Validate selected public DTOs and return only fixed projections, never raw service objects.
 * Inventories expose one page of at most five summaries; a cursor/extra rows means truncated.
 */
function projectFact(required: { tool: string; value: unknown; context: CallContext }): { data: unknown; truncated: boolean } | null {
    switch (required.tool) {
        case 'om_workspace_current': {
            const scope = scopeSchema.safeParse(required.value);
            if (!scope.success || scope.data.ownerId !== required.context.scope.ownerId || scope.data.workspaceId !== required.context.scope.workspaceId) return null;
            return { data: { workspaceId: scope.data.workspaceId }, truncated: false };
        }
        case 'om_allowance_get': {
            const allowance = generationAllowanceSettingsSchema.safeParse(required.value);
            return allowance.success ? { data: allowance.data, truncated: false } : null;
        }
        case 'integrations_list': return projectIntegrations(required);
        case 'addons_list': return projectAddons(required);
        case 'om_chart_providers_list': return projectCharts(required);
        case 'om_media_list': return projectMedia(required);
        default: return null;
    }
}

/** Saved status is not verification; connection identifiers are unnecessary for help. */
function projectIntegrations(required: { value: unknown }): { data: unknown; truncated: boolean } | null {
    const page = integrationListSchema.safeParse(required.value);
    if (!page.success) return null;
    return { data: page.data.items.slice(0, 5).map(({ pluginId, status }) => ({ pluginId, status })), truncated: page.data.cursor !== null || page.data.items.length > 5 };
}
/** Show lifecycle state without descriptions, instructions or revision metadata. */
function projectAddons(required: { value: unknown }): { data: unknown; truncated: boolean } | null {
    const page = addonListSchema.safeParse(required.value);
    if (!page.success) return null;
    return { data: page.data.items.slice(0, 5).map(({ id, kind, enabled }) => ({ id, kind, enabled })), truncated: page.data.cursor !== null || page.data.items.length > 5 };
}
/** Chart asset URLs/digests stay out of help; inventory is not admission evidence. */
function projectCharts(required: { value: unknown }): { data: unknown; truncated: boolean } | null {
    const page = chartProviderListSchema.safeParse(required.value);
    if (!page.success) return null;
    return { data: page.data.providers.slice(0, 5).map(({ id, pluginId, kinds }) => ({ id, pluginId, kinds })), truncated: page.data.providers.length > 5 };
}

/** Media titles, provenance and blob storage addresses are unnecessary for help. */
function projectMedia(required: { value: unknown; context: CallContext }): { data: unknown; truncated: boolean } | null {
    const page = z.object({ items: z.array(z.object({ record: z.object({ id: idSchema, workspaceId: idSchema }) })).max(5), cursor: idSchema.nullable() }).safeParse(required.value);
    if (!page.success || page.data.items.some(asset => asset.record.workspaceId !== required.context.scope.workspaceId)) return null;
    return { data: page.data.items.map(asset => ({ assetId: asset.record.id })), truncated: page.data.cursor !== null };
}

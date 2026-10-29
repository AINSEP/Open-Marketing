/** Generated inventory: one catalog, the owner route table and named capability NEEDS. */
import { routes } from './cli/http.js';
import type { OmToolDefinition, OmToolPolicy } from './om-tools.js';
import { discoveryTools } from './om-tools.js';
export type ToolCoverageRow = { capability: string; tool: string | null; access: 'read' | 'write'; policy: OmToolPolicy | 'owner';
    http: string | null; studio: string; cli: string; mcp: string; status: 'connected' | 'unadmitted' | 'internal' | 'NEEDS'; needs?: string; reason?: string };

/** Transports/authenticated credential ingress are deliberately outside the agent catalog. */
export const ownerRouteDisposition = {
    tools: 'Catalog transport', describeTool: 'Catalog transport', callTool: 'Catalog dispatcher transport', toolOperation: 'Catalog operation transport',
    addons: 'catalog', addonInstall: 'catalog', addonSetEnabled: 'catalog', addonUninstall: 'catalog',
    integrations: 'catalog', integrationConnect: 'Owner credential ingress; use /addons/integrations or om integrations connect --token-stdin', integrationDisconnect: 'catalog',
    chartProviders: 'catalog',
    mailProvider: 'catalog', setMailProvider: 'catalog',
    setLeadStage: 'catalog',
    integrationPluginSecretStatus: 'catalog',
    integrationConversionSettings: 'catalog', setIntegrationConversionSettings: 'catalog',
    integrationOAuthStart: 'catalog', integrationOAuthStatus: 'catalog',
    integrationOAuthClient: 'Owner-only sealed OAuth client ingress; secrets never enter assistant tools',
    integrationOAuthCallback: 'Single-use browser GET or authenticated CLI POST continuation; authorization codes never enter assistant tools',
    status: 'catalog', snapshot: 'catalog', campaigns: 'catalog', campaign: 'catalog', approvals: 'catalog', approval: 'catalog',
    answer: 'Authenticated owner approval continuation; a tool cannot answer its own card', halt: 'catalog', acknowledgeAlert: 'catalog', allowance: 'catalog',
    ask: 'Run transport; no recursive runs', conversations: 'Conversation transport', conversation: 'Conversation transport', createConversation: 'Conversation transport',
    uploadAttachment: 'Owner binary image ingress; runs receive refs, assistant reads uploads via om_media_list',
    assistantSettings: 'catalog', setAssistantSettings: 'catalog', runEvents: 'Run event transport', cancelRun: 'Run cancellation transport',
} satisfies Record<keyof typeof routes, string>;

/** Each approved capability names either its real definition or the missing owning boundary.
 * This is a capability inventory, not a manually maintained transport coverage table.
 */
const capabilities = [
    ['Conversion settings', 'integrations_conversion_settings_get', 'read', 'read', 'FEATURE_COMPOSITION', 'Installed-plugin settings reader'],
    ['Conversion settings', 'integrations_conversion_settings_set', 'write', 'write', 'FEATURE_COMPOSITION', 'Owner-only installed-plugin settings replacement'],
    ['How Open Marketing works', 'site_guide', 'read', 'read', 'SG1', 'Built-in topic guide and caller-scoped facts'],
    ['Workspace current', 'om_workspace_current', 'read', 'read', 'FEATURE_COMPOSITION', 'Current authenticated scope projection'],
    ['Mail provider selection', 'om_mail_provider_get', 'read', 'read', 'FEATURE_COMPOSITION', 'Inject provider-settings readers in server composition'],
    ['Mail provider selection', 'om_mail_provider_set', 'write', 'write', 'FEATURE_COMPOSITION', 'Inject provider-settings readers in server composition'],
    ['Account binding lookup', 'om_account_binding_get', 'read', 'read', 'FEATURE_COMPOSITION', 'Inject the existing AccountBindingLookupPort in server composition'],
    ['Workspace list', 'om_workspaces_list', 'read', 'read', 'FEATURE_COMPOSITION', 'Inject the public scoped workspace listing'],
    ['Account binding', null, 'write', 'write', 'WORKSPACE_SESSION_BINDING', 'WorkspaceService requires its freshly resolved session context; composition must supply authenticated session resolution'],
    ['Policy snapshot', null, 'read', 'read', 'POLICY_COMPOSITION', 'Policy snapshot services are not supplied to this catalog'],
    ['Policy evidence append', null, 'write', 'write', 'POLICY_EVIDENCE_PROVENANCE', 'Evidence requires verified caller provenance; no owner workflow is bound'],
    ['Audit list', 'om_audit_list', 'read', 'read', 'FEATURE_COMPOSITION', 'Inject the existing AuditService in server composition'],
    ['Contact resolve', 'om_contacts_resolve', 'read', 'read', 'FEATURE_COMPOSITION', 'Inject the existing ContactService in server composition'],
    ['Contact upsert', 'om_contacts_upsert', 'write', 'write', 'FEATURE_COMPOSITION', 'Inject the existing ContactService in server composition'],
    ['Contact merge', 'om_contacts_merge', 'write', 'destructive', 'FEATURE_COMPOSITION', 'Inject the existing ContactService in server composition'],
    ['Form preview', 'om_forms_preview', 'read', 'read', 'FEATURE_COMPOSITION', 'Inject the existing FormsService in server composition'],
    ['Form submissions', 'om_forms_submissions', 'read', 'read', 'FEATURE_COMPOSITION', 'Inject the existing FormsService in server composition'],
    ['Form publish', 'om_forms_publish', 'write', 'write', 'FEATURE_COMPOSITION', 'Bind the owning publication schema and service'],
    ['Lead inbox', 'om_leads_list', 'read', 'read', 'FEATURE_COMPOSITION', 'Inject the existing scoped LeadsService'],
    ['Lead detail', 'om_leads_get', 'read', 'read', 'FEATURE_COMPOSITION', 'Inject the existing scoped LeadsService'],
    ['Lead stage history', 'om_leads_history', 'read', 'read', 'FEATURE_COMPOSITION', 'Inject the existing scoped LeadsService'],
    ['Lead stage change', 'om_leads_set_stage', 'write', 'write', 'FEATURE_COMPOSITION', 'Fresh exact assistant card; direct owner stage route'],
    ['Attribution touches', 'om_web_events_touches', 'read', 'read', 'FEATURE_COMPOSITION', 'Inject the existing WebEventService in server composition'],
    ['Tracking snippet', 'om_web_events_snippet', 'read', 'read', 'FEATURE_COMPOSITION', 'Visitor-consented plugin tags and plugin URL templates through scoped server bindings'],
    ['Destination readiness and hosted-form fallback', 'om_tracking_readiness', 'read', 'read', 'FEATURE_COMPOSITION', 'Collector heartbeat and published form under configured public origin'],
    ['Visitor binding', 'om_web_events_bind_visitor', 'write', 'write', 'FEATURE_COMPOSITION', 'Inject the existing WebEventService and its scoped token verifier in composition'],
    ['Privacy erasure request', 'om_privacy_request_erasure', 'write', 'destructive', 'FEATURE_COMPOSITION', 'Inject the existing PrivacyService in server composition'],
    ['Privacy erasure status', 'om_privacy_status', 'read', 'read', 'FEATURE_COMPOSITION', 'Inject the existing PrivacyService in server composition'],
    ['Job get', 'om_jobs_get', 'read', 'read', 'FEATURE_COMPOSITION', 'Inject the public scoped jobs projection'],
    ['Job list', 'om_jobs_list', 'read', 'read', 'FEATURE_COMPOSITION', 'Inject the public scoped jobs projection'],
    ['Job cancel', 'om_jobs_cancel', 'write', 'write', 'FEATURE_COMPOSITION', 'Inject never-dispatched job cancellation'],
    ['Media list', 'om_media_list', 'read', 'read', 'MEDIA_DEPENDENCY_COMPOSITION', 'Inject the durable guarded MediaLibrary service'],
    ['Media import', 'om_media_import', 'write', 'write', 'MEDIA_DEPENDENCY_COMPOSITION', 'Inject the durable guarded MediaLibrary service'],
    ['Media crop', 'om_media_crop', 'write', 'write', 'MEDIA_DEPENDENCY_COMPOSITION', 'Inject the durable guarded MediaLibrary service'],
    ['Media provenance record', 'om_media_record_provenance', 'write', 'write', 'MEDIA_DEPENDENCY_COMPOSITION', 'Inject the durable guarded MediaLibrary service'],
    ['Creative generation', 'om_creative_generate', 'write', 'generation', 'FEATURE_COMPOSITION', 'Inject the real creative lifecycle with a verified local fixture quote/backend'],
    ['Creative status', 'om_creative_status', 'read', 'read', 'FEATURE_COMPOSITION', 'Inject the real creative lifecycle'],
    ['Creative cancellation', 'om_creative_cancel', 'write', 'write', 'FEATURE_COMPOSITION', 'Inject the real creative lifecycle'],
    ['Campaign reconcile', 'om_campaign_reconcile', 'read', 'read', 'FEATURE_COMPOSITION', 'Inject the existing CampaignService in server composition'],
    ['Paused/draft campaign creation', 'om_campaign_create_paused', 'write', 'write', 'FEATURE_COMPOSITION', 'Inject CampaignService with its existing transactional jobs/backend ports'],
    ['Launch proposal', 'om_campaign_propose_launch', 'write', 'write', 'FEATURE_COMPOSITION', 'Inject CampaignService with verified capabilities'],
    ['Neutral campaign local draft', 'om_campaign_save_local', 'write', 'write', 'FEATURE_COMPOSITION', 'Inject the neutral local draft service'],
    ['Neutral campaign draft lookup', 'om_campaign_get_local', 'read', 'read', 'FEATURE_COMPOSITION', 'Inject the neutral local draft service'],
    ['Campaign launch', 'om_campaign_deploy_paused', 'write', 'spend', 'C2R2', 'Owning exact approval/outbox, plugin PAUSED/DRAFT execution and readback are wired for scoped fixtures. NEEDS: production metadata/admission and DS1 UI. Activation remains unavailable.'],
    ['Campaign deployment read-only reconciliation', 'om_campaign_reconcile_deployment', 'read', 'read', 'C2R2', 'Reads saved scoped references/markers only; never creates or resumes. NEEDS: admitted vendor bindings for live reads.'],
    ['Tracked link creation', 'om_measure_create_link', 'write', 'write', 'FEATURE_COMPOSITION', 'Inject the existing MeasureService in server composition'],
    ['CAC reporting', 'om_measure_report_cac', 'read', 'read', 'FEATURE_COMPOSITION', 'Inject the existing MeasureService/platform report port in composition'],
    ['Safety status', 'om_safety_status', 'read', 'read', 'FEATURE_COMPOSITION', 'Current owning safety repository'],
    ['Generation allowance settings', 'om_allowance_get', 'read', 'read', 'FEATURE_COMPOSITION', 'Current owning safety repository'],
    ['Generation allowance setting', 'om_allowance_set', 'write', 'write', 'FEATURE_COMPOSITION', 'Current owning safety repository'],
    ['Local account halt', 'om_halt_account', 'write', 'write', 'FEATURE_COMPOSITION', 'Local durable halt; remoteStatus remains pending until typed backend stop'],
    ['Typed remote halt stop', null, 'write', 'internal', 'I-2', 'Typed worker and plugin stop mappings are bound; local remoteStatus=pending: vendors unadmitted and verified remote target inventory unavailable; Meta stop unavailable, LinkedIn stop digest incompatible with safety canonical digest'],
    ['Paid-sending allowance get', 'om_paid_sending_allowance_get', 'read', 'read', 'FEATURE_COMPOSITION', 'Inject safety paid-sending settings; default $5/day'],
    ['Paid-sending allowance set', 'om_paid_sending_allowance_set', 'write', 'write', 'FEATURE_COMPOSITION', 'Inject safety paid-sending settings; default $5/day'],
    ['Measurement grants list', 'om_measure_grants_list', 'read', 'read', 'FEATURE_COMPOSITION', 'Inject measure SQL grants via catalog scope'],
    ['Grant conversion sharing', 'om_measure_grant', 'write', 'write', 'FEATURE_COMPOSITION', 'Inject measure SQL grants via catalog scope'],
    ['Revoke conversion sharing', 'om_measure_revoke_grant', 'write', 'write', 'FEATURE_COMPOSITION', 'Inject measure SQL grants via catalog scope'],
    ['Per-campaign results', 'om_measure_results', 'read', 'read', 'FEATURE_COMPOSITION', 'Inject persisted reporting and creation-cohort counts'],
    ['Refresh campaign results', 'om_measure_refresh', 'write', 'write', 'FEATURE_COMPOSITION', 'Inject the canonical reporting jobs outbox'],
    ['Higgsfield creative lifecycle', null, 'write', 'generation', 'I-2_PRICING', 'Deferred: verified pricing/cost bounds are unavailable; hosted descriptors use executable federation after admission'],
    ['Meta ads hosted binding', null, 'write', 'write', 'I-2_META_HOSTED', 'Hosted tool names/schemas remain placeholders; organic Instagram has its own plugin backend'],
    ['Uploaded executable agent plugins', null, 'write', 'write', 'I-2_UPLOAD_BACKENDS', 'Deferred: executable backend loading covers bundled packages; uploaded instructions/MCP retain existing lifecycle'],
    ['Vendor conversions', null, 'write', 'internal', 'I-2_CONVERSION_EVIDENCE', 'Grants are owner-managed through om_measure_grant and om_measure_revoke_grant. Production conversion producer/worker remains NEEDS (W23-CONVERSION-PRODUCER-WORKER); local delivery denied'],
    ['Page control', 'page.navigate', 'write', 'write', 'A5', 'Bind authenticated frontend-session transport in composition'],
    ['Component discovery', 'search_components', 'read', 'read', 'A5', 'Published Jini component catalog'],
    ['Component description', 'describe_component', 'read', 'read', 'A5', 'Published Jini props schemas'],
    ['A2UI render/charts', 'render', 'write', 'write', 'A5', 'Bind authenticated frontend-session transport in composition'],
] as const;
const internal = ['Session/context resolution', 'Canonical policy gates', 'Audit append', 'Destination identifiers', 'Verified form/tracking ingress',
    'Privacy advance worker', 'Outbox enqueue/claim/process/resolve/retry', 'Media cost observation', 'Creative dispatch/poll/recover', 'Campaign dispatch',
    'Verified conversion ingestion/measurement-granted delivery', 'Safety approval/dispatch/reserve/settle', 'Credential callback/open/refresh/keyring', 'App supervisor/bootstrap'];

/** Catalog rows reflect actual availability; transport rows derive from the owner route table.
 * Every missing surface has a named NEEDS and reason, including dynamically installed sources.
 * @example generateOmToolCoverage({ definitions: currentCatalog });
 * @complexity O(n + r + c) time/space using sets, n <=1100 definitions; routes/capabilities fixed.
 */
export function generateOmToolCoverage(required: { definitions: readonly OmToolDefinition[] }): readonly ToolCoverageRow[] {
    const names = new Set(required.definitions.map(tool => tool.name));
    const ownerRoutes = new Set(required.definitions.map(tool => tool.ownerRoute));
    const rows: ToolCoverageRow[] = required.definitions.map(tool => catalogRow({ tool }));
    rows.push(...discoveryTools.map(tool => ({ capability: 'Catalog ' + tool.name, tool: tool.name,
        access: tool.name === 'execute_tool' ? 'write' as const : 'read' as const, policy: tool.name === 'execute_tool' ? 'write' as const : 'read' as const,
        http: '/api/agent/v1/mcp', studio: 'chat model transport', cli: 'om tools list/show/call', mcp: tool.name, status: 'connected' as const })));
    rows.push(...ownerRouteRows({ ownerRoutes }));
    rows.push({ capability: 'Site guide MCP resource', tool: null, access: 'read', policy: 'read', http: '/api/agent/v1/mcp',
        studio: 'chat via site_guide', cli: 'om tools call site_guide', mcp: 'jini://site-guide',
        status: names.has('site_guide') ? 'connected' : 'NEEDS', ...(names.has('site_guide') ? {} : { needs: 'SG1', reason: 'Built-in guide binding unavailable' }) });
    rows.push(...['/api/frontend-sessions/stream', '/api/frontend-sessions/:sessionId/responses', '/api/runs/:runId/surfaces'].map(http => ({
        capability: 'Authenticated owner frontend transport', tool: null, access: 'write' as const, policy: 'owner' as const,
        http, studio: 'Jini browser session bridge', cli: 'browser transport only', mcp: 'not an agent tool', status: 'internal' as const,
    })));
    for (const [capability, tool, access, policy, needs, reason] of capabilities) {
        if (tool && names.has(tool)) continue;
        rows.push({ capability, tool: null, access, policy, http: null, studio: 'NEEDS', cli: 'NEEDS', mcp: 'NEEDS', status: 'NEEDS', needs, reason });
    }
    rows.push(...internal.map(capability => ({ capability, access: 'write' as const, policy: 'internal' as const, tool: null,
        http: null, studio: 'owning ingress/worker', cli: 'owning ingress/worker', mcp: 'not an agent tool', status: 'internal' as const })));
    return rows;
}

/** Owner routes absent from the catalog are either named composition gaps or owner-only internals. */
function ownerRouteRows(required: { ownerRoutes: ReadonlySet<string | undefined> }): ToolCoverageRow[] {
    const rows: ToolCoverageRow[] = [];
    for (const [key, route] of Object.entries(routes)) {
        if (required.ownerRoutes.has(key)) continue;
        rows.push(ownerRouteRow({ key: key as keyof typeof routes, route }));
    }
    return rows;
}
function ownerRouteRow(required: { key: keyof typeof routes; route: { method: string; path: string } }): ToolCoverageRow {
    const { key, route } = required;
    const reason = ownerRouteDisposition[key];
    return { capability: reason === 'catalog' ? 'Owner route: ' + key : reason + ': ' + key, tool: null,
        access: route.method === 'GET' ? 'read' : 'write', policy: 'owner', http: route.path,
        studio: 'owner transport', cli: 'owner commands', mcp: 'not an agent tool', status: reason === 'catalog' ? 'NEEDS' : 'internal',
        ...(reason === 'catalog' ? { needs: 'FEATURE_COMPOSITION', reason: 'Inject the owning service to expose this route in the catalog' } : {}) };
}

/** D2 contribution metadata is not proof of a connected financial or typed backend handler. */
function catalogRow(required: { tool: OmToolDefinition }): ToolCoverageRow {
    const tool = required.tool;
    const reason = tool.unavailableReason ?? unavailableFinancialReason(required);
    return { capability: tool.capability, tool: tool.name, access: tool.policy === 'read' ? 'read' : 'write', policy: tool.policy,
        http: tool.ownerRoute ? routes[tool.ownerRoute].path : '/api/tools/call', studio: studioSurface({ name: tool.name }),
        cli: 'om tools list/show/call', mcp: 'execute_tool', status: reason ? unavailableStatus({ reason }) : 'connected',
        ...(reason ? { needs: tool.name.startsWith('page.') || tool.name === 'render' ? 'A5_FRONTEND_COMPOSITION' : 'I-2', reason } : {}) };
}
const studioSurfaces = new Map([
    ['integrations_conversion_settings_get', 'Integrations and chat via execute_tool'],
    ['integrations_conversion_settings_set', 'Integrations and chat via execute_tool'],
    ['om_measure_grants_list', 'Integrations and chat via execute_tool'],
    ['om_measure_grant', 'Integrations and chat via execute_tool'],
    ['om_measure_revoke_grant', 'Integrations and chat via execute_tool'],
    ['om_measure_results', 'Measure page and chat via execute_tool'],
    ['om_measure_refresh', 'Measure page and chat via execute_tool'],
    ['om_web_events_snippet', 'Measure setup and chat via execute_tool'],
    ['om_tracking_readiness', 'Measure setup and chat via execute_tool'],
    ['om_leads_list', 'Activity inbox and chat via execute_tool'],
    ['om_leads_set_stage', 'Activity inbox and chat via execute_tool'],
]);
/** Page labels reuse the same catalog transport as assistant calls. */
function studioSurface(required: { name: string }): string {
    return studioSurfaces.get(required.name) ?? 'chat via execute_tool';
}
/** No financial availability is inferred from effects without both current public safety seams. */
function unavailableFinancialReason(required: { tool: OmToolDefinition }): string | undefined {
    if (required.tool.policy === 'internal') return 'Typed conversion/stop jobs require server-only authority';
    if (required.tool.policy !== 'spend' && required.tool.policy !== 'generation') return undefined;
    return required.tool.safety && required.tool.prepareEffect ? undefined : 'Verified safety/backend binding is not connected';
}

/** Preserve the distinction between admission denial and an implementation/evidence gap. */
function unavailableStatus(required: { reason: string }): 'unadmitted' | 'NEEDS' {
    return required.reason.startsWith('Plugin unadmitted:') ? 'unadmitted' : 'NEEDS';
}

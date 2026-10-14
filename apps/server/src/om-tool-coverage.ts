/** Generated inventory: one catalog, the owner route table and named capability NEEDS. */
import { routes } from './cli/http.js';
import type { OmToolDefinition, OmToolPolicy } from './om-tools.js';
import { discoveryTools } from './om-tools.js';
export type ToolCoverageRow = { capability: string; tool: string | null; access: 'read' | 'write'; policy: OmToolPolicy | 'owner';
    http: string | null; studio: string; cli: string; mcp: string; status: 'connected' | 'internal' | 'NEEDS'; needs?: string; reason?: string };

/** Transports/authenticated credential ingress are deliberately outside the agent catalog. */
export const ownerRouteDisposition = {
    tools: 'Catalog transport', describeTool: 'Catalog transport', callTool: 'Catalog dispatcher transport', toolOperation: 'Catalog operation transport',
    addons: 'catalog', addonInstall: 'catalog', addonSetEnabled: 'catalog', addonUninstall: 'catalog',
    integrations: 'catalog', integrationConnect: 'Owner credential ingress; use /addons/integrations or om integrations connect --token-stdin', integrationDisconnect: 'catalog',
    status: 'catalog', snapshot: 'catalog', campaigns: 'catalog', campaign: 'catalog', approvals: 'catalog', approval: 'catalog',
    answer: 'Authenticated owner approval continuation; a tool cannot answer its own card', halt: 'catalog', allowance: 'catalog',
    ask: 'Run transport; no recursive runs', conversations: 'Conversation transport', conversation: 'Conversation transport', createConversation: 'Conversation transport',
    assistantSettings: 'catalog', setAssistantSettings: 'catalog', runEvents: 'Run event transport', cancelRun: 'Run cancellation transport',
} satisfies Record<keyof typeof routes, string>;

/** Each approved capability names either its real definition or the missing owning boundary.
 * This is a capability inventory, not a manually maintained transport coverage table.
 */
const capabilities = [
    ['Workspace current', 'om_workspace_current', 'read', 'read', 'FEATURE_COMPOSITION', 'Current authenticated scope projection'],
    ['Account binding lookup', 'om_account_binding_get', 'read', 'read', 'FEATURE_COMPOSITION', 'Inject the existing AccountBindingLookupPort in server composition'],
    ['Workspace list', null, 'read', 'read', 'WORKSPACE_LIST_API', 'No public scoped workspace listing API'],
    ['Account binding', null, 'write', 'write', 'WORKSPACE_SESSION_BINDING', 'WorkspaceService requires its freshly resolved session context; composition must supply authenticated session resolution'],
    ['Policy snapshot', null, 'read', 'read', 'POLICY_COMPOSITION', 'Policy snapshot services are not supplied to this catalog'],
    ['Policy evidence append', null, 'write', 'write', 'POLICY_EVIDENCE_PROVENANCE', 'Evidence requires verified caller provenance; no owner workflow is bound'],
    ['Audit list', 'om_audit_list', 'read', 'read', 'FEATURE_COMPOSITION', 'Inject the existing AuditService in server composition'],
    ['Contact resolve', 'om_contacts_resolve', 'read', 'read', 'FEATURE_COMPOSITION', 'Inject the existing ContactService in server composition'],
    ['Contact upsert', 'om_contacts_upsert', 'write', 'write', 'FEATURE_COMPOSITION', 'Inject the existing ContactService in server composition'],
    ['Contact merge', 'om_contacts_merge', 'write', 'destructive', 'FEATURE_COMPOSITION', 'Inject the existing ContactService in server composition'],
    ['Form preview', 'om_forms_preview', 'read', 'read', 'FEATURE_COMPOSITION', 'Inject the existing FormsService in server composition'],
    ['Form submissions', 'om_forms_submissions', 'read', 'read', 'FEATURE_COMPOSITION', 'Inject the existing FormsService in server composition'],
    ['Form publish', null, 'write', 'write', 'FORM_PUBLICATION_SCHEMA', 'Export the full owning publication boundary schema before binding this authored workflow; avoid duplicating the CMS field/consent schema'],
    ['Attribution touches', 'om_web_events_touches', 'read', 'read', 'FEATURE_COMPOSITION', 'Inject the existing WebEventService in server composition'],
    ['Tracking snippet', 'om_web_events_snippet', 'read', 'read', 'FEATURE_COMPOSITION', 'Uses the existing fixed /c collector snippet'],
    ['Visitor binding', 'om_web_events_bind_visitor', 'write', 'write', 'FEATURE_COMPOSITION', 'Inject the existing WebEventService and its scoped token verifier in composition'],
    ['Privacy erasure request', 'om_privacy_request_erasure', 'write', 'destructive', 'FEATURE_COMPOSITION', 'Inject the existing PrivacyService in server composition'],
    ['Privacy erasure status', 'om_privacy_status', 'read', 'read', 'FEATURE_COMPOSITION', 'Inject the existing PrivacyService in server composition'],
    ['Job get', null, 'read', 'read', 'JOBS_PUBLIC_API', 'JobService/JobRepoPort expose enqueue/claim/process, not scoped get'],
    ['Job list', null, 'read', 'read', 'JOBS_PUBLIC_API', 'No public scoped list API'],
    ['Job cancel', null, 'write', 'write', 'JOBS_PUBLIC_API', 'No public scoped cancel API; arbitrary outbox mutation is not an agent capability'],
    ['Media list', null, 'read', 'read', 'MEDIA_DEPENDENCY_COMPOSITION', 'Server lacks @open-marketing/media-library workspace dependency and injected service'],
    ['Media import', null, 'write', 'write', 'MEDIA_DEPENDENCY_COMPOSITION', 'Server lacks @open-marketing/media-library workspace dependency and injected service'],
    ['Media crop', null, 'write', 'write', 'MEDIA_DEPENDENCY_COMPOSITION', 'Server lacks @open-marketing/media-library workspace dependency and injected service'],
    ['Media provenance record', null, 'write', 'write', 'MEDIA_DEPENDENCY_COMPOSITION', 'Server lacks @open-marketing/media-library workspace dependency and injected service'],
    ['Creative generation', null, 'write', 'generation', 'CREATIVE_DEPENDENCY_I2', 'Server lacks @open-marketing/creative workspace dependency and verified quote/backend binding'],
    ['Creative status', null, 'read', 'read', 'CREATIVE_DEPENDENCY_I2', 'Server lacks @open-marketing/creative workspace dependency and injected service'],
    ['Creative cancellation', null, 'write', 'write', 'CREATIVE_DEPENDENCY_I2', 'Server lacks @open-marketing/creative workspace dependency and injected service'],
    ['Campaign reconcile', 'om_campaign_reconcile', 'read', 'read', 'FEATURE_COMPOSITION', 'Inject the existing CampaignService in server composition'],
    ['Paused/draft campaign creation', 'om_campaign_create_paused', 'write', 'write', 'FEATURE_COMPOSITION', 'Inject CampaignService with its existing transactional jobs/backend ports'],
    ['Launch proposal', 'om_campaign_propose_launch', 'write', 'write', 'FEATURE_COMPOSITION', 'Inject CampaignService with verified capabilities'],
    ['Campaign launch', null, 'write', 'spend', 'I-2', 'Bind the owning exact approval and transactional campaign outbox; never wrap an existing approval with a second card'],
    ['Tracked link creation', 'om_measure_create_link', 'write', 'write', 'FEATURE_COMPOSITION', 'Inject the existing MeasureService in server composition'],
    ['CAC reporting', 'om_measure_report_cac', 'read', 'read', 'FEATURE_COMPOSITION', 'Inject the existing MeasureService/platform report port in composition'],
    ['Safety status', 'om_safety_status', 'read', 'read', 'FEATURE_COMPOSITION', 'Current owning safety repository'],
    ['Generation allowance settings', 'om_allowance_get', 'read', 'read', 'FEATURE_COMPOSITION', 'Current owning safety repository'],
    ['Generation allowance setting', 'om_allowance_set', 'write', 'write', 'FEATURE_COMPOSITION', 'Current owning safety repository'],
    ['Local account halt', 'om_halt_account', 'write', 'write', 'FEATURE_COMPOSITION', 'Local durable halt; remoteStatus remains pending until typed backend stop'],
    ['Typed remote halt stop', null, 'write', 'internal', 'I-2', 'Bind SafetyService.authorizeHaltStop and closed pause/stop backend DTOs after local halt; generic halt_stop sources cannot dispatch'],
    ['Paid-sending allowance get', null, 'read', 'read', 'PAID_SENDING_API', 'No owning paid-sending allowance API'],
    ['Paid-sending allowance set', null, 'write', 'write', 'PAID_SENDING_API', 'No owning paid-sending allowance API'],
    ['Vendor account/entity/report reads (not connected)', null, 'read', 'read', 'I-2', 'Meta/Google/LinkedIn/TikTok adapters are not executable catalog sources until trusted server binding'],
    ['Vendor paused/draft creation and pause (not connected)', null, 'write', 'write', 'I-2', 'Bind installed TS vendor adapters; paused/draft creation has ordinary write policy'],
    ['Vendor activation/live budget/cap changes (not connected)', null, 'write', 'spend', 'I-2', 'Verified safety/backend bindings provide exact bounded exposure; every call needs its exact card'],
    ['Higgsfield quote/status (not connected)', null, 'read', 'read', 'I-2', 'Bind installed generation adapter'],
    ['Higgsfield generation (not connected)', null, 'write', 'generation', 'I-2', 'Bind verified quote and safety.withDispatch; normal write within allowance, exact spend otherwise'],
    ['Organic Instagram (not connected)', null, 'write', 'write', 'I-2', 'Bind installed Meta organic adapter'],
    ['Executable external MCP descriptors', null, 'write', 'write', 'I-2', 'D2 sources load contribution descriptions; executable federation descriptors/invocation are not exported through that seam'],
    ['Page navigation/find/highlight/scroll/click/fill/select', null, 'write', 'write', 'A5', 'Approved page-actions binding belongs to the next assistant run'],
    ['Component search/describe/render/charts', null, 'write', 'write', 'A5', 'Approved Jini A2UI/chart binding belongs to the next assistant run'],
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
        http: tool.ownerRoute ? routes[tool.ownerRoute].path : '/api/tools/call', studio: 'chat via execute_tool',
        cli: 'om tools list/show/call', mcp: 'execute_tool', status: reason ? 'NEEDS' : 'connected',
        ...(reason ? { needs: 'I-2', reason } : {}) };
}
/** No financial availability is inferred from effects without both current public safety seams. */
function unavailableFinancialReason(required: { tool: OmToolDefinition }): string | undefined {
    if (required.tool.policy === 'internal') return 'Typed conversion/stop jobs require server-only authority';
    if (required.tool.policy !== 'spend' && required.tool.policy !== 'generation') return undefined;
    return required.tool.safety && required.tool.prepareEffect ? undefined : 'Verified safety/backend binding is not connected';
}

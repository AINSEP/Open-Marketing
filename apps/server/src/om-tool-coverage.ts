/** Generated inventory: catalog declarations + the ONE owner route table. No claimed CLI parity yet. */
import { routes } from './cli/http.js';
import type { OmToolDefinition, OmToolPolicy } from './om-tools.js';
import { discoveryTools } from './om-tools.js';
export type ToolCoverageRow = { capability: string; tool: string | null; access: 'read' | 'write'; policy: OmToolPolicy | 'owner' | 'internal';
    http: string | null; studio: string; cli: string; mcp: string; status: 'connected' | 'internal' | 'NEEDS' };

/** These transports intentionally stay outside the agent catalog; writes land in R4. */
export const ownerRouteDisposition = {
    tools: 'Catalog transport', describeTool: 'Catalog transport', callTool: 'Catalog dispatcher transport', toolOperation: 'Catalog operation transport',
    addons: 'R4 addon management', addonInstall: 'R4 addon management', addonSetEnabled: 'R4 addon management', addonUninstall: 'R4 addon management',
    integrations: 'R4 integration management', integrationConnect: 'Owner credential ingress; never a chat tool', integrationDisconnect: 'R4 integration management',
    status: 'catalog', snapshot: 'catalog', campaigns: 'catalog', campaign: 'catalog', approvals: 'catalog', approval: 'catalog',
    answer: 'Authenticated owner approval continuation', halt: 'R4 owner halt', allowance: 'catalog',
    ask: 'Run transport; no recursive runs', conversations: 'Conversation transport', conversation: 'Conversation transport', createConversation: 'Conversation transport',
    assistantSettings: 'catalog', setAssistantSettings: 'catalog', runEvents: 'Run event transport', cancelRun: 'Run cancellation transport',
} satisfies Record<keyof typeof routes, string>;

/** Approved capability inventory. Deferred workflows are explicit, never callable stubs.
 * Financial vendor rows become connected only when I-2 supplies trusted bindings.
 */
const deferred = [
    ['Workspace current/account lookup', 'read', 'read'], ['Workspace list', 'read', 'read'], ['Account binding', 'write', 'write'],
    ['Policy snapshot', 'read', 'read'], ['Policy evidence append', 'write', 'write'], ['Audit list', 'read', 'read'],
    ['Contact resolve', 'read', 'read'], ['Contact upsert', 'write', 'write'], ['Contact merge', 'write', 'destructive'],
    ['Form preview/submissions', 'read', 'read'], ['Form publish', 'write', 'write'], ['Touches/snippet', 'read', 'read'], ['Visitor binding', 'write', 'write'],
    ['Privacy erasure request', 'write', 'destructive'], ['Privacy erasure status', 'read', 'read'],
    ['Job get/list', 'read', 'read'], ['Job cancel', 'write', 'write'], ['Media list', 'read', 'read'], ['Media import/crop/provenance', 'write', 'write'],
    ['Creative generation', 'write', 'generation'], ['Creative status', 'read', 'read'], ['Creative cancellation', 'write', 'write'],
    ['Campaign reconcile', 'read', 'read'], ['Paused/draft campaign creation', 'write', 'write'], ['Launch proposal', 'write', 'write'], ['Campaign launch', 'write', 'spend'],
    ['Tracked link creation', 'write', 'write'], ['CAC reporting', 'read', 'read'], ['Safety status/allowance get', 'read', 'read'], ['Allowance setting/owner halt', 'write', 'write'],
    ['Paid-sending allowance get/set', 'write', 'write'],
    ['Google/Meta/LinkedIn/TikTok account/entity/report reads (not connected)', 'read', 'read'],
    ['Vendor paused/draft creation and pause (not connected)', 'write', 'write'], ['Vendor activation/live budget/cap changes (not connected)', 'write', 'spend'],
    ['Higgsfield quote/status (not connected)', 'read', 'read'], ['Higgsfield generation (not connected)', 'write', 'generation'],
    ['Organic Instagram (not connected)', 'write', 'write'], ['External MCP tool descriptors (I-2)', 'write', 'write'],
    ['Page navigation/find/highlight/scroll/click/fill/select (R5)', 'write', 'write'], ['Component search/describe/render/charts (R5)', 'write', 'write'],
] as const;
const internal = ['Session/context resolution', 'Canonical policy gates', 'Audit append', 'Destination identifiers', 'Verified form/tracking ingress',
    'Privacy advance worker', 'Outbox enqueue/claim/process/resolve/retry', 'Media cost observation', 'Creative dispatch/poll/recover', 'Campaign dispatch',
    'Verified conversion ingestion/measurement-granted delivery', 'Safety approval/dispatch/reserve/settle/typed halt stops', 'Credential callback/open/refresh/keyring', 'App supervisor/bootstrap'];

/** Generate all rows from current definitions/routes. Missing catalog/CLI/UI surfaces remain NEEDS.
 * @complexity O(n + r) time/space, n <=1100 tool sources, r fixed owner routes; no I/O.
 */
export function generateOmToolCoverage(required: { definitions: readonly OmToolDefinition[] }): readonly ToolCoverageRow[] {
    const rows: ToolCoverageRow[] = required.definitions.map(tool => ({ capability: tool.capability, tool: tool.name,
        access: tool.policy === 'read' ? 'read' : 'write', policy: tool.policy,
        http: tool.ownerRoute ? routes[tool.ownerRoute].path : '/api/tools/call', studio: 'chat via execute_tool',
        cli: 'NEEDS: om tools list/show/call (R4)', mcp: 'execute_tool', status: ['spend', 'generation', 'internal'].includes(tool.policy) ? 'NEEDS' : 'connected' }));
    rows.push(...discoveryTools.map(tool => ({ capability: 'Catalog ' + tool.name, tool: tool.name,
        access: tool.name === 'execute_tool' ? 'write' as const : 'read' as const, policy: tool.name === 'execute_tool' ? 'write' as const : 'read' as const,
        http: '/api/agent/v1/mcp', studio: 'chat model transport', cli: 'NEEDS: om tools list/show/call (R4)',
        mcp: tool.name, status: 'connected' as const })));
    for (const [key, route] of Object.entries(routes)) {
        if (required.definitions.some(tool => tool.ownerRoute === key)) continue;
        const reason = ownerRouteDisposition[key as keyof typeof routes];
        const isDeferred = reason.startsWith('R4') || reason === 'catalog';
        rows.push({ capability: reason + ': ' + key, tool: null, access: route.method === 'GET' ? 'read' : 'write',
            policy: 'owner', http: route.path, studio: 'owner transport', cli: 'owner commands', mcp: 'not an agent tool', status: isDeferred ? 'NEEDS' : 'internal' });
    }
    rows.push(...deferred.map(([capability, access, policy]) => ({ capability, access, policy, tool: null, http: null,
        studio: 'NEEDS', cli: 'NEEDS', mcp: 'NEEDS', status: 'NEEDS' as const })));
    rows.push(...internal.map(capability => ({ capability, access: 'write' as const, policy: 'internal' as const, tool: null,
        http: null, studio: 'owning ingress/worker', cli: 'owning ingress/worker', mcp: 'not an agent tool', status: 'internal' as const })));
    return rows;
}

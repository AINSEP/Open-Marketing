import { handleAddonRequest } from './addons.js';
import { handleIntegrationRequest } from './integrations.js';
import type { Addons } from '../addons.js';
import type { Integrations } from '../integrations.js';
/** Owner HTTP translation. Authentication/scope are supplied by the local server dispatcher. */
import { z } from 'zod';
import { assistantRunRequestSchema, assistantSettingsSchema, approvalResponseSchema, idSchema, pageQuerySchema, parseBoundary } from '@open-marketing/contracts';
import type { CallContext, Money, Outcome, PageQuery } from '@open-marketing/contracts';
import type { FormSubjectPort } from '@open-marketing/forms';
import type { CampaignRecord, CampaignRepoPort } from '@open-marketing/campaigns';
import type { ConfirmationExchangePort, SafetyRepoPort } from '@open-marketing/safety';
import { routes } from '../cli/http.js';
import { readCard } from '../cli/approval.js';
import { localFailure } from '../composition/local-auth.js';
import type { HttpRequest, HttpResponse } from '../ports.js';
import type { Conversations } from '../conversations.js';
import type { OwnerRunPort } from '../ports.js';

/** Existing owning repositories/exchange; tests inject the same public memory adapters. */
export interface OwnerServices {
    readonly campaigns: CampaignRepoPort;
    readonly safety: SafetyRepoPort;
    readonly confirmations: ConfirmationExchangePort;
    formSubjects?: FormSubjectPort;
    runs?: OwnerRunPort;
    conversations?: Conversations;
    addons?: Addons;
    integrations?: Integrations;
}
type OwnerInput = { request: HttpRequest; context: CallContext; services: OwnerServices };
type CampaignRow = z.infer<typeof routes.campaign.schema>;

/** Map Outcomes consistently; validate successes using the same schema the CLI reads. */
function respond<T>(required: { outcome: Outcome<T>; schema: z.ZodType<T> }): HttpResponse {
    const result = required.outcome.ok ? parseBoundary({ schema: required.schema, input: required.outcome.value }) : required.outcome;
    if (result.ok) return { status: 200, body: result };
    const status = { invalid_input: 400, unauthenticated: 401, forbidden: 403, expired: 409, conflict: 409,
        limit_exceeded: 413, unavailable: 503, not_implemented: 503, cancelled: 409, protocol_mismatch: 502 }[result.error.code];
    return { status, body: result };
}

/** Unique query fields were checked at transport; route rejects extras and enforces limit 1..100. */
function pageQuery(required: { request: HttpRequest }): Outcome<PageQuery> {
    return parseBoundary({ schema: z.strictObject({ limit: z.string().regex(/^\d+$/).default('25').transform(Number), cursor: idSchema.optional() }).pipe(pageQuerySchema),
        input: required.request.query ?? {} });
}

function campaignRow(required: { record: CampaignRecord }): CampaignRow {
    return { id: required.record.receipt.campaignId, title: required.record.draft.name, detail: required.record.draft.objective,
        status: required.record.observation?.state ?? 'unknown' };
}

/** Currency precision belongs to display only; the stored balance remains integer minor units. */
function displayMoney(required: { money: Money }): string {
    const format = new Intl.NumberFormat('en-US', { style: 'currency', currency: required.money.currency });
    return format.format(required.money.minorUnits / 10 ** (format.resolvedOptions().maximumFractionDigits ?? 2));
}

/** One bounded repository page, no per-item queries; fail the whole response on invalid storage. */
async function campaigns(required: OwnerInput): Promise<HttpResponse> {
    const query = pageQuery(required);
    if (!query.ok) return respond({ outcome: query, schema: routes.campaigns.schema });
    const result = await required.services.campaigns.list({ context: required.context, query: query.value });
    const outcome = result.ok ? { ok: true as const, value: { items: result.value.items.map(record => campaignRow({ record })), cursor: result.value.cursor } } : result;
    return respond({ outcome, schema: routes.campaigns.schema });
}

/** Validate cards intact using the existing terminal safety boundary; no changed reviewed values. */
function safeCards(required: { cards: readonly unknown[] }): Outcome<z.infer<typeof routes.approvals.schema>['items']> {
    const items: z.infer<typeof routes.approvals.schema>['items'] = [];
    for (const input of required.cards) {
        const card = readCard({ input });
        if (!card.ok) return card;
        items.push(card.value);
    }
    return { ok: true, value: items };
}

async function approvals(required: OwnerInput): Promise<HttpResponse> {
    const query = pageQuery(required);
    if (!query.ok) return respond({ outcome: query, schema: routes.approvals.schema });
    const result = await required.services.confirmations.list({ context: required.context, query: query.value });
    if (!result.ok) return respond({ outcome: result, schema: routes.approvals.schema });
    const cards = safeCards({ cards: result.value.items });
    return respond({ outcome: cards.ok ? { ok: true, value: { items: cards.value, cursor: result.value.cursor } } : cards, schema: routes.approvals.schema });
}

/** SQL-backed campaigns/allowance and the existing process-local pending card exchange. Reads are
 * sequential on the single kernel; this projection does not promise a multi-feature atomic snapshot.
 * @complexity <=3 bounded reads, <=100 campaigns/50 cards and <=256 KiB presentation data.
 */
async function snapshot(required: OwnerInput): Promise<HttpResponse> {
    const campaigns = await required.services.campaigns.list({ context: required.context, query: { limit: 100 } });
    if (!campaigns.ok) return respond({ outcome: campaigns, schema: routes.snapshot.schema });
    const approvals = await required.services.confirmations.list({ context: required.context, query: { limit: 50 } });
    if (!approvals.ok) return respond({ outcome: approvals, schema: routes.snapshot.schema });
    const cards = safeCards({ cards: approvals.value.items });
    if (!cards.ok) return respond({ outcome: cards, schema: routes.snapshot.schema });
    const allowance = await required.services.safety.getGenerationAllowanceView({ context: required.context });
    if (!allowance.ok) return respond({ outcome: allowance, schema: routes.snapshot.schema });
    const activity = required.services.formSubjects ? await required.services.formSubjects.list({ context: required.context, limit: 50 }) : { ok: true as const, value: [] };
    if (!activity.ok) return respond({ outcome: activity, schema: routes.snapshot.schema });
    const activityRows = activity.value.map(item => ({ id: item.submissionId, title: 'Sandbox lead accepted', detail: 'Subject ' + item.subjectId, status: 'accepted' }));
    const rows = campaigns.value.items.map(record => campaignRow({ record }));
    const value: z.infer<typeof routes.snapshot.schema> = {
        workspace: required.context.scope.workspaceId, mode: 'connected',
        metrics: [{ label: 'Server', value: 'Local sandbox', detail: 'Vendor effects unavailable. Use om ask for a labeled sandbox run.' },
            { label: 'Campaigns', value: String(campaigns.value.items.length), detail: campaigns.value.cursor ? 'First 100 records; use om campaigns list for more.' : 'Recorded campaigns in this workspace.' },
            { label: 'Generation remaining', value: displayMoney({ money: allowance.value.remaining }), detail: allowance.value.timezone + '. Includes unresolved reservations.' }],
        rows: { workspaces: rows, creative: [], 'media-library': [], campaigns: rows,
            measure: [], connections: [], plugins: [], activity: activityRows, settings: [] },
        messages: [], cards: cards.value, allowance: allowance.value,
    };
    if (JSON.stringify(value).length > 262144) return respond({ outcome: localFailure({ code: 'limit_exceeded', message: 'Studio snapshot exceeds display bound' }), schema: routes.snapshot.schema });
    return respond({ outcome: { ok: true, value }, schema: routes.snapshot.schema });
}

/** Decode one resource ID once, rejecting URL-normalized dot segments and separators. */
function resourceId(required: { segment: string }): Outcome<string> {
    try { return parseBoundary({ schema: idSchema.refine(value => value !== '.' && value !== '..' && !/[\x00-\x1f/\\]/.test(value)), input: decodeURIComponent(required.segment) }); }
    catch { return localFailure({ code: 'invalid_input', message: 'Invalid resource ID' }); }
}

async function campaign(required: OwnerInput & { id: string }): Promise<HttpResponse> {
    const result = await required.services.campaigns.get({ context: required.context, campaignId: required.id });
    if (!result.ok) return respond({ outcome: result, schema: routes.campaign.schema });
    if (!result.value) return { status: 404, body: localFailure({ code: 'forbidden', message: 'Campaign unavailable in scope' }) };
    return respond({ outcome: { ok: true, value: campaignRow({ record: result.value }) }, schema: routes.campaign.schema });
}

async function approval(required: OwnerInput & { id: string }): Promise<HttpResponse> {
    const result = await required.services.confirmations.get({ context: required.context, cardId: required.id });
    if (!result.ok) return respond({ outcome: result, schema: routes.approval.schema });
    if (!result.value) return { status: 404, body: localFailure({ code: 'forbidden', message: 'Card unavailable in scope' }) };
    return respond({ outcome: readCard({ input: result.value }), schema: routes.approval.schema });
}

/** Authentication precedes this lazy body read. The path must agree with the exact response. */
async function answer(required: OwnerInput & { id: string }): Promise<HttpResponse> {
    const body = await requestBody(required);
    if (!body.ok) return respond({ outcome: body, schema: routes.answer.schema });
    const response = parseBoundary({ schema: approvalResponseSchema, input: body.value });
    if (!response.ok) return respond({ outcome: response, schema: routes.answer.schema });
    if (response.value.cardId !== required.id) return respond({ outcome: localFailure({ code: 'conflict', message: 'Card path differs from response' }), schema: routes.answer.schema });
    const result = await required.services.confirmations.confirm({ context: required.context, response: response.value });
    return respond({ outcome: result.ok ? { ok: true, value: { status: 'recorded' as const } } : result, schema: routes.answer.schema });
}

function requestBody(required: { request: HttpRequest }): Promise<Outcome<unknown>> {
    return required.request.readBody ? required.request.readBody({}) : Promise.resolve({ ok: true, value: required.request.body });
}

/** Record the durable local halt. Remote stop remains pending because no provider is wired. */
async function halt(required: OwnerInput): Promise<HttpResponse> {
    const body = await requestBody(required);
    if (!body.ok) return respond({ outcome: body, schema: routes.halt.schema });
    const parsed = parseBoundary({ schema: z.strictObject({ accountId: idSchema }), input: body.value });
    if (!parsed.ok) return respond({ outcome: parsed, schema: routes.halt.schema });
    const result = await required.services.safety.halt({ context: required.context, adAccountId: parsed.value.accountId });
    return respond({ outcome: result.ok ? { ok: true, value: { accountId: parsed.value.accountId, status: 'pending' as const } } : result, schema: routes.halt.schema });
}

/** Fixed owner route dispatcher. Caller MUST authenticate and derive scope before invocation.
 * Success on answer is recorded only; no route constructs or dispatches vendor dependencies.
 * @example handleOwnerRequest({ request, context: authenticatedOwner, services });
 * @complexity O(path length) routing, fixed route set; each operation has bounded reads/body.
 */
export async function handleOwnerRequest(required: OwnerInput): Promise<HttpResponse> {
    if (required.request.path.startsWith('/api/addons/v1/')) return addonOwnerRequest(required);
    switch (required.request.method + ' ' + required.request.path) {
        case 'GET /api/status': return respond({ outcome: { ok: true, value: { ready: true, mode: 'local' as const } }, schema: routes.status.schema });
        case 'GET /api/studio/snapshot': return snapshot(required);
        case 'GET /api/campaigns': return campaigns(required);
        case 'GET /api/safety/approvals': return approvals(required);
        case 'GET /api/safety/allowance': return respond({ outcome: await required.services.safety.getGenerationAllowanceView({ context: required.context }), schema: routes.allowance.schema });
        case 'POST /api/safety/halt': return halt(required);
        case 'POST /api/runs': return startRun(required);
        case 'GET /api/conversations': return conversationList(required);
        case 'POST /api/conversations': return conversationCreate(required);
        case 'GET /api/assistant/settings': return assistantSettings(required);
        case 'POST /api/assistant/settings': return assistantSettingsWrite(required);
        default: return resourceRequest(required);
    }
}

/** Keep resource matching separate from the fixed route dispatcher to bound branch complexity. */
async function resourceRequest(required: OwnerInput): Promise<HttpResponse> {
    if (required.request.path.startsWith('/api/runs/')) return runRequest(required);
    if (required.request.path.startsWith('/api/conversations/')) return conversationRead(required);
    const match = /^\/api\/(campaigns|safety\/approvals)\/([^/]+)(\/answer)?$/.exec(required.request.path);
    if (!match) return { status: 503, body: localFailure({ message: 'Owner operation unavailable in local sandbox' }) };
    const id = resourceId({ segment: match[2] });
    if (!id.ok) return { status: 400, body: id };
    switch (required.request.method + ' ' + match[1] + (match[3] ?? '')) {
        case 'GET campaigns': return campaign({ ...required, id: id.value });
        case 'GET safety/approvals': return approval({ ...required, id: id.value });
        case 'POST safety/approvals/answer': return answer({ ...required, id: id.value });
        default: return { status: 405, body: localFailure({ code: 'invalid_input', message: 'Method unavailable for owner resource' }) };
    }
}

/** Owner prompts are bounded plain text; the server creates all IDs, scope and grants. */
async function startRun(required: OwnerInput): Promise<HttpResponse> {
    if (!required.services.runs) return respond({ outcome: localFailure({ message: 'Sandbox agent unavailable' }), schema: routes.ask.schema });
    const body = await requestBody(required);
    if (!body.ok) return respond({ outcome: body, schema: routes.ask.schema });
    const parsed = parseBoundary({ schema: assistantRunRequestSchema.refine(value => value.prompt.trim().length > 0 && Buffer.byteLength(value.prompt, 'utf8') <= 65536), input: body.value });
    if (!parsed.ok) return respond({ outcome: parsed, schema: routes.ask.schema });
    return respond({ outcome: await required.services.runs.start({ context: required.context, prompt: parsed.value.prompt }, { conversationId: parsed.value.conversationId, frontendSessionId: parsed.value.frontendSessionId }), schema: routes.ask.schema });
}

/** Polling uses the shared CLI read model. The fixed sandbox requests no navigation, so
 * navigation acknowledgements are denied rather than fabricating browser completion.
 */
async function runRequest(required: OwnerInput): Promise<HttpResponse> {
    const match = /^\/api\/runs\/([^/]+)\/(events|cancel|navigation)$/.exec(required.request.path);
    if (!match || !required.services.runs) return { status: 503, body: localFailure({ message: 'Sandbox run operation unavailable' }) };
    const id = resourceId({ segment: match[1] });
    if (!id.ok) return { status: 400, body: id };
    const input = { context: required.context, runId: id.value };
    if (required.request.method === 'GET' && match[2] === 'events') {
        return pollRun({ ...required, runs: required.services.runs, ...input });
    }
    if (required.request.method === 'POST' && match[2] === 'cancel') {
        return cancelRun({ ...required, runs: required.services.runs, ...input });
    }
    return { status: 403, body: localFailure({ code: 'forbidden', message: 'Sandbox runtime requests no navigation' }) };
}

async function pollRun(required: OwnerInput & { runs: OwnerRunPort; runId: string }): Promise<HttpResponse> {
    const query = parseBoundary({ schema: z.strictObject({ after: z.string().regex(/^\d{1,16}$/).default('0').transform(Number).pipe(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)) }), input: required.request.query ?? {} });
    if (!query.ok) return respond({ outcome: query, schema: routes.runEvents.schema });
    return respond({ outcome: await required.runs.events({ context: required.context, runId: required.runId, after: query.value.after }), schema: routes.runEvents.schema });
}

async function cancelRun(required: OwnerInput & { runs: OwnerRunPort; runId: string }): Promise<HttpResponse> {
    const body = await requestBody(required);
    if (!body.ok) return respond({ outcome: body, schema: routes.cancelRun.schema });
    const empty = parseBoundary({ schema: z.strictObject({}), input: body.value });
    if (!empty.ok) return respond({ outcome: empty, schema: routes.cancelRun.schema });
    return respond({ outcome: await required.runs.cancel({ context: required.context, runId: required.runId }), schema: routes.cancelRun.schema });
}

/** Owner conversation/settings surfaces reuse I-0 schemas and Jini's bounded owner store. */
async function conversationList(required: OwnerInput): Promise<HttpResponse> {
 const query = pageQuery(required);
 if (!query.ok) return respond({ outcome: query, schema: routes.conversations.schema });
 const outcome = required.services.conversations ? await required.services.conversations.list({ context: required.context, query: query.value }) : localFailure({ message: 'Conversation storage unavailable' });
 return respond({ outcome, schema: routes.conversations.schema });
}
async function conversationCreate(required: OwnerInput): Promise<HttpResponse> {
 const body = await requestBody(required);
 const parsed = body.ok ? parseBoundary({ schema: z.strictObject({}), input: body.value }) : body;
 if (!parsed.ok) return respond({ outcome: parsed, schema: routes.createConversation.schema });
 const outcome = required.services.conversations ? await required.services.conversations.create({ context: required.context }) : localFailure({ message: 'Conversation storage unavailable' });
 return respond({ outcome, schema: routes.createConversation.schema });
}
async function conversationRead(required: OwnerInput): Promise<HttpResponse> {
 if (required.request.method !== 'GET') return { status: 405, body: localFailure({ code: 'invalid_input', message: 'Method unavailable' }) };
 const match = /^\/api\/conversations\/([^/]+)$/.exec(required.request.path);
 if (!match) return { status: 404, body: localFailure({ code: 'forbidden', message: 'Conversation unavailable' }) };
 const id = resourceId({ segment: match[1] }); const query = pageQuery(required);
 if (!id.ok) return respond({ outcome: id, schema: routes.conversation.schema });
 if (!query.ok) return respond({ outcome: query, schema: routes.conversation.schema });
 const outcome = required.services.conversations ? await required.services.conversations.read({ context: required.context, conversationId: id.value, query: query.value }) : localFailure({ message: 'Conversation storage unavailable' });
 return respond({ outcome, schema: routes.conversation.schema });
}
async function assistantSettings(required: OwnerInput): Promise<HttpResponse> {
 const outcome = required.services.conversations ? await required.services.conversations.settings({ context: required.context }) : localFailure({ message: 'Assistant settings unavailable' });
 return respond({ outcome, schema: routes.assistantSettings.schema });
}
async function assistantSettingsWrite(required: OwnerInput): Promise<HttpResponse> {
 const body = await requestBody(required);
 const parsed = body.ok ? parseBoundary({ schema: assistantSettingsSchema, input: body.value }) : body;
 if (!parsed.ok) return respond({ outcome: parsed, schema: routes.setAssistantSettings.schema });
 const outcome = required.services.conversations ? await required.services.conversations.setSettings({ context: required.context, settings: parsed.value }) : localFailure({ message: 'Assistant settings unavailable' });
 return respond({ outcome, schema: routes.setAssistantSettings.schema });
}

/** Authenticated add-on management uses D1/D2's owner boundaries and existing services. */
async function addonOwnerRequest(required: OwnerInput): Promise<HttpResponse> {
    if (required.request.path.startsWith('/api/addons/v1/integrations') && required.services.integrations) {
        return handleIntegrationRequest({ ...required, integrations: required.services.integrations });
    }
    if (required.services.addons) return handleAddonRequest({ ...required, addons: required.services.addons });
    return { status: 503, body: localFailure({ message: 'Add-ons unavailable on this server' }) };
}

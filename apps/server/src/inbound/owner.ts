import { handleAddonRequest } from './addons.js';
import { handleIntegrationRequest } from './integrations.js';
import type { MediaLibrary } from '@open-marketing/media-library';
import type { PluginService } from '@open-marketing/plugins';
import type { Integrations } from '../integrations.js';
/** Owner HTTP translation. Authentication/scope are supplied by the local server dispatcher. */
import { z } from 'zod';
import type { createRecentEvents } from '../recent-events.js';
import { captureEventSchema, recentEventsSchema } from '@open-marketing/contracts';
import type { UiFrontendPort } from '../ui-tools.js';
import type { FrontendSessions } from './frontend.js';
import type { AssistantRunRequest } from '@open-marketing/contracts';
import { surfaceAcknowledgementSchema } from '@open-marketing/contracts';
import type { ClockPort, IdPort } from '@open-marketing/contracts';
import { chatAttachmentSchema, assistantRunRequestSchema, assistantSettingsSchema, approvalResponseSchema, idSchema, pageQuerySchema, parseBoundary, toolCallSchema, toolDescriptorSchema, toolOperationSchema, toolResultSchema, toolSearchSchema } from '@open-marketing/contracts';
import type { ApproverRef, CallContext, CallOptions, Money, Outcome, PageQuery } from '@open-marketing/contracts';
import type { FormSubjectPort } from '@open-marketing/forms';
import { stageSchema as leadStageInputSchema, type LeadsService } from '@open-marketing/leads';
import type { CampaignRecord, CampaignRepoPort } from '@open-marketing/campaigns';
import type { ConfirmationExchangePort, SafetyRepoPort } from '@open-marketing/safety';
import { routes } from '../cli/http.js';
import { readCard } from '../cli/approval.js';
import { localFailure } from '../composition/local-auth.js';
import type { HttpRequest, HttpResponse } from '../ports.js';
import type { Conversations } from '../conversations.js';
import type { OwnerRunPort } from '../ports.js';
import type { OmTools } from '../om-tool-types.js';
import type { bindAlerts } from '../composition/alerts.js';

/** Existing owning repositories/exchange; tests inject the same public memory adapters. */
export interface OwnerServices {
    /** Trusted composition identity, never populated from HTTP bodies or agent credentials. */
    readonly approver?: ApproverRef;
    recentEvents?: ReturnType<typeof createRecentEvents>;
    ui?: { runtime: { clock: ClockPort; ids: IdPort }; frontend?: UiFrontendPort; sessions?: FrontendSessions };
    readonly campaigns: CampaignRepoPort;
    readonly safety: SafetyRepoPort;
    readonly confirmations: ConfirmationExchangePort;
    formSubjects?: FormSubjectPort;
    leads?: LeadsService;
    runs?: Omit<OwnerRunPort, 'start'> & {
        start(required: Parameters<OwnerRunPort['start']>[0], optional?: Omit<AssistantRunRequest, 'prompt'>): ReturnType<OwnerRunPort['start']>;
    };
    media?: Pick<MediaLibrary, 'uploadImage'>;
    conversations?: Conversations;
    addons?: PluginService;
    handleChartRequest?: (required: { request: HttpRequest; context: CallContext }) => Promise<HttpResponse>;
    integrations?: Integrations;
    tools?: OmTools;
    alerts?: Pick<ReturnType<typeof bindAlerts>, 'list' | 'acknowledge'>;
}
type OwnerInput = { request: HttpRequest; context: CallContext; services: OwnerServices };
type CampaignRow = z.infer<typeof routes.campaign.schema>;
const uploadRefusalCodes = new Set(['invalid_input', 'limit_exceeded']);

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

export function campaignRow(required: { record: CampaignRecord }): CampaignRow {
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
    return respond({ outcome: await readCampaigns({ ...required, query: query.value }), schema: routes.campaigns.schema });
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
    return respond({ outcome: await readApprovals({ ...required, query: query.value }), schema: routes.approvals.schema });
}

/** One scoped campaign page for owner surfaces; cancellation and repository failures propagate.
 * @complexity O(n) time/space for <=100 rows; one repository read, no per-item I/O. */
export async function readCampaigns(required: { context: CallContext; services: OwnerServices; query: PageQuery }, optional?: CallOptions): Promise<Outcome<z.infer<typeof routes.campaigns.schema>>> {
    const result = await required.services.campaigns.list({ context: required.context, query: required.query }, optional);
    return result.ok ? { ok: true, value: { items: result.value.items.map(record => campaignRow({ record })), cursor: result.value.cursor } } : result;
}

/** One scoped approval page, rejecting the whole page on an invalid card; forwards cancellation/failures.
 * @complexity O(n) time/space for <=100 bounded cards; one exchange read, no per-item I/O. */
export async function readApprovals(required: { context: CallContext; services: OwnerServices; query: PageQuery }, optional?: CallOptions): Promise<Outcome<z.infer<typeof routes.approvals.schema>>> {
    const result = await required.services.confirmations.list({ context: required.context, query: required.query }, optional);
    if (!result.ok) return result;
    const cards = safeCards({ cards: result.value.items });
    return cards.ok ? { ok: true, value: { items: cards.value, cursor: result.value.cursor } } : cards;
}

/** SQL-backed campaigns/allowance and the existing process-local pending card exchange. Reads are
 * sequential on the single kernel; this projection does not promise a multi-feature atomic snapshot.
 * @complexity <=3 bounded reads, <=100 campaigns/50 cards and <=256 KiB presentation data.
 */
export async function readStudioSnapshot(required: { context: CallContext; services: OwnerServices }): Promise<Outcome<z.infer<typeof routes.snapshot.schema>>> {
    const campaigns = await readCampaigns({ ...required, query: { limit: 100 } });
    if (!campaigns.ok) return campaigns;
    const approvals = await readApprovals({ ...required, query: { limit: 50 } });
    if (!approvals.ok) return approvals;
    const allowance = await required.services.safety.getGenerationAllowanceView({ context: required.context });
    if (!allowance.ok) return allowance;
    const activity = required.services.formSubjects ? await required.services.formSubjects.list({ context: required.context, limit: 50 }) : { ok: true as const, value: [] };
    if (!activity.ok) return activity;
    const activityRows = activity.value.map(item => ({ id: item.submissionId, title: 'Sandbox lead accepted', detail: 'Subject ' + item.subjectId, status: 'accepted' }));
    const rows = campaigns.value.items;
    const value: z.infer<typeof routes.snapshot.schema> = {
        workspace: required.context.scope.workspaceId, mode: 'connected',
        metrics: [{ label: 'Server', value: 'Local sandbox', detail: 'Vendor effects unavailable. Use om ask for a labeled sandbox run.' },
            { label: 'Campaigns', value: String(rows.length), detail: campaigns.value.cursor ? 'First 100 records; use om campaigns list for more.' : 'Recorded campaigns in this workspace.' },
            { label: 'Generation remaining', value: displayMoney({ money: allowance.value.remaining }), detail: allowance.value.timezone + '. Includes unresolved reservations.' }],
        rows: { workspaces: rows, creative: [], 'media-library': [], campaigns: rows,
            measure: [], connections: [], plugins: [], activity: activityRows, settings: [] },
        messages: [], cards: approvals.value.items, allowance: allowance.value,
    };
    if (JSON.stringify(value).length > 262144) return localFailure({ code: 'limit_exceeded', message: 'Studio snapshot exceeds display bound' });
    return { ok: true, value };
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
async function answerResponse(required: OwnerInput & { id: string }): Promise<HttpResponse> {
    const approver = required.services.approver;
    if (!approver) return respond({ outcome: localFailure({ code: 'unauthenticated', message: 'Authenticated approver identity required' }), schema: routes.answer.schema });
    const body = await requestBody(required);
    if (!body.ok) return respond({ outcome: body, schema: routes.answer.schema });
    const response = parseBoundary({ schema: approvalResponseSchema, input: body.value });
    if (!response.ok) return respond({ outcome: response, schema: routes.answer.schema });
    if (response.value.cardId !== required.id) return respond({ outcome: localFailure({ code: 'conflict', message: 'Card path differs from response' }), schema: routes.answer.schema });
    const result = required.services.tools && await required.services.tools.card({ context: required.context, operationId: response.value.operationId });
    const continued = result?.ok && result.value
        ? await required.services.tools!.answer({ context: required.context, response: response.value, approver })
        : await required.services.confirmations.confirm({ context: required.context, response: response.value, approver });
    return respond({ outcome: continued.ok ? { ok: true, value: { status: 'recorded' as const } } : continued, schema: routes.answer.schema });
}

/** Authenticated browser ingestion accepts only product/error variants; never server trace claims.
 * @complexity One <=2 KiB event, one bounded buffer append; no recursive capture.
 */
async function captureEvent(required: OwnerInput): Promise<HttpResponse> {
    const body = await requestBody(required);
    const parsed = body.ok ? parseBoundary({ schema: captureEventSchema, input: body.value }) : body;
    if (!parsed.ok) return respond({ outcome: parsed, schema: routes.answer.schema });
    if (parsed.value.kind === 'trace') return respond({ outcome: localFailure({ code: 'invalid_input', message: 'Browser trace events are not accepted' }), schema: routes.answer.schema });
    const outcome = required.services.recentEvents?.capture({ event: parsed.value }) ?? localFailure<never>({ message: 'Local events unavailable' });
    return respond({ outcome, schema: routes.answer.schema });
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

/** Owner acknowledgement uses the existing bound service; identity never comes from the body.
 * @complexity One bounded notice input and one local persistence call; no approval card or retry.
 */
async function acknowledgeAlert(required: OwnerInput): Promise<HttpResponse> {
    const body = await requestBody(required);
    if (!body.ok) return respond({ outcome: body, schema: routes.acknowledgeAlert.schema });
    const parsed = parseBoundary({ schema: z.strictObject({ noticeId: idSchema }), input: body.value });
    if (!parsed.ok) return respond({ outcome: parsed, schema: routes.acknowledgeAlert.schema });
    if (!required.services.alerts) return respond({ outcome: localFailure({ message: 'Alerts unavailable' }), schema: routes.acknowledgeAlert.schema });
    const result = await required.services.alerts.acknowledge({ context: required.context, noticeId: parsed.value.noticeId });
    return respond({ outcome: result.ok ? { ok: true, value: { status: 'acknowledged' as const } } : result, schema: routes.acknowledgeAlert.schema });
}

/** Fixed owner route dispatcher. Caller MUST authenticate and derive scope before invocation.
 * Success on answer is recorded only; no route constructs or dispatches vendor dependencies.
 * @example handleOwnerRequest({ request, context: authenticatedOwner, services });
 * @complexity O(path length) routing, fixed route set; each operation has bounded reads/body.
 */
export async function handleOwnerRequest(required: OwnerInput): Promise<HttpResponse> {
    if (required.request.path.startsWith('/api/frontend-sessions/')) return required.services.ui?.sessions
        ? required.services.ui.sessions.handle(required) : { status: 503, body: localFailure({ message: 'Frontend transport unavailable' }) };
    if (required.request.path === '/api/tools' || required.request.path.startsWith('/api/tools/')) return ownerToolRequest(required);
    if (required.request.path.startsWith('/api/addons/v1/')) return addonOwnerRequest(required);
    switch (required.request.method + ' ' + required.request.path) {
        case 'POST /api/dev/events': return captureEvent(required);
        case 'GET /api/dev/events': return respond({ outcome: required.services.recentEvents
            ? { ok: true, value: required.services.recentEvents.recent({}) } : localFailure({ message: 'Local events unavailable' }), schema: recentEventsSchema });
        case 'GET /api/status': return respond({ outcome: { ok: true, value: { ready: true, mode: 'local' as const } }, schema: routes.status.schema });
        case 'GET /api/studio/snapshot': return respond({ outcome: await readStudioSnapshot(required), schema: routes.snapshot.schema });
        case 'GET /api/campaigns': return campaigns(required);
        case 'GET /api/safety/approvals': return approvals(required);
        case 'GET /api/safety/allowance': return respond({ outcome: await required.services.safety.getGenerationAllowanceView({ context: required.context }), schema: routes.allowance.schema });
        case 'POST /api/safety/halt': return halt(required);
        case 'POST /api/alerts/acknowledge': return acknowledgeAlert(required);
        case 'POST /api/attachments': return uploadAttachment(required);
        case 'POST /api/runs': return startRun(required);
        case 'GET /api/conversations': return conversationList(required);
        case 'POST /api/conversations': return conversationCreate(required);
        case 'GET /api/assistant/settings': return assistantSettings(required);
        case 'POST /api/assistant/settings': return assistantSettingsWrite(required);
        case 'POST /api/leads/stage': return setLeadStage(required);
        default: return resourceRequest(required);
    }
}

/** Generic catalog transport; owner authentication is supplied before parsing or invocation. */
async function ownerToolRequest(required: OwnerInput): Promise<HttpResponse> {
    const tools = required.services.tools;
    if (!tools) return { status: 503, body: localFailure({ message: 'OM tool catalog unavailable' }) };
    if (required.request.method === 'GET' && required.request.path === '/api/tools') return ownerToolList({ ...required, tools });
    if (required.request.method === 'POST' && required.request.path === '/api/tools/call') return ownerToolCall({ ...required, tools });
    return ownerToolResource({ ...required, tools });
}
/** Direct catalog calls and surface-button calls share one dispatcher. */
async function ownerToolCall(required: OwnerInput & { tools: OmTools }): Promise<HttpResponse> {
    const body = await requestBody(required);
    if (body.ok && typeof body.value === 'object' && body.value !== null && 'call' in body.value)
        return surfaceToolCall({ ...required, body: body.value });
    const parsed = body.ok ? parseBoundary({ schema: toolCallSchema, input: body.value }) : body;
    if (!parsed.ok) return { status: 400, body: parsed };
    return respond({ outcome: await required.tools.dispatch({ context: required.context, call: parsed.value, signal: required.request.signal }), schema: toolResultSchema });
}
/** Surface buttons reuse the catalog and its one policy, with server-derived run ownership. */
async function surfaceToolCall(required: OwnerInput & { tools: OmTools; body: unknown }): Promise<HttpResponse> {
    const parsed = parseBoundary({ schema: z.strictObject({ call: toolCallSchema, runId: idSchema, frontendSessionId: idSchema }), input: required.body });
    if (!parsed.ok) return { status: 400, body: parsed };
    const context = required.services.ui?.sessions?.actionContext({ context: required.context, ...parsed.value });
    if (!context) return { status: 503, body: localFailure({ message: 'Frontend action transport unavailable' }) };
    if (!context.ok) return respond({ outcome: context, schema: toolResultSchema });
    return respond({ outcome: await required.tools.dispatch({ context: context.value, call: parsed.value.call, signal: required.request.signal }), schema: toolResultSchema });
}
async function ownerToolList(required: OwnerInput & { tools: OmTools }): Promise<HttpResponse> {
    const parsed = parseBoundary({ schema: z.strictObject({ query: z.string().max(1024).optional(), limit: z.string().regex(/^\d{1,3}$/).default('25').transform(Number) }).pipe(toolSearchSchema), input: required.request.query ?? {} });
    if (!parsed.ok) return { status: 400, body: parsed };
    return respond({ outcome: await required.tools.list({ context: required.context, ...parsed.value }), schema: toolDescriptorSchema.array().max(100) });
}
async function ownerToolResource(required: OwnerInput & { tools: OmTools }): Promise<HttpResponse> {
    const match = /^\/api\/tools\/(describe|operations)\/([^/]+)$/.exec(required.request.path);
    if (!match || required.request.method !== 'GET') return { status: 404, body: localFailure({ code: 'invalid_input', message: 'Tool route unavailable' }) };
    const id = resourceId({ segment: match[2] });
    if (!id.ok) return { status: 400, body: id };
    if (match[1] === 'describe') return respond({ outcome: await required.tools.describe({ context: required.context, name: id.value }), schema: toolDescriptorSchema });
    return respond({ outcome: await required.tools.operation({ context: required.context, operationId: id.value }), schema: toolOperationSchema });
}

/** Keep resource matching separate from the fixed route dispatcher to bound branch complexity. */
async function resourceRequest(required: OwnerInput): Promise<HttpResponse> {
    if (/^\/api\/runs\/[^/]+\/surfaces$/.test(required.request.path)) return surfaceAcknowledgement(required);
    if (required.request.path.startsWith('/api/runs/')) return runRequest(required);
    if (required.request.path.startsWith('/api/conversations/')) return conversationRead(required);
    const match = /^\/api\/(campaigns|safety\/approvals)\/([^/]+)(\/answer)?$/.exec(required.request.path);
    if (!match) return { status: 503, body: localFailure({ message: 'Owner operation unavailable in local sandbox' }) };
    const id = resourceId({ segment: match[2] });
    if (!id.ok) return { status: 400, body: id };
    switch (required.request.method + ' ' + match[1] + (match[3] ?? '')) {
        case 'GET campaigns': return campaign({ ...required, id: id.value });
        case 'GET safety/approvals': return approval({ ...required, id: id.value });
        case 'POST safety/approvals/answer': return answerResponse({ ...required, id: id.value });
        default: return { status: 405, body: localFailure({ code: 'invalid_input', message: 'Method unavailable for owner resource' }) };
    }
}

/** Owner authentication precedes this lazy raw read. Sniffed media admission ignores Content-Type.
 * @complexity One <=1 MiB upload, no retry; fixed failures never include filenames or upstream text.
 */
async function uploadAttachment(required: OwnerInput): Promise<HttpResponse> {
    const query = parseBoundary({ schema: z.strictObject({ name: chatAttachmentSchema.shape.name }), input: required.request.query ?? {} });
    if (!query.ok) return respond({ outcome: localFailure({ code: 'invalid_input', message: 'Invalid attachment.' }), schema: chatAttachmentSchema });
    if (!required.services.media || !required.request.readRawBody) return respond({ outcome: localFailure({ message: 'Image upload unavailable' }), schema: chatAttachmentSchema });
    const bytes = await required.request.readRawBody({});
    if (!bytes.ok) return respond({ outcome: bytes, schema: chatAttachmentSchema });
    if (!bytes.value.length || bytes.value.length > 1048576) return respond({ outcome: localFailure({ code: 'limit_exceeded', message: 'Image exceeds byte limit' }), schema: chatAttachmentSchema });
    const asset = await required.services.media.uploadImage({ context: required.context, bytes: bytes.value, filename: query.value.name,
        contentTypes: ['image/png', 'image/jpeg', 'image/webp'] }, { signal: required.request.signal });
    if (!asset.ok) return respond({ outcome: localFailure({ code: asset.error.code,
        message: uploadRefusalCodes.has(asset.error.code) ? asset.error.message : 'Image upload unavailable' }), schema: chatAttachmentSchema });
    return respond({ outcome: { ok: true, value: { path: asset.value.record.id, name: query.value.name, kind: 'image' as const, size: bytes.value.length } }, schema: chatAttachmentSchema });
}

/** Owner prompts are bounded plain text; the server creates all IDs, scope and grants. */
async function startRun(required: OwnerInput): Promise<HttpResponse> {
    if (!required.services.runs) return respond({ outcome: localFailure({ message: 'Sandbox agent unavailable' }), schema: routes.ask.schema });
    const body = await requestBody(required);
    if (!body.ok) return respond({ outcome: body, schema: routes.ask.schema });
    const parsed = parseBoundary({ schema: assistantRunRequestSchema.refine(value => value.prompt.trim().length > 0 && Buffer.byteLength(value.prompt, 'utf8') <= 65536), input: body.value });
    if (!parsed.ok) return respond({ outcome: parsed, schema: routes.ask.schema });
    return respond({ outcome: await required.services.runs.start({ context: required.context, prompt: parsed.value.prompt }, { attachments: parsed.value.attachments, conversationId: parsed.value.conversationId, frontendSessionId: parsed.value.frontendSessionId, frontendBindToken: parsed.value.frontendBindToken }), schema: routes.ask.schema });
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

/** Owner UI changes apply directly; the existing service enforces scoped revision CAS/history.
 * One bounded body parse and one service call; missing composition returns unavailable. */
async function setLeadStage(required: OwnerInput): Promise<HttpResponse> {
    const body = await requestBody(required);
    const parsed = body.ok ? parseBoundary({ schema: leadStageInputSchema.omit({ context: true }), input: body.value }) : body;
    if (!parsed.ok) return respond({ outcome: parsed, schema: routes.setLeadStage.schema });
    const outcome = required.services.leads ? await required.services.leads.setStage({ context: required.context, ...parsed.value }, { signal: required.request.signal })
        : localFailure({ message: 'Lead inbox unavailable' });
    return respond({ outcome, schema: routes.setLeadStage.schema });
}

/** Authenticated add-on management uses D1/D2's owner boundaries and existing services. */
async function addonOwnerRequest(required: OwnerInput): Promise<HttpResponse> {
    if (required.request.path.startsWith('/api/addons/v1/integrations') && required.services.integrations) {
        return handleIntegrationRequest({ ...required, integrations: required.services.integrations });
    }
    if (required.request.path === '/api/addons/v1/chart-providers' || required.request.path.startsWith('/api/addons/v1/chart-assets/')) {
        return required.services.handleChartRequest?.(required) ?? { status: 503, body: localFailure({ message: 'Chart providers unavailable' }) };
    }
    if (required.services.addons) return handleAddonRequest({ ...required, addons: required.services.addons });
    return { status: 503, body: localFailure({ message: 'Add-ons unavailable on this server' }) };
}

/** Browser evidence is authenticated by owner ingress; transport rechecks session/run/invocation.
 * No acknowledgement route dispatches a business effect or grants authority.
 */
async function surfaceAcknowledgement(required: OwnerInput): Promise<HttpResponse> {
    if (required.request.method !== 'POST' || !required.services.ui?.frontend)
        return { status: 503, body: localFailure({ message: 'Frontend surface transport unavailable' }) };
    const body = await requestBody(required);
    const parsed = body.ok ? parseBoundary({ schema: surfaceAcknowledgementSchema, input: body.value }) : body;
    if (!parsed.ok) return { status: 400, body: parsed };
    if (required.request.path !== '/api/runs/' + encodeURIComponent(parsed.value.runId) + '/surfaces')
        return { status: 400, body: localFailure({ code: 'invalid_input', message: 'Surface acknowledgement run mismatch' }) };
    const result = await required.services.ui.frontend.acknowledge({ context: required.context, result: parsed.value });
    return respond({ outcome: result.ok ? { ok: true, value: { status: 'recorded' as const } } : result,
        schema: z.strictObject({ status: z.literal('recorded') }) });
}

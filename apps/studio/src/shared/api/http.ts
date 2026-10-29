import { conversionSettingsStatusSchema, setConversionSettingsSchema, mailProviderSelectionSchema, mailProviderSettingsSchema, oauthClientStatusSchema, pluginSecretQuerySchema, pluginSecretSetSchema, pluginSecretStatusSchema, captureEventSchema, recentEventsSchema, assistantUsageSchema, confirmationCardSchema, toolOperationSchema, surfaceAcknowledgementSchema, toolCallSchema, toolResultSchema } from '@open-marketing/contracts';
/** Cookie-authenticated owner transport. Server state is validated before reaching presentation. */
import { z } from 'zod';
import { addonListRequestSchema, addonListSchema, addonSummarySchema, addonUninstallReceiptSchema, installAddonSchema, setAddonEnabledSchema, uninstallAddonSchema, integrationListSchema, integrationSummarySchema, connectIntegrationTokenSchema, disconnectIntegrationSchema, pageQuerySchema } from '@open-marketing/contracts';
import { chatAttachmentSchema, assistantRunRequestSchema, assistantSettingsSchema, assistantSettingsStatusSchema, conversationListSchema, conversationSchema, appErrorSchema, approvalResponseSchema, epochSchema, idSchema, runEventSchema, parseBoundary } from '@open-marketing/contracts';
import type { AppError, ObserverPort, Outcome } from '@open-marketing/contracts';
import type { StudioApiPort, StudioRuntime, StudioTrace } from './types.js';
import { leadDisplaySchema, leadStageRequestSchema, oauthClientSetSchema, oauthStatusQuerySchema, pluginOAuthStatusSchema, isSafeUiValue, parseStudioSnapshot } from './validation.js';

interface Dependencies {
    readonly baseUrl: string;
    /** Native fetch ABI; composition/fixtures provide the implementation. */
    readonly fetch: typeof fetch;
    readonly runtime: StudioRuntime;
    readonly observer: ObserverPort;
}
const envelope = z.discriminatedUnion('ok', [z.strictObject({ ok: z.literal(true), value: z.unknown() }),
    z.strictObject({ ok: z.literal(false), error: appErrorSchema })]);
const recordedSchema = z.strictObject({ status: z.literal('recorded') });
const acknowledgedSchema = z.strictObject({ status: z.literal('acknowledged') });

function failure(required: { code: AppError['code']; message: string }): Outcome<never> {
    return { ok: false, error: { ...required, retryable: false } };
}
function unavailable(): Outcome<never> {
    return failure({ code: 'unavailable', message: 'Agent operations are unavailable in this local sandbox' });
}

/** Config is an HTTP(S) origin only. No credential, query, fragment, or arbitrary path. */
function baseOrigin(required: { baseUrl: string }): Outcome<string> {
    try {
        if (required.baseUrl.length > 2048) return failure({ code: 'invalid_input', message: 'Server URL too long' });
        const url = new URL(required.baseUrl);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
            return failure({ code: 'invalid_input', message: 'Server URL must be an HTTP(S) origin' });
        }
        return { ok: true, value: url.origin };
    } catch { return failure({ code: 'invalid_input', message: 'Invalid server URL' }); }
}

/** Enforce 256 KiB while streaming, including malformed UTF-8/JSON; always release the reader.
 * @complexity O(b) time/space, b <=256 KiB. Deadline stays active during consumption.
 */
async function readJson(required: { response: Response }): Promise<Outcome<unknown>> {
    const reader = required.response.body?.getReader();
    if (!reader) return failure({ code: 'protocol_mismatch', message: 'Missing server response' });
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let bytes = 0;
    let text = '';
    try {
        while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > 262144) return failure({ code: 'limit_exceeded', message: 'Server response exceeds 256 KiB' });
            text += decoder.decode(chunk.value, { stream: true });
        }
        return { ok: true, value: JSON.parse(text + decoder.decode()) as unknown };
    } catch { return failure({ code: 'protocol_mismatch', message: 'Malformed or interrupted server response' }); }
    finally {
        try { await reader.cancel(); }
        catch { /* An already-errored stream is closed; preserve the typed receive failure. */ }
        finally { reader.releaseLock(); }
    }
}

/** Status and envelope must agree before a successful value is parsed by its owning validator. */
async function receive<T>(required: { response: Response; parse: (required: { input: unknown }) => Outcome<T> }): Promise<Outcome<T>> {
    if (required.response.status >= 300 && required.response.status < 400) {
        await required.response.body?.cancel();
        return failure({ code: 'protocol_mismatch', message: 'Server redirects are not permitted' });
    }
    const body = await readJson(required);
    if (!body.ok) return body;
    const parsed = parseBoundary({ schema: envelope, input: body.value });
    if (!parsed.ok) return failure({ code: 'protocol_mismatch', message: 'Malformed server response envelope' });
    if (!parsed.value.ok) return parsed.value;
    if (!required.response.ok) return failure({ code: 'protocol_mismatch', message: 'HTTP status contradicts successful response' });
    return required.parse({ input: parsed.value.value });
}

/** A cancelled/deadline-aborted body cannot acknowledge success. Post-dispatch protocol/transport
 * failures do not establish whether an answer committed; the owner must reread before resubmitting.
 */
function transportResult<T>(required: { result: Outcome<T>; method: 'GET' | 'POST'; aborted: boolean; ownerAborted: boolean }): Outcome<T> {
    if (required.aborted) return failure({ code: required.ownerAborted ? 'cancelled' : 'unavailable',
        message: required.method === 'POST' ? 'Write response unavailable; outcome unknown. Refresh before another submission.' : 'Server response interrupted' });
    if (!required.result.ok && required.method === 'POST' && ['protocol_mismatch', 'unavailable', 'limit_exceeded'].includes(required.result.error.code)) {
        return failure({ code: required.result.error.code, message: 'Write response unavailable; outcome unknown. Refresh before another submission.' });
    }
    return required.result;
}

/** Raw uploads take precedence; serialization errors stay inside the request's try/catch. */
function requestBody(required: { body?: unknown; rawBody?: Blob }): string | Blob | undefined {
    return required.rawBody ?? (required.body === undefined ? undefined : JSON.stringify(required.body));
}

/** One request with injected deadlines and tracing. Writes are never retried. Cookies are sent
 * only to the current browser origin; redirects cannot move authentication to another origin.
 * @complexity One HTTP call, O(b) bounded response; timeout 15s, no retained request state.
 */
async function request<T>(required: {
    dependencies: Dependencies; origin: Outcome<string>; path: string; method: 'GET' | 'POST'; body?: unknown; rawBody?: Blob;
    signal?: AbortSignal; trace?: StudioTrace; parse: (required: { input: unknown }) => Outcome<T>;
}): Promise<Outcome<T>> {
    if (!required.origin.ok) return required.origin;
    if (required.signal?.aborted) return failure({ code: 'cancelled', message: 'Request cancelled' });
    const { runtime } = required.dependencies;
    const correlationId = required.trace?.correlationId ?? runtime.ids.next({});
    const traceId = required.trace?.traceId ?? runtime.ids.next({});
    const controller = runtime.abort();
    const abort = (): void => controller.abort();
    required.signal?.addEventListener('abort', abort, { once: true });
    const timer = runtime.timers.schedule({ delayMs: 15000, callback: abort });
    let outcome = 'unavailable';
    try {
        const response = await required.dependencies.fetch(new URL(required.path, required.origin.value), {
            method: required.method, credentials: 'same-origin', redirect: 'manual', signal: controller.signal,
            headers: { accept: 'application/json', 'content-type': required.rawBody ? 'application/octet-stream' : 'application/json', 'x-correlation-id': correlationId,
                'x-trace-id': traceId, 'idempotency-key': correlationId },
            body: requestBody(required),
        });
        const received = await receive({ response, parse: required.parse });
        const result = transportResult({ result: received, method: required.method, aborted: controller.signal.aborted, ownerAborted: required.signal?.aborted ?? false });
        outcome = result.ok ? 'succeeded' : result.error.code;
        return result;
    } catch {
        const code = required.signal?.aborted ? 'cancelled' : 'unavailable';
        outcome = code;
        return failure({ code, message: required.method === 'POST' ? 'Write response unavailable; outcome unknown. Refresh before another submission.' : 'Server response unavailable' });
    } finally {
        runtime.timers.cancel({ handle: timer });
        required.signal?.removeEventListener('abort', abort);
        controller.abort();
        try { required.dependencies.observer.observe({ operation: 'studio.http.' + required.method.toLowerCase(), outcome, correlationId, traceId }); }
        catch { /* Diagnostics cannot replace the operation result. */ }
    }
}

/** Inert owner transport; poll cursors for incremental text, activity and terminal evidence.
 * No sample fallback and no automatic write retries.
 * @example createHttpStudioApi({ baseUrl: location.origin, fetch, runtime, observer });
 * @complexity O(1) construction; each snapshot/answer has one bounded request, no retries.
 */
export function createHttpStudioApi(required: Dependencies): StudioApiPort {
    const origin = baseOrigin(required);
    return {
        setLeadStage: input => addonWrite({ dependencies: required, origin, path: '/api/leads/stage', schema: leadDisplaySchema, inputSchema: leadStageRequestSchema, ...input }),
        async captureEvent(input) {
            const event = captureEventSchema.safeParse(input.event);
            if (!event.success || event.data.kind === 'trace') return failure({ code: 'invalid_input', message: 'Invalid browser event' });
            return request({ dependencies: required, origin, path: '/api/dev/events', method: 'POST', body: event.data, signal: input.signal,
                parse: value => parseBoundary({ schema: recordedSchema, input: value.input }) });
        },
        recentEvents: input => request({ dependencies: required, origin, path: '/api/dev/events', method: 'GET', signal: input.signal,
            parse: value => parseBoundary({ schema: recentEventsSchema, input: value.input }) }),
        async tool(input) {
            const call = parseBoundary({ schema: toolCallSchema, input: input.call });
            if (!call.ok) return call;
            const body = input.runId || input.frontendSessionId ? { call: call.value, runId: input.runId, frontendSessionId: input.frontendSessionId } : call.value;
            return request({ dependencies: required, origin, path: '/api/tools/call', method: 'POST', body, signal: input.signal, trace: input.trace,
                parse: value => parseBoundary({ schema: toolResultSchema, input: value.input }) });
        },
        operation: input => addonRead({ dependencies: required, origin, path: '/api/tools/operations/' + encodeURIComponent(input.operationId), schema: toolOperationSchema,
            querySchema: z.strictObject({}), query: {}, signal: input.signal, trace: input.trace }).then(result => {
                if (!result.ok) return result;
                return result.value.operationId === input.operationId && isSafeUiValue({ value: result.value, maxCharacters: 262144 }) ? result
                    : failure({ code: 'protocol_mismatch', message: 'Operation identity or display data rejected' });
            }),
        approvalCard: input => request({ dependencies: required, origin, path: '/api/safety/approvals/' + encodeURIComponent(input.cardId), method: 'GET', signal: input.signal, trace: input.trace,
            parse: value => parseBoundary({ schema: confirmationCardSchema, input: value.input }) }),
        acknowledgeAlert: input => request({ dependencies: required, origin, path: '/api/alerts/acknowledge', method: 'POST', body: { noticeId: input.noticeId }, signal: input.signal, trace: input.trace,
            parse: value => parseBoundary({ schema: acknowledgedSchema, input: value.input }) }),
        async acknowledgeSurface(input) {
            const result = parseBoundary({ schema: surfaceAcknowledgementSchema, input: input.result });
            if (!result.ok) return result;
            return request({ dependencies: required, origin, path: '/api/runs/' + encodeURIComponent(result.value.runId) + '/surfaces', method: 'POST', body: result.value, trace: input.trace,
                parse: value => parseBoundary({ schema: recordedSchema, input: value.input }) });
        },
        addons: {
            conversionSettings: input => addonRead({ dependencies: required, origin, path: '/api/addons/v1/integrations/conversion-settings', schema: conversionSettingsStatusSchema, querySchema: setConversionSettingsSchema.pick({ pluginId: true }), query: { pluginId: input.pluginId }, signal: input.signal, trace: input.trace }),
            setConversionSettings: input => addonWrite({ dependencies: required, origin, path: '/api/addons/v1/integrations/conversion-settings', schema: conversionSettingsStatusSchema, inputSchema: setConversionSettingsSchema, ...input }),
            mailProviderSettings: input => addonRead({ dependencies: required, origin, path: '/api/addons/v1/provider-settings/mail', schema: mailProviderSettingsSchema, querySchema: z.strictObject({}), query: {}, signal: input.signal, trace: input.trace }),
            setMailProviderSettings: input => addonWrite({ dependencies: required, origin, path: '/api/addons/v1/provider-settings/mail', schema: mailProviderSelectionSchema, inputSchema: mailProviderSelectionSchema, ...input }),
            setOAuthClient: input => addonWrite({ dependencies: required, origin, path: '/api/addons/v1/integrations/oauth/client', schema: oauthClientStatusSchema, inputSchema: oauthClientSetSchema, ...input }),
            oauthStatus: input => addonRead({ dependencies: required, origin, path: '/api/addons/v1/integrations/oauth/status', schema: pluginOAuthStatusSchema, querySchema: oauthStatusQuerySchema, ...input }),
            setPluginSecret: input => addonWrite({ dependencies: required, origin, path: '/api/addons/v1/integrations/plugin-secret', schema: pluginSecretStatusSchema, inputSchema: pluginSecretSetSchema, ...input }),
            pluginSecretStatus: input => addonRead({ dependencies: required, origin, path: '/api/addons/v1/integrations/plugin-secret', schema: pluginSecretStatusSchema, querySchema: pluginSecretQuerySchema, query: { pluginId: input.pluginId }, signal: input.signal, trace: input.trace }),
            list: input => addonRead({ dependencies: required, origin, path: '/api/addons/v1/packages', schema: addonListSchema, querySchema: addonListRequestSchema, ...input }),
            integrations: input => addonRead({ dependencies: required, origin, path: '/api/addons/v1/integrations', schema: integrationListSchema, querySchema: pageQuerySchema, ...input }),
            install: input => addonWrite({ dependencies: required, origin, path: '/api/addons/v1/install', schema: addonSummarySchema, inputSchema: installAddonSchema, ...input }),
            setEnabled: input => addonWrite({ dependencies: required, origin, path: '/api/addons/v1/set-enabled', schema: addonSummarySchema, inputSchema: setAddonEnabledSchema, ...input }),
            uninstall: input => addonWrite({ dependencies: required, origin, path: '/api/addons/v1/uninstall', schema: addonUninstallReceiptSchema, inputSchema: uninstallAddonSchema, ...input }),
            connect: input => addonWrite({ dependencies: required, origin, path: '/api/addons/v1/integrations/token', schema: integrationSummarySchema, inputSchema: connectIntegrationTokenSchema, ...input }),
            disconnect: input => addonWrite({ dependencies: required, origin, path: '/api/addons/v1/integrations/disconnect', schema: integrationSummarySchema, inputSchema: disconnectIntegrationSchema, ...input }),
        },
        snapshot: input => request({ dependencies: required, origin, path: '/api/studio/snapshot', method: 'GET', signal: input.signal, trace: input.trace, parse: parseStudioSnapshot }),
        async approve(input) {
            const response = parseBoundary({ schema: approvalResponseSchema, input: input.response });
            if (!response.ok) return response;
            return request({ dependencies: required, origin, path: '/api/safety/approvals/' + encodeURIComponent(response.value.cardId) + '/answer',
                method: 'POST', body: response.value, signal: input.signal, trace: input.trace, parse: value => parseBoundary({ schema: recordedSchema, input: value.input }) });
        },
        attachments: {
            async upload(input) {
                const file = chatAttachmentSchema.pick({ name: true, size: true }).safeParse({ name: input.file.name, size: input.file.size });
                if (!file.success) return failure({ code: 'invalid_input', message: 'Invalid attachment.' });
                return request({ dependencies: required, origin, path: '/api/attachments?name=' + encodeURIComponent(file.data.name),
                    method: 'POST', rawBody: input.file, signal: input.signal, trace: input.trace,
                    parse: value => parseBoundary({ schema: chatAttachmentSchema, input: value.input }) });
            },
        },
        async start(input) {
            const parsed = parseBoundary({ schema: assistantRunRequestSchema, input: { prompt: input.message.text, attachments: input.attachments, conversationId: input.conversationId, frontendSessionId: input.frontendSessionId, frontendBindToken: input.frontendBindToken } });
            if (!parsed.ok) return parsed;
            return request({ dependencies: required, origin, path: '/api/runs', method: 'POST', body: parsed.value, signal: input.signal, trace: input.trace,
                parse: value => parseBoundary({ schema: runReceiptSchema, input: value.input }) });
        },
        runStatus: input => readRunStatus({ dependencies: required, origin, runId: input.runId, after: input.after ?? 0, trace: input.trace, signal: input.signal ?? required.runtime.abort().signal }),
        events: input => pollEvents({ dependencies: required, origin, ...input }),
        cancel: input => request({ dependencies: required, origin, path: '/api/runs/' + encodeURIComponent(input.runId) + '/cancel', method: 'POST', body: {}, trace: input.trace,
            parse: value => parseBoundary({ schema: cancellationSchema, input: value.input }) }),
        conversations: input => request({ dependencies: required, origin, path: '/api/conversations?limit=25' + (input.cursor ? '&cursor=' + encodeURIComponent(input.cursor) : ''), method: 'GET', signal: input.signal, trace: input.trace,
            parse: value => parseBoundary({ schema: conversationListSchema, input: value.input }) }),
        conversation: input => request({ dependencies: required, origin, path: '/api/conversations/' + encodeURIComponent(input.conversationId) + '?limit=100' + (input.cursor ? '&cursor=' + encodeURIComponent(input.cursor) : ''), method: 'GET', signal: input.signal, trace: input.trace,
            parse: value => parseBoundary({ schema: conversationSchema, input: value.input }) }),
        settings: input => request({ dependencies: required, origin, path: '/api/assistant/settings', method: 'GET', signal: input.signal, trace: input.trace,
            parse: value => parseBoundary({ schema: assistantSettingsStatusSchema, input: value.input }) }),
        async setSettings(input) {
            const parsed = parseBoundary({ schema: assistantSettingsSchema, input: input.settings });
            if (!parsed.ok) return parsed;
            return request({ dependencies: required, origin, path: '/api/assistant/settings', method: 'POST', body: parsed.value, signal: input.signal, trace: input.trace,
                parse: value => parseBoundary({ schema: assistantSettingsStatusSchema, input: value.input }) });
        },
        async acknowledgeNavigation() { return unavailable(); },
    };
}

const runReceiptSchema = z.strictObject({ runId: idSchema, status: z.enum(['requested', 'pending']), expiresAt: epochSchema,
 conversationId: idSchema.optional(), mode: z.enum(['sandbox', 'model']).optional() });
const cancellationSchema = z.strictObject({ runId: idSchema, status: z.enum(['requested', 'cancelled']) });
const runPageSchema = z.strictObject({ runId: idSchema, status: z.enum(['running', 'completed', 'cancelled', 'interrupted']), events: z.array(runEventSchema).max(128), usage: assistantUsageSchema.optional() });

/** Validate a full page before yielding anything; malformed/foreign/gapped pages leak no partial UI. */
function checkedRunPage(required: { input: unknown; runId: string; after: number }): Outcome<z.infer<typeof runPageSchema>> {
 const parsed = parseBoundary({ schema: runPageSchema, input: required.input });
 if (!parsed.ok) return parsed;
 let sequence = required.after;
 if (parsed.value.runId !== required.runId) return failure({ code: 'protocol_mismatch', message: 'Different run returned' });
 for (const event of parsed.value.events) {
  if (event.runId !== required.runId || event.sequence !== ++sequence) return failure({ code: 'protocol_mismatch', message: 'Run event cursor mismatch' });
 }
 const last = parsed.value.events.at(-1)?.kind;
 const expected = { completed: 'ended', cancelled: 'cancelled', interrupted: 'error', running: null }[parsed.value.status];
 if (expected && last !== expected) return failure({ code: 'protocol_mismatch', message: 'Run page lacks terminal evidence' });
 return parsed;
}
type PollInput = { dependencies: Dependencies; origin: Outcome<string>; runId: string; after: number; signal: AbortSignal; trace?: StudioTrace };
/** One cursor stream, bounded by the run deadline/session cancellation; <=8,192 unique events.
 * Poll interval 1s, no retry of failed pages; every request retains the transport's 15s deadline.
 */
async function* pollEvents(required: PollInput): AsyncIterable<Outcome<import('@open-marketing/contracts').RunEvent>> {
 let after = required.after;
 while (!required.signal.aborted) {
  const page = await requestRunPage({ ...required, after });
  if (!page.ok) { yield* observedPollingFailure({ result: page, signal: required.signal }); return; }
  for (const event of page.value.events) { after = event.sequence; yield { ok: true, value: event }; }
  if (page.value.status !== 'running') return;
  const next = await waitForRunPage({ ...required, after });
  if (!next.ok) { yield next; return; }
 }
}

function requestRunPage(required: PollInput): Promise<Outcome<z.infer<typeof runPageSchema>>> {
 return request({ ...required, path: '/api/runs/' + encodeURIComponent(required.runId) + '/events?after=' + required.after, method: 'GET',
  parse: value => checkedRunPage({ input: value.input, runId: required.runId, after: required.after }) });
}

/** Owner cancellation ends observation without presenting an error from the interrupted request. */
function* observedPollingFailure(required: { result: Outcome<never>; signal: AbortSignal }): Generator<Outcome<never>> {
 if (!required.signal.aborted) yield required.result;
}

/** Preserve the event cap and injected interval; an expected owner abort is not a transport failure. */
async function waitForRunPage(required: PollInput): Promise<Outcome<void>> {
 if (required.after >= 8192) return failure({ code: 'limit_exceeded', message: 'Run event limit exceeded' });
 try { await required.dependencies.runtime.timers.wait({ delayMs: 1000, signal: required.signal }); }
 catch {
  if (!required.signal.aborted) return failure({ code: 'unavailable', message: 'Run polling interrupted' });
 }
 return { ok: true, value: undefined };
}

/** Add-on reads validate query and response using I-0; one bounded request, no retry. */
async function addonRead<T>(required: { dependencies: Dependencies; origin: Outcome<string>; path: string; schema: z.ZodType<T>; querySchema: z.ZodType; query: unknown; signal?: AbortSignal; trace?: StudioTrace }): Promise<Outcome<T>> {
    const query = parseBoundary({ schema: required.querySchema, input: required.query });
    if (!query.ok) return query;
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(query.value as Record<string, unknown>)) if (value !== undefined) search.set(key, String(value));
    return request({ ...required, path: required.path + '?' + search, method: 'GET', parse: input => parseBoundary({ schema: required.schema, input: input.input }) });
}
/** Owner mutations are validated before dispatch; plaintext is never copied into diagnostics. */
async function addonWrite<T>(required: { dependencies: Dependencies; origin: Outcome<string>; path: string; schema: z.ZodType<T>; inputSchema: z.ZodType; request: unknown; signal?: AbortSignal; trace?: StudioTrace }): Promise<Outcome<T>> {
    const body = parseBoundary({ schema: required.inputSchema, input: required.request });
    if (!body.ok) return failure({ code: 'invalid_input', message: 'Invalid add-on request' });
    return request({ ...required, method: 'POST', body: body.value, parse: input => parseBoundary({ schema: required.schema, input: input.input }) });
}

/** Intermediate pages of a completed run say running. Drain nonempty pages, <=8,192 events/128 pages,
 * before returning status; an empty running page is the current head. No polling or write.
 * @complexity O(n) bounded events, O(128) page space; existing per-request deadlines apply.
 */
async function readRunStatus(required: PollInput): Promise<Outcome<Omit<z.infer<typeof runPageSchema>, 'events'>>> {
 let after = required.after, pages = 0;
 while (after < 8192 && pages++ < 128) {
  const page = await requestRunPage({ ...required, after });
  if (!page.ok) return page;
  if (page.value.status !== 'running' || page.value.events.length === 0) return { ok: true, value: { runId: required.runId, status: page.value.status, usage: page.value.usage } };
  after = page.value.events.at(-1)!.sequence;
 }
 return failure({ code: 'limit_exceeded', message: 'Run status exceeds the event bound' });
}

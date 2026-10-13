/** Cookie-authenticated owner transport. Server state is validated before reaching presentation. */
import { z } from 'zod';
import { appErrorSchema, approvalResponseSchema, parseBoundary } from '@open-marketing/contracts';
import type { AppError, ObserverPort, Outcome } from '@open-marketing/contracts';
import type { StudioApiPort, StudioRuntime } from './types.js';
import { parseStudioSnapshot } from './validation.js';

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
        message: required.method === 'POST' ? 'Approval response unavailable; outcome unknown. Refresh before another submission.' : 'Server response interrupted' });
    if (!required.result.ok && required.method === 'POST' && ['protocol_mismatch', 'unavailable', 'limit_exceeded'].includes(required.result.error.code)) {
        return failure({ code: required.result.error.code, message: 'Approval response unavailable; outcome unknown. Refresh before another submission.' });
    }
    return required.result;
}

/** One request with injected deadlines and tracing. Writes are never retried. Cookies are sent
 * only to the current browser origin; redirects cannot move authentication to another origin.
 * @complexity One HTTP call, O(b) bounded response; timeout 15s, no retained request state.
 */
async function request<T>(required: {
    dependencies: Dependencies; origin: Outcome<string>; path: string; method: 'GET' | 'POST'; body?: unknown;
    signal?: AbortSignal; parse: (required: { input: unknown }) => Outcome<T>;
}): Promise<Outcome<T>> {
    if (!required.origin.ok) return required.origin;
    if (required.signal?.aborted) return failure({ code: 'cancelled', message: 'Request cancelled' });
    const { runtime } = required.dependencies;
    const correlationId = runtime.ids.next({});
    const traceId = runtime.ids.next({});
    const controller = runtime.abort();
    const abort = (): void => controller.abort();
    required.signal?.addEventListener('abort', abort, { once: true });
    const timer = runtime.timers.schedule({ delayMs: 15000, callback: abort });
    let outcome = 'unavailable';
    try {
        const response = await required.dependencies.fetch(new URL(required.path, required.origin.value), {
            method: required.method, credentials: 'same-origin', redirect: 'manual', signal: controller.signal,
            headers: { accept: 'application/json', 'content-type': 'application/json', 'x-correlation-id': correlationId,
                'x-trace-id': traceId, 'idempotency-key': correlationId },
            ...(required.body === undefined ? {} : { body: JSON.stringify(required.body) }),
        });
        const received = await receive({ response, parse: required.parse });
        const result = transportResult({ result: received, method: required.method, aborted: controller.signal.aborted, ownerAborted: required.signal?.aborted ?? false });
        outcome = result.ok ? 'succeeded' : result.error.code;
        return result;
    } catch {
        const code = required.signal?.aborted ? 'cancelled' : 'unavailable';
        outcome = code;
        return failure({ code, message: required.method === 'POST' ? 'Approval response unavailable; outcome unknown. Refresh before another submission.' : 'Server response unavailable' });
    } finally {
        runtime.timers.cancel({ handle: timer });
        required.signal?.removeEventListener('abort', abort);
        controller.abort();
        try { required.dependencies.observer.observe({ operation: 'studio.http.' + required.method.toLowerCase(), outcome, correlationId, traceId }); }
        catch { /* Diagnostics cannot replace the operation result. */ }
    }
}

/** Inert HTTP implementation of the existing StudioApiPort. No sample fallback after connection
 * failures. Agent methods explicitly remain unavailable until I4 supplies the run transport.
 * @example createHttpStudioApi({ baseUrl: location.origin, fetch, runtime, observer });
 * @complexity O(1) construction; each snapshot/answer has one bounded request, no retries.
 */
export function createHttpStudioApi(required: Dependencies): StudioApiPort {
    const origin = baseOrigin(required);
    return {
        snapshot: input => request({ dependencies: required, origin, path: '/api/studio/snapshot', method: 'GET', signal: input.signal, parse: parseStudioSnapshot }),
        async approve(input) {
            const response = parseBoundary({ schema: approvalResponseSchema, input: input.response });
            if (!response.ok) return response;
            return request({ dependencies: required, origin, path: '/api/safety/approvals/' + encodeURIComponent(response.value.cardId) + '/answer',
                method: 'POST', body: response.value, signal: input.signal, parse: value => parseBoundary({ schema: recordedSchema, input: value.input }) });
        },
        async start() { return unavailable(); },
        async *events() { yield unavailable(); },
        async cancel() { return unavailable(); },
        async acknowledgeNavigation() { return unavailable(); },
    };
}

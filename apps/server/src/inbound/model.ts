/** Anthropic wire proxy. Run tokens enter; only the server-held provider key leaves. */
import { z } from 'zod';
import { parseBoundary } from '@open-marketing/contracts';
import type { ClockPort, ObserverPort, Outcome, RunGrantMetadata } from '@open-marketing/contracts';
import type { HttpRequest, HttpResponse } from '../ports.js';
import type { RunGrantVerifierPort } from './om.js';

const modelPath = '/api/agent/v1/model/anthropic/v1/messages';
const messageSchema = z.strictObject({ role: z.enum(['user', 'assistant']), content: z.union([z.string(), z.array(z.record(z.string(), z.json())).max(100)]) });
const requestSchema = z.strictObject({
    model: z.string().min(1).max(256), stream: z.literal(true), max_tokens: z.number().int().min(1).max(4096),
    messages: z.array(messageSchema).min(1).max(90), system: z.string().max(131072).optional(),
    tools: z.array(z.strictObject({ name: z.string().min(1).max(256), description: z.string().max(4096).optional(), input_schema: z.record(z.string(), z.json()), strict: z.boolean().optional() })).max(100).optional(),
});

/** Addons/composition owns sealed storage and the selected model. Keys never enter OM DTOs. */
export interface ModelCredentials {
    resolveProviderKey(required: { grant: RunGrantMetadata; signal: AbortSignal }): Promise<Outcome<{ apiKey: string; model: string }>>;
}

/** Composition supplies transport and a cancellable deadline. No retries or caller-selected URL.
 * A fixture implements the same contract without vendor access.
 */
export interface ModelUpstream {
    send(required: { url: string; headers: Readonly<Record<string, string>>; body: string; signal: AbortSignal; redirect: 'error' }): Promise<Response>;
    deadline(required: { timeoutMs: number }): { signal: AbortSignal; dispose(): void };
}

interface BrokerInput {
    request: HttpRequest; grants: RunGrantVerifierPort; credentials: ModelCredentials;
    upstream: ModelUpstream; clock: ClockPort; observer: ObserverPort;
}

function traceIdentifiers(required: { input: BrokerInput; grant: RunGrantMetadata }) {
    const identifier = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/);
    const correlation = identifier.safeParse(required.input.request.headers?.['x-correlation-id']);
    const trace = identifier.safeParse(required.input.request.headers?.['x-trace-id']);
    return { correlationId: correlation.success ? correlation.data : required.grant.grantId,
        traceId: trace.success ? trace.data : required.grant.grantId };
}

function rejected(required: { status: number; code: 'invalid_input' | 'forbidden' | 'unavailable' | 'limit_exceeded' }): HttpResponse {
    return { status: required.status, body: { ok: false, error: { code: required.code, message: 'Model broker request unavailable', retryable: false } } };
}

/** Authenticate native Anthropic x-api-key as an OM bearer. Service/owner tokens must fail
 * the injected run verifier. A current model capability is required before reading the body.
 * @complexity O(1) plus the verifier's scoped lookup.
 */
async function verifyModelGrant(required: { input: BrokerInput; authorization: string | undefined }): Promise<Outcome<RunGrantMetadata>> {
    const result = await required.input.grants.verify({ authorization: required.authorization });
    if (!result.ok) return result;
    const grant = result.value;
    if (grant.revoked || grant.expiresAt <= required.input.clock.now({}) || !grant.capabilities.includes('model')) {
        return { ok: false, error: { code: 'forbidden', message: 'Model run authority unavailable', retryable: false } };
    }
    return result;
}

/** Parse the provider wire envelope, with a second byte bound for in-memory callers.
 * Tool-result messages may extend the 40-message initial context across 24 tool turns.
 * @complexity O(b) time/space, b <=256 KiB; malformed/cyclic inputs return typed failures.
 */
async function modelBody(required: { request: HttpRequest }): Promise<Outcome<z.infer<typeof requestSchema>>> {
    const body = required.request.readBody ? await required.request.readBody({}) : { ok: true as const, value: required.request.body };
    if (!body.ok) return body;
    try {
        if (Buffer.byteLength(JSON.stringify(body.value), 'utf8') > 262144) {
            return { ok: false, error: { code: 'limit_exceeded', message: 'Model request exceeds 256 KiB', retryable: false } };
        }
        return parseBoundary({ schema: requestSchema, input: body.value });
    } catch { return { ok: false, error: { code: 'invalid_input', message: 'Invalid model request', retryable: false } }; }
}

/** Trace only validated identifiers; never upstream error text, prompts, headers or credentials. */
function observe(required: { input: BrokerInput; grant: RunGrantMetadata; outcome: string }): void {
    try {
        required.input.observer.observe({ operation: 'server.model.request', outcome: required.outcome, runId: required.grant.runId,
            ...traceIdentifiers(required) });
    } catch { /* Telemetry cannot authorize or repeat a billed request. */ }
}

/** Single authenticated model request, without automatic retry. Exact route and grant precede
 * body/key access; authority is rechecked after key resolution, immediately before egress.
 * @example await handleModelRequest({ request, grants, credentials, upstream, clock, observer });
 * @returns Bounded SSE bytes or an opaque typed error; composition must mount this route explicitly.
 * @complexity O(b) request parsing and O(s) streaming, <=256 KiB request and <=2 MiB response.
 */
export async function handleModelRequest(required: BrokerInput): Promise<HttpResponse> {
    if (required.request.path !== modelPath || required.request.method !== 'POST') return rejected({ status: 403, code: 'forbidden' });
    const token = required.request.headers?.['x-api-key'];
    if (!token || !/^[^\s]{32,8192}$/.test(token)) return rejected({ status: 401, code: 'forbidden' });
    const authorization = 'Bearer ' + token;
    try {
        const grant = await verifyModelGrant({ input: required, authorization });
        if (!grant.ok) return { status: 403, body: grant };
        const body = await modelBody({ request: required.request });
        if (!body.ok) return { status: body.error.code === 'limit_exceeded' ? 413 : 400, body };
        return await openModelStream({ input: required, grant: grant.value, authorization, token, body: body.value });
    } catch { return rejected({ status: 503, code: 'unavailable' }); }
}

/** Own the upstream reader/deadline until the listener cancels or finishes. All caller auth,
 * cookies, routing and beta headers are discarded; only fixed provider headers are constructed.
 * @complexity O(b) serialization, one upstream request and one active reader.
 */
async function openModelStream(required: { input: BrokerInput; grant: RunGrantMetadata; authorization: string; token: string; body: z.infer<typeof requestSchema> }): Promise<HttpResponse> {
    const { input, grant } = required;
    const admitted = await verifyModelGrant({ input, authorization: required.authorization });
    if (!admitted.ok) return { status: 403, body: admitted };
    const deadline = input.upstream.deadline({ timeoutMs: Math.min(300000, grant.expiresAt - input.clock.now({})) });
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, deadline.signal, ...(input.request.signal ? [input.request.signal] : [])]);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let cancelled = false;
    async function cancel() {
        if (cancelled) return;
        cancelled = true;
        signal.removeEventListener('abort', interrupted);
        controller.abort();
        deadline.dispose();
        try { await reader?.cancel(); } catch { /* An interrupted upstream is already closed. */ }
    }
    function interrupted() { void cancel(); }
    signal.addEventListener('abort', interrupted, { once: true });
    try {
        const credentials = await input.credentials.resolveProviderKey({ grant, signal });
        if (!credentials.ok || !/^[^\s]{1,8192}$/.test(credentials.value.apiKey) || credentials.value.model !== required.body.model) {
            await cancel(); return rejected({ status: 503, code: 'unavailable' });
        }
        const current = await verifyModelGrant({ input, authorization: required.authorization });
        if (!current.ok || current.value.grantId !== grant.grantId || signal.aborted) {
            await cancel(); return rejected({ status: 403, code: 'forbidden' });
        }
        const trace = traceIdentifiers({ input, grant });
        const response = await input.upstream.send({ url: 'https://api.anthropic.com/v1/messages',
            headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': credentials.value.apiKey,
                'x-correlation-id': trace.correlationId, 'x-trace-id': trace.traceId, 'x-om-run-id': grant.runId },
            body: JSON.stringify(required.body), signal, redirect: 'error' });
        reader = response.body?.getReader();
        if (signal.aborted) { await reader?.cancel(); throw new Error('Model stream interrupted'); }
        if (!response.ok || !reader || response.headers.get('content-type')?.split(';')[0].trim() !== 'text/event-stream') {
            observe({ input, grant, outcome: 'upstream_rejected' });
            await cancel(); return rejected({ status: 502, code: 'unavailable' });
        }
        observe({ input, grant, outcome: 'streaming' });
        return { status: 200, body: null, contentType: 'text/event-stream; charset=utf-8',
            stream: { chunks: cleanStream({ reader, signal, input, grant, authorization: required.authorization, secrets: [credentials.value.apiKey, required.token] }), cancel } };
    } catch {
        observe({ input, grant, outcome: 'interrupted' });
        await cancel(); return rejected({ status: 503, code: 'unavailable' });
    }
}

/** Redact complete SSE lines so secret fragments split across chunks cannot leak.
 * Invalid UTF-8, an oversized line/stream, interruption or revoked authority aborts the socket.
 * @complexity O(s) time, <=64 KiB pending line and <=2 MiB total incoming data. No replay.
 */
async function* cleanStream(required: { reader: ReadableStreamDefaultReader<Uint8Array>; signal: AbortSignal; input: BrokerInput; grant: RunGrantMetadata; authorization: string; secrets: readonly string[] }): AsyncIterable<Uint8Array> {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const encoder = new TextEncoder();
    let pending = ''; let bytes = 0; let stopped = false;
    try {
        while (true) {
            required.signal.throwIfAborted();
            const chunk = await required.reader.read();
            required.signal.throwIfAborted();
            const current = await verifyModelGrant({ input: required.input, authorization: required.authorization });
            if (!current.ok || current.value.grantId !== required.grant.grantId) throw new Error('Model stream authority lost');
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > 2097152) throw new Error('Model stream limit reached');
            pending += decoder.decode(chunk.value, { stream: true });
            const lines = boundedLines({ text: pending });
            pending = lines.pending;
            stopped ||= messageStopped({ text: lines.complete });
            yield encoder.encode(redact({ text: lines.complete, secrets: required.secrets }));
        }
        pending += decoder.decode();
        if (!stopped) throw new Error('Model stream ended before message_stop');
        if (pending) yield encoder.encode(redact({ text: pending, secrets: required.secrets }));
        observe({ ...required, outcome: 'completed' });
    } catch {
        observe({ ...required, outcome: 'interrupted' });
        throw new Error('Model stream interrupted');
    }
}

/** Bound each UTF-8 SSE line before forwarding, including a trailing partial line. */
function boundedLines(required: { text: string }): { complete: string; pending: string } {
    if (required.text.split('\n').some(line => Buffer.byteLength(line, 'utf8') > 65536)) throw new Error('Model line limit reached');
    const boundary = required.text.lastIndexOf('\n') + 1;
    return { complete: required.text.slice(0, boundary), pending: required.text.slice(boundary) };
}

/** A clean socket EOF alone does not prove the billed provider turn completed. Jini owns all
 * other provider parsing; this check distinguishes a truncated upstream from message_stop.
 */
function messageStopped(required: { text: string }): boolean {
    return required.text.split('\n').some(line => {
        if (!line.startsWith('data:')) return false;
        try { return z.object({ type: z.literal('message_stop') }).safeParse(JSON.parse(line.slice(5))).success; }
        catch { return false; }
    });
}

function redact(required: { text: string; secrets: readonly string[] }): string {
    let text = required.text;
    for (const secret of required.secrets) text = text.split(secret).join('[redacted]');
    return text;
}

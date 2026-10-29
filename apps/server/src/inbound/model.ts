/** Declaration-driven native model broker. Run tokens enter; only the server-held provider key leaves. */
import { z } from 'zod';
import { parseBoundary } from '@open-marketing/contracts';
import type { AppError, ClockPort, ObserverPort, Outcome, RunGrantMetadata } from '@open-marketing/contracts';
import type { HttpRequest, HttpResponse } from '../ports.js';
import type { RunGrantVerifierPort } from './om.js';

import { decodeSseFrames } from '@jini-ai/core/primitives';
import type { AssistantSettings, ModelProtocol, ModelProvider, IdPort } from '@open-marketing/contracts';
import type { CampaignSqlPort } from '@open-marketing/campaigns';
import { modelProtocols, modelRoute, providerRequest, captureUsage, emptyUsage } from '../model-protocols.js';
import { selectedModel } from '../model-providers.js';
import { appendUsage } from '../model-usage.js';

/** Addons/composition owns sealed storage and the selected model. Keys never enter OM DTOs. */
export interface ModelCredentials {
    resolveProviderKey(required: { grant: RunGrantMetadata; signal: AbortSignal }): Promise<Outcome<{ apiKey: string; settings: AssistantSettings; declaration: ModelProvider }>>;
}
type ResolvedModel = Extract<Awaited<ReturnType<ModelCredentials['resolveProviderKey']>>, { ok: true }>['value'];
type ModelSelection = ResolvedModel & { wire: Extract<ReturnType<typeof providerRequest>, { ok: true }>['value'] };

/** Composition supplies transport and a cancellable deadline. No retries or caller-selected URL.
 * A fixture implements the same contract without vendor access.
 */
export interface ModelUpstream {
    send(required: { url: string; headers: Readonly<Record<string, string>>; body: string; signal: AbortSignal; redirect: 'error' }): Promise<Response>;
    deadline(required: { timeoutMs: number }): { signal: AbortSignal; dispose(): void };
}

interface BrokerInput {
    request: HttpRequest; grants: RunGrantVerifierPort; credentials: ModelCredentials;
    upstream: ModelUpstream; clock: ClockPort; observer: ObserverPort; usage?: { db: CampaignSqlPort; ids: IdPort };
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

/** Authenticate native protocol headers as an OM bearer. Service/owner tokens must fail
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
 * @complexity O(b) time/space, b <=8 MiB; malformed/cyclic inputs return typed failures.
 */
async function modelBody(required: { request: HttpRequest; protocol: keyof typeof modelProtocols }): Promise<Outcome<Record<string, unknown>>> {
    const body = required.request.readBody ? await required.request.readBody({}) : { ok: true as const, value: required.request.body };
    if (!body.ok) return body;
    try {
        if (Buffer.byteLength(JSON.stringify(body.value), 'utf8') > 8388608) {
            return { ok: false, error: { code: 'limit_exceeded', message: 'Model request exceeds 8 MiB', retryable: false } };
        }
        const schema: z.ZodType<Record<string, unknown>> = modelProtocols[required.protocol].requestSchema;
        return parseBoundary({ schema, input: body.value });
    } catch { return { ok: false, error: { code: 'invalid_input', message: 'Invalid model request', retryable: false } }; }
}

/** Trace only validated identifiers; never upstream error text, prompts, headers or credentials. */
function observe(required: { input: BrokerInput; grant: RunGrantMetadata; outcome: string }): void {
    try {
        required.input.observer.observe({ operation: 'server.model.request', outcome: required.outcome, runId: required.grant.runId,
            ...traceIdentifiers(required) });
    } catch { /* Telemetry cannot authorize or repeat a billed request. */ }
}

/** Translate native authentication headers to the same run token; never accept a vendor key. */
function brokerToken(required: { request: HttpRequest; protocol: keyof typeof modelProtocols }): string | undefined {
    const header = modelProtocols[required.protocol].tokenHeader;
    const token = required.request.headers?.[header];
    return header === 'authorization' ? token?.replace(/^Bearer /, '') : token;
}
function selectionStatus(required: { code: AppError['code'] }): number { return required.code === 'invalid_input' ? 400 : 503; }

/** Single authenticated model request, without automatic retry. Exact route and grant precede
 * body/key access; authority is rechecked after key resolution and intent persistence,
 * immediately before egress.
 * @example await handleModelRequest({ request, grants, credentials, upstream, clock, observer });
 * @returns Bounded SSE bytes or an opaque typed error; composition must mount this route explicitly.
 * @complexity O(b) request parsing and O(s) streaming, <=256 KiB request and <=2 MiB response.
 */
export async function handleModelRequest(required: BrokerInput): Promise<HttpResponse> {
    const route = modelRoute({ path: required.request.path });
    if (!route || required.request.method !== 'POST') return rejected({ status: 403, code: 'forbidden' });
    const token = brokerToken({ request: required.request, protocol: route.protocol });
    if (!token || !/^[^\s]{32,8192}$/.test(token)) return rejected({ status: 401, code: 'forbidden' });
    const authorization = 'Bearer ' + token;
    try {
        const grant = await verifyModelGrant({ input: required, authorization });
        if (!grant.ok) return { status: 403, body: grant };
        const body = await modelBody({ request: required.request, protocol: route.protocol });
        if (!body.ok) return { status: body.error.code === 'limit_exceeded' ? 413 : 400, body };
        return await openModelStream({ input: required, grant: grant.value, authorization, token, route, body: body.value });
    } catch { return rejected({ status: 503, code: 'unavailable' }); }
}

/** Resolve only the accepted provider/model; all authentication stays inside the broker. */
async function modelSelection(required: { input: BrokerInput; grant: RunGrantMetadata; signal: AbortSignal; route: NonNullable<ReturnType<typeof modelRoute>>; body: Record<string, unknown> }): Promise<Outcome<ModelSelection>> {
    const credentials = await required.input.credentials.resolveProviderKey(required);
    if (!credentials.ok) return credentials;
    const { apiKey, settings, declaration } = credentials.value;
    const wireModel = required.route.wireModel ?? required.body.model;
    if (!/^[^\s]{1,8192}$/.test(apiKey) || settings.provider !== required.route.providerId || declaration.protocol !== required.route.protocol || settings.model !== wireModel) {
        return { ok: false, error: { code: 'invalid_input', message: 'Model selection differs from accepted run', retryable: false } };
    }
    const selection = selectedModel({ settings, providers: [{ id: required.route.providerId, declaration }] });
    if (!selection.ok) return selection;
    const wire = providerRequest({ settings, declaration, body: required.body, apiKey });
    return wire.ok ? { ok: true, value: { ...credentials.value, wire: wire.value } } : wire;
}

/** Own the upstream reader/deadline until the listener cancels or finishes. All caller auth,
 * cookies, routing and beta headers are discarded; only fixed provider headers are constructed.
 * @complexity O(b) serialization, one upstream request and one active reader.
 */
async function openModelStream(required: { input: BrokerInput; grant: RunGrantMetadata; authorization: string; token: string; route: NonNullable<ReturnType<typeof modelRoute>>; body: Record<string, unknown> }): Promise<HttpResponse> {
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
        const selection = await modelSelection({ ...required, signal });
        if (!selection.ok) { await cancel(); return { status: selectionStatus({ code: selection.error.code }), body: selection }; }
        const { settings, apiKey, declaration, wire } = selection.value;
        const provider = settings.provider!;
        const pricing = declaration.models.find(model => model.id === settings.model)?.pricing;
        const trace = traceIdentifiers({ input, grant });
        const requestId = input.usage?.ids.next({});
        if (input.usage) await appendUsage({ db: input.usage.db, grant, requestId: requestId!, kind: 'intent', provider, model: settings.model, pricing, now: input.clock.now({}) });
        const current = await verifyModelGrant({ input, authorization: required.authorization });
        if (!current.ok || current.value.grantId !== grant.grantId || signal.aborted) {
            await cancel(); return rejected({ status: 403, code: 'forbidden' });
        }
        const response = await input.upstream.send({ ...wire,
            headers: { 'content-type': 'application/json', ...wire.headers, 'x-correlation-id': trace.correlationId, 'x-trace-id': trace.traceId, 'x-om-run-id': grant.runId },
            signal, redirect: 'error' });
        reader = response.body?.getReader();
        if (signal.aborted) { await reader?.cancel(); throw new Error('Model stream interrupted'); }
        if (!response.ok || !reader || response.headers.get('content-type')?.split(';')[0].trim() !== 'text/event-stream') {
            observe({ input, grant, outcome: 'upstream_rejected' });
            await cancel(); return rejected({ status: 502, code: 'unavailable' });
        }
        observe({ input, grant, outcome: 'streaming' });
        return { status: 200, body: null, contentType: 'text/event-stream; charset=utf-8',
            stream: { chunks: cleanStream({ reader, signal, input, grant, authorization: required.authorization, provider, protocol: declaration.protocol, pricing, model: settings.model, requestId, secrets: [apiKey, required.token] }), cancel } };
    } catch {
        observe({ input, grant, outcome: 'interrupted' });
        await cancel(); return rejected({ status: 503, code: 'unavailable' });
    }
}

/** Redact complete SSE lines so secret fragments split across chunks cannot leak.
 * Invalid UTF-8, an oversized line/stream, interruption or revoked authority aborts the socket.
 * @complexity O(s) time, <=64 KiB pending line and <=2 MiB total incoming data. No replay.
 */
async function* cleanStream(required: { reader: ReadableStreamDefaultReader<Uint8Array>; signal: AbortSignal; input: BrokerInput; grant: RunGrantMetadata; authorization: string; provider: string; protocol: ModelProtocol; pricing?: ModelProvider['models'][number]['pricing']; model: string; requestId?: string; secrets: readonly string[] }): AsyncIterable<Uint8Array> {
    const usage = emptyUsage();
    const encoder = new TextEncoder();
    const pending: Uint8Array[] = [];
    try {
        for await (const frame of decodeSseFrames({ source: boundedSource(required) }, { maxBufferChars: 65536 })) {
            captureUsage({ protocol: required.protocol, data: frame.data, usage });
            const text = [...(frame.event === null ? [] : ['event: ' + frame.event]), ...frame.dataLines.map(line => 'data: ' + line)].join('\n') + '\n\n';
            const bytes = encoder.encode(redact({ text, secrets: required.secrets }));
            if (usage.stopped) pending.push(bytes);
            else yield bytes;
        }
        if (!usage.stopped) throw new Error('Model stream ended before completion');
        if (required.input.usage) await appendUsage({ db: required.input.usage.db, grant: required.grant, requestId: required.requestId!, kind: 'completion', provider: required.provider, model: required.model, pricing: required.pricing, usage, now: required.input.clock.now({}) });
        // Persist before releasing the final frame: native consumers can stop reading at the terminal marker.
        for (const bytes of pending) yield bytes;
        observe({ ...required, outcome: 'completed' });
    } catch {
        observe({ ...required, outcome: 'interrupted' });
        throw new Error('Model stream interrupted');
    }
}
/** Validate UTF-8 and current authority before each bounded source chunk. O(s), <=2 MiB. */
async function* boundedSource(required: { reader: ReadableStreamDefaultReader<Uint8Array>; signal: AbortSignal; input: BrokerInput; grant: RunGrantMetadata; authorization: string }): AsyncIterable<string> {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let bytes = 0;
    while (true) {
        required.signal.throwIfAborted();
        const chunk = await required.reader.read();
        required.signal.throwIfAborted();
        const current = await verifyModelGrant({ input: required.input, authorization: required.authorization });
        if (!current.ok || current.value.grantId !== required.grant.grantId) throw new Error('Model stream authority lost');
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 2097152) throw new Error('Model stream limit reached');
        const text = decoder.decode(chunk.value, { stream: true });
        for (let offset = 0; offset < text.length; offset += 8192) yield text.slice(offset, offset + 8192);
    }
    yield decoder.decode();
}

function redact(required: { text: string; secrets: readonly string[] }): string {
    let text = required.text;
    for (const secret of required.secrets) text = text.split(secret).join('[redacted]');
    return text;
}

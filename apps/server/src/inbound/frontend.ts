/** Owner-authenticated browser relay. It executes no DOM or business operation itself. */
import { z } from 'zod';
import { PAGE_CAPABILITIES } from '@jini-ai/agentic';
import { a2uiSurfacePayloadSchema, boundedJsonSchema, idSchema, parseBoundary, surfaceAcknowledgementSchema } from '@open-marketing/contracts';
import type { AssistantRunRequest, CallContext, ClockPort, IdPort, Outcome } from '@open-marketing/contracts';
import type { HttpRequest, HttpResponse } from '../ports.js';
import type { UiFrontendPort } from '../ui-tools.js';
import { localFailure } from '../composition/local-auth.js';

type Schedule = (required: { delayMs: number; callback(): void }) => () => void;
type Session = { id: string; token: string; context: CallContext; capabilities: ReadonlySet<string>; frames: { bytes: Uint8Array; runId?: string }[]; wake?: () => void; closed: boolean; close(): void };
type Binding = { session: Session; context: CallContext; expiresAt: number; completed: boolean };
type Pending = { binding: Binding; surfaceId?: string; finish(result: Outcome<unknown>): void };
const responseSchema = z.discriminatedUnion('ok', [
    z.strictObject({ invocationId: idSchema, ok: z.literal(true), output: boundedJsonSchema }),
    z.strictObject({ invocationId: idSchema, ok: z.literal(false), message: z.string().min(1).max(4096) }),
]);
/** One instance per server boot; session tokens never enter URLs, run events/history or telemetry. */
export interface FrontendSessions {
    readonly frontend: UiFrontendPort;
    handle(required: { request: HttpRequest; context: CallContext }): Promise<HttpResponse>;
    bindRun(required: { context: CallContext; runId: string; expiresAt: number } & Pick<AssistantRunRequest, 'frontendSessionId' | 'frontendBindToken'>): Outcome<void>;
    actionContext(required: { context: CallContext; runId: string; frontendSessionId: string }): Outcome<CallContext>;
    endRun(required: { context: CallContext; runId: string; status: 'completed' | 'cancelled' | 'interrupted' }): Promise<void>;
    dispose(required: Record<string, never>): Promise<void>;
}
function sameOwner(required: { left: CallContext; right: CallContext }): boolean {
    return required.left.scope.ownerId === required.right.scope.ownerId && required.left.scope.workspaceId === required.right.scope.workspaceId;
}
function response(required: { result: Outcome<unknown> }): HttpResponse {
    const status = required.result.ok ? 200 : { invalid_input: 400, unauthenticated: 401, forbidden: 403, expired: 409,
        conflict: 409, limit_exceeded: 413, unavailable: 503, not_implemented: 503, cancelled: 409, protocol_mismatch: 502 }[required.result.error.code];
    return { status, body: required.result };
}
function frame(required: { value: unknown }): Uint8Array {
    return new TextEncoder().encode('data: ' + JSON.stringify(required.value) + '\n\n');
}

/** Relay bounded plain JSON to exactly the attached owner session. Pending calls settle on
 * response, deadline, run revocation, disconnect or disposal; there are no retries.
 * @complexity <=32 sessions/bindings, <=64 pending calls, <=32 queued frames/session.
 * Page inputs/results and surface envelopes are capped at 64 KiB; frames add bounded identity.
 */
export function createFrontendSessions(required: {
    clock: ClockPort; ids: IdPort; schedule: Schedule; randomToken(required: Record<string, never>): string;
    authorize(required: { context: CallContext }): Outcome<void>;
    disconnected(required: { context: CallContext; runId: string }): Promise<void>;
}): FrontendSessions {
    const sessions = new Map<string, Session>();
    const bindings = new Map<string, Binding>();
    const pending = new Map<string, Pending>();
    let disposed = false;
    let disconnects = Promise.resolve();
    let disconnectFailure: { reason: unknown } | undefined;

    /** EventTarget/timer callbacks must stay synchronous. Local revocation is immediate;
     * queued durable cleanup is serialized, awaited by stream cancellation/endRun/dispose,
     * and its first failure is retained for the lifecycle caller instead of being dropped.
     */
    function disconnect(input: { context: CallContext; runId: string }): void {
        disconnects = disconnects.then(async () => { await required.disconnected(input); })
            .catch(reason => { disconnectFailure ??= { reason }; });
    }
    async function settleDisconnects(): Promise<void> {
        await disconnects;
        if (disconnectFailure) throw disconnectFailure.reason;
    }

    function voidPending(input: { binding: Binding }): void {
        input.binding.session.frames = input.binding.session.frames.filter(frame => frame.runId !== input.binding.context.runId);
        for (const entry of pending.values()) if (entry.binding === input.binding)
            entry.finish(localFailure({ code: 'cancelled', message: 'Frontend invocation voided; browser effects remain unconfirmed' }));
    }
    function removeBinding(input: { runId: string; binding: Binding; status?: 'cancelled' | 'interrupted' }): void {
        bindings.delete(input.runId);
        voidPending(input);
        disconnect({ context: input.binding.context, runId: input.runId });
        if (!input.binding.session.closed) enqueue({ session: input.binding.session, value: { type: 'voided', runId: input.runId,
            frontendSessionId: input.binding.session.id, status: input.status ?? 'interrupted' } });
    }
    function enqueue(input: { session: Session; value: unknown; runId?: string }): Outcome<void> {
        if (input.session.closed) return localFailure({ message: 'Frontend is disconnected' });
        if (input.session.frames.length >= 32) { input.session.close(); return localFailure({ code: 'limit_exceeded', message: 'Frontend buffer full' }); }
        input.session.frames.push({ bytes: frame(input), runId: input.runId }); input.session.wake?.();
        return { ok: true, value: undefined };
    }
    function liveBinding(input: { context: CallContext }): Outcome<Binding> {
        const binding = bindings.get(input.context.runId ?? '');
        if (!binding || binding.session.closed || !sameOwner({ left: binding.context, right: input.context }))
            return localFailure({ code: 'forbidden', message: 'No frontend is bound to this run' });
        if (binding.expiresAt <= required.clock.now({})) { removeBinding({ runId: input.context.runId!, binding }); return localFailure({ code: 'expired', message: 'Frontend run expired' }); }
        return { ok: true, value: binding };
    }
    function invocation(input: { context: CallContext; surfaceId?: string; signal?: AbortSignal; value: (required: { invocationId: string; binding: Binding }) => Outcome<unknown> }): Promise<Outcome<unknown>> {
        const authorized = required.authorize(input);
        if (!authorized.ok) return Promise.resolve(authorized);
        const found = liveBinding(input);
        if (!found.ok) return Promise.resolve(found);
        if (disposed || input.signal?.aborted) return Promise.resolve(localFailure({ code: 'cancelled', message: 'Frontend request cancelled' }));
        if (pending.size >= 64) return Promise.resolve(localFailure({ code: 'limit_exceeded', message: 'Too many frontend invocations' }));
        const invocationId = required.ids.next({});
        const value = input.value({ invocationId, binding: found.value });
        if (!value.ok) return Promise.resolve(value);
        return waitForResponse({ ...input, binding: found.value, invocationId, value: value.value });
    }
    function waitForResponse(input: { binding: Binding; invocationId: string; value: unknown; surfaceId?: string; signal?: AbortSignal }): Promise<Outcome<unknown>> {
        return new Promise(resolve => {
            function finish(result: Outcome<unknown>): void {
                if (!pending.delete(input.invocationId)) return;
                cancelDeadline(); input.signal?.removeEventListener('abort', aborted); resolve(result);
            }
            function aborted(): void { finish(localFailure({ code: 'cancelled', message: 'Frontend request cancelled; browser outcome unconfirmed' })); }
            const cancelDeadline = required.schedule({ delayMs: Math.max(0, Math.min(15000, input.binding.expiresAt - required.clock.now({}))),
                callback: () => finish(localFailure({ code: 'expired', message: 'Browser acknowledgement timed out; outcome unconfirmed' })) });
            pending.set(input.invocationId, { binding: input.binding, surfaceId: input.surfaceId, finish });
            input.signal?.addEventListener('abort', aborted, { once: true });
            if (input.signal?.aborted) { aborted(); return; }
            const sent = enqueue({ session: input.binding.session, value: input.value, runId: input.binding.context.runId });
            if (!sent.ok) finish(sent);
        });
    }
    function ownedPending(input: { context: CallContext; sessionId: string; invocationId: string }): Outcome<Pending> {
        const entry = pending.get(input.invocationId);
        if (!entry || entry.binding.session.id !== input.sessionId || !sameOwner({ left: entry.binding.context, right: input.context }))
            return localFailure({ code: 'forbidden', message: 'Invocation unavailable in this session' });
        const live = liveBinding({ context: entry.binding.context });
        if (!live.ok) return live;
        const authority = required.authorize({ context: entry.binding.context });
        return authority.ok ? { ok: true, value: entry } : authority;
    }
    async function answer(input: { request: HttpRequest; context: CallContext; sessionId: string }): Promise<HttpResponse> {
        const body = input.request.readBody ? await input.request.readBody({}) : { ok: true as const, value: input.request.body };
        const parsed = body.ok ? parseBoundary({ schema: responseSchema, input: body.value }) : body;
        if (!parsed.ok) return response({ result: parsed });
        const entry = ownedPending({ ...input, invocationId: parsed.value.invocationId });
        if (!entry.ok) return response({ result: entry });
        if (entry.value.surfaceId) return response({ result: localFailure({ code: 'invalid_input', message: 'Use the surface acknowledgement route' }) });
        entry.value.finish(parsed.value.ok ? { ok: true, value: parsed.value.output }
            : localFailure({ code: 'invalid_input', message: 'Browser refused the page action: ' + parsed.value.message }));
        return response({ result: { ok: true, value: { status: 'recorded' } } });
    }
    function attach(input: { request: HttpRequest; context: CallContext }): HttpResponse {
        const query = z.strictObject({ capabilities: z.string().max(2048) }).safeParse(input.request.query);
        if (!query.success) return response({ result: localFailure({ code: 'invalid_input', message: 'Invalid frontend capabilities' }) });
        const capabilities = query.data.capabilities.split(',');
        if (capabilities.some(id => !PAGE_CAPABILITIES.some(capability => capability.id === id)))
            return response({ result: localFailure({ code: 'invalid_input', message: 'Unknown page capability' }) });
        if (disposed || sessions.size >= 32) return response({ result: localFailure({ code: 'limit_exceeded', message: 'Frontend session limit reached' }) });
        const session: Session = { id: required.ids.next({}), token: required.randomToken({}), context: input.context,
            capabilities: new Set(capabilities), frames: [], closed: false, close() {
                if (session.closed) return;
                session.closed = true; sessions.delete(session.id);
                for (const [runId, binding] of bindings) if (binding.session === session) removeBinding({ runId, binding });
                session.frames.length = 0; session.wake?.(); cleanup();
            } };
        const cleanup = streamLifetime({ session, signal: input.request.signal, schedule: required.schedule });
        sessions.set(session.id, session);
        enqueue({ session, value: { type: 'attached', sessionId: session.id, bindToken: session.token } });
        if (input.request.signal?.aborted) session.close();
        return { status: 200, body: undefined, contentType: 'text/event-stream; charset=utf-8',
            headers: { 'x-accel-buffering': 'no' }, stream: { chunks: sessionFrames({ session, settleDisconnects }), async cancel() { session.close(); await settleDisconnects(); } } };
    }
    const frontend: UiFrontendPort = {
        page(input) { return invocation({ ...input, value: ({ invocationId, binding }) => {
            if (!binding.session.capabilities.has(input.name)) return localFailure({ code: 'unavailable', message: 'Frontend does not serve this page capability' });
            const parsed = boundedJsonSchema.safeParse(input.input);
            return parsed.success ? { ok: true, value: { type: 'invocation', invocationId, capabilityId: input.name,
                input: parsed.data, runId: binding.context.runId, frontendSessionId: binding.session.id } }
                : localFailure({ code: 'invalid_input', message: 'Invalid page input' });
        } }); },
        async render(input) {
            const result = await invocation({ ...input, value: ({ invocationId, binding }) => parseBoundary({ schema: a2uiSurfacePayloadSchema,
                input: { type: 'a2ui', version: 'v1.0', surfaceId: input.surfaceId, invocationId, runId: binding.context.runId,
                    frontendSessionId: binding.session.id, messages: input.messages } }) });
            return result.ok ? parseBoundary({ schema: surfaceAcknowledgementSchema, input: result.value }) : result;
        },
        async acknowledge(input) {
            const parsed = parseBoundary({ schema: surfaceAcknowledgementSchema, input: input.result });
            if (!parsed.ok) return parsed;
            const result = parsed.value;
            const entry = ownedPending({ context: input.context, sessionId: result.frontendSessionId, invocationId: result.invocationId });
            if (!entry.ok) return entry;
            if (entry.value.surfaceId !== result.surfaceId || entry.value.binding.context.runId !== result.runId)
                return localFailure({ code: 'forbidden', message: 'Surface acknowledgement identity mismatch' });
            if (result.status !== 'sent') entry.value.finish({ ok: true, value: result });
            return { ok: true, value: undefined };
        },
    };
    return { frontend,
        async handle(input) {
            if (input.context.principal.kind !== 'owner') return { status: 403, body: localFailure({ code: 'forbidden', message: 'Owner frontend authentication required' }) };
            if (input.request.path === '/api/frontend-sessions/stream' && input.request.method === 'GET') return attach(input);
            const match = /^\/api\/frontend-sessions\/([^/]+)\/responses$/.exec(input.request.path);
            if (!match || input.request.method !== 'POST') return { status: 404, body: localFailure({ code: 'invalid_input', message: 'Frontend route unavailable' }) };
            const session = idSchema.safeParse(match[1]);
            return session.success ? answer({ ...input, sessionId: session.data }) : response({ result: localFailure({ code: 'invalid_input', message: 'Invalid frontend session' }) });
        },
        bindRun(input) {
            if (!input.frontendSessionId && !input.frontendBindToken) return { ok: true, value: undefined };
            const session = sessions.get(input.frontendSessionId ?? '');
            if (!session || session.closed || session.token !== input.frontendBindToken || !sameOwner({ left: session.context, right: input.context }))
                return localFailure({ code: 'forbidden', message: 'Frontend attachment is stale or belongs to another owner/session' });
            for (const [runId, binding] of bindings) if (binding.completed || binding.expiresAt <= required.clock.now({})) removeBinding({ runId, binding });
            if (bindings.size >= 32) return localFailure({ code: 'limit_exceeded', message: 'Frontend run binding limit reached' });
            bindings.set(input.runId, { session, context: { ...input.context, runId: input.runId }, expiresAt: input.expiresAt, completed: false });
            const sent = enqueue({ session, runId: input.runId, value: { type: 'bound', runId: input.runId, frontendSessionId: session.id, expiresAt: input.expiresAt } });
            if (!sent.ok) return sent;
            return { ok: true, value: undefined };
        },
        actionContext(input) {
            const binding = liveBinding({ context: { ...input.context, runId: input.runId } });
            if (!binding.ok) return binding;
            if (input.context.principal.kind !== 'owner' || binding.value.session.id !== input.frontendSessionId)
                return localFailure({ code: 'forbidden', message: 'Surface action belongs to another frontend' });
            return { ok: true, value: { ...input.context, runId: input.runId } };
        },
        async endRun(input) {
            const binding = bindings.get(input.runId);
            if (!binding || !sameOwner({ left: binding.context, right: input.context })) { await settleDisconnects(); return; }
            if (input.status === 'completed') { binding.completed = true; voidPending({ binding }); await settleDisconnects(); return; }
            removeBinding({ ...input, binding, status: input.status === 'cancelled' ? 'cancelled' : 'interrupted' });
            await settleDisconnects();
        },
        async dispose() { disposed = true; for (const session of sessions.values()) session.close(); await settleDisconnects(); },
    };
}

/** One pending pull per stream. Disconnect/deadline wakes the iterator and clears all timers. */
async function* sessionFrames(required: { session: Session; settleDisconnects(): Promise<void> }): AsyncIterable<Uint8Array> {
    const session = required.session;
    try {
        while (!session.closed) {
            const next = session.frames.shift();
            if (next) yield next.bytes;
            else await new Promise<void>(resolve => { session.wake = resolve; if (session.closed || session.frames.length) resolve(); });
            session.wake = undefined;
        }
    } finally { session.close(); await required.settleDisconnects(); }
}
/** Keep EventSource alive for five minutes; reattachment gets a new token and voids old runs. */
function streamLifetime(required: { session: Session; signal?: AbortSignal; schedule: Schedule }): () => void {
    const close = () => required.session.close();
    const heartbeat = () => {
        if (required.session.closed) return;
        if (required.session.frames.length < 32) { required.session.frames.push({ bytes: new TextEncoder().encode(': keepalive\n\n') }); required.session.wake?.(); }
        cancelHeartbeat = required.schedule({ delayMs: 10000, callback: heartbeat });
    };
    let cancelHeartbeat = required.schedule({ delayMs: 10000, callback: heartbeat });
    const cancelLifetime = required.schedule({ delayMs: 300000, callback: close });
    required.signal?.addEventListener('abort', close, { once: true });
    return () => { cancelHeartbeat(); cancelLifetime(); required.signal?.removeEventListener('abort', close); };
}

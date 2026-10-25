/** Deterministic local fixture runtime. No model, tool, database or vendor execution. */
import type { ClockPort, IdPort, Outcome, RunEvent, StartRunRequest } from '@open-marketing/contracts';
import { parseBoundary, startRunSchema } from '@open-marketing/contracts';
import type { JiniRuntimePort } from '../ports.js';

/** Only two grant-scoped OM callbacks; tests replace these with a controllable in-memory double. */
export interface SandboxContextClient {
    load(required: { run: StartRunRequest; signal: AbortSignal }): Promise<Outcome<{ mode: 'local-sandbox' }>>;
    publish(required: { run: StartRunRequest; event: RunEvent; signal: AbortSignal }): Promise<Outcome<void>>;
}
interface SandboxRun {
    request: StartRunRequest; events: RunEvent[]; controller: AbortController;
    terminal: boolean; settled: boolean; work?: Promise<void>;
}

function failure<T>(required: { code: 'forbidden' | 'conflict' | 'expired' | 'limit_exceeded' | 'unavailable'; message: string }): Outcome<T> {
    return { ok: false, error: { ...required, retryable: false } };
}

/** Cross-field grant binding is checked in addition to the shared wire schema. */
function admitted(required: { run: StartRunRequest; clock: ClockPort }): boolean {
    const { run } = required;
    return !run.grant.revoked && run.grant.expiresAt > required.clock.now({})
        && run.runId === run.grant.runId && run.agentInstanceId === run.grant.agentInstanceId
        && run.conversationId === run.grant.conversationId && run.context.runId === run.runId
        && run.context.scope.ownerId === run.grant.scope.ownerId
        && run.context.scope.workspaceId === run.grant.scope.workspaceId
        && run.context.principal.kind === 'agent' && run.context.principal.agentInstanceId === run.agentInstanceId
        && run.context.principal.runId === run.runId
        && run.grant.capabilities.join(',') === 'context,events';
}

/** Append locally before publishing, so a lost acknowledgement can be recovered by control polling.
 * Events contain fixed fixture text/IDs only; prompt text never enters an event or log.
 */
async function emit(required: { state: SandboxRun; kind: RunEvent['kind']; payload: RunEvent['payload']; ids: IdPort; client: SandboxContextClient }): Promise<Outcome<void>> {
    const { state } = required;
    if (state.events.length >= 128) return failure({ code: 'limit_exceeded', message: 'Sandbox event limit reached' });
    const event: RunEvent = { protocolVersion: 1, eventId: required.ids.next({}), runId: state.request.runId,
        correlationId: state.request.context.correlationId, traceId: state.request.context.traceId,
        sequence: state.events.length + 1, kind: required.kind, payload: required.payload };
    state.events.push(event);
    return required.client.publish({ run: state.request, event, signal: state.controller.signal });
}

/** Two bounded callback stages; cancellation/expiry suppresses all later success events. */
async function performRun(required: { state: SandboxRun; clock: ClockPort; ids: IdPort; client: SandboxContextClient }): Promise<void> {
    const { state } = required;
    const started = await emit({ ...required, kind: 'started', payload: {} });
    if (!started.ok) throw new Error('Callback unavailable');
    const context = await required.client.load({ run: state.request, signal: state.controller.signal });
    if (state.terminal) return;
    if (!context.ok || !admitted({ run: state.request, clock: required.clock })) throw new Error('Context unavailable');
    const message = await emit({ ...required, kind: 'delta', payload: { text: 'Sandbox response: OM agent subprocess is connected. No model or business action was executed.' } });
    if (state.terminal) return;
    if (!message.ok || !admitted({ run: state.request, clock: required.clock })) throw new Error('Callback unavailable');
    const ended = await emit({ ...required, kind: 'ended', payload: {} });
    if (!ended.ok) throw new Error('Callback unavailable');
}

/** A callback failure leaves one local error, recoverable through control polling; no retry. */
async function execute(required: { state: SandboxRun; clock: ClockPort; ids: IdPort; client: SandboxContextClient }): Promise<void> {
    const { state } = required;
    try { await performRun(required);
    } catch {
        await recordFailure(required);
    } finally { state.terminal = true; state.settled = true; }
}

/** Retain an error for polling even when its callback publication fails. */
async function recordFailure(required: { state: SandboxRun; ids: IdPort; client: SandboxContextClient }): Promise<void> {
    if (required.state.terminal) return;
    try { await emit({ ...required, kind: 'error', payload: { code: 'unavailable' } }); }
    catch { /* The retained error remains observable through authenticated control polling. */ }
}

/** Inert, instance-owned fixture runtime with 32 retained runs and <=128 events/run.
 * At capacity only the oldest terminal run with completed cleanup is evicted. Cancellation aborts I/O.
 * Elapsed effective deadlines are rejected before history eviction or callbacks.
 * @example const runtime = createSandboxRuntime({ clock, ids, contextClient });
 * @complexity O(32*128) maximum retained space; subscriptions scan one capped event list.
 */
export function createSandboxRuntime(required: { clock: ClockPort; ids: IdPort; contextClient: SandboxContextClient }): JiniRuntimePort & { dispose(required: Record<string, never>): Promise<void> } {
    const runs = new Map<string, SandboxRun>();
    let disposed = false;
    return {
        async startRun(run) {
            const parsed = parseBoundary({ schema: startRunSchema, input: run });
            if (!parsed.ok) return parsed;
            if (disposed || !admitted({ run, clock: required.clock })) return failure({ code: 'forbidden', message: 'Sandbox run grant unavailable' });
            if (runs.has(run.runId)) return failure({ code: 'conflict', message: 'Run already exists' });
            const deadlineAt = Math.min(run.deadlineAt ?? run.grant.expiresAt, run.grant.expiresAt);
            if (deadlineAt <= required.clock.now({})) return failure({ code: 'expired', message: 'Sandbox run deadline elapsed' });
            if (runs.size >= 32) {
                const oldest = [...runs].find(([, state]) => state.terminal && state.settled);
                if (!oldest) return failure({ code: 'limit_exceeded', message: 'Sandbox retains at most 32 active or unsettled runs' });
                runs.delete(oldest[0]);
            }
            const state: SandboxRun = { request: structuredClone({ ...run, prompt: '[sandbox prompt omitted]' }), events: [], controller: new AbortController(), terminal: false, settled: false };
            runs.set(run.runId, state);
            state.work = execute({ state, clock: required.clock, ids: required.ids, client: required.contextClient });
            return { ok: true, value: { runId: run.runId, status: 'pending' } };
        },
        async cancelRun(input) {
            const state = runs.get(input.runId);
            if (!state) return failure({ code: 'forbidden', message: 'Run unavailable' });
            if (state.terminal) return failure({ code: 'conflict', message: 'Run already terminal' });
            state.terminal = true;
            state.controller.abort();
            state.events.push({ protocolVersion: 1, eventId: required.ids.next({}), runId: input.runId,
                correlationId: state.request.context.correlationId, traceId: state.request.context.traceId,
                sequence: state.events.length + 1, kind: 'cancelled', payload: {} });
            return { ok: true, value: { runId: input.runId, status: 'cancelled' } };
        },
        async events(input) {
            const state = runs.get(input.runId);
            if (!state) return failure({ code: 'forbidden', message: 'Run unavailable' });
            return { ok: true, value: structuredClone(state.events.filter(event => event.sequence > input.after).slice(0, input.limit)) };
        },
        async dispose() {
            disposed = true;
            for (const state of runs.values()) { state.terminal = true; state.controller.abort(); }
            await Promise.all([...runs.values()].map(state => state.work));
            runs.clear();
        },
    };
}

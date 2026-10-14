/** Jini's provider loop stays in the agent; every model/tool effect goes through OM. */
import { runProviderToolTurn } from '@jini-ai/agent-runtime/providers/tool-turn';
import type { ProviderTurnAdapters, ProviderTurnEvent, ProviderToolCall, ProviderToolResult } from '@jini-ai/agent-runtime/providers/tool-turn';
import { assistantContextSchema, parseBoundary, startRunSchema, toolCallSchema, toolDescriptorSchema, toolResultSchema } from '@open-marketing/contracts';
import type { AppError, AssistantContext, ClockPort, IdPort, Outcome, RunEvent, StartRunRequest, ToolCall, ToolDescriptor, ToolResult } from '@open-marketing/contracts';
import type { JiniRuntimePort } from '../ports.js';

/** Caller-owned OM transport. No provider key or direct vendor tool belongs here.
 * Injected adapters carry transport effects; the client supplies cancellable run deadlines.
 */
export interface ModelClient {
    readonly brokerBaseUrl: string;
    readonly system: string;
    readonly tools: readonly ToolDescriptor[];
    load(required: { run: StartRunRequest; signal: AbortSignal }): Promise<Outcome<AssistantContext>>;
    publish(required: { run: StartRunRequest; event: RunEvent; signal: AbortSignal }): Promise<Outcome<void>>;
    executeTool(required: { run: StartRunRequest; call: ToolCall; signal: AbortSignal }): Promise<Outcome<ToolResult>>;
    deadline(required: { timeoutMs: number }): { signal: AbortSignal; dispose(): void };
}

interface ModelRun {
    request: StartRunRequest; events: RunEvent[]; controller: AbortController; signal: AbortSignal;
    terminal: boolean; bytes: number; publications: Promise<void>; work?: Promise<void>; releaseDeadline(): void;
}
interface ModelDependencies { clock: ClockPort; ids: IdPort; client: ModelClient; adapters: ProviderTurnAdapters }

function failure<T>(required: { code: AppError['code'] }): Outcome<T> {
    return { ok: false, error: { code: required.code, message: 'Model run unavailable', retryable: false } };
}

/** Admission binds every identity to the server-issued grant, in addition to wire parsing. */
function boundIdentity(required: { run: StartRunRequest }): boolean {
    const { run } = required;
    return run.runId === run.grant.runId && run.context.runId === run.runId
        && run.agentInstanceId === run.grant.agentInstanceId && run.conversationId === run.grant.conversationId
        && run.context.scope.ownerId === run.grant.scope.ownerId && run.context.scope.workspaceId === run.grant.scope.workspaceId;
}

function admitted(required: { run: StartRunRequest; clock: ClockPort }): boolean {
    const { run } = required;
    return boundIdentity({ run }) && !run.grant.revoked && run.grant.expiresAt > required.clock.now({})
        && run.grant.capabilities.includes('model') && /^[^\s]{32,8192}$/.test(run.runBearer ?? '')
        && run.context.principal.kind === 'agent' && run.context.principal.agentInstanceId === run.agentInstanceId
        && run.context.principal.runId === run.runId;
}

/** The spike admits only the exact loopback OM broker. Injected adapters cannot receive a vendor URL. */
function brokerConfigured(required: { client: ModelClient }): boolean {
    try {
        const url = new URL(required.client.brokerBaseUrl);
        return url.protocol === 'http:' && url.hostname === '127.0.0.1' && !url.username && !url.password
            && url.pathname === '/api/agent/v1/model/anthropic' && !url.search && !url.hash;
    } catch { return false; }
}

function active(required: { state: ModelRun; deps: ModelDependencies }): boolean {
    return !required.state.terminal && !required.state.signal.aborted && admitted({ run: required.state.request, clock: required.deps.clock });
}

/** Append before publication for control polling. Reserve one terminal slot and 2 KiB;
 * callback publication is ordered and bounded by the same retained-event limits.
 * @complexity O(b) per event serialization; <=8,192 events and <=2 MiB retained data/run.
 */
function append(required: { state: ModelRun; deps: ModelDependencies; kind: RunEvent['kind']; payload: RunEvent['payload']; terminal?: boolean }): void {
    const { state, deps } = required;
    const event: RunEvent = { protocolVersion: 1, eventId: deps.ids.next({}), runId: state.request.runId,
        sequence: state.events.length + 1, correlationId: state.request.context.correlationId, traceId: state.request.context.traceId,
        kind: required.kind, payload: required.payload };
    const bytes = new TextEncoder().encode(JSON.stringify(event)).length;
    if (!required.terminal && (state.events.length >= 8191 || state.bytes + bytes > 2095104)) throw new Error('Model event limit reached');
    state.bytes += bytes; state.events.push(event);
    state.publications = state.publications.then(async () => {
        if (state.signal.aborted) return;
        const published = await deps.client.publish({ run: state.request, event, signal: state.signal });
        if (!published.ok) { state.controller.abort(); throw new Error('Model event publication unavailable'); }
    });
    // Observe rejection immediately; executeRun awaits the original chain and records an error.
    void state.publications.catch(() => undefined);
}

/** Provider callbacks are synchronous. Only text deltas are forwarded here; errors become fixed
 * terminal codes and tool records come from the validated OM execution seam below.
 */
function providerEvent(required: { event: ProviderTurnEvent; state: ModelRun; deps: ModelDependencies }): void {
    if (!active(required)) return;
    if (required.event.type === 'error') throw new Error('Model provider unavailable');
    if (required.event.type === 'text_delta') {
        const text = required.event.delta.split(required.state.request.runBearer!).join('[redacted]');
        append({ ...required, kind: 'delta', payload: { text } });
    }
}

/** Validate before invoking OM and after its result. Pending operations intentionally fail
 * until R3 supplies bounded approval continuation; they are never reported as completed.
 * @complexity O(b) validation with the shared 64 KiB/depth bounds; one OM tool request.
 */
async function executeTool(required: { call: ProviderToolCall; state: ModelRun; deps: ModelDependencies }): Promise<ProviderToolResult> {
    if (!active(required)) throw new Error('Model run cancelled');
    const call = parseBoundary({ schema: toolCallSchema, input: { name: required.call.name, input: required.call.input, operationId: required.deps.ids.next({}) } });
    if (!call.ok || !required.deps.client.tools.some(tool => tool.name === required.call.name)) throw new Error('Model tool unavailable');
    append({ ...required, kind: 'tool_requested', payload: { type: 'tool_requested', call: call.value } });
    const result = await required.deps.client.executeTool({ run: required.state.request, call: call.value, signal: required.state.signal });
    if (!active(required) || !result.ok) throw new Error('Model tool unavailable');
    const parsed = parseBoundary({ schema: toolResultSchema, input: result.value });
    if (!parsed.ok || parsed.value.status !== 'completed') throw new Error('Model tool result unavailable');
    append({ ...required, kind: 'tool_result', payload: { type: 'tool_result', operationId: call.value.operationId, result: parsed.value } });
    return { content: JSON.stringify(parsed.value.output) };
}

/** Reuse Jini's actual provider/tool loop with caller-injected adapters, never a local imitation.
 * Context, tools, callbacks and model all come from OM; max 24 tool turns/4,096 output tokens.
 * @complexity Owned retention is bounded; provider parsing and loop cost belongs to Jini.
 */
async function performTurn(required: { state: ModelRun; deps: ModelDependencies }): Promise<void> {
    const { state, deps } = required;
    append({ ...required, kind: 'started', payload: {} });
    await state.publications;
    const context = await deps.client.load({ run: state.request, signal: state.signal });
    if (!context.ok || !active(required)) throw new Error('Model context unavailable');
    const parsed = parseBoundary({ schema: assistantContextSchema, input: context.value });
    if (!parsed.ok || parsed.value.settings.mode !== 'model') throw new Error('Model context unavailable');
    const tools = toolDescriptorSchema.array().max(100).parse(deps.client.tools);
    const result = await runProviderToolTurn({ protocol: 'anthropic', adapters: deps.adapters, apiKey: state.request.runBearer!,
        model: parsed.value.settings.model, system: deps.client.system,
        messages: [...parsed.value.messages.slice(-39).map(message => ({ role: message.role, content: message.text })),
            { role: 'user', content: state.request.prompt }],
        tools: tools.map(tool => ({ id: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
        executeTool: call => executeTool({ call, ...required }), onEvent: event => providerEvent({ event, ...required }),
    }, { baseUrl: deps.client.brokerBaseUrl, maxTokens: 4096, maxToolTurns: 24, signal: state.signal });
    if (!active(required)) throw new Error('Model run interrupted');
    if (result.stopReason !== 'stop') throw new Error('Model turn interrupted');
    await state.publications;
    state.terminal = true;
    append({ ...required, kind: 'ended', payload: {}, terminal: true });
    await state.publications;
}

/** Opaque provider/transport exceptions never enter events. Cancellation wins over late success;
 * a publication outage retains local terminal evidence recoverable through control polling.
 */
async function executeRun(required: { state: ModelRun; deps: ModelDependencies }): Promise<void> {
    try { await performTurn(required); }
    catch {
        required.state.controller.abort();
        if (!required.state.terminal) append({ ...required, kind: 'error', payload: { code: 'unavailable' }, terminal: true });
        await required.state.publications.catch(() => undefined);
    } finally { required.state.terminal = true; required.state.releaseDeadline(); }
}

/** Inert, instance-owned model runtime, retaining at most 32 runs. No composition or service
 * startup occurs here; sandbox remains the composed default until R2.
 * @example const runtime = createModelRuntime({ clock, ids, client, adapters });
 * @returns Existing runtime port plus disposal; typed rejection for invalid or full admission.
 * @complexity <=32 bounded event lists; polling scans one run, disposal aborts all owned work.
 */
export function createModelRuntime(required: ModelDependencies): JiniRuntimePort & { dispose(required: Record<string, never>): Promise<void> } {
    const runs = new Map<string, ModelRun>();
    let disposed = false;
    return {
        async startRun(input) {
            const parsed = parseBoundary({ schema: startRunSchema, input });
            if (!parsed.ok) return parsed;
            if (disposed || !brokerConfigured({ client: required.client }) || !admitted({ run: parsed.value, clock: required.clock })) return failure({ code: 'forbidden' });
            if (runs.has(input.runId)) return failure({ code: 'conflict' });
            if (runs.size >= 32) return failure({ code: 'limit_exceeded' });
            const deadlineAt = Math.min(input.deadlineAt ?? input.grant.expiresAt, input.grant.expiresAt);
            if (deadlineAt <= required.clock.now({})) return failure({ code: 'expired' });
            const deadline = required.client.deadline({ timeoutMs: deadlineAt - required.clock.now({}) });
            const controller = new AbortController();
            const state: ModelRun = { request: structuredClone(parsed.value), events: [], controller, signal: AbortSignal.any([controller.signal, deadline.signal]),
                terminal: false, bytes: 0, publications: Promise.resolve(), releaseDeadline: deadline.dispose };
            runs.set(input.runId, state);
            state.work = executeRun({ state, deps: required });
            return { ok: true, value: { runId: input.runId, status: 'pending' } };
        },
        async cancelRun(input) {
            const state = runs.get(input.runId);
            if (!state) return failure({ code: 'forbidden' });
            if (state.terminal) return failure({ code: 'conflict' });
            state.terminal = true; state.controller.abort(); state.releaseDeadline();
            append({ state, deps: required, kind: 'cancelled', payload: {}, terminal: true });
            return { ok: true, value: { runId: input.runId, status: 'cancelled' } };
        },
        async events(input) {
            const state = runs.get(input.runId);
            if (!state) return failure({ code: 'forbidden' });
            return { ok: true, value: structuredClone(state.events.filter(event => event.sequence > input.after).slice(0, input.limit)) };
        },
        async dispose() {
            disposed = true;
            for (const state of runs.values()) { state.terminal = true; state.controller.abort(); state.releaseDeadline(); }
            await Promise.all([...runs.values()].map(state => state.work));
            runs.clear();
        },
    };
}

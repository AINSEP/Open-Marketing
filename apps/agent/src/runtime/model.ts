/** Jini's provider loop stays in the agent; every model/tool effect goes through OM. */
import { runProviderToolTurn } from '@jini-ai/agent-runtime/providers/tool-turn';
import type { ProviderTurnAdapters, ProviderTurnEvent, ProviderToolCall, ProviderToolResult } from '@jini-ai/agent-runtime/providers/tool-turn';
import { assistantContextSchema, confirmationCardSchema, operationPollSchema, parseBoundary, startRunSchema, toolCallSchema, toolDescriptorSchema, toolOperationSchema, toolResultSchema } from '@open-marketing/contracts';
import type { AppError, AssistantContext, ClockPort, ConfirmationCard, IdPort, Outcome, RunEvent, StartRunRequest, ToolCall, ToolDescriptor, ToolOperation, ToolResult } from '@open-marketing/contracts';
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
    loadTools?(required: { run: StartRunRequest; signal: AbortSignal }): Promise<Outcome<readonly ToolDescriptor[]>>;
    operation?(required: { run: StartRunRequest; operationId: string; signal: AbortSignal }): Promise<Outcome<ToolOperation>>;
    readCard?(required: { run: StartRunRequest; operationId: string; signal: AbortSignal }): Promise<Outcome<ConfirmationCard | null>>;
    wait?(required: { signal: AbortSignal; intervalMs: number }): Promise<void>;
    deadline(required: { timeoutMs: number }): { signal: AbortSignal; dispose(): void };
}

interface ModelRun {
    request: StartRunRequest; events: RunEvent[]; controller: AbortController; signal: AbortSignal;
    terminal: boolean; bytes: number; tools: readonly ToolDescriptor[]; publications: Promise<void>; work?: Promise<void>; releaseDeadline(): void;
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

/** Validate before invoking OM and after its result. Jini's callback stays open during approval.
 * @complexity O(b) validation with shared 64 KiB/depth bounds; bounded one-second polling.
 */
async function executeTool(required: { call: ProviderToolCall; state: ModelRun; deps: ModelDependencies }): Promise<ProviderToolResult> {
    if (!active(required)) throw new Error('Model run cancelled');
    const call = admittedToolCall(required);
    const target = targetCall({ call: call.value });
    if (!target.ok) return { content: JSON.stringify(target.error), isError: true };
    if (call.value.name === 'execute_tool') call.value.input = target.value;
    append({ ...required, kind: 'tool_requested', payload: { type: 'tool_requested', call: target.value } });
    const result = await required.deps.client.executeTool({ run: required.state.request, call: call.value, signal: required.state.signal });
    if (!active(required)) throw new Error('Model tool unavailable');
    if (!result.ok) return { content: JSON.stringify(result.error), isError: true };
    const parsed = parseBoundary({ schema: toolResultSchema, input: result.value });
    if (!parsed.ok) throw new Error('Model tool result unavailable');
    checkPendingIdentity({ result: parsed.value, operationId: target.value.operationId });
    const completed = parsed.value.status === 'pending'
        ? await awaitOperation({ ...required, pending: parsed.value }) : parsed.value;
    append({ ...required, kind: 'tool_result', payload: { type: 'tool_result', operationId: target.value.operationId, result: completed } });
    return { content: JSON.stringify(completed.output) };
}
function admittedToolCall(required: { call: ProviderToolCall; state: ModelRun; deps: ModelDependencies }): { ok: true; value: ToolCall } {
    const parsed = parseBoundary({ schema: toolCallSchema, input: { name: required.call.name, input: required.call.input, operationId: required.deps.ids.next({}) } });
    if (!parsed.ok || !required.state.tools.some(tool => tool.name === required.call.name)) throw new Error('Model tool unavailable');
    return parsed;
}
function checkPendingIdentity(required: { result: ToolResult; operationId: string }): void {
    if (required.result.status === 'pending' && required.result.operationId !== required.operationId) throw new Error('Pending tool identity differs');
}

/** Agent mints the target identity once per invocation; model input cannot borrow a prior approval. */
function targetCall(required: { call: ToolCall }): Outcome<ToolCall> {
    if (required.call.name !== 'execute_tool') return { ok: true, value: required.call };
    const parsed = parseBoundary({ schema: toolCallSchema, input: required.call.input });
    return parsed.ok ? { ok: true, value: { ...parsed.value, operationId: required.call.operationId } } : parsed;
}

/** Overall deadline is exactly the run deadline, capped by its grant. Cancellation wins late polls.
 * Pending cards are authoritative server values; an approved result is fed to the active Jini loop.
 * @complexity At most one poll/sec until the <=5 minute run deadline; constant polling storage.
 */
async function awaitOperation(required: { state: ModelRun; deps: ModelDependencies; pending: Extract<ToolResult, { status: 'pending' }> }): Promise<Extract<ToolResult, { status: 'completed' }>> {
    const { state, deps, pending } = required;
    const poll = operationPollSchema.parse({ operationId: pending.operationId, intervalMs: 1000,
        deadlineAt: Math.min(state.request.deadlineAt ?? state.request.grant.expiresAt, state.request.grant.expiresAt) });
    if (!deps.client.operation || !deps.client.wait) throw new Error('Approval continuation unavailable');
    append({ ...required, kind: 'tool_result', payload: { type: 'tool_result', operationId: poll.operationId, result: pending } });
    const card = await publishCard({ ...required, operationId: poll.operationId });
    while (pollActive({ ...required, deadlineAt: poll.deadlineAt })) {
        await deps.client.wait({ signal: state.signal, intervalMs: poll.intervalMs });
        if (!pollActive({ ...required, deadlineAt: poll.deadlineAt })) throw new Error('Approval wait expired');
        const operation = await readOperation({ ...required, operationId: poll.operationId });
        if (operation.status === 'pending') continue;
        resolveCard({ ...required, card, operation });
        if (operation.status !== 'completed') throw new Error('Approval operation interrupted');
        return { status: 'completed', output: operation.output };
    }
    throw new Error('Approval wait interrupted');
}
function pollActive(required: { state: ModelRun; deps: ModelDependencies; deadlineAt: number }): boolean {
    return active(required) && required.deps.clock.now({}) < required.deadlineAt;
}
/** One authoritative, identity-bound poll. The run signal also bounds its transport deadline. */
async function readOperation(required: { state: ModelRun; deps: ModelDependencies; operationId: string }): Promise<ToolOperation> {
    const result = await required.deps.client.operation!({ run: required.state.request, operationId: required.operationId, signal: required.state.signal });
    if (!active(required) || !result.ok) throw new Error('Approval operation unavailable');
    const parsed = parseBoundary({ schema: toolOperationSchema, input: result.value });
    if (!parsed.ok || parsed.value.operationId !== required.operationId) throw new Error('Approval operation identity differs');
    return parsed.value;
}
async function publishCard(required: { state: ModelRun; deps: ModelDependencies; operationId: string }): Promise<ConfirmationCard | null> {
    if (!required.deps.client.readCard) return null;
    const result = await required.deps.client.readCard({ run: required.state.request, operationId: required.operationId, signal: required.state.signal });
    if (!result.ok || !active(required)) throw new Error('Approval card unavailable');
    if (!result.value) return null; // Owner may have answered before this read.
    const parsed = parseBoundary({ schema: confirmationCardSchema, input: result.value });
    if (!parsed.ok || parsed.value.operationId !== required.operationId) throw new Error('Approval card identity differs');
    append({ ...required, kind: 'tool_requested', payload: { type: 'confirmation', card: parsed.value } });
    return parsed.value;
}
function resolveCard(required: { state: ModelRun; deps: ModelDependencies; card: ConfirmationCard | null; operation: ToolOperation }): void {
    if (!required.card) return;
    const status = required.operation.status === 'completed' ? 'completed' : required.operation.status === 'cancelled' ? 'cancelled' : 'interrupted';
    append({ ...required, kind: 'tool_result', payload: { type: 'confirmation_resolved', cardId: required.card.cardId,
        operationId: required.operation.operationId, status } });
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
    const discovery = deps.client.loadTools ? await deps.client.loadTools({ run: state.request, signal: state.signal }) : { ok: true as const, value: deps.client.tools };
    if (!discovery.ok || !active(required)) throw new Error('Model discovery unavailable');
    const tools = toolDescriptorSchema.array().max(100).parse(discovery.value);
    state.tools = tools;
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
                terminal: false, bytes: 0, tools: [], publications: Promise.resolve(), releaseDeadline: deadline.dispose };
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

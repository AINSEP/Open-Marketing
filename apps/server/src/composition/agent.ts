/** Independent agent process and scoped authority; optional Jini persistence owns durable observation. */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { CallContext, ClockPort, IdPort, ObserverPort, Outcome, RunEvent, RunGrantMetadata, StartRunRequest } from '@open-marketing/contracts';
import { createAgentControlClient } from '../agent-client/index.js';
import { failure, routes, type HttpRuntime } from '../cli/http.js';
import type { AssistantRuns } from '../runs.js';
import type { OwnerRunPort } from '../ports.js';
import { toolRequestedPayloadSchema, toolResultPayloadSchema, approvalPayloadSchema } from '@open-marketing/contracts';
import type { RunGrantVerifierPort, SandboxCallbacks } from '../inbound/om.js';
import type { FrontendSessions } from '../inbound/frontend.js';
import type { AssistantRunRequest } from '@open-marketing/contracts';

type RunPage = z.infer<typeof routes.runEvents.schema>;
type RunStatus = RunPage['status'];
interface LocalRun { context: CallContext; grant: RunGrantMetadata; status: RunStatus; events: RunEvent[]; mode: 'sandbox' | 'model'; bytes: number; writes: Promise<void> }
interface AgentChild { origin: string; pid: number; stop(required: Record<string, never>): Promise<Outcome<void>> }
/** Concrete process/fetch effects are replaceable by the shared in-memory integration harness. */
export interface AgentEffects {
    runtime: HttpRuntime;
    launch(required: { serverUrl: string; instanceId: string; controlToken: string; grantKey: string; exited: () => void }): Promise<Outcome<AgentChild>>;
}
/** Read at most 8 KiB of readiness output, check the child PID and a bare loopback origin.
 * Native stdout/exit callbacks resolve once. No stdout/stderr content enters owner DTOs or logs.
 */
function awaitReadiness(required: { child: ChildProcess; runtime: HttpRuntime }): Promise<Outcome<{ origin: string; pid: number }>> {
    return new Promise(resolve => {
        const deadline = required.runtime.deadline.create({ timeoutMs: 5000 });
        let output = '';
        function finish({ result }: { result: Outcome<{ origin: string; pid: number }> }) {
            deadline.dispose({}); deadline.signal.removeEventListener('abort', expired);
            required.child.stdout?.off('data', data); required.child.off('error', expired); required.child.off('exit', expired);
            resolve(result);
        }
        function expired() { finish({ result: failure({ code: 'unavailable', message: 'Sandbox agent did not become ready' }) }); }
        function readData({ chunk }: { chunk: Buffer }) {
            output += chunk.toString('utf8');
            if (Buffer.byteLength(output) > 8192) { expired(); return; }
            const newline = output.indexOf('\n');
            if (newline < 0) return;
            const line = output.slice(0, newline);
            try {
                if (!line.startsWith('OM_AGENT_READY ')) { expired(); return; }
                const parsed = z.strictObject({ origin: z.url(), pid: z.number().int().positive() }).safeParse(JSON.parse(line.slice(15)) as unknown);
                if (!parsed.success || parsed.data.pid !== required.child.pid) { expired(); return; }
                const url = new URL(parsed.data.origin);
                if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.search || url.hash || url.pathname !== '/') { expired(); return; }
                finish({ result: { ok: true, value: { origin: url.origin, pid: parsed.data.pid } } });
            } catch { expired(); }
        }
        // Node's data listener is retained for exact unsubscription during readiness cleanup.
        const data: Parameters<NonNullable<ChildProcess['stdout']>['on']>[1] = chunk => readData({ chunk });
        required.child.stdout?.on('data', data);
        required.child.once('error', expired); required.child.once('exit', expired);
        deadline.signal.addEventListener('abort', expired, { once: true });
    });
}

function exited(required: { child: ChildProcess }): boolean {
    return required.child.exitCode !== null || required.child.signalCode !== null;
}

/** Wait for OS reaping, bounded by an injected deadline. Already-exited children resolve immediately. */
function waitForExit(required: { child: ChildProcess; runtime: HttpRuntime; timeoutMs: number }): Promise<boolean> {
    if (exited(required)) return Promise.resolve(true);
    return new Promise(resolve => {
        const deadline = required.runtime.deadline.create({ timeoutMs: required.timeoutMs });
        function finish({ value }: { value: boolean }) { deadline.dispose({}); deadline.signal.removeEventListener('abort', expired); required.child.off('exit', stopped); resolve(value); }
        function stopped() { finish({ value: true }); }
        function expired() { finish({ value: false }); }
        required.child.once('exit', stopped); deadline.signal.addEventListener('abort', expired, { once: true });
        if (exited(required)) stopped();
    });
}

/** SIGTERM first, SIGKILL only after five seconds; await reaping before scratch cleanup. */
async function stopChild(required: { child: ChildProcess; directory: string; runtime: HttpRuntime }): Promise<Outcome<void>> {
    required.child.kill('SIGTERM');
    let stopped = await waitForExit({ ...required, timeoutMs: 5000 });
    if (!stopped) { required.child.kill('SIGKILL'); stopped = await waitForExit({ ...required, timeoutMs: 1000 }); }
    if (!stopped) return failure({ code: 'unavailable', message: 'Sandbox agent could not be reaped' });
    try { await rm(required.directory, { recursive: true, force: true }); }
    catch { return failure({ code: 'unavailable', message: 'Agent scratch cleanup failed' }); }
    return { ok: true, value: undefined };
}

/** Node binding stays in server composition. The child gets a fresh cwd and exactly five OM
 * environment values: no inherited PATH, HOME, vendor settings, product DB path or owner token.
 * @example const effects = createNodeAgentEffects({ projectRoot, ids });
 */
export function createNodeAgentEffects(required: { projectRoot: string; ids: IdPort }): AgentEffects {
    const runtime: HttpRuntime = { fetch, ids: required.ids, env: {}, deadline: { create({ timeoutMs }) {
        const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
        return { signal: controller.signal, dispose: () => clearTimeout(timer) };
    } } };
    return { runtime, async launch(input) {
        let directory: string | undefined;
        let child: ChildProcess | undefined;
        try {
            directory = await mkdtemp(join(tmpdir(), 'om-agent-'));
            child = spawn(process.execPath, [join(required.projectRoot, 'apps/agent/dist/composition/serve.js')], {
                cwd: directory, env: { OM_MODE: 'local-sandbox', OM_AGENT_SERVER_URL: input.serverUrl,
                    OM_AGENT_INSTANCE_ID: input.instanceId, OM_AGENT_CONTROL_TOKEN: input.controlToken, OM_AGENT_GRANT_KEY: input.grantKey },
                stdio: ['ignore', 'pipe', 'pipe'], shell: false,
            });
            child.once('exit', input.exited); child.once('error', input.exited);
            // Drain diagnostic pipes without retaining prompt/credential-bearing child output.
            child.stderr?.resume();
            const ready = await awaitReadiness({ child, runtime });
            child.stdout?.resume();
            if (!ready.ok) { await stopChild({ child, directory, runtime }); return ready; }
            const owned = child; const scratch = directory;
            let stopping: Promise<Outcome<void>> | undefined;
            return { ok: true, value: { ...ready.value, stop: () => stopping ??= stopChild({ child: owned, directory: scratch, runtime }) } };
        } catch {
            await cleanupLaunch({ child, directory, runtime });
            return failure({ code: 'unavailable', message: 'Sandbox agent launch failed' });
        }
    } };
}

/** Failed launches reap an owned child before removing its scratch directory. */
async function cleanupLaunch(required: { child?: ChildProcess; directory?: string; runtime: HttpRuntime }): Promise<void> {
    if (!required.directory) return;
    if (required.child) { await stopChild({ child: required.child, directory: required.directory, runtime: required.runtime }); return; }
    await rm(required.directory, { recursive: true, force: true });
}

/** Only fixed sandbox event payloads may enter owner observation. No tools/business receipts. */
const sandboxEvent = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('started'), payload: z.strictObject({}) }),
    z.strictObject({ kind: z.literal('delta'), payload: z.strictObject({ text: z.literal('Sandbox response: OM agent subprocess is connected. No model or business action was executed.') }) }),
    z.strictObject({ kind: z.literal('ended'), payload: z.strictObject({}) }),
    z.strictObject({ kind: z.literal('cancelled'), payload: z.strictObject({}) }),
    z.strictObject({ kind: z.literal('error'), payload: z.strictObject({ code: z.literal('unavailable') }) }),
]);

function observe(required: { observer: ObserverPort; context: CallContext; operation: string; outcome: string }): void {
    try { required.observer.observe({ operation: required.operation, outcome: required.outcome, correlationId: required.context.correlationId, traceId: required.context.traceId, runId: required.context.runId }); }
    catch { /* Diagnostics cannot widen or revoke committed authority. */ }
}

/** Cross-field event binding and fixed payload admission precede any mutation. */
function validEvent(required: { run: LocalRun; event: RunEvent }): boolean {
    const { run, event } = required;
    return event.runId === run.grant.runId && event.correlationId === run.context.correlationId && event.traceId === run.context.traceId
        && event.operationId === undefined && event.argumentsDigest === undefined
        && (run.mode === 'sandbox' ? sandboxEvent.safeParse({ kind: event.kind, payload: event.payload }).success : validModelPayload({ event }));
}

/** Model display events use the shared payload contracts; tool execution stays in R3. */
function validModelPayload(required: { event: RunEvent }): boolean {
    const { kind, payload } = required.event;
    switch (kind) {
        case 'delta': return z.strictObject({ text: z.string().max(65536) }).safeParse(payload).success;
        case 'tool_requested': return toolRequestedPayloadSchema.safeParse(payload).success || approvalPayloadSchema.safeParse(payload).success;
        case 'tool_result': return toolResultPayloadSchema.safeParse(payload).success || approvalPayloadSchema.safeParse(payload).success;
        default: return sandboxEvent.safeParse({ kind, payload }).success;
    }
}

function terminalStatus(required: { kind: RunEvent['kind'] }): RunStatus {
    switch (required.kind) {
        case 'ended': return 'completed';
        case 'cancelled': return 'cancelled';
        case 'error': return 'interrupted';
        default: return 'running';
    }
}

/** This fixture has exactly started→delta→ended, or a terminal cancellation/error. */
function orderedEvent(required: { run: LocalRun; event: RunEvent }): boolean {
    if (required.run.mode === 'model') return required.run.events.length === 0 ? required.event.kind === 'started' || required.event.kind === 'error' : required.event.kind !== 'started';
    return required.event.kind === 'error' || required.event.kind === 'cancelled'
        || required.event.kind === ['started', 'delta', 'ended'][required.run.events.length];
}

/** One bounded append; reserve the last event slot and 2 KiB for terminal evidence. */
function admitEvent(required: { run: LocalRun; event: RunEvent; clock: ClockPort }): Outcome<{ recorded: true }> {
    const { run, event } = required;
    if (run.status !== 'running' || run.grant.revoked || run.grant.expiresAt <= required.clock.now({})) return failure({ code: 'expired', message: 'Run no longer accepts events' });
    const bytes = Buffer.byteLength(JSON.stringify(event));
    const terminal = terminalStatus({ kind: event.kind }) !== 'running';
    if (run.events.length >= (terminal ? 8192 : 8191) || run.bytes + bytes > (terminal ? 2097152 : 2095104) || event.sequence !== run.events.length + 1 || !orderedEvent(required)) return failure({ code: 'limit_exceeded', message: 'Run event bound or sequence exceeded' });
    return { ok: true, value: { recorded: true } };
}
function commitEvent(required: { run: LocalRun; event: RunEvent }): void {
    const { run, event } = required;
    run.bytes += Buffer.byteLength(JSON.stringify(event)); run.events.push(structuredClone(event));
    run.status = terminalStatus({ kind: event.kind });
    if (run.status !== 'running') run.grant.revoked = true;
}

/** Per-run observation writes serialize across callbacks, polling and terminal evidence.
 * Revocation itself is immediate; an already accepted observation may finish before cancellation.
 */
function queueRun<T>(required: { run: LocalRun; work(): Promise<T> }): Promise<T> {
    const result = required.run.writes.then(required.work);
    required.run.writes = result.then(() => undefined, () => undefined);
    return result;
}

/** Finished projections can be dropped because persisted history remains server-readable. */
function releaseFinishedRun(required: { runs: Map<string, LocalRun>; tokens: Map<string, LocalRun> }): Outcome<void> {
    if (required.runs.size < 32) return { ok: true, value: undefined };
    const finished = [...required.runs.values()].find(run => run.status !== 'running');
    if (!finished) return failure({ code: 'limit_exceeded', message: 'At most 32 simultaneous runs' });
    required.runs.delete(finished.grant.runId);
    for (const [token, run] of required.tokens) if (run === finished) required.tokens.delete(token);
    return { ok: true, value: undefined };
}

/** Server-owned token map, grants, cancellation and bounded run projection. There is one child,
 * no automatic restart; Jini persistence is supplied by the server composition root.
 * @example const agent = createLocalAgent({ effects, clock, ids, observer, randomToken });
 * @complexity <=32 live projections, <=8,192 events/2 MiB per run; reconciliation reads <=128 events.
 */
export function createLocalAgent(required: { effects: AgentEffects; clock: ClockPort; ids: IdPort; observer: ObserverPort; randomToken(required: Record<string, never>): string; persistence?: AssistantRuns; frontend?: FrontendSessions; onRevoked?(required: { context: CallContext; runId: string; status: Exclude<RunStatus, 'running'> }): Promise<void> }) {
    const runs = new Map<string, LocalRun>();
    const tokens = new Map<string, LocalRun>();
    const instanceId = required.ids.next({});
    const controlToken = required.randomToken({});
    const grantKey = required.randomToken({});
    let child: AgentChild | undefined;
    let client: ReturnType<typeof createAgentControlClient> | undefined;
    let available = false;
    let stopping: Promise<Outcome<void>> | undefined;

    /** Local terminal evidence; grants revoke before any subsequent callback can be admitted. */
    async function terminate(input: { run: LocalRun; status: 'cancelled' | 'interrupted' }): Promise<Outcome<void>> {
        input.run.grant.revoked = true;
        await required.onRevoked?.({ context: input.run.context, runId: input.run.grant.runId, status: input.status });
        return queueRun({ run: input.run, work: async () => {
            if (input.run.status !== 'running') return { ok: true, value: undefined };
            const event: RunEvent = { protocolVersion: 1, eventId: required.ids.next({}), runId: input.run.grant.runId,
                correlationId: input.run.context.correlationId, traceId: input.run.context.traceId,
                sequence: input.run.events.length + 1, kind: input.status === 'cancelled' ? 'cancelled' : 'error',
                payload: input.status === 'cancelled' ? {} : { code: 'unavailable' } };
            if (required.persistence) {
                const saved = await required.persistence.record({ context: input.run.context, event });
                if (!saved.ok) return saved;
            }
            input.run.status = input.status; input.run.events.push(event);
            observe({ ...required, context: input.run.context, operation: 'server.agent.run', outcome: input.status });
            return { ok: true, value: undefined };
        } });
    }
    async function lost() { available = false; for (const run of runs.values()) await terminate({ run, status: 'interrupted' }); }

    function ownerRun(input: { context: CallContext; runId: string }): Outcome<LocalRun> {
        const run = runs.get(input.runId);
        if (!run || run.context.scope.ownerId !== input.context.scope.ownerId || run.context.scope.workspaceId !== input.context.scope.workspaceId) return failure({ code: 'forbidden', message: 'Run unavailable in owner scope' });
        return { ok: true, value: run };
    }

    function currentGrant(input: { grant: RunGrantMetadata }): Outcome<LocalRun> {
        const run = runs.get(input.grant.runId);
        if (!run || run.grant.grantId !== input.grant.grantId) return failure({ code: 'forbidden', message: 'Run grant mismatch' });
        if (run.grant.revoked || run.grant.expiresAt <= required.clock.now({})) return failure({ code: 'expired', message: 'Run authority unavailable' });
        return { ok: true, value: run };
    }

    /** Duplicates must match the entire validated event; gaps/conflicting IDs fail closed. */
    async function record(input: { grant: RunGrantMetadata; event: RunEvent }): Promise<Outcome<{ recorded: true }>> {
        const run = runs.get(input.grant.runId);
        if (!run || run.grant.grantId !== input.grant.grantId) return failure({ code: 'forbidden', message: 'Run grant mismatch' });
        return queueRun({ run, work: async () => recordEvent({ run, event: input.event }) });
    }
    async function recordEvent(input: { run: LocalRun; event: RunEvent }): Promise<Outcome<{ recorded: true }>> {
        const { run, event } = input;
        if (!validEvent({ run, event })) return failure({ code: 'invalid_input', message: 'Invalid sandbox event scope or payload' });
        const prior = run.events.find(value => value.sequence === event.sequence || value.eventId === event.eventId);
        if (prior) return JSON.stringify(prior) === JSON.stringify(event) ? { ok: true, value: { recorded: true } } : failure({ code: 'conflict', message: 'Conflicting run event identity' });
        const admitted = admitEvent({ run, event, clock: required.clock });
        if (!admitted.ok) return admitted;
        if (required.persistence) {
            const persisted = await required.persistence.record({ context: run.context, event });
            if (!persisted.ok) return persisted;
        }
        commitEvent({ run, event });
        if (run.status !== 'running') await required.onRevoked?.({ context: run.context, runId: run.grant.runId, status: run.status });
        observe({ ...required, context: run.context, operation: 'server.agent.event', outcome: event.kind });
        return { ok: true, value: { recorded: true } };
    }

    const grants: RunGrantVerifierPort = { async verify({ authorization }) {
        const run = tokens.get(authorization ?? '');
        if (!run) return failure({ code: 'unauthenticated', message: 'Scoped run credential required' });
        return { ok: true, value: structuredClone(run.grant) };
    } };
    const callbacks: SandboxCallbacks = {
        async context({ grant }) {
            const run = currentGrant({ grant });
            if (!run.ok) return run;
            return required.persistence ? required.persistence.context({ grant }) : { ok: true, value: { mode: 'local-sandbox' } };
        },
        async record(input) { const run = currentGrant(input); return run.ok ? record(input) : run; },
    };

    /** Reconcile a single bounded control page. A transport or validation failure interrupts,
     * and never retries or invents continuity. Callback/poll duplicates share the same append rule.
     */
    async function reconcile(input: { run: LocalRun; control: ReturnType<typeof createAgentControlClient> }): Promise<void> {
        try {
            const source = input.control.events({ runId: input.run.grant.runId, after: input.run.events.length,
                path: '/internal/v1/runs/' + encodeURIComponent(input.run.grant.runId) + '/events', authorization: 'Bearer ' + controlToken });
            for await (const event of source) {
                if (!event.ok || !(await record({ grant: input.run.grant, event: event.value })).ok) { await terminate({ run: input.run, status: 'interrupted' }); break; }
            }
        } catch { await terminate({ run: input.run, status: 'interrupted' }); }
    }

    /** Control acceptance happens only after Jini has committed the question and assistant stub. */
    async function begin(input: { context: CallContext; prompt: string; runId: string; conversationId: string; mode: 'sandbox' | 'model'; expiresAt: number; frontendSessionId?: string; frontendBindToken?: string }): ReturnType<OwnerRunPort['start']> {
        const grant: RunGrantMetadata = { protocolVersion: 1, grantId: required.ids.next({}), agentInstanceId: instanceId,
            scope: structuredClone(input.context.scope), conversationId: input.conversationId, runId: input.runId,
            capabilities: input.mode === 'model' ? ['context', 'events', 'model', 'tools'] : ['context', 'events'],
            expiresAt: input.expiresAt, authenticationEpoch: required.clock.now({}), revoked: false };
        const context: CallContext = { ...structuredClone(input.context), runId: input.runId, principal: { kind: 'agent', agentInstanceId: instanceId, runId: input.runId } };
        const bound = required.frontend?.bindRun({ ...input, context });
        if (bound && !bound.ok) return bound;
        const bearer = createHmac('sha256', grantKey).update(grant.grantId).digest('hex');
        const run: LocalRun = { context, grant, status: 'running', events: [], mode: input.mode, bytes: 0, writes: Promise.resolve() };
        runs.set(input.runId, run); tokens.set('Bearer ' + bearer, run);
        const started = await client!.start({ protocolVersion: 1, context, agentInstanceId: instanceId,
            conversationId: input.conversationId, runId: input.runId, grant, prompt: input.prompt,
            ...(input.mode === 'model' ? { runBearer: bearer, deadlineAt: grant.expiresAt } : {}), frontendSessionId: input.frontendSessionId, frontendBindToken: input.frontendBindToken });
        if (!started.ok || started.value.runId !== input.runId) {
            await terminate({ run, status: 'interrupted' });
            return failure({ code: 'unavailable', message: 'Agent start failed; no automatic retry' });
        }
        observe({ ...required, context, operation: 'server.agent.start', outcome: input.mode });
        return { ok: true, value: { runId: input.runId, status: started.value.status, expiresAt: grant.expiresAt,
            conversationId: input.conversationId, mode: input.mode } };
    }

    const owner: OwnerRunPort = {
        async start({ context, prompt }, options: Omit<AssistantRunRequest, 'prompt'> = {}) {
            if (!available || !client) return failure({ code: 'unavailable', message: 'OM agent unavailable' });
            const capacity = releaseFinishedRun({ runs, tokens });
            if (!capacity.ok) return capacity;
            if (required.persistence) return required.persistence.start({ context, prompt, conversationId: options.conversationId,
                launch: input => begin({ ...input, context, prompt, frontendSessionId: options.frontendSessionId, frontendBindToken: options.frontendBindToken }) });
            return begin({ context, prompt, ...options, mode: 'sandbox', runId: required.ids.next({}), conversationId: options.conversationId ?? required.ids.next({}), expiresAt: required.clock.now({}) + 300000 });
        },
        async events(input) {
            const result = ownerRun(input);
            if (!result.ok) return required.persistence ? required.persistence.events(input) : result;
            const run = result.value;
            if (run.grant.expiresAt <= required.clock.now({})) await terminate({ run, status: 'interrupted' });
            if (run.status === 'running' && client) await reconcile({ run, control: client });
            if (required.persistence) return required.persistence.events(input);
            const events = run.events.filter(event => event.sequence > input.after).slice(0, 128);
            const terminal = events.at(-1)?.kind;
            const status = events.length && !['ended', 'error', 'cancelled'].includes(terminal ?? '') ? 'running' : run.status;
            return { ok: true, value: { runId: input.runId, status, events: structuredClone(events) } };
        },
        async cancel(input) {
            const result = ownerRun(input);
            if (!result.ok) return result;
            const run = result.value;
            if (run.status === 'cancelled') return { ok: true, value: { runId: input.runId, status: 'cancelled' } };
            if (run.status !== 'running') return failure({ code: 'conflict', message: 'Run already terminal' });
            const terminal = await terminate({ run, status: 'cancelled' });
            if (!terminal.ok) return terminal;
            if (!client) return failure({ code: 'unavailable', message: 'Authority revoked; agent control unavailable' });
            const cancelled = await client.cancel({ request: { protocolVersion: 1, runId: input.runId, reason: 'owner' }, correlationId: input.context.correlationId, traceId: input.context.traceId });
            if (!cancelled.ok || cancelled.value.runId !== input.runId) return failure({ code: 'unavailable', message: 'Authority revoked; agent cancellation unconfirmed' });
            return cancelled;
        },
    };
    return { owner, grants, callbacks,
        /** Recheck current run authority at every tool dispatch and owner continuation. */
        authorize(input: { context: CallContext }): Outcome<void> {
            const owned = ownerRun({ context: input.context, runId: input.context.runId ?? '' });
            if (!owned.ok) return owned;
            const run = owned.value;
            const principal = input.context.principal;
            if (principal.kind !== 'agent' || principal.runId !== run.grant.runId || principal.agentInstanceId !== instanceId
                || run.status !== 'running' || !run.grant.capabilities.includes('tools')) return failure({ code: 'forbidden', message: 'Tool run authority unavailable' });
            const current = currentGrant({ grant: run.grant });
            return current.ok ? { ok: true, value: undefined } : current;
        },
        async start(input: { serverUrl: string }): Promise<Outcome<void>> {
            if (child || stopping) return failure({ code: 'conflict', message: 'Sandbox agent lifecycle already started' });
            const launched = await required.effects.launch({ ...input, instanceId, controlToken, grantKey, exited: () => { void lost(); } });
            if (!launched.ok) return launched;
            child = launched.value;
            client = createAgentControlClient({ baseUrl: child.origin, token: controlToken, runtime: required.effects.runtime, observer: required.observer });
            const health = await client.health();
            if (!health.ok) { await child.stop({}); return health; }
            available = true;
            return { ok: true, value: undefined };
        },
        stop(_input: Record<string, never>): Promise<Outcome<void>> {
            stopping ??= (async () => { await lost(); const result = child ? await child.stop({}) : { ok: true as const, value: undefined }; runs.clear(); tokens.clear(); return result; })();
            return stopping;
        },
    };
}

#!/usr/bin/env node
/** Executable OM composition. Server-issued run grants choose sandbox or the Jini model runtime. */
import { providerTurnAdapters } from '@jini-ai/agent-runtime/providers/tool-turn';
import { createModelRuntime } from '../runtime/model.js';
import { createOmModelClient } from '../om-client/index.js';
import { createServer } from 'node:http';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { appErrorSchema, parseBoundary } from '@open-marketing/contracts';
import type { ClockPort, ObserverPort, Outcome, StartRunRequest } from '@open-marketing/contracts';
import { createAgentApp } from './index.js';
import { createAgentHttpListener } from '../inbound/http.js';
import { createSandboxRuntime, type SandboxContextClient } from '../runtime/sandbox.js';

const environmentSchema = z.strictObject({
    OM_MODE: z.literal('local-sandbox'), OM_AGENT_CONTROL_TOKEN: z.string().regex(/^[a-f0-9]{64}$/),
    OM_AGENT_GRANT_KEY: z.string().regex(/^[a-f0-9]{64}$/), OM_AGENT_INSTANCE_ID: z.uuid(),
    OM_AGENT_SERVER_URL: z.url().refine(value => { const url = new URL(value); return url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.pathname === '/' && !url.username && !url.password && !url.search && !url.hash; }),
});
type Configuration = z.infer<typeof environmentSchema>;

/** Parse only the explicitly passed sandbox environment; no vendor configuration is consumed.
 * @example parseAgentEnvironment({ env: childEnv });
 */
export function parseAgentEnvironment(required: { env: Readonly<Record<string, string | undefined>> }): Outcome<Configuration> {
    return parseBoundary({ schema: environmentSchema, input: Object.fromEntries(Object.keys(environmentSchema.shape).map(key => [key, required.env[key]])) });
}

/** Read bounded OM-only responses; redirect rejection and the signal apply through body consumption. */
async function readResponse<T>(required: { response: Response; schema: z.ZodType<T> }): Promise<Outcome<T>> {
    const reader = required.response.body?.getReader();
    if (!reader) throw new Error('Missing callback response');
    let bytes = 0;
    const chunks: Uint8Array[] = [];
    try {
        while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > 16384) throw new Error('Callback response exceeds bound');
            chunks.push(chunk.value);
        }
        const envelope = z.discriminatedUnion('ok', [z.strictObject({ ok: z.literal(true), value: required.schema }), z.strictObject({ ok: z.literal(false), error: appErrorSchema })]);
        const parsed = parseBoundary({ schema: envelope, input: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) as unknown });
        if (!parsed.ok) return parsed;
        if (!required.response.ok && parsed.value.ok) throw new Error('Contradictory callback response');
        return parsed.value;
    } finally { await reader.cancel(); reader.releaseLock(); }
}

/** Callback token is derived per server-issued grant, never serialized into events/receipts.
 * Two fixed routes, 5s deadlines, no redirects/retries or arbitrary URL selection.
 */
function createContextClient(required: { config: Configuration; fetch: typeof fetch; observer: ObserverPort }): SandboxContextClient {
    async function call<T>(input: { run: StartRunRequest; operation: 'context' | 'events'; body?: unknown; signal: AbortSignal; schema: z.ZodType<T> }): Promise<Outcome<T>> {
        const authorization = 'Bearer ' + createHmac('sha256', required.config.OM_AGENT_GRANT_KEY).update(input.run.grant.grantId).digest('hex');
        let outcome = 'unavailable';
        try {
            const response = await required.fetch(required.config.OM_AGENT_SERVER_URL + '/api/agent/v1/runs/' + encodeURIComponent(input.run.runId) + '/' + input.operation, {
                method: input.operation === 'context' ? 'GET' : 'POST', redirect: 'error',
                headers: { authorization, 'content-type': 'application/json', 'x-correlation-id': input.run.context.correlationId, 'x-trace-id': input.run.context.traceId },
                body: input.body === undefined ? undefined : JSON.stringify(input.body), signal: AbortSignal.any([input.signal, AbortSignal.timeout(5000)]),
            });
            const result = await readResponse({ response, schema: input.schema });
            outcome = result.ok ? 'ok' : result.error.code;
            return result;
        } catch { return { ok: false, error: { code: 'unavailable', message: 'Sandbox server callback unavailable', retryable: false } }; }
        finally {
            try { required.observer.observe({ operation: 'agent.om.' + input.operation, outcome, correlationId: input.run.context.correlationId, traceId: input.run.context.traceId, runId: input.run.runId }); }
            catch { /* Diagnostics do not change callback authority or the recorded outcome. */ }
        }
    }
    return {
        load: input => call({ ...input, operation: 'context', schema: z.strictObject({ mode: z.literal('local-sandbox') }) }),
        async publish(input) {
            const result = await call({ ...input, operation: 'events', body: input.event, schema: z.strictObject({ recorded: z.literal(true) }) });
            return result.ok ? { ok: true, value: undefined } : result;
        },
    };
}

/** Compose one sandbox instance, verify the assigned instance on every run, and reap on signals. */
async function main(): Promise<void> {
    const config = parseAgentEnvironment({ env: process.env });
    if (!config.ok) { process.stderr.write('Invalid sandbox agent environment\n'); process.exitCode = 1; return; }
    const clock: ClockPort = { now: () => Date.now() };
    const observer: ObserverPort = { observe(event) { process.stderr.write(JSON.stringify({ service: 'om-agent', ...event }) + '\n'); } };
    const sandbox = createSandboxRuntime({ clock, ids: { next: () => randomUUID() }, contextClient: createContextClient({ config: config.value, fetch, observer }) });
    const model = createModelRuntime({ clock, ids: { next: () => randomUUID() },
        client: createOmModelClient({ serverOrigin: config.value.OM_AGENT_SERVER_URL, fetch, observer,
            deadline({ timeoutMs }) { const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
                return { signal: controller.signal, dispose: () => clearTimeout(timer) }; } }), adapters: providerTurnAdapters });
    const runtimes = new Map<string, typeof sandbox | typeof model>();
    const runtime = {
        async startRun(run: StartRunRequest) {
            const selected = run.grant.capabilities.includes('model') ? model : sandbox;
            const started = await selected.startRun(run);
            if (started.ok) runtimes.set(run.runId, selected);
            return started;
        },
        cancelRun(input: Parameters<typeof sandbox.cancelRun>[0]) { return (runtimes.get(input.runId) ?? sandbox).cancelRun(input); },
        events(input: Parameters<typeof sandbox.events>[0]) { return (runtimes.get(input.runId) ?? sandbox).events(input); },
        async dispose(_input: Record<string, never>) { await Promise.all([sandbox.dispose({}), model.dispose({})]); runtimes.clear(); },
    };
    const listener = createAgentHttpListener({ createServer, token: config.value.OM_AGENT_CONTROL_TOKEN });
    const credential = { kind: 'service-control' as const, bearer: config.value.OM_AGENT_CONTROL_TOKEN };
    const app = createAgentApp({ listener, runtime: {
        startRun: run => run.agentInstanceId === config.value.OM_AGENT_INSTANCE_ID ? runtime.startRun(run) : Promise.resolve({ ok: false, error: { code: 'forbidden', message: 'Agent instance mismatch', retryable: false } }),
        cancelRun: input => runtime.cancelRun(input), events: input => runtime.events(input),
    }, credential, runtimeAvailable: true, auth: { verify({ supplied }) {
        const value = Buffer.from(supplied ?? ''); const expected = Buffer.from('Bearer ' + credential.bearer);
        return value.length === expected.length && timingSafeEqual(value, expected) ? { ok: true, value: undefined }
            : { ok: false, error: { code: 'unauthenticated', message: 'Agent control credential required', retryable: false } };
    } } });
    let stopping: Promise<void> | undefined;
    function stop() {
        stopping ??= (async () => { await runtime.dispose({}); await app.stop({}); process.off('SIGTERM', stop); process.off('SIGINT', stop); })();
    }
    process.on('SIGTERM', stop); process.on('SIGINT', stop);
    const started = await app.start({});
    if (!started.ok) { stop(); await stopping; process.exitCode = 1; return; }
    if (stopping) { await stopping; return; }
    process.stdout.write('OM_AGENT_READY ' + JSON.stringify({ origin: listener.origin({}), pid: process.pid }) + '\n');
}

if (import.meta.main) void main().catch(() => { process.stderr.write('Sandbox agent failed\n'); process.exitCode = 1; });

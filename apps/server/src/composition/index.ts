/** Sole server resource composition. Imports and factories are inert; boot is explicitly effectful. */
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { CallContext, ClockPort, IdPort, ObserverPort, Outcome } from '@open-marketing/contracts';
import type { HttpRequest, HttpListenerPort, LifecyclePort, HttpResponse } from '../ports.js';
import { handleOmRequest, type RunGrantVerifierPort } from '../inbound/om.js';
import { createNodeHttpListener, prepareStudioAssets, serveStudioAsset, type HttpEffects, type NodeHttpListener } from '../inbound/http.js';
import { bindServerDatabase, provisionWorkspace } from './database.js';
import { loadMigrations } from './migrations.js';
import { runMigrations } from '../platform/jini-compat/db/src/index.js';
import { createLocalAuth, localFailure, parseLocalEnvironment, provisionLocalOwner, readLocalFile, writeLocalEndpoint, type LocalFilesystem } from './local-auth.js';

/** Retain the inert grant-authenticated shell; boot supplies its concrete HTTP dispatcher.
 * @example const app = createServerApp({ listener, handle }); await app.start({});
 * @complexity O(1); resource ownership remains with the explicit boot/stop pair.
 */
export function createServerApp(required: { listener: HttpListenerPort; grants: RunGrantVerifierPort; clock: ClockPort }
    | { listener: HttpListenerPort; handle: (required: HttpRequest) => Promise<HttpResponse> }): LifecyclePort {
    const handle = 'handle' in required ? required.handle
        : (request: HttpRequest) => handleOmRequest({ request, grants: required.grants, clock: required.clock });
    return { start: () => required.listener.start({ handle }), stop: () => required.listener.stop({}) };
}

/** Concrete Node I/O/configuration supplied once by serve.ts; tests replace paths and effects.
 * ready is the only OM_READY sink and is called after migrations, assets and listener are ready.
 */
export interface ServerBootIo extends HttpEffects {
    readonly fs: LocalFilesystem;
    readonly projectRoot: string;
    readonly studioRoot: string;
    readonly openSqlite: (required: { path: string }) => Database.Database;
    readonly randomToken: (required: Record<string, never>) => string;
    readonly ready: (required: { studioUrl: string }) => void;
}
/** Explicit owned lifecycle returned after successful boot. stop is idempotent and closes SQLite last. */
export interface BootedServer { readonly studioUrl: string; stop(required: Record<string, never>): Promise<Outcome<void>> }
interface BootResources { native?: Database.Database; app?: LifecyclePort; stopped?: Promise<Outcome<void>> }

/** Best-effort low-cardinality lifecycle diagnostics; no credential/token or raw exception details. */
function observeBoot(required: { observer: ObserverPort; context: CallContext; operation: string; outcome: string }): void {
    try { required.observer.observe({ operation: required.operation, outcome: required.outcome,
        correlationId: required.context.correlationId, traceId: required.context.traceId }); }
    catch { /* Observer failure cannot change committed work or readiness. */ }
}

/** Stop transport before closing the native handle, including on partially completed startup. */
async function closeResources(required: { resources: BootResources }): Promise<Outcome<void>> {
    let result: Outcome<void> = { ok: true, value: undefined };
    try { if (required.resources.app) result = await required.resources.app.stop({}); }
    catch { result = localFailure({ message: 'Server transport cleanup failed' }); }
    try { if (required.resources.native?.open) required.resources.native.close(); }
    catch { return localFailure({ message: 'SQLite cleanup failed' }); }
    return result;
}

function stopResources(required: { resources: BootResources }): Promise<Outcome<void>> {
    return required.resources.stopped ??= closeResources(required);
}

/** I1 boot routes. Authenticate before touching bodies; all business effects remain unavailable.
 * Status follows the existing CLI DTO. Owner features/public ingress are implemented in later runs.
 */
async function handleBootRequest(required: {
    request: HttpRequest; auth: ReturnType<typeof createLocalAuth>; listener: NodeHttpListener;
    fs: LocalFilesystem; studioRoot: string;
}): Promise<HttpResponse> {
    const origin = required.listener.origin({});
    if (!origin) return { status: 503, body: localFailure({ message: 'Server is stopping' }) };
    if (required.request.path === '/health' && required.request.method === 'GET') {
        return { status: 200, body: { ok: true, value: { ready: true, mode: 'local' } } };
    }
    if (required.request.path === '/bootstrap') return required.auth.bootstrap({ request: required.request, origin });
    const authenticated = required.auth.verify({ request: required.request, origin });
    if (!authenticated.ok) return { status: authenticated.error.code === 'forbidden' ? 403 : 401, body: authenticated };
    if (required.request.path === '/api/status' && required.request.method === 'GET') {
        return { status: 200, body: { ok: true, value: { ready: true, mode: 'local' } } };
    }
    if (required.request.path.startsWith('/api/')) {
        return { status: 503, body: localFailure({ message: 'Owner features and agent operations are unavailable in I1 local boot' }) };
    }
    return serveStudioAsset({ request: required.request, fs: required.fs, studioRoot: required.studioRoot });
}

/** Boot one explicitly owned local database: validate config, provision owner, prepare assets,
 * migrate on one checked kernel, persist workspace, bind HTTP, then publish discovery/readiness.
 * Every failed step closes any resources acquired so far; no provider/plugin/worker starts here.
 * @example await bootServer({ env, io, clock, ids, observer });
 * @returns A loopback bootstrap URL and stop handle, or a stable typed startup failure.
 * @complexity Fixed 16-entry bounded migration batch; no unbounded work or scheduling queue.
 */
export async function bootServer(required: {
    env: Readonly<Record<string, string | undefined>>; io: ServerBootIo; clock: ClockPort; ids: IdPort; observer: ObserverPort;
}): Promise<Outcome<BootedServer>> {
    const config = parseLocalEnvironment({ env: required.env });
    if (!config.ok) return config;
    const resources: BootResources = {};
    let context: CallContext | undefined;
    let phase = 'local credentials';
    try {
        const credentials = await provisionLocalOwner({ fs: required.io.fs, stateRoot: config.value.stateRoot, ids: required.ids, randomToken: required.io.randomToken });
        if (!credentials.ok) return credentials;
        context = { scope: { ownerId: credentials.value.ownerId, workspaceId: credentials.value.workspaceId },
            principal: { kind: 'owner', ownerId: credentials.value.ownerId }, correlationId: required.ids.next({}), traceId: required.ids.next({}) };
        phase = 'studio assets';
        const assets = await prepareStudioAssets({ fs: required.io.fs, studioRoot: required.io.studioRoot });
        if (!assets.ok) return assets;
        phase = 'SQLite migrations';
        resources.native = required.io.openSqlite({ path: join(config.value.stateRoot, 'om.sqlite') });
        resources.native.pragma('foreign_keys = ON');
        resources.native.pragma('busy_timeout = 5000');
        const database = bindServerDatabase({ native: resources.native, context, observer: required.observer });
        const migrations = await loadMigrations({ readSql: async ({ path }) => (await readLocalFile({ fs: required.io.fs,
            path: join(required.io.projectRoot, path), maxBytes: 1048576 })).toString('utf8') });
        await runMigrations({ pool: database.pool, migrations }, { observer: database.observe });
        await provisionWorkspace({ database: database.workspace, scope: context.scope });
        observeBoot({ ...required, context, operation: 'server.boot.database', outcome: 'ready' });
        phase = 'HTTP listener';
        const listener = createNodeHttpListener({ ...config.value, effects: required.io, ids: required.ids, observer: required.observer });
        const auth = createLocalAuth({ credentials: credentials.value, clock: required.clock, bootstrapToken: required.io.randomToken({}) });
        resources.app = createServerApp({ listener, handle: request => handleBootRequest({ request, auth, listener, fs: required.io.fs, studioRoot: assets.value }) });
        const started = await resources.app.start({});
        if (!started.ok) { await stopResources({ resources }); return started; }
        const origin = listener.origin({});
        if (!origin) { await stopResources({ resources }); return localFailure({ message: 'Local server address unavailable' }); }
        phase = 'readiness';
        await writeLocalEndpoint({ fs: required.io.fs, stateRoot: config.value.stateRoot, serverUrl: origin });
        const studioUrl = auth.studioUrl({ origin });
        required.io.ready({ studioUrl });
        observeBoot({ ...required, context, operation: 'server.boot', outcome: 'ready' });
        return { ok: true, value: { studioUrl, stop: () => stopResources({ resources }) } };
    } catch {
        await stopResources({ resources });
        if (context) observeBoot({ ...required, context, operation: 'server.boot', outcome: 'failed' });
        return localFailure({ message: `Local server startup failed during ${phase}` });
    }
}

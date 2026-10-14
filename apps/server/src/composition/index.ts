/** Sole server resource composition. Imports and factories are inert; boot is explicitly effectful. */
import { createSqlMeasureRepo, createSqlTrackedLink, type MeasureSqlDatabase } from '@open-marketing/measure';
import { handlePublicRequest } from '../inbound/public.js';
import { createAesGcmSecretSealer, createCredentialBroker, createCredentialKeyring, createCredentialService,
    createMemoryCredentialLock, createSqlCredentialAudit, createSqlCredentialRepo } from '@open-marketing/credentials';
import type { KeyringConfiguration } from '@open-marketing/credentials';
import { createIntegrations, type Integrations } from '../integrations.js';
import { handleIntegrationRequest } from '../inbound/integrations.js';
import { bindForms, seedSandboxForm } from './forms.js';
import { bindIdentity, createVisitTokens, localKey } from './identity.js';
import { bindPrivacy } from './privacy.js';
import { createFormWorkers } from './workers.js';
import { createLocalAgent, createNodeAgentEffects, type AgentEffects } from './agent.js';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { CallContext, ClockPort, IdPort, ObserverPort, Outcome } from '@open-marketing/contracts';
import { z } from 'zod';
import { createSqlCampaignRepo, type CampaignSqlPort } from '@open-marketing/campaigns';
import { createMemoryConfirmationExchange, createSqlSafetyRepo, type MemoryConfirmationExchange, type SafetySqlDatabase } from '@open-marketing/safety';
import { handleOwnerRequest, type OwnerServices } from '../inbound/owner.js';
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
    readonly agentEffects?: AgentEffects;
    readonly loadCredentialMaster?: (required: { configuration: KeyringConfiguration; masterHex?: string }) => Promise<Outcome<Uint8Array>>;
}
/** Explicit owned lifecycle returned after successful boot. stop is idempotent and closes SQLite last. */
export interface BootedServer { readonly studioUrl: string; stop(required: Record<string, never>): Promise<Outcome<void>> }
interface BootResources { native?: Database.Database; app?: LifecyclePort; confirmations?: MemoryConfirmationExchange; workers?: ReturnType<typeof createFormWorkers>; privacy?: ReturnType<typeof bindPrivacy>; agent?: ReturnType<typeof createLocalAgent>; stopped?: Promise<Outcome<void>> }

/** Best-effort low-cardinality lifecycle diagnostics; no credential/token or raw exception details. */
function observeBoot(required: { observer: ObserverPort; context: CallContext; operation: string; outcome: string }): void {
    try { required.observer.observe({ operation: required.operation, outcome: required.outcome,
        correlationId: required.context.correlationId, traceId: required.context.traceId }); }
    catch { /* Observer failure cannot change committed work or readiness. */ }
}

/** Cleanup continues after an explicit/throwing port failure; no acquired service is skipped. */
async function stopService(required: { service?: Pick<LifecyclePort, 'stop'>; message: string }): Promise<Outcome<void>> {
    try { return required.service ? await required.service.stop({}) : { ok: true, value: undefined }; }
    catch { return localFailure({ message: required.message }); }
}

/** Close admission, revoke/reap the agent, stop workers, and close SQLite last. */
async function closeResources(required: { resources: BootResources }): Promise<Outcome<void>> {
    let result = await stopService({ service: required.resources.app, message: 'Server transport cleanup failed' });
    const agent = await stopService({ service: required.resources.agent, message: 'Sandbox agent cleanup failed' });
    if (!agent.ok) result = agent;
    const workers = await stopService({ service: required.resources.workers, message: 'Worker cleanup failed' });
    if (!workers.ok) result = workers;
    required.resources.privacy?.participants.dispose({});
    required.resources.confirmations?.reset({});
    try { if (required.resources.native?.open) required.resources.native.close(); }
    catch { return localFailure({ message: 'SQLite cleanup failed' }); }
    return result;
}

function stopResources(required: { resources: BootResources }): Promise<Outcome<void>> {
    return required.resources.stopped ??= closeResources(required);
}

/** Authenticate before bodies and derive owner scope locally. Studio configuration is supplied
 * in same-origin HTML; the owner cookie stays HttpOnly. Public ingress never uses owner auth.
 */
async function handleBootRequest(required: {
    request: HttpRequest; auth: ReturnType<typeof createLocalAuth>; listener: NodeHttpListener;
    fs: LocalFilesystem; studioRoot: string; context: CallContext; services: OwnerServices; integrations: Integrations; ids: IdPort; agent: ReturnType<typeof createLocalAgent>; clock: ClockPort; publicServices: Omit<Parameters<typeof handlePublicRequest>[0], 'request' | 'context'>;
}): Promise<HttpResponse> {
    const origin = required.listener.origin({});
    if (!origin) return { status: 503, body: localFailure({ message: 'Server is stopping' }) };
    if (required.request.path === '/health' && required.request.method === 'GET') {
        return { status: 200, body: { ok: true, value: { ready: true, mode: 'local' } } };
    }
    if (required.request.path.startsWith('/f/') || required.request.path === '/c' || required.request.path === '/web-events.js') {
        const trace = ownerContext({ request: required.request, context: required.context, ids: required.ids });
        return handlePublicRequest({ ...required.publicServices, request: required.request,
            context: { ...trace, principal: { kind: 'service', serviceId: 'public-ingress' } } });
    }
    if (required.request.path === '/bootstrap') return required.auth.bootstrap({ request: required.request, origin });
    if (required.request.path.startsWith('/api/agent/')) return handleOmRequest({ request: required.request, grants: required.agent.grants, callbacks: required.agent.callbacks, clock: required.clock });
    const authenticated = required.auth.verify({ request: required.request, origin });
    if (!authenticated.ok) return { status: authenticated.error.code === 'forbidden' ? 403 : 401, body: authenticated };
    if (required.request.path.startsWith('/api/')) {
        const context = ownerContext({ request: required.request, context: required.context, ids: required.ids });
        return handleOwnerApi({ request: required.request, context, services: required.services, integrations: required.integrations });
    }
    return configuredStudioAsset(required);
}

/** Dispatch only after boot authentication, retaining the existing owner routes unchanged. */
function handleOwnerApi(required: {
    request: HttpRequest; context: CallContext; services: OwnerServices; integrations: Integrations;
}): Promise<HttpResponse> {
    if (required.request.path.startsWith('/api/addons/v1/integrations')) return handleIntegrationRequest(required);
    return handleOwnerRequest(required);
}

/** Same-origin API selection is presentation configuration; credentials stay in the HttpOnly cookie. */
async function configuredStudioAsset(required: { request: HttpRequest; fs: LocalFilesystem; studioRoot: string }): Promise<HttpResponse> {
    const asset = await serveStudioAsset(required);
    if (asset.status === 200 && asset.contentType?.startsWith('text/html')) {
        const html = Buffer.isBuffer(asset.body) ? asset.body.toString('utf8') : String(asset.body);
        return { ...asset, body: html.replace(/(<head\b[^>]*>)/i, '$1<meta name="om-server-url" content="/">') };
    }
    return asset;
}

/** Client tracing cannot override trusted identity. Invalid/missing IDs receive injected IDs. */
function ownerContext(required: { request: HttpRequest; context: CallContext; ids: IdPort }): CallContext {
    const schema = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/);
    const correlation = schema.safeParse(required.request.headers?.['x-correlation-id']);
    const trace = schema.safeParse(required.request.headers?.['x-trace-id']);
    return { ...required.context, correlationId: correlation.success ? correlation.data : required.ids.next({}),
        traceId: trace.success ? trace.data : required.ids.next({}) };
}

/** Boot one explicitly owned local database: validate config, provision owner, prepare assets,
 * migrate on one checked kernel, persist workspace, bind HTTP, then publish discovery/readiness.
 * Every failed step closes acquired resources. The forms worker and fixed sandbox child start here.
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
        const safetyDb: SafetySqlDatabase = { transaction: ({ execute }) => database.unit.transaction({ work: ({ session }) => execute({
            session: { query: ({ sql, parameters }) => session.query({ text: sql, values: [...parameters] }) },
        }) }) };
        resources.confirmations = createMemoryConfirmationExchange({ clock: required.clock, ids: required.ids });
        const campaignDb: CampaignSqlPort = {
            query: <Row extends Record<string, unknown>>(input: { text: string; values?: unknown[] }) =>
                database.unit.transaction({ work: ({ session }) => session.query<Row>(input) }),
        };
        const integrations = bindServerIntegrations({ db: campaignDb, clock: required.clock, ids: required.ids,
            observer: required.observer, io: required.io, stateRoot: config.value.stateRoot, masterHex: required.env.OM_CREDENTIAL_KEY });
        const services: OwnerServices = {
            campaigns: createSqlCampaignRepo({ db: campaignDb }, { observer: required.observer }),
            safety: createSqlSafetyRepo({ db: safetyDb, clock: required.clock, ids: required.ids, ownerTimezone: config.value.timezone, observer: required.observer }),
            confirmations: resources.confirmations,
        };
        const visits = createVisitTokens({ key: localKey({ ownerToken: credentials.value.token, domain: 'visits' }), clock: required.clock, ids: required.ids });
        const digestKey = localKey({ ownerToken: credentials.value.token, domain: 'contacts' });
        const identity = bindIdentity({ unit: database.unit, clock: required.clock, ids: required.ids, observer: required.observer, digestKey, tokens: visits.tokens });
        const forms = bindForms({ database, clock: required.clock, ids: required.ids, observer: required.observer, digestKey, tokens: visits.tokens });
        await seedSandboxForm({ binding: forms, context, clock: required.clock, ids: required.ids });
        const measureDb: MeasureSqlDatabase = {
            query: input => database.unit.transaction({ work: ({ session }) => session.query(input) }),
            transaction: ({ work }) => database.unit.transaction({ work: ({ session }) => work(session) }),
        };
        const measure = createSqlMeasureRepo({ database: measureDb, jobs: { async enqueue() { return localFailure({ code: 'forbidden', message: 'Conversions denied in local sandbox' }); } } }, { observer: required.observer });
        resources.privacy = bindPrivacy({ unit: database.unit, identity, subjects: forms.subjects, measure, clock: required.clock, ids: required.ids, observer: required.observer });
        resources.workers = createFormWorkers({ unit: database.unit, forms, clock: required.clock, ids: required.ids, observer: required.observer, context, schedule: required.io.schedule });
        const publicServices = { forms, identity, visits, clock: required.clock, campaigns: services.campaigns,
            links: createSqlTrackedLink({ database: measureDb, ids: required.ids, baseUrl: 'https://sandbox.example.test/l/', allowedOrigins: ['https://sandbox.example.test'] }, { observer: required.observer }) };
        services.formSubjects = forms.subjects;
        resources.agent = createLocalAgent({ effects: required.io.agentEffects ?? createNodeAgentEffects({ projectRoot: required.io.projectRoot, ids: required.ids }),
            clock: required.clock, ids: required.ids, observer: required.observer, randomToken: required.io.randomToken });
        services.runs = resources.agent.owner;
        const agent = resources.agent;
        const bootContext = context;
        resources.app = createServerApp({ listener, handle: request => handleBootRequest({ request, auth, listener, fs: required.io.fs,
            studioRoot: assets.value, context: bootContext, services, integrations, ids: required.ids, publicServices, agent, clock: required.clock }) });
        const started = await resources.app.start({});
        if (!started.ok) { await stopResources({ resources }); return started; }
        const origin = listener.origin({});
        if (!origin) { await stopResources({ resources }); return localFailure({ message: 'Local server address unavailable' }); }
        phase = 'sandbox agent';
        const agentStarted = await agent.start({ serverUrl: origin });
        if (!agentStarted.ok) { await stopResources({ resources }); return agentStarted; }
        const workersStarted = resources.workers.start({});
        if (!workersStarted.ok) { await stopResources({ resources }); return workersStarted; }
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

/** Sole composition binding for credential storage, crypto, locks and operations on the owned SQLite handle.
 * OAuth entry points stay unavailable in this paste-token run. Key reads are lazy and injected;
 * importing/constructing integrations opens no file, listener, database or vendor connection.
 * @example const integrations = bindServerIntegrations({ db, clock, ids, observer, io, stateRoot });
 * @complexity O(1) construction; bounded repository/crypto work belongs to the supplied adapters.
 */
export function bindServerIntegrations(required: {
    db: CampaignSqlPort; clock: ClockPort; ids: IdPort; observer: ObserverPort; io: ServerBootIo; stateRoot: string; masterHex?: string;
}): Integrations {
    const configuration: KeyringConfiguration = { hkdfSalt: 'io.github.ainsep.openmarketing.credentials.v1',
        envVarName: 'OM_CREDENTIAL_KEY', keyFilePath: join(required.stateRoot, 'credentials.key') };
    const keyring = createCredentialKeyring({ loadMaster: async input => {
        if (!required.io.loadCredentialMaster) return localFailure({ message: 'Credential key loader unavailable' });
        return required.io.loadCredentialMaster({ ...input, masterHex: required.masterHex });
    } });
    const sealer = createAesGcmSecretSealer({ keyring, configuration, randomBytes: ({ size }) => {
        const hex = z.string().regex(/^[a-f0-9]{64}$/).parse(required.io.randomToken({}));
        return new Uint8Array(Buffer.from(hex, 'hex').subarray(0, size));
    } });
    const locks = createMemoryCredentialLock({});
    const repo = createSqlCredentialRepo({ db: required.db, clock: required.clock });
    const audit = createSqlCredentialAudit({ db: required.db, ids: required.ids, clock: required.clock });
    const broker = createCredentialBroker({ repo, sealer, locks, audit });
    const service = createCredentialService({ repo, sealer, keyring, locks, audit, clock: required.clock,
        oauth: {
            async begin() { return localFailure({ code: 'not_implemented', message: 'OAuth sign-in deferred' }); },
            async complete() { return localFailure({ code: 'not_implemented', message: 'OAuth sign-in deferred' }); },
        } });
    return createIntegrations({ repo, sealer, locks, audit, broker, service, db: required.db, observer: required.observer });
}

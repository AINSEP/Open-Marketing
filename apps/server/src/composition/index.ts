import { bindSandboxCreative } from './creative.js';
import { bindSandboxCampaigns } from './campaigns.js';
import { bindCatalogAudit, bindCatalogScope, bindCatalogMeasure, sandboxPlatformReports } from './catalog.js';
import type { OmFeatureServices } from '../om-tools.js';
import { bindServerAddons, type AddonEffects } from './addons.js';
import { buildOmToolDefinitions, createOmTools } from '../om-tools.js';
import type { OmTools } from '../om-tools.js';
import type { YamlReaderPort } from '@jini-ai/agentic/skills/install';
import type { ExternalMcpSessions } from '../external-mcp.js';
import { bindAddonFederationSessions } from './addon-federation.js';
import type { AddonFederationEffects } from './addon-federation.js';
/** Sole server resource composition. Imports and factories are inert; boot is explicitly effectful. */
import { createSqliteChatStore } from '@jini-ai/chat/store/sqlite';
import { createChatRunLedger, createDurableRunStore } from '@jini-ai/chat/store/runtime';
import type { StorageKernel } from '@jini-ai/db/kernel';
import { createAssistantRuns, type AssistantDatabase, type AssistantRuns } from '../runs.js';
import { createConversations } from '../conversations.js';
import { handleModelRequest, type ModelCredentials, type ModelUpstream } from '../inbound/model.js';
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
import { createFrontendSessions, type FrontendSessions } from '../inbound/frontend.js';
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
    readonly addonEffects?: (required: { clock: ClockPort; ids: IdPort }) => AddonEffects;
    readonly addonYaml?: YamlReaderPort;
    readonly addonSessions?: ExternalMcpSessions;
    readonly addonFederation?: AddonFederationEffects;
    readonly modelUpstream?: ModelUpstream;
    readonly loadCredentialMaster?: (required: { configuration: KeyringConfiguration; masterHex?: string }) => Promise<Outcome<Uint8Array>>;
}
/** Explicit owned lifecycle returned after successful boot. stop is idempotent and closes SQLite last. */
export interface BootedServer { readonly studioUrl: string; stop(required: Record<string, never>): Promise<Outcome<void>> }
interface BootResources { frontend?: FrontendSessions; tools?: OmTools; addons?: ReturnType<typeof bindBootAddons>; native?: Database.Database; app?: LifecyclePort; confirmations?: MemoryConfirmationExchange; workers?: ReturnType<typeof createFormWorkers>; privacy?: ReturnType<typeof bindPrivacy>; agent?: ReturnType<typeof createLocalAgent>; stopped?: Promise<Outcome<void>> }

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
    required.resources.frontend?.dispose({});
    let result = await stopService({ service: required.resources.app, message: 'Server transport cleanup failed' });
    const agent = await stopService({ service: required.resources.agent, message: 'Sandbox agent cleanup failed' });
    required.resources.tools?.dispose({});
    if (!agent.ok) result = agent;
    const workers = await stopService({ service: required.resources.workers, message: 'Worker cleanup failed' });
    if (!workers.ok) result = workers;
    try {
        const addons = await required.resources.addons?.dispose();
        if (addons && !addons.ok) result = addons;
    } catch { result = localFailure({ message: 'Add-on cleanup failed' }); }
    required.resources.privacy?.participants.dispose({});
    required.resources.confirmations?.reset({});
    try { if (required.resources.native?.open) required.resources.native.close(); }
    catch { return localFailure({ message: 'SQLite cleanup failed' }); }
    return result;
}

function stopResources(required: { resources: BootResources }): Promise<Outcome<void>> {
    return required.resources.stopped ??= closeResources(required);
}

type BootRequestInput = {
    request: HttpRequest; auth: ReturnType<typeof createLocalAuth>; listener: NodeHttpListener;
    fs: LocalFilesystem; studioRoot: string; context: CallContext; services: OwnerServices; integrations: Integrations; ids: IdPort; agent: ReturnType<typeof createLocalAgent>; clock: ClockPort; observer: ObserverPort; model: { credentials: ModelCredentials; upstream: ModelUpstream }; publicServices: Omit<Parameters<typeof handlePublicRequest>[0], 'request' | 'context'>;
};
/** Authenticate before bodies and derive owner scope locally. Studio configuration is supplied
 * in same-origin HTML; the owner cookie stays HttpOnly. Public ingress never uses owner auth.
 */
async function handleBootRequest(required: BootRequestInput): Promise<HttpResponse> {
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
    if (required.request.path.startsWith('/api/agent/v1/model/')) return handleModelRequest({ request: required.request, grants: required.agent.grants, clock: required.clock, observer: required.observer, ...required.model });
    if (required.request.path.startsWith('/api/agent/')) return handleOmRequest({ request: required.request, grants: required.agent.grants, callbacks: required.agent.callbacks, clock: required.clock, tools: required.services.tools });
    return handleAuthenticatedBootRequest({ ...required, origin });
}

/** Owner APIs and assets require the same origin-bound authentication before dispatch. */
async function handleAuthenticatedBootRequest(required: BootRequestInput & { origin: string }): Promise<HttpResponse> {
    const { origin } = required;
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

/** Owner authority comes only from authenticated ingress, still restricted to this boot scope. */
function scopedOwnerAuthority(required: { context: CallContext; expected: CallContext }): Outcome<void> {
    const principal = required.context.principal;
    if (principal.kind !== 'owner' || principal.ownerId !== required.expected.scope.ownerId
        || required.context.scope.ownerId !== required.expected.scope.ownerId || required.context.scope.workspaceId !== required.expected.scope.workspaceId)
        return localFailure({ code: 'forbidden', message: 'Owner tool scope unavailable' });
    return { ok: true, value: undefined };
}

/** Boot one explicitly owned local database: validate config, provision owner, prepare assets,
 * migrate on one checked kernel, persist workspace, bind HTTP, then publish discovery/readiness.
 * Every failed step closes acquired resources. The forms worker and fixed sandbox child start here.
 * @example await bootServer({ env, io, clock, ids, observer });
 * @returns A loopback bootstrap URL and stop handle, or a stable typed startup failure.
 * @complexity Bounded migration batch; no unbounded work or scheduling queue.
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
        const services: OwnerServices & OmFeatureServices = {
            campaigns: createSqlCampaignRepo({ db: campaignDb }, { observer: required.observer }),
            safety: createSqlSafetyRepo({ db: safetyDb, clock: required.clock, ids: required.ids, ownerTimezone: config.value.timezone, observer: required.observer }),
            confirmations: resources.confirmations, integrations,
        };
        resources.addons = bindBootAddons({ ...required, context, db: campaignDb, stateRoot: config.value.stateRoot, integrations });
        services.addons = resources.addons?.addons;
        services.handleChartRequest = resources.addons?.handleChartRequest;
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
        const publicServices = { forms, identity, visits, clock: required.clock, campaigns: services.campaigns,
            links: createSqlTrackedLink({ database: measureDb, ids: required.ids, baseUrl: 'https://sandbox.example.test/l/', allowedOrigins: ['https://sandbox.example.test'] }, { observer: required.observer }) };
        services.formSubjects = forms.subjects;
        const audit = bindCatalogAudit({ unit: database.unit, clock: required.clock, ids: required.ids, observer: required.observer });
        Object.assign(services, bindCatalogScope({ database, safetyDb, clock: required.clock, ids: required.ids, observer: required.observer, timezone: config.value.timezone }), {
            creative: bindSandboxCreative({ unit: database.unit, safetyRepo: services.safety, confirmations: resources.confirmations, clock: required.clock, ids: required.ids, observer: required.observer, audit }),
            campaignWorkflow: bindSandboxCampaigns({ unit: database.unit, repo: services.campaigns, safety: services.safety, clock: required.clock, ids: required.ids, observer: required.observer, audit }),
            audit, contacts: identity.contacts, forms: forms.forms, webEvents: identity.webEvents, privacy: resources.privacy.privacy,
            measure: bindCatalogMeasure({ repo: measure, links: publicServices.links, reports: sandboxPlatformReports(required), clock: required.clock, ids: required.ids, observer: required.observer, audit }),
        });
        resources.workers = createFormWorkers({ unit: database.unit, forms, creative: services.creative, clock: required.clock, ids: required.ids, observer: required.observer, context, schedule: required.io.schedule });
        // Migration 17 supplies these table types on the existing kernel; this assertion opens no second kernel.
        const chatKernel = database.kernel as unknown as StorageKernel<AssistantDatabase>;
        const conversations = createConversations({ db: campaignDb, ids: required.ids, observer: required.observer, integrations,
            stores: ({ scope }) => createSqliteChatStore({ kernel: chatKernel, scope }, { clock: { nowMs: () => required.clock.now({}) } }) });
        const persistence = createAssistantRuns({ kernel: chatKernel, conversations, clock: required.clock, ids: required.ids, observer: required.observer,
            durable: createDurableRunStore({ kernel: chatKernel, isDaemonRunId: () => true }),
            ledger: createChatRunLedger({ kernel: chatKernel, isDaemonRunId: () => true }) });
        const interrupted = await persistence.initialize({ context });
        if (!interrupted.ok) throw new Error('Assistant recovery unavailable');
        services.conversations = conversations;
        const model = { credentials: bindModelCredentials({ integrations, persistence }), upstream: required.io.modelUpstream ?? createModelUpstream({ fetch }) };
        resources.frontend = createFrontendSessions({ clock: required.clock, ids: required.ids, schedule: required.io.schedule, randomToken: required.io.randomToken,
            authorize: input => input.context.principal.kind === 'owner' ? scopedOwnerAuthority({ context: input.context, expected: context! })
                : resources.agent?.authorize(input) ?? localFailure({ message: 'Agent authority unavailable' }),
            disconnected: input => resources.tools?.cancel(input) });
        services.ui = { runtime: { clock: required.clock, ids: required.ids }, frontend: resources.frontend.frontend, sessions: resources.frontend };
        resources.agent = createLocalAgent({ effects: required.io.agentEffects ?? createNodeAgentEffects({ projectRoot: required.io.projectRoot, ids: required.ids }),
            clock: required.clock, ids: required.ids, observer: required.observer, randomToken: required.io.randomToken, persistence,
            frontend: resources.frontend, onRevoked: input => { resources.tools?.cancel(input); resources.frontend?.endRun(input); } });
        services.runs = resources.agent.owner;
        resources.tools = createOmTools({ clock: required.clock, observer: required.observer, confirmations: resources.confirmations,
            authorize: input => input.context.principal.kind === 'owner'
                ? scopedOwnerAuthority({ context: input.context, expected: context! })
                : resources.agent!.authorize(input),
            definitions: input => buildOmToolDefinitions({ ...input, services,
                addons: services.addons ? { addons: services.addons, integrations, observer: required.observer } : undefined }) });
        services.tools = resources.tools;
        const agent = resources.agent;
        const bootContext = context;
        resources.app = createServerApp({ listener, handle: request => handleBootRequest({ request, auth, listener, fs: required.io.fs,
            studioRoot: assets.value, context: bootContext, services, integrations, ids: required.ids, publicServices, agent, model, clock: required.clock, observer: required.observer }) });
        const started = await resources.app.start({});
        if (!started.ok) { await stopResources({ resources }); return started; }
        const origin = listener.origin({});
        if (!origin) { await stopResources({ resources }); return localFailure({ message: 'Local server address unavailable' }); }
        phase = 'sandbox agent';
        const agentStarted = await agent.start({ serverUrl: origin });
        if (!agentStarted.ok) { await stopResources({ resources }); return agentStarted; }
        phase = 'add-ons';
        const addonsStarted = await startBootAddons({ resources });
        if (!addonsStarted.ok) { await stopResources({ resources }); return addonsStarted; }
        const workersStarted = resources.workers.start({});
        if (!workersStarted.ok) { await stopResources({ resources }); return workersStarted; }
        phase = 'readiness';
        await writeLocalEndpoint({ fs: required.io.fs, stateRoot: config.value.stateRoot, serverUrl: origin });
        const studioUrl = auth.studioUrl({ origin });
        required.io.ready({ studioUrl });
        observeBoot({ ...required, context, operation: 'server.boot', outcome: 'ready' });
        return { ok: true, value: { studioUrl, stop: () => stopResources({ resources }) } };
    } catch {
        return failedBoot({ resources, context, observer: required.observer, phase });
    }
}

/** Add-ons are optional when the boot IO supplies no add-on effects. */
async function startBootAddons(required: { resources: BootResources }): Promise<Outcome<unknown>> {
    return (await required.resources.addons?.start()) ?? { ok: true, value: undefined };
}

/** Failed startup releases acquired resources before reporting its phase; diagnostics are optional. */
async function failedBoot(required: { resources: BootResources; context?: CallContext; observer: ObserverPort; phase: string }): Promise<Outcome<never>> {
    await stopResources(required);
    if (required.context) observeBoot({ observer: required.observer, context: required.context, operation: 'server.boot', outcome: 'failed' });
    return localFailure({ message: `Local server startup failed during ${required.phase}` });
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

/** Bind the selected run's settings to the server-only sealed connection resolver.
 * @example bindModelCredentials({ integrations, persistence });
 * @complexity One scoped context read plus one fresh credential access; no credential cache.
 */
export function bindModelCredentials(required: { integrations: Integrations; persistence: AssistantRuns }): ModelCredentials {
 return { async resolveProviderKey({ grant, signal }) {
  const current = await required.persistence.context({ grant });
  if (!current.ok) return current;
  if (!('settings' in current.value) || current.value.settings.mode !== 'model') return localFailure({ code: 'forbidden', message: 'Model configuration unavailable' });
  const settings = current.value.settings;
  const context: CallContext = { scope: grant.scope, principal: { kind: 'service', serviceId: 'om-model-broker' }, runId: grant.runId, correlationId: grant.grantId, traceId: grant.grantId };
  const secret = settings.connectionId === null
   ? await required.integrations.resolveProviderKey({ context, provider: 'anthropic' }, { signal })
   : await required.integrations.access({ context, pluginId: 'anthropic', connectionId: settings.connectionId }, { signal });
  if (!secret.ok) return secret;
  return { ok: true, value: { apiKey: typeof secret.value === 'string' ? secret.value : secret.value.accessToken, model: settings.model } };
 } };
}
/** Host-only provider I/O. Broker fixes the URL and rechecks run authority before every request. */
function createModelUpstream(required: { fetch: typeof fetch }): ModelUpstream {
 return { send: input => required.fetch(input.url, { method: 'POST', headers: input.headers, body: input.body, signal: input.signal, redirect: input.redirect }),
  deadline({ timeoutMs }) { const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
   return { signal: controller.signal, dispose: () => clearTimeout(timer) }; } };
}

/** Hosts without native federation I/O fail explicitly; no fake session activation. */
function unavailableAddonSessions(): ExternalMcpSessions {
    return { async reload() { throw new Error('Federation binding unavailable'); }, async close() { /* No session was acquired. */ } };
}

/** Bind D2 only when executable composition supplies native effects and safe YAML.
 * Test/server shell hosts without these adapters retain explicit unavailable owner routes.
 * @complexity O(1) construction; start/dispose remain owned by bootResources.
 */
function bindBootAddons(required: { io: ServerBootIo; context: CallContext; db: CampaignSqlPort; stateRoot: string; clock: ClockPort; ids: IdPort; observer: ObserverPort; integrations: Integrations }): (ReturnType<typeof bindServerAddons> & { federation?: ReturnType<typeof bindAddonFederationSessions> }) | undefined {
    if (!required.io.addonEffects || !required.io.addonYaml) return undefined;
    const federation = !required.io.addonSessions && required.io.addonFederation
        ? bindAddonFederationSessions({ context: required.context, effects: required.io.addonFederation, integrations: required.integrations, observer: required.observer }) : undefined;
    const binding = bindServerAddons({ ...required, projectRoot: required.io.projectRoot,
        effects: required.io.addonEffects({ clock: required.clock, ids: required.ids }), yamlReader: required.io.addonYaml,
        sessions: required.io.addonSessions ?? federation ?? unavailableAddonSessions() });
    return { ...binding, federation };
}

import { bindSandboxCreative } from './creative.js';
import { createNoopObservabilityPort, type ObservabilityPort } from '@jini-ai/diagnostics/observability';
import { createRecentEvents } from '../recent-events.js';
import { bindSandboxCampaigns, bindPausedCampaignDeployment } from './campaigns.js';
import { bindCatalogAudit, catalogAuditPort, bindCatalogScope, bindCatalogMeasure, bindCatalogMedia, createCatalogMediaEffects, sandboxPlatformReports } from './catalog.js';
import type { OmFeatureServices } from '../om-tools.js';
import { bindServerAddons, type AddonEffects } from './addons.js';
import { createSqlToolOperationStore } from '../tool-operations.js';
import { buildOmToolDefinitions, createOmTools, toolInputSchema } from '../om-tools.js';
import { runOmSiteGuide, siteGuideInputSchema } from '../site-guide.js';
import type { OmTools, OmToolDefinition } from '../om-tools.js';
import type { YamlReaderPort } from '@jini-ai/agentic/skills/install';
import type { ExternalMcpSessions } from '../external-mcp.js';
import { bindAddonFederationSessions } from './addon-federation.js';
import { bindAgentPluginBackends, bindAgentPluginJobs } from './agent-plugin-backends.js';
import type { AgentPluginEffects } from './agent-plugin-backends.js';
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
    createMemoryCredentialLock, createSqlCredentialAudit, createSqlCredentialRepo, createJiniOAuthClient, createJiniCredentialRefresh } from '@open-marketing/credentials';
import type { KeyringConfiguration, OAuthClientPort, CredentialBrokerPort } from '@open-marketing/credentials';
import { createPendingAuthorizationStore, type OAuthHttpPorts } from '@jini-ai/oauth';
import { metaOAuthChallengeRules, oauthCallbackPath, oauthMetadataSchema, type IntegrationOAuthProvider } from '../integration-oauth-contracts.js';
import { createVendorOAuthBindings } from '../integration-oauth-vendors.js';
import { createIntegrations, type Integrations, type IntegrationDependencies } from '../integrations.js';
import { handleIntegrationRequest, handleOAuthBrowserCallback } from '../inbound/integrations.js';
import { bindForms, seedSandboxForm } from './forms.js';
import { bindIdentity, createVisitTokens, localKey } from './identity.js';
import { createSqlContactRepo } from '@open-marketing/contacts';
import { createSubjectLane } from './subject-lane.js';
import { bindPrivacy } from './privacy.js';
import { bindAgentPluginHaltJobs, createFormWorkers } from './workers.js';
import { createLocalAgent, createNodeAgentEffects, type AgentEffects } from './agent.js';
import { createFrontendSessions, type FrontendSessions } from '../inbound/frontend.js';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { CallContext, ClockPort, IdPort, ObserverPort, Outcome, UnitOfWork } from '@open-marketing/contracts';
import { z } from 'zod';
import { createSqlCampaignRepo, type CampaignSqlPort } from '@open-marketing/campaigns';
import { createMemoryAccountDispatchLock, createSqlConfirmationExchange, createSafetyService, createSqlSafetyRepo, type AccountDispatchLockPort, type ConfirmationExchangePort, type SafetySqlDatabase } from '@open-marketing/safety';
import { handleOwnerRequest, type OwnerServices } from '../inbound/owner.js';
import type { HttpRequest, HttpListenerPort, LifecyclePort, HttpResponse } from '../ports.js';
import { handleOmRequest, type RunGrantVerifierPort } from '../inbound/om.js';
import { createNodeHttpListener, prepareStudioAssets, serveStudioAsset, type HttpEffects, type NodeHttpListener } from '../inbound/http.js';
import { bindServerDatabase, provisionWorkspace } from './database.js';
import { loadMigrations } from './migrations.js';
import { runMigrations } from '../platform/jini-compat/db/src/index.js';
import { createLocalAuth, localApprover, localFailure, parseLocalEnvironment, provisionLocalOwner, readLocalFile, writeLocalEndpoint, type LocalFilesystem } from './local-auth.js';

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
    readonly agentPlugins?: AgentPluginEffects;
    readonly modelUpstream?: ModelUpstream;
    readonly oauth?: OAuthHttpPorts;
    readonly loadCredentialMaster?: (required: { configuration: KeyringConfiguration; masterHex?: string }) => Promise<Outcome<Uint8Array>>;
}
/** Explicit owned lifecycle returned after successful boot. stop is idempotent and closes SQLite last. */
export interface BootedServer { readonly studioUrl: string; stop(required: Record<string, never>): Promise<Outcome<void>> }
interface BootResources { recentEvents?: ReturnType<typeof createRecentEvents>; frontend?: FrontendSessions; tools?: OmTools; addons?: ReturnType<typeof bindBootAddons>; native?: Database.Database; app?: LifecyclePort; confirmations?: ConfirmationExchangePort; workers?: ReturnType<typeof createFormWorkers>; privacy?: ReturnType<typeof bindPrivacy>; agent?: ReturnType<typeof createLocalAgent>; stopped?: Promise<Outcome<void>> }

/** Best-effort low-cardinality lifecycle diagnostics; no credential/token or raw exception details. */
function observeBoot(required: { observer: ObserverPort; context: CallContext; operation: string; outcome: string }): void {
    try { required.observer.observe({ operation: required.operation, outcome: required.outcome,
        correlationId: required.context.correlationId, traceId: required.context.traceId }); }
    catch { /* Observer failure cannot change committed work or readiness. */ }
}

/** Recovery is best effort: retain pending evidence and let the bounded worker retry after readiness.
 * @complexity One recovery call; failed projection never closes otherwise healthy server resources.
 */
async function recoverBootCreative(required: { creative: OmFeatureServices['creative']; context: CallContext; observer: ObserverPort }): Promise<void> {
    if (!required.creative) return;
    try {
        const recovered = await required.creative.service.recover({ context: required.context });
        if (!recovered.ok) observeBoot({ ...required, operation: 'server.boot.creative', outcome: recovered.error.code });
    } catch { observeBoot({ ...required, operation: 'server.boot.creative', outcome: 'unavailable' }); }
}

/** Cleanup continues after an explicit/throwing port failure; no acquired service is skipped. */
async function stopService(required: { service?: Pick<LifecyclePort, 'stop'>; message: string }): Promise<Outcome<void>> {
    try { return required.service ? await required.service.stop({}) : { ok: true, value: undefined }; }
    catch { return localFailure({ message: required.message }); }
}

/** Both tool and frontend disposal reject on incomplete persistence; cleanup still continues. */
async function disposeService(required: { service?: Pick<OmTools, 'dispose'>; message: string }): Promise<Outcome<void>> {
    try { await required.service?.dispose({}); return { ok: true, value: undefined }; }
    catch { return localFailure({ message: required.message }); }
}

/** Close admission, revoke/reap the agent, stop workers, and close SQLite last. */
async function closeResources(required: { resources: BootResources }): Promise<Outcome<void>> {
    const tools = disposeService({ service: required.resources.tools, message: 'Tool cleanup failed' });
    const frontend = await disposeService({ service: required.resources.frontend, message: 'Frontend cleanup failed' });
    let result = await stopService({ service: required.resources.app, message: 'Server transport cleanup failed' });
    const agent = await stopService({ service: required.resources.agent, message: 'Sandbox agent cleanup failed' });
    const toolResult = await tools;
    if (!toolResult.ok) result = toolResult;
    if (!frontend.ok) result = frontend;
    if (!agent.ok) result = agent;
    const workers = await stopService({ service: required.resources.workers, message: 'Worker cleanup failed' });
    if (!workers.ok) result = workers;
    try {
        const addons = await required.resources.addons?.dispose();
        if (addons && !addons.ok) result = addons;
    } catch { result = localFailure({ message: 'Add-on cleanup failed' }); }
    required.resources.privacy?.participants.dispose({});
    required.resources.recentEvents?.dispose({});
    try { if (required.resources.native?.open) required.resources.native.close(); }
    catch { return localFailure({ message: 'SQLite cleanup failed' }); }
    return result;
}

function stopResources(required: { resources: BootResources }): Promise<Outcome<void>> {
    return required.resources.stopped ??= closeResources(required);
}

type BootRequestInput = {
    request: HttpRequest; auth: ReturnType<typeof createLocalAuth>; listener: NodeHttpListener;
    fs: LocalFilesystem; studioRoot: string; context: CallContext; services: OwnerServices; integrations: Integrations; ids: IdPort; agent: ReturnType<typeof createLocalAgent>; clock: ClockPort; observer: ObserverPort; model: { credentials: ModelCredentials; upstream: ModelUpstream; usage?: Parameters<typeof handleModelRequest>[0]['usage'] }; publicServices: Omit<Parameters<typeof handlePublicRequest>[0], 'request' | 'context'>;
};
/** Authenticate before bodies and derive owner scope locally. Studio configuration is supplied
 * in same-origin HTML; the owner cookie stays HttpOnly. Public ingress never uses owner auth.
 */
async function handleBootRequest(required: BootRequestInput): Promise<HttpResponse> {
    const origin = required.listener.origin({});
    if (!origin) return { status: 503, body: localFailure({ message: 'Server is stopping' }) };
    if (required.request.method === 'GET' && required.request.path === oauthCallbackPath) return handleOAuthBrowserCallback(required);
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
    if (required.request.path.startsWith('/api/agent/')) return handleOmRequest({ request: required.request, grants: required.agent.grants, callbacks: required.agent.callbacks, clock: required.clock, tools: required.services.tools, ids: required.ids });
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
}, optional: { observability?: ObservabilityPort } = {}): Promise<Outcome<BootedServer>> {
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
        const safetyDb: SafetySqlDatabase = database.unit;
        resources.confirmations = createSqlConfirmationExchange({ db: safetyDb, clock: required.clock, ids: required.ids,
            recordAnswer: async ({ session, context, answer }) => {
                const audit = bindCatalogAudit({ ...required, unit: session });
                const recorded = await audit.record({ context, entry: { kind: 'approval', operationId: answer.response.operationId,
                    argumentsDigest: answer.response.argumentsDigest, references: [answer.response.cardId],
                    approval: { response: answer.response, approver: answer.approver } } });
                return recorded.ok ? { ok: true, value: undefined } : recorded;
            } });
        const campaignDb: CampaignSqlPort = database.workspace;
        const integrations = bindServerIntegrations({ db: campaignDb, clock: required.clock, ids: required.ids,
            observer: required.observer, io: required.io, stateRoot: config.value.stateRoot, masterHex: required.env.OM_CREDENTIAL_KEY,
            providers: await loadOAuthProviders({ io: required.io }),
            agentPluginState: async input => resources.addons?.agentPluginState(input) ?? null,
            readCredentialCards: async input => resources.addons?.readCredentialCards(input) ?? localFailure({ message: 'Connection cards unavailable' }),
            readCredentialAsset: async input => resources.addons?.readCredentialAsset(input) ?? localFailure({ message: 'Connection asset unavailable' }),
            redirectUri: () => { const origin = listener.origin({}); return origin ? origin + oauthCallbackPath : null; } });
        const services: OwnerServices & OmFeatureServices = {
            recentEvents: resources.recentEvents = createRecentEvents({ clock: required.clock, observer: required.observer }),
            observability: optional.observability ?? createNoopObservabilityPort({}),
            campaigns: createSqlCampaignRepo({ db: campaignDb }, { observer: required.observer }),
            safety: createSqlSafetyRepo({ db: safetyDb, clock: required.clock, ids: required.ids, ownerTimezone: config.value.timezone, observer: required.observer }),
            confirmations: resources.confirmations, integrations, approver: localApprover({ credentials: credentials.value }),
        };
        resources.addons = bindBootAddons({ ...required, context, db: campaignDb, unit: database.unit, stateRoot: config.value.stateRoot, integrations });
        services.addons = resources.addons?.addons;
        services.handleChartRequest = resources.addons?.handleChartRequest;
        const visits = createVisitTokens({ key: localKey({ ownerToken: credentials.value.token, domain: 'visits' }), clock: required.clock, ids: required.ids });
        const digestKey = localKey({ ownerToken: credentials.value.token, domain: 'contacts' });
        const subjectLane = createSubjectLane({ resolveSubject: createSqlContactRepo({ uow: database.unit }).get });
        const identity = bindIdentity({ unit: database.unit, clock: required.clock, ids: required.ids, observer: required.observer, digestKey, tokens: visits.tokens, subjectLane });
        const forms = bindForms({ database, clock: required.clock, ids: required.ids, observer: required.observer, digestKey, tokens: visits.tokens, subjectLane });
        await seedSandboxForm({ binding: forms, context, clock: required.clock, ids: required.ids });
        const measureDb: MeasureSqlDatabase = database.workspace;
        const measure = createSqlMeasureRepo({ database: measureDb, jobs: { async enqueue() { return localFailure({ code: 'forbidden', message: 'Conversions denied in local sandbox' }); } } }, { observer: required.observer });
        resources.privacy = bindPrivacy({ unit: database.unit, identity, subjects: forms.subjects, measure, clock: required.clock, ids: required.ids, observer: required.observer, subjectLane });
        const publicServices = { forms, identity, visits, clock: required.clock, campaigns: services.campaigns,
            links: createSqlTrackedLink({ database: measureDb, ids: required.ids, baseUrl: 'https://sandbox.example.test/l/', allowedOrigins: ['https://sandbox.example.test'] }, { observer: required.observer }) };
        services.formSubjects = forms.subjects;
        const audit = bindCatalogAudit({ unit: database.unit, clock: required.clock, ids: required.ids, observer: required.observer });
        const media = bindCatalogMedia({ db: campaignDb, context, clock: required.clock, ids: required.ids, observer: required.observer, audit,
            effects: createCatalogMediaEffects({ stateRoot: config.value.stateRoot, clock: required.clock }) });
        Object.assign(services, bindCatalogScope({ database, safetyDb, clock: required.clock, ids: required.ids, observer: required.observer, timezone: config.value.timezone }), {
            media,
            creative: bindSandboxCreative({ unit: database.unit, media, safetyRepo: services.safety, confirmations: resources.confirmations, clock: required.clock, ids: required.ids, observer: required.observer, audit }),
            campaignWorkflow: bindSandboxCampaigns({ unit: database.unit, repo: services.campaigns, safety: services.safety, clock: required.clock, ids: required.ids, observer: required.observer, audit }),
            audit, contacts: identity.contacts, forms: forms.forms, webEvents: identity.webEvents, privacy: resources.privacy.privacy,
            measure: bindCatalogMeasure({ repo: measure, links: publicServices.links, reports: sandboxPlatformReports(required), clock: required.clock, ids: required.ids, observer: required.observer, audit }),
        });
        // Migration 17 supplies these table types on the existing kernel; this assertion opens no second kernel.
        const chatKernel = database.kernel as unknown as StorageKernel<AssistantDatabase>;
        const conversations = createConversations({ db: campaignDb, kernel: chatKernel, ids: required.ids, observer: required.observer, integrations,
            stores: ({ scope }) => createSqliteChatStore({ kernel: chatKernel, scope }, { clock: { nowMs: () => required.clock.now({}) } }) });
        const persistence = createAssistantRuns({ kernel: chatKernel, conversations, clock: required.clock, ids: required.ids, observer: required.observer,
            durable: createDurableRunStore({ kernel: chatKernel, isDaemonRunId: () => true }),
            ledger: createChatRunLedger({ kernel: chatKernel, isDaemonRunId: () => true }, { now: () => required.clock.now({}) }) });
        const interrupted = await persistence.initialize({ context });
        if (!interrupted.ok) throw new Error('Assistant recovery unavailable');
        services.conversations = conversations;
        const model = { usage: { db: campaignDb, ids: required.ids }, credentials: bindModelCredentials({ integrations, persistence }), upstream: required.io.modelUpstream ?? createModelUpstream({ fetch }) };
        resources.frontend = createFrontendSessions({ clock: required.clock, ids: required.ids, schedule: required.io.schedule, randomToken: required.io.randomToken,
            authorize: input => input.context.principal.kind === 'owner' ? scopedOwnerAuthority({ context: input.context, expected: context! })
                : resources.agent?.authorize(input) ?? localFailure({ message: 'Agent authority unavailable' }),
            disconnected: async input => { await resources.tools?.cancel(input); } });
        services.ui = { runtime: { clock: required.clock, ids: required.ids }, frontend: resources.frontend.frontend, sessions: resources.frontend };
        resources.agent = createLocalAgent({ effects: required.io.agentEffects ?? createNodeAgentEffects({ projectRoot: required.io.projectRoot, ids: required.ids }),
            clock: required.clock, ids: required.ids, observer: required.observer, randomToken: required.io.randomToken, persistence,
            frontend: resources.frontend, onRevoked: async input => { await resources.frontend?.endRun(input); await resources.tools?.cancel(input); } });
        services.runs = resources.agent.owner;
        const accountLocks = createMemoryAccountDispatchLock({ ids: required.ids });
        const pluginBackends = bindBootPluginBackends({ io: required.io, addons: resources.addons, services, integrations, accountLocks, confirmations: resources.confirmations, subjectLane,
            policyForTransaction: ({ unit }) => bindIdentity({ unit, clock: required.clock, ids: required.ids, observer: required.observer, digestKey, tokens: visits.tokens, subjectLane }).policy,
            unit: database.unit, clock: required.clock, ids: required.ids, observer: required.observer });
        const halt = bindBootHalt({ ...required, unit: database.unit, services, audit, accountLocks, confirmations: resources.confirmations, pluginBackends });
        const campaignUnavailable = async () => localFailure<never>({ code: 'not_implemented', message: 'NEEDS: admitted plugin binding and scoped campaign metadata' });
        services.campaignDeployment = bindPausedCampaignDeployment({ ...required, unit: database.unit, repo: services.campaigns,
            safety: halt.safety, confirmations: resources.confirmations,
            prepare: input => pluginBackends?.prepareCampaign(input) ?? campaignUnavailable(),
            definitions: input => pluginBackends?.definitions(input) ?? campaignUnavailable(),
            execute: input => pluginBackends?.executeCampaign(input) ?? campaignUnavailable(), read: input => pluginBackends?.readCampaign(input) ?? campaignUnavailable() });
        Object.assign(services, { safety: { ...services.safety, halt: halt.halt } });
        resources.workers = createFormWorkers({ unit: database.unit, forms, creative: services.creative, halt, clock: required.clock, ids: required.ids, observer: required.observer, context, schedule: required.io.schedule });
        const siteGuideCatalog = await loadSiteGuideCatalog({ ...required, context });
        const authorize: Parameters<typeof createOmTools>[0]['authorize'] = input => input.context.principal.kind === 'owner'
                ? scopedOwnerAuthority({ context: input.context, expected: context! })
                : resources.agent!.authorize(input);
        const siteGuide: OmToolDefinition = {
            name: 'site_guide', capability: 'How Open Marketing works', description: 'Read OM capability overview, then explain one topic with fresh scoped facts. Help grants no action authority.',
            effects: ['read'], policy: 'read', revision: '1', inputSchema: toolInputSchema({ schema: siteGuideInputSchema }),
            parse: input => { const parsed = siteGuideInputSchema.safeParse(input.input); return parsed.success ? { ok: true, value: parsed.data } : localFailure({ code: 'invalid_input', message: 'Invalid guide input' }); },
            invoke: input => runOmSiteGuide({ ...input, catalog: siteGuideCatalog, tools: resources.tools!, ids: required.ids, definitions, authorize }, { signal: input.signal }),
        };
        const definitions: Parameters<typeof createOmTools>[0]['definitions'] = async input => {
                const base = await buildOmToolDefinitions({ ...input, services, siteGuide,
                    addons: services.addons ? { addons: services.addons, integrations, observer: required.observer } : undefined });
                if (!base.ok) return base;
                const plugins = await pluginBackends?.definitions(input);
                if (plugins && !plugins.ok) return plugins;
                const mcp = await resources.addons?.federation?.definitions(input);
                if (mcp && !mcp.ok) return mcp;
                return { ok: true, value: [...base.value, ...(plugins?.value ?? []), ...(mcp?.value ?? [])] };
            };
        resources.tools = createOmTools({ store: createSqlToolOperationStore({ unit: database.unit }), clock: required.clock, observer: required.observer,
            confirmations: resources.confirmations, authorize, definitions });
        await restoreTools({ tools: resources.tools, context });
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
        phase = 'creative recovery';
        await recoverBootCreative({ creative: services.creative, context, observer: required.observer });
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

/** Boot-only bounded help loading. A missing catalog disables help without blocking the app.
 * @complexity O(b) time/space, b <=64 KiB; one injected local file read, no vendor effects. */
async function loadSiteGuideCatalog(required: { io: ServerBootIo; observer: ObserverPort; context: CallContext }): Promise<unknown> {
    try { return JSON.parse((await readLocalFile({ fs: required.io.fs, path: join(required.io.projectRoot,
        'content/agent-plugins/om-playbook/skills/om-playbook/references/om-site-guide.json'), maxBytes: 64512 })).toString('utf8')); }
    catch { observeBoot({ observer: required.observer, context: required.context, operation: 'site-guide.load', outcome: 'unavailable' }); return undefined; }
}

/** Boot admission stays closed until all operation recovery transitions have persisted. */
async function restoreTools(required: { tools: OmTools; context: CallContext }): Promise<void> {
    const restored = await required.tools.restore({ context: required.context });
    if (!restored.ok) throw new Error('Tool operation recovery unavailable');
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
 * OAuth adapters are lazy until the listener has its exact loopback redirect. Key reads are injected;
 * Meta rechecks server plugin admission for each request; missing lifecycle state denies egress.
 * importing/constructing integrations opens no file, listener, database or vendor connection.
 * @example const integrations = bindServerIntegrations({ db, clock, ids, observer, io, stateRoot });
 * @complexity O(1) construction; bounded repository/crypto work belongs to the supplied adapters.
 */
export function bindServerIntegrations(required: {
    db: CampaignSqlPort; clock: ClockPort; ids: IdPort; observer: ObserverPort; io: ServerBootIo; stateRoot: string; masterHex?: string;
    providers?: ReadonlyMap<string, IntegrationOAuthProvider>; redirectUri?: () => string | null;
    agentPluginState?: NonNullable<ReturnType<typeof bindBootAddons>>['agentPluginState'];
    readCredentialCards?: IntegrationDependencies['readCredentialCards']; readCredentialAsset?: IntegrationDependencies['readCredentialAsset'];
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
    const providers = required.providers ?? new Map<string, IntegrationOAuthProvider>();
    const challengeRules = new Map([['meta-ads', metaOAuthChallengeRules]]);
    const randomBytesFn = ({ byteLength }: { byteLength: number }) => new Uint8Array(Buffer.from(z.string().regex(/^[a-f0-9]{64}$/).parse(required.io.randomToken({})), 'hex').subarray(0, byteLength));
    const pending = createPendingAuthorizationStore({ clock: { nowMs: () => required.clock.now({}) }, randomBytesFn });
    const http = required.io.oauth;
    const dependencies = http ? { ...http, providers, clock: required.clock, sealer, observer: required.observer } : undefined;
    const broker: CredentialBrokerPort = createCredentialBroker({ repo, sealer, locks, audit, refresh: dependencies ? { refresh: (input, options) =>
        createJiniCredentialRefresh({ ...dependencies, clientCredentials: { repo, broker } }).refresh(input, options) } : undefined });
    let oauth: OAuthClientPort | undefined;
    const service = createCredentialService({ repo, sealer, keyring, locks, audit, clock: required.clock, challengeRules,
        oauth: {
            async begin(input, options) {
                const redirect = required.redirectUri?.();
                if (!dependencies || !redirect) return localFailure({ message: 'OAuth configuration unavailable' });
                oauth ??= createJiniOAuthClient({ ...dependencies, clientCredentials: { repo, broker }, pending, randomBytesFn, ids: required.ids, allowedReturnUris: [redirect], challengeRules,
                    allowedAuthorizationOrigins: [...providers.values()].map(value => new URL(value.provider.authorizationEndpoint!).origin),
                    bindings: ({ standard }) => createVendorOAuthBindings({ standard, metadata: providers.get('meta-ads'), repo, broker, sealer,
                        pending, randomBytesFn, clock: required.clock, http: dependencies, observer: required.observer,
                        admission: async input => {
                            const state = await required.agentPluginState?.(input);
                            return state?.enabled === true && state.bundled && state.admitted;
                        },
                        deadline: { create({ timeoutMs }) {
                            const controller = new AbortController();
                            const dispose = required.io.schedule({ callback: () => controller.abort(), delayMs: timeoutMs });
                            return { signal: controller.signal, dispose };
                        } } }),
                    clientDisplayName: 'Open Marketing', softwareId: 'io.github.ainsep.openmarketing' });
                return oauth.begin(input, options);
            },
            async complete(input, options) { return oauth ? oauth.complete(input, options) : localFailure({ code: 'expired', message: 'Sign-in expired' }); },
        } });
    return createIntegrations({ repo, sealer, locks, audit, broker, service, db: required.db, observer: required.observer, redirectUri: required.redirectUri,
        readCredentialCards: required.readCredentialCards, readCredentialAsset: required.readCredentialAsset });
}

/** Parse plugin metadata; client configuration comes only from sealed storage at use time.
 * @throws On invalid/oversized config or metadata; boot reports a fixed startup failure.
 * @complexity Three bounded local reads, <=16 KiB each; no vendor calls or admission changes.
 */
export async function loadOAuthProviders(required: { io: ServerBootIo }): Promise<ReadonlyMap<string, IntegrationOAuthProvider>> {
    const providers = new Map<string, IntegrationOAuthProvider>();
    for (const id of ['google-ads', 'linkedin-ads', 'meta-ads']) {
        const metadata = oauthMetadataSchema.parse(JSON.parse((await readLocalFile({ fs: required.io.fs,
            path: join(required.io.projectRoot, 'content/agent-plugins', id, 'io.github.ainsep.openmarketing/oauth.json'), maxBytes: 16384 })).toString('utf8')));
        if (metadata.provider.providerId !== id) throw new Error('OAuth provider mismatch');
        providers.set(id, metadata);
    }
    return providers;
}

/** Bind the selected run's settings to the server-only sealed connection resolver.
 * @example bindModelCredentials({ integrations, persistence });
 * @complexity One scoped context read plus one fresh credential access; no credential cache.
 */
export function bindModelCredentials(required: { integrations: Pick<Integrations, 'access'>; persistence: AssistantRuns }): ModelCredentials {
 return { async resolveProviderKey({ grant, signal }) {
  const current = await required.persistence.context({ grant });
  if (!current.ok) return current;
  if (!('settings' in current.value) || current.value.settings.mode !== 'model') return localFailure({ code: 'forbidden', message: 'Model configuration unavailable' });
  const settings = current.value.settings;
  const context: CallContext = { scope: grant.scope, principal: { kind: 'service', serviceId: 'om-model-broker' }, runId: grant.runId, correlationId: grant.grantId, traceId: grant.grantId };
  if (!settings.connectionId) return localFailure({ code: 'forbidden', message: 'Run credential was not frozen' });
  const provider = settings.provider ?? 'anthropic';
  const secret = await required.integrations.access({ context, pluginId: provider, connectionId: settings.connectionId }, { signal });
  if (!secret.ok) return secret;
  return { ok: true, value: { apiKey: secret.value.accessToken, model: settings.model, provider, effort: settings.effort } };
 } };
}
/** Host-only provider I/O. Broker fixes the URL and rechecks run authority before every request. */
function createModelUpstream(required: { fetch: typeof fetch }): ModelUpstream {
 return { send: input => required.fetch(input.url, { method: 'POST', headers: input.headers, body: input.body, signal: input.signal, redirect: input.redirect }),
  deadline({ timeoutMs }) { const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
   return { signal: controller.signal, dispose: () => clearTimeout(timer) }; } };
}

/** Local boot supplies read-only account authority; fixture compositions inject financial safety
 * separately. Missing host effects leave vendor definitions absent, without constructing services. */
function bindBootPluginBackends(required: { io: ServerBootIo; addons: ReturnType<typeof bindBootAddons>; services: OwnerServices & OmFeatureServices;
    policyForTransaction: NonNullable<Parameters<typeof bindAgentPluginBackends>[0]['policyForTransaction']>;
    integrations: Integrations; unit: UnitOfWork; clock: ClockPort; ids: IdPort; observer: ObserverPort; accountLocks: AccountDispatchLockPort; confirmations: ConfirmationExchangePort; subjectLane: ReturnType<typeof createSubjectLane> }): ReturnType<typeof bindAgentPluginBackends> | undefined {
    if (!required.io.agentPlugins || !required.addons || !required.services.accountBindings) return undefined;
    return bindAgentPluginBackends({ ...required.io.agentPlugins, projectRoot: required.io.projectRoot, clock: required.clock, observer: required.observer,
        unit: required.unit, policyForTransaction: required.policyForTransaction, subjectLane: required.subjectLane,
        state: required.addons.agentPluginState, integrations: required.integrations, accounts: required.services.accountBindings, safetyRepo: required.services.safety,
        jobs: bindAgentPluginJobs(required), mode: 'read_only', accountLocks: required.accountLocks, confirmations: required.confirmations });
}

/** The local host commits halt through SafetyService under the same vendor-write barrier.
 * No verified remote entity inventory exists locally, so it queues no guessed stop targets. */
function bindBootHalt(required: { services: OwnerServices; audit: Parameters<typeof catalogAuditPort>[0]['audit'];
    unit: UnitOfWork; clock: ClockPort; ids: IdPort; observer: ObserverPort; accountLocks: AccountDispatchLockPort;
    confirmations: ConfirmationExchangePort; pluginBackends?: ReturnType<typeof bindAgentPluginBackends> }) {
    const unavailable = async () => localFailure<never>({ code: 'forbidden', message: 'Verified vendor authority is unavailable in local mode' });
    const safety = createSafetyService({ repo: required.services.safety, confirmations: required.confirmations,
        accountLocks: required.accountLocks, clock: required.clock, ids: required.ids, audit: catalogAuditPort(required),
        policy: { assess: unavailable }, effects: { resolve: unavailable, verifyGenerationQuote: unavailable, verifyHaltStop: unavailable },
        platformLimits: { get: unavailable } }, { observer: required.observer, haltServiceId: 'om-halt-worker' });
    return { ...bindAgentPluginHaltJobs({ ...required, safety,
        targets: async () => ({ ok: true, value: [] }),
        stop: input => required.pluginBackends?.haltStop(input) ?? unavailable() }), safety };
}

/** Hosts without native federation I/O fail explicitly; no fake session activation. */
function unavailableAddonSessions(): ExternalMcpSessions {
    return { async reload() { throw new Error('Federation binding unavailable'); }, async close() { /* No session was acquired. */ } };
}

/** Bind D2 only when executable composition supplies native effects and safe YAML.
 * Test/server shell hosts without these adapters retain explicit unavailable owner routes.
 * @complexity O(1) construction; start/dispose remain owned by bootResources.
 */
function bindBootAddons(required: { io: ServerBootIo; context: CallContext; db: CampaignSqlPort; unit: UnitOfWork; stateRoot: string; clock: ClockPort; ids: IdPort; observer: ObserverPort; integrations: Integrations }): (ReturnType<typeof bindServerAddons> & { federation?: ReturnType<typeof bindAddonFederationSessions> }) | undefined {
    if (!required.io.addonEffects || !required.io.addonYaml) return undefined;
    let binding: ReturnType<typeof bindServerAddons>;
    const federation = !required.io.addonSessions && required.io.addonFederation
        ? bindAddonFederationSessions({ context: required.context, effects: required.io.addonFederation, integrations: required.integrations, observer: required.observer,
            pluginState: input => binding.agentPluginState(input),
            jobs: bindAgentPluginJobs({ unit: required.unit, clock: required.clock, ids: required.ids, observer: required.observer }) }) : undefined;
    binding = bindServerAddons({ ...required, projectRoot: required.io.projectRoot,
        effects: required.io.addonEffects({ clock: required.clock, ids: required.ids }), yamlReader: required.io.addonYaml,
        sessions: required.io.addonSessions ?? federation ?? unavailableAddonSessions() });
    return { ...binding, federation };
}

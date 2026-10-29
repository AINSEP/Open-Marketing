/** Host-owned state, admission, guarded transport and sealing for plugin-owned OAuth exchanges. */
import { beginAuthorizationCode, OAuthError } from '@jini-ai/oauth';
import type { OAuthHttpPorts, OAuthRandomBytes, PendingAuthorizationStore } from '@jini-ai/oauth';
import { readCredentialAccess, readCredentialOAuthClient } from '@open-marketing/credentials';
import type { CredentialBrokerPort, CredentialRepoPort, OAuthHostBindings, SealedSecret, SecretSealerPort } from '@open-marketing/credentials';
import { appErrorSchema, digestSchema } from '@open-marketing/contracts';
import type { AppError, CallContext, CallOptions, ClockPort, ObserverPort, Outcome, PluginCapabilityDependencies } from '@open-marketing/contracts';
import { readFetchResponseText } from '@jini-ai/platform/fetch-with-timeout';
import { z } from 'zod';
import type { IntegrationDependencies } from './integrations.js';
import { credentialOAuthClientFields } from './integration-credential-cards.js';
import type { IntegrationOAuthProvider } from './integration-oauth-contracts.js';
import type { AgentPluginEffects, AgentPluginState } from './composition/agent-plugin-backends.js';

interface VendorDependencies {
    standard: OAuthHostBindings; providers: ReadonlyMap<string, IntegrationOAuthProvider>; repo: CredentialRepoPort; broker: CredentialBrokerPort;
    sealer: SecretSealerPort; pending: PendingAuthorizationStore; clock: ClockPort; http: OAuthHttpPorts;
    randomBytesFn: OAuthRandomBytes; observer: ObserverPort;
    readCredentialCards: IntegrationDependencies['readCredentialCards'];
    agentPluginState?: (required: { context: CallContext; pluginId: string }) => Promise<AgentPluginState | null>;
    loadModule?: AgentPluginEffects['loadModule']; moduleDigest?: AgentPluginEffects['moduleDigest'];
    deadline: { create(required: { timeoutMs: number }): { signal: AbortSignal; dispose(): void } };
}
type GrantInput = Parameters<OAuthHostBindings['exchange']>[0];
type CustomMetadata = Extract<IntegrationOAuthProvider, { exchange: unknown }>;
type Exchange = { exchange(required: { client: unknown; code: string; redirectUri: string; requiredScopes: readonly string[] }, optional?: CallOptions): Promise<unknown> };
type PinnedModule = { revision: string; entryUrl: string; digest: string };
const publicClientSchema = z.object({ clientId: z.string().min(1).max(2048) });
const resultSchema = z.union([z.object({ ok: z.literal(true), value: z.unknown() }),
    z.object({ ok: z.literal(false), error: z.object({ code: appErrorSchema.shape.code.catch('unavailable') }) })]);

/** Select custom exchanges by discovered metadata; standard providers retain their existing bindings.
 * @example createVendorOAuthBindings({ standard, providers, ...hostDependencies });
 * @complexity O(1) dispatch; bounded client/module/HTTP work belongs to the selected call.
 */
export function createVendorOAuthBindings(required: VendorDependencies): OAuthHostBindings {
    return {
        authorize(input, options) {
            const metadata = required.providers.get(input.request.pluginId);
            if (!metadata || !('exchange' in metadata)) return required.standard.authorize(input, options);
            return exchangeBoundary({ deadline: required.deadline, run: signal => authorizePlugin({ dependencies: required, input, metadata }, { ...options, signal }) }, options);
        },
        exchange(input, options) {
            const metadata = required.providers.get(input.request.pluginId);
            if (!metadata || !('exchange' in metadata)) return required.standard.exchange(input, options);
            return exchangeBoundary({ deadline: required.deadline, run: signal => exchangePlugin({ dependencies: required, input, metadata, signal }, options) }, options);
        },
    };
}

/** Build the dialog using only client identity and declared public field mappings, never the secret.
 * @complexity One sealed client read; O(fields), at most two additional authorization parameters.
 */
async function authorizePlugin(required: { dependencies: VendorDependencies; input: Parameters<OAuthHostBindings['authorize']>[0]; metadata: CustomMetadata }, optional?: CallOptions): Promise<Outcome<{ authorizationUrl: string; expiresAt: number }>> {
    const { dependencies, input, metadata } = required;
    const client = await pluginClient({ dependencies, context: input.context, pluginId: input.request.pluginId }, optional);
    if (!client.ok) return client;
    const params: Record<string, string> = {};
    for (const [param, field] of Object.entries(metadata.exchange.authorizationParams)) {
        const parsed = z.string().min(1).max(2048).safeParse(client.value.publicClient[field!]);
        if (!parsed.success) return denied({ code: 'unavailable' });
        params[param] = parsed.data;
    }
    const result = await beginAuthorizationCode({ provider: metadata.provider, client: { clientId: client.value.publicClient.clientId, authMethod: 'none' },
        pending: dependencies.pending, randomBytesFn: dependencies.randomBytesFn, guard: dependencies.http.guard,
        ownerKey: ownerKey(input), redirectUri: input.request.returnUri,
        options: { clientDisplayName: 'Open Marketing', softwareId: 'io.github.ainsep.openmarketing', redirectUris: [input.request.returnUri] },
    }, { scopes: metadata.exchange.authorizationScopes, extraAuthorizationParams: params });
    return { ok: true, value: { authorizationUrl: result.authorizationUrl, expiresAt: Date.parse(result.expiresAt) } };
}

/** Reuse purpose-bound client access; declared extras are retained for the plugin's own parser.
 * @complexity Fixed audited broker I/O and O(client bytes), bounded at 64 KiB; no vendor request.
 */
async function pluginClient(required: { dependencies: VendorDependencies; context: CallContext; pluginId: string }, optional?: CallOptions): Promise<Outcome<{ client: unknown; publicClient: z.infer<typeof publicClientSchema> & Record<string, unknown> }>> {
    const readCards = required.dependencies.readCredentialCards;
    if (!readCards) return denied({ code: 'unavailable' });
    const manifest = await readCards({ context: required.context, pluginId: required.pluginId });
    if (!manifest.ok) return denied({ code: manifest.error.code });
    const fields = credentialOAuthClientFields({ cards: manifest.value.credentialCards });
    const saved = await readCredentialOAuthClient({ ...required.dependencies, pluginId: required.pluginId, clientFields: fields,
        context: { ...required.context, principal: { kind: 'service', serviceId: 'oauth-client' } } }, optional);
    if (!saved.ok) return denied({ code: saved.error.code });
    const parsed = publicClientSchema.safeParse(saved.value);
    if (!parsed.success || !saved.value) return denied({ code: 'unavailable' });
    const publicClient = { ...Object.fromEntries(fields.map(field => [field, saved.value![field]])), ...parsed.data };
    return { ok: true, value: { client: saved.value, publicClient } };
}

/** Consume state before loading executable code or dispatching; seal only a valid complete token payload.
 * @complexity One client read and per-call module load; bounded HTTP is delegated, no retries.
 */
async function exchangePlugin(required: { dependencies: VendorDependencies; input: GrantInput; metadata: CustomMetadata; signal: AbortSignal }, optional?: CallOptions): Promise<Outcome<SealedSecret>> {
    const { dependencies, input, signal } = required;
    const entry = await dependencies.pending.take({ state: input.callback.state, ownerKey: ownerKey(input) });
    if (entry.providerId !== input.request.pluginId || entry.redirectUri !== input.callback.redirectUri) return denied({ code: 'forbidden' });
    if (input.callback.error || !input.callback.code) return denied({ code: 'unauthenticated' });
    const client = await pluginClient({ dependencies, context: input.context, pluginId: input.request.pluginId }, { ...optional, signal });
    if (!client.ok) return client;
    const loaded = await loadExchange({ dependencies, context: input.context, pluginId: input.request.pluginId, signal });
    if (!loaded.ok) return loaded;
    const returned = await loaded.value.exchange({ client: client.value.client, code: input.callback.code,
        redirectUri: entry.redirectUri, requiredScopes: required.metadata.provider.defaultScopes }, { ...optional, signal });
    signal.throwIfAborted();
    const result = resultSchema.parse(returned);
    if (!result.ok) return denied({ code: result.error.code });
    const plaintext = 'om.oauth.v1:' + JSON.stringify(result.value);
    if (!readCredentialAccess({ plaintext }).ok) return denied({ code: 'protocol_mismatch' });
    signal.throwIfAborted();
    return dependencies.sealer.seal({ reference: input.reference, plaintext }, { ...optional, signal });
}

/** Load one current admitted executable; factories, clients and capabilities live for this call only.
 * @complexity One lifecycle read, one digest read and one module load; O(module size) loader work.
 */
async function loadExchange(required: { dependencies: VendorDependencies; context: CallContext; pluginId: string; signal: AbortSignal }): Promise<Outcome<Exchange>> {
    const { dependencies } = required;
    const current = { state: await dependencies.agentPluginState?.({ context: required.context, pluginId: required.pluginId }) };
    if (!isAdmitted(current)) return denied({ code: 'forbidden' });
    const state = current.state;
    if (!dependencies.loadModule || !dependencies.moduleDigest) return denied({ code: 'unavailable' });
    const pin = { revision: state.revision, entryUrl: state.entryUrl, digest: digestSchema.parse(await dependencies.moduleDigest({ moduleUrl: state.entryUrl })) };
    const module = await dependencies.loadModule({ moduleUrl: pin.entryUrl + '?revision=' + pin.revision });
    const factory = (module as { createOAuthExchange?: unknown }).createOAuthExchange;
    if (typeof factory !== 'function') return denied({ code: 'unavailable' });
    const fetch: PluginCapabilityDependencies['fetch'] = (input, init) => guardedFetch({ ...required, pin, input, init });
    const exchange = factory({ fetch, clock: dependencies.clock }) as Exchange;
    if (typeof exchange?.exchange !== 'function') return denied({ code: 'unavailable' });
    return { ok: true, value: exchange };
}

/** An admitted current entry is required even for uploaded plugins; origin never grants authority. */
function isAdmitted(required: { state: AgentPluginState | null | undefined }): required is { state: AgentPluginState & { entryUrl: string } } {
    return required.state?.enabled === true && required.state.admitted && !!required.state.entryUrl;
}

/** Recheck lifecycle and executable identity immediately before each dispatch, without caching authority.
 * @complexity One lifecycle read and one digest read per request; O(executable bytes) digest work.
 */
async function assertCurrent(required: { dependencies: VendorDependencies; context: CallContext; pluginId: string; pin: PinnedModule }): Promise<void> {
    const current = { state: await required.dependencies.agentPluginState?.({ context: required.context, pluginId: required.pluginId }) };
    if (!isAdmitted(current)) throw admissionError({});
    if (current.state.revision !== required.pin.revision || current.state.entryUrl !== required.pin.entryUrl) throw admissionError({});
    const digest = await required.dependencies.moduleDigest?.({ moduleUrl: current.state.entryUrl });
    if (digest !== required.pin.digest) throw admissionError({});
}

/** Foreign fetch ABI wrapper forces GET, correlation and a single shared deadline through guarded IO.
 * @complexity O(b) time/space, b<=64 KiB; one request, no redirects or retry.
 */
async function guardedFetch(required: { dependencies: VendorDependencies; context: CallContext; pluginId: string; pin: PinnedModule; signal: AbortSignal;
    input: Parameters<typeof fetch>[0]; init?: RequestInit }): Promise<Response> {
    const { dependencies } = required;
    const raw = required.input instanceof Request ? required.input.url : String(required.input);
    const url = dependencies.http.guard.assertSafeUrl({ raw, label: 'token endpoint' });
    const headers = new Headers({ 'x-om-correlation-id': required.context.correlationId, 'x-om-trace-id': required.context.traceId });
    if (required.context.runId) headers.set('x-om-run-id', required.context.runId);
    const signals = [required.signal, required.init?.signal, required.input instanceof Request ? required.input.signal : undefined]
        .filter((signal): signal is AbortSignal => !!signal);
    const signal = AbortSignal.any(signals);
    let succeeded = false;
    try {
        await assertCurrent(required);
        signal.throwIfAborted();
        const response = await dependencies.http.fetchFn({ url }, { method: 'GET', headers, signal, redirect: 'error' });
        const body = await readFetchResponseText({ response, maxResponseBytes: 65536, onLimit: 'reject', signal, result: 'details' });
        succeeded = response.ok;
        return new Response(body.text, { status: response.status, statusText: response.statusText, headers: response.headers });
    } finally {
        try { dependencies.observer.observe({ operation: 'credentials.oauth.http', outcome: succeeded ? 'succeeded' : 'failed',
            correlationId: required.context.correlationId, traceId: required.context.traceId, runId: required.context.runId }); }
        catch { /* Telemetry cannot change authority or expose request data. */ }
    }
}

/** One injected, disposed deadline spans the call; no foreign message, URL, body or cause escapes.
 * @complexity O(1) overhead plus bounded supplied operation.
 */
async function exchangeBoundary<T>(required: { deadline: VendorDependencies['deadline']; run: (signal: AbortSignal) => Promise<Outcome<T>> }, optional?: CallOptions): Promise<Outcome<T>> {
    const deadline = required.deadline.create({ timeoutMs: 15000 });
    const signal = AbortSignal.any([deadline.signal, ...(optional?.signal ? [optional.signal] : [])]);
    try { signal.throwIfAborted(); return await required.run(signal); }
    catch (error) {
        if (optional?.signal?.aborted) return denied({ code: 'cancelled' });
        if (signal.aborted) return denied({ code: 'unavailable' });
        return denied({ code: exchangeErrorCode({ error }) });
    } finally { deadline.dispose(); }
}

/** Map only known exception codes; diagnostics never contain foreign text. @complexity O(1). */
function exchangeErrorCode(required: { error: unknown }): AppError['code'] {
    const { error } = required;
    if (error instanceof z.ZodError || error instanceof SyntaxError) return 'protocol_mismatch';
    if (!(error instanceof OAuthError)) return 'unavailable';
    switch (error.code) {
        case 'OAUTH_INVALID_STATE': return 'expired';
        case 'OAUTH_ACCESS_DENIED': return 'forbidden';
        case 'OAUTH_MALFORMED_RESPONSE': return 'protocol_mismatch';
        default: return 'unavailable';
    }
}

/** Match the credentials lifecycle's owner/workspace/connection binding. */
function ownerKey(required: { reference: GrantInput['reference'] }): string {
    return JSON.stringify([required.reference.scope.ownerId, required.reference.scope.workspaceId, required.reference.connectionId]);
}
function admissionError(_required: Record<string, never>): OAuthError {
    return new OAuthError({ code: 'OAUTH_ACCESS_DENIED', message: 'Plugin unavailable', operatorAction: 'Check plugin admission' });
}
function denied(required: { code: AppError['code'] }): { ok: false; error: AppError } {
    return { ok: false, error: { code: required.code, message: 'Sign-in unavailable; check the app configuration and the exact callback URI (Strict Mode/Enforce HTTPS may reject local HTTP).', retryable: false } };
}

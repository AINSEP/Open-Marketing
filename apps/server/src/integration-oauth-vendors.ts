/** Meta protocol only. O1 owns pending connections, callback consumption, audit and storage.
 * Evidence: https://developers.facebook.com/documentation/facebook-login/guides/advanced/manual-flow
 * https://developers.facebook.com/documentation/facebook-login/guides/access-tokens/get-long-lived
 * https://developers.facebook.com/docs/graph-api/reference/debug_token/
 * Jini's authMethod=none is used only to build the dialog; both GET exchanges require the sealed secret.
 */
import { beginAuthorizationCode, OAuthError } from '@jini-ai/oauth';
import type { OAuthHttpPorts, OAuthRandomBytes, PendingAuthorizationStore } from '@jini-ai/oauth';
import { readCredentialOAuthClient } from '@open-marketing/credentials';
import type { CredentialBrokerPort, CredentialRepoPort, OAuthHostBindings, SealedSecret, SecretSealerPort } from '@open-marketing/credentials';
import type { AppError, CallContext, CallOptions, ClockPort, ObserverPort, Outcome } from '@open-marketing/contracts';
import { z } from 'zod';
import type { IntegrationOAuthProvider } from './integration-oauth-contracts.js';

interface VendorDependencies {
    standard: OAuthHostBindings; metadata?: IntegrationOAuthProvider; repo: CredentialRepoPort; broker: CredentialBrokerPort;
    sealer: SecretSealerPort; pending: PendingAuthorizationStore; clock: ClockPort; http: OAuthHttpPorts;
    randomBytesFn: OAuthRandomBytes; observer: ObserverPort;
    admission(required: { context: CallContext; pluginId: string }): Promise<boolean>;
    deadline: { create(required: { timeoutMs: number }): { signal: AbortSignal; dispose(): void } };
}
type GrantInput = Parameters<OAuthHostBindings['exchange']>[0];
const clientSchema = z.object({ clientId: z.string().min(1).max(2048), clientSecret: z.string().min(1).max(8192), configId: z.string().regex(/^[1-9][0-9]{0,127}$/) });
const tokenSchema = z.object({ access_token: z.string().min(1).max(32768), token_type: z.string().regex(/^bearer$/i), expires_in: z.number().int().nonnegative().max(3155760000) });
const scopeSchema = z.string().min(1).max(128).regex(/^[\x21\x23-\x5b\x5d-\x7e]+$/);
const expirySchema = z.number().int().nonnegative().max(253402300799);
const debugSchema = z.object({ data: z.object({ app_id: z.string(), type: z.literal('USER'), is_valid: z.literal(true),
    expires_at: expirySchema, data_access_expires_at: expirySchema, scopes: z.array(scopeSchema).max(64),
    granular_scopes: z.array(z.object({ scope: scopeSchema, target_ids: z.array(z.union([z.string().regex(/^[0-9]{1,128}$/), z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)])).max(1024).optional() })).max(64).optional() }) });

/** Wrap standard bindings only for Meta; Jini still creates the state in the existing store.
 * @example bindings: ({ standard }) => createVendorOAuthBindings({ standard, ...dependencies })
 * @complexity O(b + s) time/space, b<=64 KiB per response, s<=64 scopes; three requests, no retry.
 */
export function createVendorOAuthBindings(required: VendorDependencies): OAuthHostBindings {
    return {
        authorize(input, options) {
            if (input.request.pluginId !== 'meta-ads') return required.standard.authorize(input, options);
            return metaBoundary({ deadline: required.deadline, run: async signal => {
                const client = await metaClient({ dependencies: required, context: input.context }, { ...options, signal });
                if (!client.ok) return client;
                if (!required.metadata?.debugTokenEndpoint) return denied({ code: 'unavailable' });
                const result = await beginAuthorizationCode({ provider: required.metadata.provider, client: { ...client.value, authMethod: 'none' },
                    pending: required.pending, randomBytesFn: required.randomBytesFn, guard: required.http.guard,
                    ownerKey: ownerKey(input), redirectUri: input.request.returnUri,
                    options: { clientDisplayName: 'Open Marketing', softwareId: 'io.github.ainsep.openmarketing', redirectUris: [input.request.returnUri] },
                }, { scopes: [], extraAuthorizationParams: { config_id: client.value.configId } });
                return { ok: true, value: { authorizationUrl: result.authorizationUrl, expiresAt: Date.parse(result.expiresAt) } };
            } }, options);
        },
        exchange(input, options) {
            if (input.request.pluginId !== 'meta-ads') return required.standard.exchange(input, options);
            return metaBoundary({ deadline: required.deadline, run: signal => exchangeMeta({ dependencies: required, input, signal }, options) }, options);
        },
    };
}

/** Reuse sealed client-purpose access; confidential Meta exchange requires all three fields.
 * @complexity Fixed audited broker I/O; O(client bytes), no vendor request.
 */
async function metaClient(required: { dependencies: VendorDependencies; context: CallContext }, optional?: CallOptions): Promise<Outcome<z.infer<typeof clientSchema>>> {
    const saved = await readCredentialOAuthClient({ ...required.dependencies, pluginId: 'meta-ads',
        context: { ...required.context, principal: { kind: 'service', serviceId: 'oauth-client' } } }, optional);
    if (!saved.ok) return saved;
    const parsed = clientSchema.safeParse(saved.value);
    return parsed.success ? { ok: true, value: parsed.data } : denied({ code: 'unavailable' });
}

/** Consume Jini state before HTTP; all requests share one deadline. Nothing persists on failure.
 * @complexity Three sequential bounded GETs; O(response bytes + scopes) time/space.
 */
async function exchangeMeta(required: { dependencies: VendorDependencies; input: GrantInput; signal: AbortSignal }, optional?: CallOptions): Promise<Outcome<SealedSecret>> {
    const { dependencies, input, signal } = required;
    const entry = await dependencies.pending.take({ state: input.callback.state, ownerKey: ownerKey(input) });
    if (entry.providerId !== 'meta-ads' || entry.redirectUri !== input.callback.redirectUri) return denied({ code: 'forbidden' });
    if (input.callback.error || !input.callback.code) return denied({ code: 'unauthenticated' });
    const client = await metaClient({ dependencies, context: input.context }, { ...optional, signal });
    if (!client.ok) return client;
    const metadata = dependencies.metadata;
    if (!metadata?.debugTokenEndpoint) return denied({ code: 'unavailable' });
    const common = { dependencies, context: input.context, signal };
    const identity = { client_id: client.value.clientId, client_secret: client.value.clientSecret };
    const short = tokenSchema.parse(await metaGet({ ...common, endpoint: metadata.provider.tokenEndpoint,
        params: { ...identity, redirect_uri: entry.redirectUri, code: input.callback.code } }));
    const exchangeStartedAt = dependencies.clock.now({});
    const token = tokenSchema.parse(await metaGet({ ...common, endpoint: metadata.provider.tokenEndpoint,
        params: { ...identity, grant_type: 'fb_exchange_token', fb_exchange_token: short.access_token } }));
    const inspected = debugSchema.parse(await metaGet({ ...common, endpoint: metadata.debugTokenEndpoint,
        params: { input_token: token.access_token, access_token: client.value.clientId + '|' + client.value.clientSecret } })).data;
    const tokens = validatedTokens({ token, inspected, clientId: client.value.clientId, requiredScopes: metadata.provider.defaultScopes,
        exchangeStartedAt, now: dependencies.clock.now({}) });
    signal.throwIfAborted();
    return dependencies.sealer.seal({ reference: input.reference, plaintext: 'om.oauth.v1:' + JSON.stringify(tokens) }, { ...optional, signal });
}

/** Validate identity, actual grants and every reported positive expiry; zero means no time limit.
 * @complexity O(s + g) time/space for <=64 scopes/granular grants; no I/O or assumed lifetime.
 */
function validatedTokens(required: { token: z.infer<typeof tokenSchema>; inspected: z.infer<typeof debugSchema>['data']; clientId: string;
    requiredScopes: readonly string[]; exchangeStartedAt: number; now: number }) {
    const { token, inspected } = required;
    const granted = new Set(inspected.scopes);
    if (inspected.app_id !== required.clientId || required.requiredScopes.some(scope => !granted.has(scope))) throw malformed({});
    if (inspected.granular_scopes?.some(grant => !granted.has(grant.scope))) throw malformed({});
    const expiries = [token.expires_in === 0 ? 0 : required.exchangeStartedAt + token.expires_in * 1000, inspected.expires_at * 1000, inspected.data_access_expires_at * 1000].filter(expiry => expiry > 0);
    const expiresAt = expiries.length ? Math.min(...expiries) : null;
    if (expiresAt !== null && expiresAt <= required.now) throw malformed({});
    return { accessToken: token.access_token, refreshToken: null, tokenType: 'Bearer', scopes: [...granted],
        expiresAt: expiresAt === null ? null : new Date(expiresAt).toISOString() };
}

/** Recheck server admission before every GET; secrets stay transient and telemetry contains only correlation.
 * @complexity O(b) time/space, b<=64 KiB; one request, no redirects or retry.
 */
async function metaGet(required: { dependencies: VendorDependencies; context: CallContext; endpoint: string; params: Record<string, string>; signal: AbortSignal }): Promise<unknown> {
    const url = required.dependencies.http.guard.assertSafeUrl({ raw: required.endpoint, label: 'token endpoint' });
    url.search = new URLSearchParams(required.params).toString();
    const headers = new Headers({ 'x-om-correlation-id': required.context.correlationId, 'x-om-trace-id': required.context.traceId });
    if (required.context.runId) headers.set('x-om-run-id', required.context.runId);
    let succeeded = false;
    try {
        if (!await required.dependencies.admission({ context: required.context, pluginId: 'meta-ads' }))
            throw new OAuthError({ code: 'OAUTH_ACCESS_DENIED', message: 'Plugin unadmitted', operatorAction: 'Check plugin admission' });
        required.signal.throwIfAborted();
        const response = await required.dependencies.http.fetchFn({ url }, { method: 'GET', headers, signal: required.signal, redirect: 'error' });
        if (!response.ok) { await response.body?.cancel(); throw malformed({}); }
        const result = await readJson({ response, signal: required.signal });
        succeeded = true;
        return result;
    } finally {
        try { required.dependencies.observer.observe({ operation: 'credentials.oauth.http', outcome: succeeded ? 'succeeded' : 'failed',
            correlationId: required.context.correlationId, traceId: required.context.traceId, runId: required.context.runId }); }
        catch { /* Telemetry cannot change authority or expose request data. */ }
    }
}

/** Bound streamed bytes before JSON parsing even with a fixture/replacement HTTP adapter.
 * @complexity O(b) time/space, b<=64 KiB; abort/error cancels the stream.
 */
async function readJson(required: { response: Response; signal: AbortSignal }): Promise<unknown> {
    const reader = required.response.body?.getReader();
    if (!reader) throw malformed({});
    const cancel = () => { void reader.cancel().catch(() => undefined); };
    required.signal.addEventListener('abort', cancel, { once: true });
    const chunks: Uint8Array[] = []; let bytes = 0;
    try {
        required.signal.throwIfAborted();
        for (;;) {
            const chunk = await reader.read();
            required.signal.throwIfAborted();
            if (chunk.done) return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
            bytes += chunk.value.byteLength;
            if (bytes > 65536) throw malformed({});
            chunks.push(chunk.value);
        }
    } finally { required.signal.removeEventListener('abort', cancel); await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

/** One injected, disposed deadline spans the protocol; foreign failures never expose URL/body/cause.
 * @complexity O(1) overhead plus bounded supplied operation.
 */
async function metaBoundary<T>(required: { deadline: VendorDependencies['deadline']; run: (signal: AbortSignal) => Promise<Outcome<T>> }, optional?: CallOptions): Promise<Outcome<T>> {
    const deadline = required.deadline.create({ timeoutMs: 15000 });
    const signal = AbortSignal.any([deadline.signal, ...(optional?.signal ? [optional.signal] : [])]);
    try { signal.throwIfAborted(); return await required.run(signal); }
    catch (error) {
        if (optional?.signal?.aborted) return denied({ code: 'cancelled' });
        if (signal.aborted) return denied({ code: 'unavailable' });
        return denied({ code: metaErrorCode({ error }) });
    } finally { deadline.dispose(); }
}

/** Map a foreign exception to a safe error code without exposing its details or performing I/O.
 * @complexity O(1) time/space.
 */
function metaErrorCode(required: { error: unknown }): AppError['code'] {
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

/** Match O1's owner/workspace/connection binding in the shared Jini pending store. */
function ownerKey(required: { reference: GrantInput['reference'] }): string {
    return JSON.stringify([required.reference.scope.ownerId, required.reference.scope.workspaceId, required.reference.connectionId]);
}
function malformed(_required: Record<string, never>): OAuthError {
    return new OAuthError({ code: 'OAUTH_MALFORMED_RESPONSE', message: 'Invalid Meta grant', operatorAction: 'Reconnect Meta' });
}
function denied(required: { code: AppError['code'] }): { ok: false; error: AppError } {
    return { ok: false, error: { code: required.code, message: 'Meta sign-in unavailable; check Business Login configuration and the exact callback URI (Strict Mode/Enforce HTTPS may reject local HTTP).', retryable: false } };
}

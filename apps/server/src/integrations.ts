/** Server-only connection use cases. Plaintext leaves only through trusted credential access. */
import { z } from 'zod';
import { appErrorSchema, callContextSchema, connectIntegrationTokenSchema, disconnectIntegrationSchema, idSchema,
    integrationListSchema, integrationSummarySchema, parseBoundary } from '@open-marketing/contracts';
import type { AppError, CallContext, CallOptions, ConnectIntegrationToken, DisconnectIntegration, IntegrationList,
    IntegrationSummary, ObserverPort, Outcome, PageQuery } from '@open-marketing/contracts';
import { readCredentialDeveloperToken, readCredentialOAuthClient, connectCredentialToken, listCredentialConnections, readCredentialAccess } from '@open-marketing/credentials';
import { developerTokenQuerySchema, developerTokenSetSchema } from './integration-oauth-contracts.js';
import { oauthClientSetSchema, oauthClientStatusSchema, oauthCallbackSchema, oauthChallengeSchema, oauthStartSchema, oauthStatusQuerySchema, oauthStatusSchema } from './integration-oauth-contracts.js';
import type { ConnectionSummary, CredentialAuditPort, CredentialBrokerPort, CredentialLockPort,
    CredentialRepoPort, CredentialService, CredentialSqlPort, SecretSealerPort } from '@open-marketing/credentials';
import { credentialDigestSchema, credentialIcon, credentialPluginStatusSchema } from './integration-credential-cards.js';
import type { CredentialCard, CredentialCardManifest } from './integration-credential-cards.js';

/** Concrete ports are supplied once by server composition; no vendor parsing or I/O construction here. */
export interface IntegrationDependencies {
    readonly repo: CredentialRepoPort;
    readonly sealer: SecretSealerPort;
    readonly locks: CredentialLockPort;
    readonly audit: CredentialAuditPort;
    readonly broker: CredentialBrokerPort;
    readonly service: CredentialService;
    readonly redirectUri?: () => string | null;
    readonly db: CredentialSqlPort;
    readonly observer: ObserverPort;
    readonly readCredentialCards?: (required: { context: CallContext; pluginId: string }) => Promise<Outcome<CredentialCardManifest>>;
    readonly readCredentialAsset?: (required: { context: CallContext; pluginId: string; path: string }) => Promise<Outcome<Uint8Array>>;
}
/** Owner management returns secret-free contracts. access/resolveProviderKey stay server-only. */
export interface Integrations {
    credentialAsset(required: { context: CallContext; pluginId: string; digest: string }, optional?: CallOptions): Promise<Outcome<{ bytes: Uint8Array; contentType: 'image/svg+xml' | 'image/png' }>>;
    /** Owner-only paste/clear and secret-free status; resolve is a Google transport-only host seam. */
    setDeveloperToken(required: { context: CallContext; request: unknown }, optional?: CallOptions): Promise<Outcome<{ configured: boolean }>>;
    developerTokenStatus(required: { context: CallContext; pluginId: string }, optional?: CallOptions): Promise<Outcome<{ configured: boolean }>>;
    resolveDeveloperToken(required: { context: CallContext; pluginId: string }, optional?: CallOptions): Promise<Outcome<string | null>>;
    setOAuthClient(required: { context: CallContext; request: unknown }, optional?: CallOptions): Promise<Outcome<z.infer<typeof oauthClientStatusSchema>>>;
    startOAuth(required: { context: CallContext; request: z.infer<typeof oauthStartSchema> }, optional?: CallOptions): Promise<Outcome<z.infer<typeof oauthChallengeSchema>>>;
    completeOAuth(required: { context: CallContext; response: unknown }, optional?: CallOptions): Promise<Outcome<IntegrationSummary>>;
    oauthStatus(required: { context: CallContext } & z.infer<typeof oauthStatusQuerySchema>, optional?: CallOptions): Promise<Outcome<z.infer<typeof oauthStatusSchema>>>;
    connect(required: { context: CallContext; request: ConnectIntegrationToken }, optional?: CallOptions): Promise<Outcome<IntegrationSummary>>;
    list(required: { context: CallContext; query: PageQuery }, optional?: CallOptions): Promise<Outcome<IntegrationList>>;
    disconnect(required: { context: CallContext; request: DisconnectIntegration }, optional?: CallOptions): Promise<Outcome<IntegrationSummary>>;
    access(required: { context: CallContext; pluginId: string; connectionId: string }, optional?: CallOptions): Promise<Outcome<{ accessToken: string; expiresAt?: number }>>;
    resolveProviderKey(required: { context: CallContext; provider: 'anthropic' }, optional?: CallOptions): Promise<Outcome<string>>;
}

/** Inert binding to the existing credential lifecycle/sealing; operations use injected I/O, without caches.
 * @example const integrations = createIntegrations({ repo, sealer, locks, audit, broker, service, db, observer });
 * @complexity O(1) instance space; operations use bounded pages or one credential.
 */
export function createIntegrations(required: IntegrationDependencies): Integrations {
    return {
        credentialAsset: (input, options) => integrationBoundary({ dependencies: required, context: input.context, operation: 'integrations.credential-asset',
            run: () => readCredentialIcon({ ...input, dependencies: required }) }, options),
        setDeveloperToken: (input, options) => integrationBoundary({ dependencies: required, context: input.context, operation: 'integrations.developer-token.set', run: async () => {
            const parsed = parseBoundary({ schema: developerTokenSetSchema, input: input.request });
            if (!parsed.ok) return parsed;
            const saved = await connectCredentialToken({ ...required, context: input.context, pluginId: parsed.value.pluginId, connectionId: 'developer-token.google-ads',
                plaintext: JSON.stringify(parsed.value.token), purpose: 'developer-token' }, options);
            return saved.ok ? { ok: true, value: { configured: parsed.value.token !== null } } : saved;
        } }, options),
        developerTokenStatus: (input, options) => integrationBoundary({ dependencies: required, context: input.context, operation: 'integrations.developer-token.status', run: async () => {
            if (input.context.principal.kind !== 'owner' || input.context.principal.ownerId !== input.context.scope.ownerId) return integrationFailure({ code: 'forbidden' });
            if (!developerTokenQuerySchema.safeParse({ pluginId: input.pluginId }).success) return integrationFailure({ code: 'invalid_input' });
            const token = await readCredentialDeveloperToken({ ...required, pluginId: input.pluginId, context: { ...input.context, principal: { kind: 'service', serviceId: 'developer-token-status' } } }, options);
            return token.ok ? { ok: true, value: { configured: token.value !== null } } : token;
        } }, options),
        resolveDeveloperToken: (input, options) => integrationBoundary({ dependencies: required, context: input.context, operation: 'integrations.developer-token.resolve',
            run: () => readCredentialDeveloperToken({ ...required, ...input }, options) }, options),
        setOAuthClient: (input, options) => integrationBoundary({ dependencies: required, context: input.context, operation: 'integrations.oauth.client.set', run: async () => {
            const parsed = parseBoundary({ schema: oauthClientSetSchema, input: input.request });
            if (!parsed.ok) return parsed;
            const saved = await connectCredentialToken({ ...required, context: input.context, pluginId: parsed.value.pluginId, connectionId: 'oauth-client.' + parsed.value.pluginId,
                plaintext: JSON.stringify(parsed.value.client), purpose: 'oauth-client' }, options);
            const client = parsed.value.client as { clientId: string } | null; // Successful credential ingress validates the complete client shape.
            return saved.ok ? oauthClientSummary({ client, pluginId: parsed.value.pluginId }) : saved;
        } }, options),
        startOAuth: (input, options) => integrationBoundary({ dependencies: required, context: input.context, operation: 'integrations.oauth.start', run: async () => {
            const parsed = parseBoundary({ schema: oauthStartSchema, input: input.request });
            if (!parsed.ok) return parsed;
            const returnUri = required.redirectUri?.();
            if (!returnUri) return integrationFailure({ code: 'unavailable' });
            const challenge = await required.service.beginConnect({ context: input.context, request: { ...parsed.value, returnUri } }, options);
            return challenge.ok ? parseBoundary({ schema: oauthChallengeSchema, input: challenge.value }) : challenge;
        } }, options),
        completeOAuth: (input, options) => integrationBoundary({ dependencies: required, context: input.context, operation: 'integrations.oauth.callback', run: async () => {
            const parsed = parseBoundary({ schema: oauthCallbackSchema, input: input.response });
            if (!parsed.ok) return parsed;
            const redirectUri = required.redirectUri?.();
            if (!redirectUri) return integrationFailure({ code: 'unavailable' });
            const completed = await required.service.completeConnect({ callback: { ...parsed.value, redirectUri } }, options);
            return completed.ok ? publicSummary({ summary: completed.value }) : completed;
        } }, options),
        oauthStatus: (input, options) => integrationBoundary({ dependencies: required, context: input.context, operation: 'integrations.oauth.status', run: async () => {
            const { context, ...query } = input;
            const parsed = parseBoundary({ schema: oauthStatusQuerySchema, input: query });
            if (!parsed.ok) return parsed;
            if ('pluginId' in parsed.value) return oauthPluginStatus({ dependencies: required, context, pluginId: parsed.value.pluginId }, options);
            if (/^(oauth-client|developer-token)\./.test(parsed.value.transactionId)) return { ok: true, value: { status: 'expired' } };
            const status = await required.service.connectStatus({ context, transactionId: parsed.value.transactionId }, options);
            if (!status.ok) return status;
            return parseBoundary({ schema: oauthStatusSchema, input: { status: status.value.status,
                ...(status.value.connection ? { connection: summaryDto({ summary: status.value.connection }) } : {}) } });
        } }, options),
        connect: (input, options) => integrationBoundary({ dependencies: required, context: input.context, operation: 'integrations.connect', run: async () => {
            const parsed = parseBoundary({ schema: connectIntegrationTokenSchema, input: input.request });
            if (!parsed.ok) return parsed;
            const stored = await connectCredentialToken({ ...required, context: input.context, ...parsed.value }, options);
            if (!stored.ok) return stored;
            return publicSummary({ summary: stored.value });
        } }, options),
        list: (input, options) => integrationBoundary({ dependencies: required, context: input.context, operation: 'integrations.list', run: async () => {
            const page = await listCredentialConnections({ db: required.db, ...input }, options);
            if (!page.ok) return page;
            const items = page.value.items.map(summary => summaryDto({ summary }));
            return parseBoundary({ schema: integrationListSchema, input: { items, cursor: page.value.cursor } });
        } }, options),
        disconnect: (input, options) => integrationBoundary({ dependencies: required, context: input.context, operation: 'integrations.disconnect', run: async () => {
            const parsed = parseBoundary({ schema: disconnectIntegrationSchema, input: input.request });
            if (!parsed.ok) return parsed;
            if (/^(oauth-client|developer-token)\./.test(parsed.value.connectionId)) return integrationFailure({ code: 'forbidden' });
            return disconnect({ dependencies: required, context: input.context, connectionId: parsed.value.connectionId }, options);
        } }, options),
        access: (input, options) => accessCredential({ ...input, dependencies: required }, options),
        resolveProviderKey: (input, options) => resolveProviderKey({ ...input, dependencies: required }, options),
    };
}

/** Preserve core lifecycle labels while exposing only the approved public fields. */
function summaryDto(required: { summary: ConnectionSummary }): IntegrationSummary {
    const status = { connected: 'saved', revoked: 'disconnected', reconnect_required: 'reconnect_required' } as const;
    return { connectionId: required.summary.connectionId, pluginId: required.summary.pluginId, status: status[required.summary.status] };
}

function publicSummary(required: { summary: ConnectionSummary }): Outcome<IntegrationSummary> {
    return parseBoundary({ schema: integrationSummarySchema, input: summaryDto(required) });
}

/** Owner-only installed cards plus scoped saved summaries. Configuration never implies verification.
 * @complexity <=32 icons (256 KiB each) and <=100 summaries; one client lookup, no vendor I/O.
 */
async function oauthPluginStatus(required: { dependencies: IntegrationDependencies; context: CallContext; pluginId: string }, optional?: CallOptions): Promise<Outcome<z.infer<typeof oauthClientStatusSchema> | z.infer<typeof credentialPluginStatusSchema>>> {
    const { context, pluginId } = required;
    if (context.principal.kind !== 'owner' || context.principal.ownerId !== context.scope.ownerId) return integrationFailure({ code: 'forbidden' });
    const status = await configuredClientStatus(required, optional);
    if (!status.ok || !required.dependencies.readCredentialCards) return status;
    const manifest = await required.dependencies.readCredentialCards({ context, pluginId });
    if (!manifest.ok) return manifest;
    const page = await listCredentialConnections({ context, db: required.dependencies.db, query: { pluginId, limit: 100 } }, optional);
    if (!page.ok) return page;
    const credentialCards: CredentialCard[] = [];
    for (const card of manifest.value.credentialCards) credentialCards.push(await cardWithIcon({ ...required, card, manifest: manifest.value }));
    return parseBoundary({ schema: credentialPluginStatusSchema, input: { ...status.value, credentialCards,
        connections: page.value.items.map(summary => summaryDto({ summary })), connectionsCursor: page.value.cursor } });
}

/** Generic installed packages never enter the supported OAuth-client secret decoder. No vendor I/O. */
async function configuredClientStatus(required: { dependencies: IntegrationDependencies; context: CallContext; pluginId: string }, optional?: CallOptions): Promise<Outcome<z.infer<typeof oauthClientStatusSchema>>> {
    const { context, pluginId } = required;
    if (pluginId === 'tiktok-ads') return { ok: true, value: { configured: false, guidance: 'TikTok uses paste-token. Connect a Marketing API advertiser access token with integrations connect --token-stdin. Saved tokens are unverified.' } };
    if (!['google-ads', 'linkedin-ads', 'meta-ads'].includes(pluginId)) return { ok: true, value: { configured: false } };
    const client = await readCredentialOAuthClient({ ...required.dependencies, pluginId, context: { ...context, principal: { kind: 'service', serviceId: 'oauth-client' } } }, optional);
    return client.ok ? oauthClientSummary({ client: client.value, pluginId }) : client;
}

/** Broken icons are omitted without hiding usable cards or affecting existing credential operations.
 * @complexity <=32 bounded icon reads/status; no vendor effects or retained cache.
 */
async function cardWithIcon(required: { dependencies: IntegrationDependencies; context: CallContext; pluginId: string; card: CredentialCard; manifest: CredentialCardManifest }): Promise<CredentialCard> {
    const { icon, iconDigest: _iconDigest, ...card } = required.card;
    const readAsset = required.dependencies.readCredentialAsset;
    if (!icon || !readAsset) return card;
    const result = await integrationBoundary({ ...required, operation: 'integrations.credential-icon', run: async () => {
        const bytes = await readAsset({ context: required.context, pluginId: required.pluginId, path: icon });
        return bytes.ok ? credentialIcon({ path: icon, digest: required.manifest.credentialAssets[icon], bytes: bytes.value }) : bytes;
    } });
    return result.ok ? required.card : card;
}

/** Owner-only contained icon lookup. Request data never selects arbitrary files; errors are redacted.
 * @complexity One installed manifest and one <=256 KiB binary read; O(b) hashing/space.
 */
async function readCredentialIcon(required: { dependencies: IntegrationDependencies; context: CallContext; pluginId: string; digest: string }): Promise<Outcome<{ bytes: Uint8Array; contentType: 'image/svg+xml' | 'image/png' }>> {
    const { dependencies, context, pluginId, digest } = required;
    const input = z.strictObject({ context: callContextSchema, pluginId: idSchema, digest: credentialDigestSchema }).safeParse({ context, pluginId, digest });
    if (!input.success) return integrationFailure({ code: 'invalid_input' });
    if (context.principal.kind !== 'owner' || context.principal.ownerId !== context.scope.ownerId) return integrationFailure({ code: 'forbidden' });
    if (!dependencies.readCredentialCards || !dependencies.readCredentialAsset) return integrationFailure({ code: 'unavailable' });
    try {
        const manifest = await dependencies.readCredentialCards({ context, pluginId });
        if (!manifest.ok) return manifest;
        const path = manifest.value.credentialCards.map(card => card.icon).find(path => path && manifest.value.credentialAssets[path] === digest);
        if (!path) return integrationFailure({ code: 'invalid_input' });
        const bytes = await dependencies.readCredentialAsset({ context, pluginId, path });
        return bytes.ok ? credentialIcon({ path, digest, bytes: bytes.value }) : bytes;
    } catch { return integrationFailure({ code: 'unavailable' }); }
}

/** Secret-free client status includes Meta callback/configuration guidance. @complexity O(1). */
function oauthClientSummary(required: { client: { clientId: string } | null; pluginId: string }): Outcome<z.infer<typeof oauthClientStatusSchema>> {
    const guidance = required.pluginId === 'meta-ads' ? { guidance: 'Meta Business Login needs a user-token config with the required permissions. If Meta rejects the callback, check the exact redirect URI: Strict Mode/Enforce HTTPS may reject http://127.0.0.1. Sign-in must be restarted after expiry.' } : {};
    return { ok: true, value: required.client ? { configured: true, clientId: required.client.clientId, ...guidance } : { configured: false, ...guidance } };
}

/** Reuse the credential service's locked revocation/audit sequence; no local duplicate lifecycle.
 * A receipt is validated by that service; an audit failure cannot restore authority. @complexity Fixed indexed I/O.
 */
async function disconnect(required: { dependencies: IntegrationDependencies; context: CallContext; connectionId: string }, optional?: CallOptions): Promise<Outcome<IntegrationSummary>> {
    const revoked = await required.dependencies.service.revoke({ context: required.context, connectionId: required.connectionId }, optional);
    if (!revoked.ok) return revoked;
    const summary = await required.dependencies.repo.get({ context: required.context, connectionId: required.connectionId }, optional);
    if (!summary.ok) return summary;
    if (!summary.value || summary.value.status !== 'revoked') return integrationFailure({ code: 'protocol_mismatch' });
    return publicSummary({ summary: summary.value });
}

/** Trusted host access checks plugin ownership before broker use, then unseals the returned version.
 * Tagged OAuth payloads are decoded here; refresh material never reaches a plugin.
 * Call immediately before egress. No credential or ciphertext caching is permitted.
 * @tradeoffs Disconnect racing an already authorized in-flight call is accepted on a single server.
 * @example await accessCredential({ context: serviceContext, pluginId, connectionId, dependencies });
 * @complexity O(b) time/space for <=64 KiB token; fixed indexed I/O and at most one bounded refresh.
 */
export async function accessCredential(required: {
    context: CallContext; pluginId: string; connectionId: string; dependencies: IntegrationDependencies;
}, optional?: CallOptions): Promise<Outcome<{ accessToken: string; expiresAt?: number }>> {
    return integrationBoundary({ ...required, operation: 'integrations.access', run: async () => {
        const parsed = z.strictObject({ context: callContextSchema, pluginId: idSchema, connectionId: idSchema }).safeParse({ context: required.context, pluginId: required.pluginId, connectionId: required.connectionId });
        if (!parsed.success) return integrationFailure({ code: 'invalid_input' });
        if (parsed.data.context.principal.kind !== 'service') return integrationFailure({ code: 'forbidden' });
        return accessCurrent({ dependencies: required.dependencies, ...parsed.data }, optional);
    } }, optional);
}

/** Only matching plugin records reach the broker. The broker's secret.version reflects refresh.
 * @complexity Fixed repository/broker calls, at most one refresh and O(b) decryption, <=64 KiB.
 */
async function accessCurrent(required: {
    context: CallContext; pluginId: string; connectionId: string; dependencies: IntegrationDependencies;
}, optional?: CallOptions): Promise<Outcome<{ accessToken: string; expiresAt?: number; scopes?: readonly string[] }>> {
    const { dependencies, context, connectionId, pluginId } = required;
    if (/^(oauth-client|developer-token)\./.test(connectionId)) return integrationFailure({ code: 'forbidden' });
    const loaded = await dependencies.repo.getSecret({ context, connectionId }, optional);
    if (!loaded.ok) return loaded;
    if (!loaded.value) return integrationFailure({ code: 'unauthenticated' });
    if (loaded.value.summary.pluginId !== pluginId) return integrationFailure({ code: 'forbidden' });
    const used = await dependencies.broker.use({ context, reference: loaded.value.reference, operationId: context.correlationId }, optional);
    if (!used.ok) return used;
    const reference = { scope: context.scope, connectionId, version: used.value.version };
    const opened = await dependencies.sealer.open({ reference, secret: used.value }, optional);
    if (!opened.ok) return opened;
    return readCredentialAccess({ plaintext: opened.value });
}

/** Model-broker seam only: select the one saved Anthropic connection in this scope at call time.
 * No agent/HTTP DTO contains the returned key. Multiple saved keys conflict rather than guessing.
 * @example await resolveProviderKey({ context: serviceContext, provider: 'anthropic', dependencies });
 * @complexity One bounded two-row list plus one credential access; O(b) space, <=64 KiB.
 */
export async function resolveProviderKey(required: {
    context: CallContext; provider: 'anthropic'; dependencies: IntegrationDependencies;
}, optional?: CallOptions): Promise<Outcome<string>> {
    return integrationBoundary({ ...required, operation: 'integrations.resolveProviderKey', run: async () => {
        if (required.provider !== 'anthropic') return integrationFailure({ code: 'invalid_input' });
        if (required.context.principal.kind !== 'service') return integrationFailure({ code: 'forbidden' });
        const saved = await listCredentialConnections({ context: required.context, db: required.dependencies.db,
            query: { limit: 2, pluginId: required.provider, status: 'connected' } }, optional);
        if (!saved.ok) return saved;
        if (!saved.value.items.length) return integrationFailure({ code: 'unauthenticated' });
        if (saved.value.items.length !== 1) return integrationFailure({ code: 'conflict' });
        const accessed = await accessCredential({ ...required, pluginId: required.provider, connectionId: saved.value.items[0].connectionId }, optional);
        if (!accessed.ok) return accessed;
        return { ok: true, value: accessed.value.accessToken };
    } }, optional);
}

/** Fixed diagnostics sanitize thrown/returned foreign errors; observer receives correlation only.
 * Never observes success values, request bodies, credential IDs or provider exceptions.
 * @complexity O(1) metadata overhead plus the supplied bounded operation.
 */
async function integrationBoundary<T>(required: {
    dependencies: IntegrationDependencies; context: CallContext; operation: string; run: () => Promise<Outcome<T>>;
}, optional?: CallOptions): Promise<Outcome<T>> {
    let result: Outcome<T>;
    try {
        if (optional?.signal?.aborted) result = integrationFailure({ code: 'cancelled' });
        else result = await required.run();
    } catch { result = integrationFailure({ code: 'unavailable' }); }
    if (!result.ok) {
        const code = appErrorSchema.shape.code.safeParse(result.error.code);
        result = integrationFailure({ code: code.success ? code.data : 'unavailable' });
    }
    try { required.dependencies.observer.observe({ operation: required.operation, outcome: result.ok ? 'succeeded' : result.error.code,
        correlationId: required.context.correlationId, traceId: required.context.traceId, runId: required.context.runId }); }
    catch { /* Telemetry cannot change stored authority or expose operation data. */ }
    return result;
}

function integrationFailure(required: { code: AppError['code'] }): { ok: false; error: AppError } {
    return { ok: false, error: { code: required.code, message: 'Integration operation unavailable or denied', retryable: required.code === 'unavailable' } };
}

/** Server-only connection use cases. Plaintext leaves only through trusted credential access. */
import { z } from 'zod';
import { appErrorSchema, callContextSchema, connectIntegrationTokenSchema, disconnectIntegrationSchema, idSchema,
    integrationListSchema, integrationSummarySchema, parseBoundary } from '@open-marketing/contracts';
import type { AppError, CallContext, CallOptions, ConnectIntegrationToken, DisconnectIntegration, IntegrationList,
    IntegrationSummary, ObserverPort, Outcome, PageQuery } from '@open-marketing/contracts';
import { connectCredentialToken, listCredentialConnections } from '@open-marketing/credentials';
import type { ConnectionSummary, CredentialAuditPort, CredentialBrokerPort, CredentialLockPort,
    CredentialRepoPort, CredentialService, CredentialSqlPort, SecretSealerPort } from '@open-marketing/credentials';

/** Concrete ports are supplied once by server composition; no vendor parsing or I/O construction here. */
export interface IntegrationDependencies {
    readonly repo: CredentialRepoPort;
    readonly sealer: SecretSealerPort;
    readonly locks: CredentialLockPort;
    readonly audit: CredentialAuditPort;
    readonly broker: CredentialBrokerPort;
    readonly service: Pick<CredentialService, 'revoke'>;
    readonly db: CredentialSqlPort;
    readonly observer: ObserverPort;
}
/** Owner management returns secret-free contracts. access/resolveProviderKey stay server-only. */
export interface Integrations {
    connect(required: { context: CallContext; request: ConnectIntegrationToken }, optional?: CallOptions): Promise<Outcome<IntegrationSummary>>;
    list(required: { context: CallContext; query: PageQuery }, optional?: CallOptions): Promise<Outcome<IntegrationList>>;
    disconnect(required: { context: CallContext; request: DisconnectIntegration }, optional?: CallOptions): Promise<Outcome<IntegrationSummary>>;
    access(required: { context: CallContext; pluginId: string; connectionId: string }, optional?: CallOptions): Promise<Outcome<{ accessToken: string; expiresAt?: number }>>;
    resolveProviderKey(required: { context: CallContext; provider: 'anthropic' }, optional?: CallOptions): Promise<Outcome<string>>;
}

/** Inert operation binding using existing credential lifecycle/sealing. No network calls or caches.
 * @example const integrations = createIntegrations({ repo, sealer, locks, audit, broker, service, db, observer });
 * @complexity O(1) instance space; operations use bounded pages or one credential.
 */
export function createIntegrations(required: IntegrationDependencies): Integrations {
    return {
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
 * Opaque token contents are parsed by the plugin; paste-token connections have no host expiry.
 * Call immediately before egress. No credential or ciphertext caching is permitted.
 * @tradeoffs Disconnect racing an already authorized in-flight call is accepted on a single server.
 * @example await accessCredential({ context: serviceContext, pluginId, connectionId, dependencies });
 * @complexity O(b) time/space for <=64 KiB token, fixed indexed I/O; no vendor effects.
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
 * @complexity Fixed repository/broker calls and O(b) decryption, <=64 KiB.
 */
async function accessCurrent(required: {
    context: CallContext; pluginId: string; connectionId: string; dependencies: IntegrationDependencies;
}, optional?: CallOptions): Promise<Outcome<{ accessToken: string }>> {
    const { dependencies, context, connectionId, pluginId } = required;
    const loaded = await dependencies.repo.getSecret({ context, connectionId }, optional);
    if (!loaded.ok) return loaded;
    if (!loaded.value) return integrationFailure({ code: 'unauthenticated' });
    if (loaded.value.summary.pluginId !== pluginId) return integrationFailure({ code: 'forbidden' });
    const used = await dependencies.broker.use({ context, reference: loaded.value.reference, operationId: context.correlationId }, optional);
    if (!used.ok) return used;
    const reference = { scope: context.scope, connectionId, version: used.value.version };
    const opened = await dependencies.sealer.open({ reference, secret: used.value }, optional);
    if (!opened.ok) return opened;
    return { ok: true, value: { accessToken: opened.value } };
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

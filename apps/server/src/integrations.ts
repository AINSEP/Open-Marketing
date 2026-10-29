/** Server-only connection use cases. Plaintext leaves only through trusted credential access. */
import { z } from 'zod';
import { conversionSettingsDeclarationSchema, conversionSettingsValuesSchema, setConversionSettingsSchema, pluginSecretQuerySchema, pluginSecretSetSchema, credentialPluginStatusSchema, digestSchema, oauthClientStatusSchema, oauthChallengeSchema, appErrorSchema, callContextSchema, connectIntegrationTokenSchema, disconnectIntegrationSchema, idSchema,
    integrationListSchema, integrationSummarySchema, parseBoundary } from '@open-marketing/contracts';
import type { AppError, CallContext, CallOptions, ConnectIntegrationToken, DisconnectIntegration, IntegrationList,
    ConversionSettingsDeclaration, ConversionSettingsStatus, ConversionSettingsValues, CredentialCard, IntegrationSummary, ObserverPort, Outcome, PageQuery, PluginSecretStatus } from '@open-marketing/contracts';
import { credentialPluginSecretStatus, setCredentialPluginSecret, readCredentialPluginSecrets, readCredentialOAuthClient, connectCredentialToken, listCredentialConnections, readCredentialAccess } from '@open-marketing/credentials';
import { oauthClientSetSchema, oauthCallbackSchema, oauthStartSchema, oauthStatusQuerySchema, oauthStatusSchema } from './integration-oauth-contracts.js';
import type { ConnectionSummary, CredentialAuditPort, CredentialBrokerPort, CredentialLockPort,
    CredentialRepoPort, CredentialService, CredentialSqlPort, SecretSealerPort } from '@open-marketing/credentials';
import { credentialCardAction, credentialIcon, credentialOAuthClientFields } from './integration-credential-cards.js';
import type { CredentialCardManifest } from './integration-credential-cards.js';

const reservedPurposeId = /^(oauth-client|developer-token|plugin-secret)\./;

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
    readonly oauthProviders: Pick<ReadonlyMap<string, unknown>, 'has'>;
    readonly readCredentialCards?: (required: { context: CallContext; pluginId: string }) => Promise<Outcome<CredentialCardManifest>>;
    readonly readCredentialAsset?: (required: { context: CallContext; pluginId: string; path: string }) => Promise<Outcome<Uint8Array>>;
}
/** Owner management returns secret-free contracts. Credential access stays server-only. */
export interface Integrations {
    /** Non-secret scoped read; declaration null means this installed plugin has no usable settings form. */
    conversionSettings(required: { context: CallContext; pluginId: string }, optional?: CallOptions): Promise<Outcome<ConversionSettingsStatus>>;
    /** Owner-only complete replacement; values: {} clears. Saving never installs or enables a plugin. */
    setConversionSettings(required: { context: CallContext; request: unknown }, optional?: CallOptions): Promise<Outcome<ConversionSettingsStatus>>;
    credentialAsset(required: { context: CallContext; pluginId: string; digest: string }, optional?: CallOptions): Promise<Outcome<{ bytes: Uint8Array; contentType: 'image/svg+xml' | 'image/png' }>>;
    /** Owner-only declared-field replacement/clear; responses contain only configured status. */
    setPluginSecret(required: { context: CallContext; request: unknown }, optional?: CallOptions): Promise<Outcome<PluginSecretStatus>>;
    pluginSecretStatus(required: { context: CallContext; pluginId: string }, optional?: CallOptions): Promise<Outcome<PluginSecretStatus>>;
    setOAuthClient(required: { context: CallContext; request: unknown }, optional?: CallOptions): Promise<Outcome<z.infer<typeof oauthClientStatusSchema>>>;
    startOAuth(required: { context: CallContext; request: z.infer<typeof oauthStartSchema> }, optional?: CallOptions): Promise<Outcome<z.infer<typeof oauthChallengeSchema>>>;
    completeOAuth(required: { context: CallContext; response: unknown }, optional?: CallOptions): Promise<Outcome<IntegrationSummary>>;
    oauthStatus(required: { context: CallContext } & z.infer<typeof oauthStatusQuerySchema>, optional?: CallOptions): Promise<Outcome<z.infer<typeof oauthStatusSchema>>>;
    connect(required: { context: CallContext; request: ConnectIntegrationToken }, optional?: CallOptions): Promise<Outcome<IntegrationSummary>>;
    list(required: { context: CallContext; query: PageQuery }, optional?: CallOptions): Promise<Outcome<IntegrationList>>;
    disconnect(required: { context: CallContext; request: DisconnectIntegration }, optional?: CallOptions): Promise<Outcome<IntegrationSummary>>;
    access(required: { context: CallContext; pluginId: string; connectionId: string }, optional?: CallOptions): Promise<Outcome<{ accessToken: string; expiresAt?: number; secrets?: Readonly<Record<string, string>> }>>;
}

/** Inert binding to the existing credential lifecycle/sealing; operations use injected I/O, without caches.
 * @example const integrations = createIntegrations({ repo, sealer, locks, audit, broker, service, db, observer, oauthProviders });
 * @complexity O(1) instance space; operations use bounded pages or one credential.
 */
export function createIntegrations(required: IntegrationDependencies): Integrations {
    return {
        conversionSettings: (input, options) => integrationBoundary({ dependencies: required, context: input.context, operation: 'integrations.conversion-settings.get',
            run: () => conversionSettings({ ...input, dependencies: required }) }, options),
        setConversionSettings: (input, options) => integrationBoundary({ dependencies: required, context: input.context, operation: 'integrations.conversion-settings.set',
            run: () => setConversionSettings({ ...input, dependencies: required }) }, options),
        credentialAsset: (input, options) => integrationBoundary({ dependencies: required, context: input.context, operation: 'integrations.credential-asset',
            run: () => readCredentialIcon({ ...input, dependencies: required }) }, options),
        setPluginSecret: (input, options) => integrationBoundary({ dependencies: required, context: input.context, operation: 'integrations.plugin-secret.set',
            run: () => setPluginSecret({ ...input, dependencies: required }, options) }, options),
        pluginSecretStatus: (input, options) => integrationBoundary({ dependencies: required, context: input.context, operation: 'integrations.plugin-secret.status', run: async () => {
            const parsed = parseBoundary({ schema: pluginSecretQuerySchema, input: { pluginId: input.pluginId } });
            if (!parsed.ok) return parsed;
            if (input.context.principal.kind !== 'owner' || input.context.principal.ownerId !== input.context.scope.ownerId) return integrationFailure({ code: 'forbidden' });
            return credentialPluginSecretStatus({ ...required, pluginId: parsed.value.pluginId,
                context: { ...input.context, principal: { kind: 'service', serviceId: 'plugin-secret-status' } } }, options);
        } }, options),
        setOAuthClient: (input, options) => integrationBoundary({ dependencies: required, context: input.context, operation: 'integrations.oauth.client.set', run: async () => {
            const parsed = parseBoundary({ schema: oauthClientSetSchema, input: input.request });
            if (!parsed.ok) return parsed;
            if (input.context.principal.kind !== 'owner' || input.context.principal.ownerId !== input.context.scope.ownerId) return integrationFailure({ code: 'forbidden' });
            if (!required.readCredentialCards) return integrationFailure({ code: 'unavailable' });
            const manifest = await required.readCredentialCards({ context: input.context, pluginId: parsed.value.pluginId });
            if (!manifest.ok) return manifest;
            if (!manifest.value.credentialCards.some(card => card.saveKind === 'oauth-client')) return integrationFailure({ code: 'forbidden' });
            const saved = await connectCredentialToken({ ...required, context: input.context, pluginId: parsed.value.pluginId, connectionId: 'oauth-client.' + parsed.value.pluginId,
                plaintext: JSON.stringify(parsed.value.client), purpose: 'oauth-client', clientFields: credentialOAuthClientFields({ cards: manifest.value.credentialCards }) }, options);
            const client = parsed.value.client as { clientId: string } | null; // Successful credential ingress validates the complete client shape.
            return saved.ok ? oauthClientSummary({ client }) : saved;
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
            if (reservedPurposeId.test(parsed.value.transactionId)) return { ok: true, value: { status: 'expired' } };
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
            if (reservedPurposeId.test(parsed.value.connectionId)) return integrationFailure({ code: 'forbidden' });
            return disconnect({ dependencies: required, context: input.context, connectionId: parsed.value.connectionId }, options);
        } }, options),
        access: (input, options) => accessCredential({ ...input, dependencies: required }, options),
    };
}

/** Build strict declared fields only. Empty values explicitly clear the complete configuration.
 * @complexity O(bytes + fields + entries), <=4096 bytes, 8 fields and 100 entries/map; pure.
 */
function validateConversionSettings(required: { declaration: ConversionSettingsDeclaration; values: unknown }): Outcome<ConversionSettingsValues> {
    const values = conversionSettingsValuesSchema.safeParse(required.values);
    if (!values.success) return integrationFailure({ code: 'invalid_input' });
    if (Buffer.byteLength(JSON.stringify(values.data)) > 4096) return integrationFailure({ code: 'limit_exceeded' });
    if (!Object.keys(values.data).length) return { ok: true, value: {} };
    const fields = Object.fromEntries(required.declaration.fields.map(field => {
        const value = z.string().min(1).max(128).regex(field.format === 'decimal-id' ? /^[1-9][0-9]*$/ : /^[A-Za-z0-9_-]+$/);
        return [field.name, field.kind === 'string' ? value : z.record(idSchema, value).refine(map => Object.keys(map).length <= 100)];
    }));
    const parsed = z.strictObject(fields).safeParse(values.data);
    return parsed.success ? { ok: true, value: values.data } : integrationFailure({ code: 'invalid_input' });
}

/** One scoped indexed read. Corrupt/obsolete rows are ignored; database errors reach the boundary.
 * @complexity O(bytes) parsing, <=4096 bytes; no credentials, vendor I/O or retained state.
 */
async function readStoredConversionSettings(required: { context: CallContext; db: CredentialSqlPort; pluginId: string; declaration: ConversionSettingsDeclaration }): Promise<ConversionSettingsValues | null> {
    const result = await required.db.query({ text: 'SELECT value_json FROM om_owner_settings WHERE owner_id=$1 AND workspace_id=$2 AND key=$3',
        values: [required.context.scope.ownerId, required.context.scope.workspaceId, 'conversion-settings.' + required.pluginId] });
    const raw = result.rows[0]?.value_json;
    if (typeof raw !== 'string' || Buffer.byteLength(raw) > 4096) return null;
    try {
        const parsed = validateConversionSettings({ declaration: required.declaration, values: JSON.parse(raw) });
        return parsed.ok ? parsed.value : null;
    } catch { return null; }
}

/** Scoped non-secret read for owner and assistant; declarations come only from installed manifests.
 * @complexity One bounded manifest read and at most one indexed settings query.
 */
async function conversionSettings(required: { dependencies: IntegrationDependencies; context: CallContext; pluginId: string }): Promise<Outcome<ConversionSettingsStatus>> {
    const parsed = z.strictObject({ context: callContextSchema, pluginId: idSchema }).safeParse({ context: required.context, pluginId: required.pluginId });
    if (!parsed.success) return integrationFailure({ code: 'invalid_input' });
    if (!required.dependencies.readCredentialCards) return integrationFailure({ code: 'unavailable' });
    const manifest = await required.dependencies.readCredentialCards(parsed.data);
    if (!manifest.ok) return manifest;
    const declaration = manifest.value.conversionSettings ?? null;
    const values = declaration ? await readStoredConversionSettings({ ...parsed.data, db: required.dependencies.db, declaration }) : null;
    return { ok: true, value: { pluginId: parsed.data.pluginId, declaration, values } };
}

/** Owner replacement only; authority precedes all I/O and saving never changes plugin lifecycle.
 * @complexity One manifest read and one scoped upsert; <=4096 serialized bytes. Fixed errors only.
 */
async function setConversionSettings(required: { dependencies: IntegrationDependencies; context: CallContext; request: unknown }): Promise<Outcome<ConversionSettingsStatus>> {
    const { context, dependencies } = required;
    if (context.principal.kind !== 'owner' || context.principal.ownerId !== context.scope.ownerId) return integrationFailure({ code: 'forbidden' });
    if (!callContextSchema.safeParse(context).success) return integrationFailure({ code: 'invalid_input' });
    const parsed = parseBoundary({ schema: setConversionSettingsSchema, input: required.request });
    if (!parsed.ok) return parsed;
    if (!dependencies.readCredentialCards) return integrationFailure({ code: 'unavailable' });
    const manifest = await dependencies.readCredentialCards({ context, pluginId: parsed.value.pluginId });
    if (!manifest.ok) return manifest;
    const declaration = manifest.value.conversionSettings;
    if (!declaration) return integrationFailure({ code: 'forbidden' });
    const validated = validateConversionSettings({ declaration, values: parsed.value.values });
    if (!validated.ok) return validated;
    await dependencies.db.query({ text: `INSERT INTO om_owner_settings(owner_id,workspace_id,key,value_json) VALUES ($1,$2,$3,$4)
        ON CONFLICT(owner_id,workspace_id,key) DO UPDATE SET value_json=excluded.value_json`,
        values: [context.scope.ownerId, context.scope.workspaceId, 'conversion-settings.' + parsed.value.pluginId, JSON.stringify(validated.value)] });
    return { ok: true, value: { pluginId: parsed.value.pluginId, declaration, values: validated.value } };
}

/** Merge a validated override without changing admission or disabling unrelated plugin operations.
 * Invalid/absent declarations or values preserve metadata. DB errors propagate to the caller.
 * @example await withConversionSettings({ context, db, pluginId, metadata });
 * @complexity One indexed read, <=4096 bytes plus a shallow metadata copy; no plugin execution.
 */
export async function withConversionSettings(required: { context: CallContext; db: CredentialSqlPort; pluginId: string; metadata: Record<string, unknown> }): Promise<Record<string, unknown>> {
    const declaration = conversionSettingsDeclarationSchema.safeParse(required.metadata.conversionSettings);
    if (!declaration.success) return required.metadata;
    const values = await readStoredConversionSettings({ ...required, declaration: declaration.data });
    return values === null ? required.metadata : { ...required.metadata, conversionConfiguration: values };
}

/** Require the installed plugin's declared field names before sealing a replacement or clear.
 * Returns only configured status; the surrounding boundary redacts all foreign failures.
 * @complexity O(cards + fields + submitted keys), <=32 cards/16 fields each; fixed credential I/O.
 */
async function setPluginSecret(required: { dependencies: IntegrationDependencies; context: CallContext; request: unknown }, optional?: CallOptions): Promise<Outcome<PluginSecretStatus>> {
    const parsed = parseBoundary({ schema: pluginSecretSetSchema, input: required.request });
    if (!parsed.ok) return parsed;
    const { context, dependencies } = required;
    if (context.principal.kind !== 'owner' || context.principal.ownerId !== context.scope.ownerId) return integrationFailure({ code: 'forbidden' });
    if (!dependencies.readCredentialCards) return integrationFailure({ code: 'unavailable' });
    const manifest = await dependencies.readCredentialCards({ context, pluginId: parsed.value.pluginId });
    if (!manifest.ok) return manifest;
    const fields = manifest.value.credentialCards.filter(card => card.saveKind === 'plugin-secret').flatMap(card => card.secretFields ?? []);
    if (!fields.length) return integrationFailure({ code: 'forbidden' });
    const names = new Set(fields.map(field => field.name));
    const values = parsed.value.values;
    if (values !== null && (Object.keys(values).some(name => !names.has(name)) || fields.some(field => field.required && !Object.hasOwn(values, field.name)))) return integrationFailure({ code: 'invalid_input' });
    return setCredentialPluginSecret({ ...dependencies, context, request: parsed.value }, optional);
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
    if (!required.dependencies.readCredentialCards) return { ok: true, value: { configured: false } };
    const manifest = await required.dependencies.readCredentialCards({ context, pluginId });
    if (!manifest.ok) return manifest;
    const status = await configuredClientStatus({ ...required, manifest: manifest.value }, optional);
    if (!status.ok) return status;
    const page = await listCredentialConnections({ context, db: required.dependencies.db, query: { pluginId, limit: 100 } }, optional);
    if (!page.ok) return page;
    const credentialCards: CredentialCard[] = [];
    const oauthRegistered = required.dependencies.oauthProviders.has(pluginId);
    for (const card of manifest.value.credentialCards) credentialCards.push(await cardWithIcon({ ...required, manifest: manifest.value,
        card: { ...card, actionSupported: credentialCardAction({ card, oauthRegistered }) } }));
    return parseBoundary({ schema: credentialPluginStatusSchema, input: { ...status.value, credentialCards,
        connections: page.value.items.map(summary => summaryDto({ summary })), connectionsCursor: page.value.cursor } });
}

/** Only manifests declaring an OAuth client enter its sealed decoder. No vendor I/O. */
async function configuredClientStatus(required: { dependencies: IntegrationDependencies; context: CallContext; pluginId: string; manifest: CredentialCardManifest }, optional?: CallOptions): Promise<Outcome<z.infer<typeof oauthClientStatusSchema>>> {
    const { context, pluginId } = required;
    if (!required.manifest.credentialCards.some(card => card.saveKind === 'oauth-client')) return { ok: true, value: { configured: false } };
    const client = await readCredentialOAuthClient({ ...required.dependencies, pluginId, clientFields: credentialOAuthClientFields({ cards: required.manifest.credentialCards }),
        context: { ...context, principal: { kind: 'service', serviceId: 'oauth-client' } } }, optional);
    return client.ok ? oauthClientSummary({ client: client.value }) : client;
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
    const input = z.strictObject({ context: callContextSchema, pluginId: idSchema, digest: digestSchema }).safeParse({ context, pluginId, digest });
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

/** Configuration status exposes only the public client ID; guidance belongs to plugin cards. */
function oauthClientSummary(required: { client: { clientId: string } | null }): Outcome<z.infer<typeof oauthClientStatusSchema>> {
    return { ok: true, value: required.client ? { configured: true, clientId: required.client.clientId } : { configured: false } };
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
 * Attaches only the bound plugin's declared saved secrets; secret-read failures refuse access.
 * Call immediately before egress. No credential or ciphertext caching is permitted.
 * @tradeoffs Disconnect racing an already authorized in-flight call is accepted on a single server.
 * @example await accessCredential({ context: serviceContext, pluginId, connectionId, dependencies });
 * @complexity O(b + fields) time/space for bounded credential payloads/cards; fixed indexed I/O and at most one bounded refresh.
 */
export async function accessCredential(required: {
    context: CallContext; pluginId: string; connectionId: string; dependencies: IntegrationDependencies;
}, optional?: CallOptions): Promise<Outcome<{ accessToken: string; expiresAt?: number; secrets?: Readonly<Record<string, string>> }>> {
    return integrationBoundary({ ...required, operation: 'integrations.access', run: async () => {
        const parsed = z.strictObject({ context: callContextSchema, pluginId: idSchema, connectionId: idSchema }).safeParse({ context: required.context, pluginId: required.pluginId, connectionId: required.connectionId });
        if (!parsed.success) return integrationFailure({ code: 'invalid_input' });
        if (parsed.data.context.principal.kind !== 'service') return integrationFailure({ code: 'forbidden' });
        const credential = await accessCurrent({ dependencies: required.dependencies, ...parsed.data }, optional);
        if (!credential.ok) return credential;
        const read = await declaredSecrets({ dependencies: required.dependencies, context: parsed.data.context, pluginId: parsed.data.pluginId }, optional);
        if (!read.ok) return read;
        const secrets = read.value;
        return secrets && Object.keys(secrets).length ? { ok: true, value: { ...credential.value, secrets } } : credential;
    } }, optional);
}

/** Read declarations afresh; unavailable cards omit secrets so ordinary provider access still works.
 * The credential reader filters declared plugin-secret fields and fails closed on stored-record errors.
 * @complexity O(cards + fields + bytes) time/space; <=32 cards/16 fields each, <=64 KiB secrets, fixed I/O.
 */
async function declaredSecrets(required: {
    dependencies: IntegrationDependencies; context: CallContext; pluginId: string;
}, optional?: CallOptions): Promise<Outcome<Readonly<Record<string, string>> | null>> {
    const { dependencies, context, pluginId } = required;
    const manifest = await Promise.resolve().then(() => dependencies.readCredentialCards?.({ context, pluginId })).catch(() => undefined);
    if (!manifest?.ok) return { ok: true, value: null };
    const secretFields = [...new Set(manifest.value.credentialCards.filter(card => card.saveKind === 'plugin-secret').flatMap(card => card.secretFields ?? []).map(field => field.name))];
    if (!secretFields.length) return { ok: true, value: null };
    return readCredentialPluginSecrets({ ...dependencies, context, pluginId, secretFields }, optional);
}

/** Only matching plugin records reach the broker. The broker's secret.version reflects refresh.
 * @complexity Fixed repository/broker calls, at most one refresh and O(b) decryption, <=64 KiB.
 */
async function accessCurrent(required: {
    context: CallContext; pluginId: string; connectionId: string; dependencies: IntegrationDependencies;
}, optional?: CallOptions): Promise<Outcome<{ accessToken: string; expiresAt?: number; scopes?: readonly string[] }>> {
    const { dependencies, context, connectionId, pluginId } = required;
    if (reservedPurposeId.test(connectionId)) return integrationFailure({ code: 'forbidden' });
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

/** Written-only D1 coverage. Native SQLite, fixture secrets and injected effects; no vendor calls. */
import { readFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { expect, it, vi } from 'vitest';
import type { AddonSummary, CallContext, CallOptions, ObserverEvent, Outcome, PluginCapabilityDependencies } from '@open-marketing/contracts';
import { createAesGcmSecretSealer, createCredentialBroker, createCredentialKeyring, createCredentialService,
    createMemoryCredentialAudit, createMemoryCredentialLock, createMemoryCredentialRefresh,
    createMemoryOAuthClient, createSqlCredentialRepo, readCredentialOAuthClient } from '@open-marketing/credentials';
import type { CredentialRefreshPort, CredentialSqlPort, KeyringConfiguration } from '@open-marketing/credentials';
import { withConversionSettings, createIntegrations } from '../src/integrations.js';
import type { IntegrationDependencies } from '../src/integrations.js';
import { handleIntegrationRequest } from '../src/inbound/integrations.js';
import { bindServerIntegrations, loadOAuthProviders } from '../src/composition/index.js';
import { fileURLToPath } from 'node:url';
import { createOAuthUrlGuard } from '@jini-ai/oauth';
import { handleOAuthBrowserCallback } from '../src/inbound/integrations.js';
import { oauthCallbackPath, oauthMetadataSchema, type IntegrationOAuthProvider } from '../src/integration-oauth-contracts.js';
import { createNodeBootIo, createOAuthHttp, loadCredentialMaster } from '../src/composition/serve.js';
import type { HttpRequest } from '../src/ports.js';
import { createHash } from 'node:crypto';
import { parseCredentialCardManifest } from '../src/integration-credential-cards.js';

const owner: CallContext = { scope: { ownerId: 'owner', workspaceId: 'workspace' }, principal: { kind: 'owner', ownerId: 'owner' }, correlationId: 'fixture-correlation', traceId: 'fixture-trace', runId: 'fixture-run' };
const host: CallContext = { ...owner, principal: { kind: 'service', serviceId: 'model-broker' } };
const request = { connectionId: 'anthropic-fixture', pluginId: 'anthropic', plaintext: 'fixture-provider-token-never-live' };
const configuration: KeyringConfiguration = { hkdfSalt: 'fixture-integration-salt-v1', envVarName: 'OM_CREDENTIAL_KEY', keyFilePath: '/fixture/key' };
const clock = { now: () => 1000 };

/** Protocol tests use source fixtures; production discovery reads installed revision-matched bytes. */
function fixtureOAuthProviders(required: { pluginIds: string[] }): Map<string, IntegrationOAuthProvider> {
    return new Map(required.pluginIds.map(pluginId => [pluginId, oauthMetadataSchema.parse(JSON.parse(readFileSync(
        new URL('../../../content/agent-plugins/' + pluginId + '/io.github.ainsep.openmarketing/oauth.json', import.meta.url), 'utf8')))]));
}

it.each(['key', 'apiKey'])('rejects credential-bearing card URLs using %s before status output and redacts diagnostics', async key => {
    const f = fixture({}); const pluginId = 'fixture-vendor';
    const readCredentialCards = async (input: { pluginId: string }) => parseCredentialCardManifest({ pluginId: input.pluginId, raw: JSON.stringify({ name: pluginId,
        extensions: { 'io.github.ainsep.openmarketing': { credentialCards: [{ target: pluginId, title: 'Fixture', label: 'Save token', category: 'Advertising',
            intro: 'Saved credentials are unverified.', usedFor: [], helpUrl: 'https://fixture.example/help?' + key + '=fixture-query-secret', helpLabel: 'Help',
            baseUrl: 'https://fixture.example', saveKind: 'api-key', secretFields: [{ name: 'token', label: 'Token', required: true }] }] } } }) });
    const integrations = createIntegrations({ ...f.dependencies, readCredentialCards });
    try {
        const response = await handleIntegrationRequest({ context: owner, integrations, request: { method: 'GET', path: '/api/addons/v1/integrations/oauth/status', query: { pluginId } } });
        expect(response).toEqual({ status: 400, body: { ok: false, error: { code: 'invalid_input', message: 'Invalid credential card or asset', retryable: false } }, headers: { 'cache-control': 'no-store' } });
        expect(JSON.stringify([response, f.events, f.dependencies.audit.entries({})])).not.toContain('fixture-query-secret');
    } finally { f.dispose(); }
});

it('serves installed card/status metadata and icons without secrets; corrupt icons leave cards usable', async () => {
    const f = fixture({}); const pluginId = 'fixture-vendor';
    const path = 'io.github.ainsep.openmarketing/assets/icon.svg'; const bytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');
    const digest = createHash('sha256').update(bytes).digest('hex'); let corrupt = false;
    const readCredentialCards = async (input: { pluginId: string }) => parseCredentialCardManifest({ pluginId: input.pluginId, raw: JSON.stringify({ name: pluginId,
        extensions: { 'io.github.ainsep.openmarketing': { credentialAssets: { [path]: digest }, credentialCards: [{ target: pluginId, title: 'Fixture', label: 'Save token',
            category: 'Advertising', intro: 'Saved credentials are unverified.', usedFor: ['Read campaigns'], helpUrl: 'https://fixture.example/help', helpLabel: 'Help', baseUrl: 'https://fixture.example',
            saveKind: 'api-key', secretFields: [{ name: 'token', label: 'Token', required: true }], icon: path }] } } }) });
    const integrations = createIntegrations({ ...f.dependencies, readCredentialCards, readCredentialAsset: async () => ({ ok: true, value: corrupt ? Buffer.from('corrupt') : bytes }) });
    try {
        unwrap({ result: await integrations.connect({ context: owner, request: { ...request, pluginId } }) });
        const status = await integrations.oauthStatus({ context: owner, pluginId });
        expect(status).toMatchObject({ ok: true, value: { configured: false, credentialCards: [{ pluginId, iconDigest: digest }], connections: [{ pluginId, status: 'saved' }], connectionsCursor: null } });
        expect(JSON.stringify([status, f.events])).not.toContain(request.plaintext);
        const http: HttpRequest = { method: 'GET', path: '/api/addons/v1/integrations/credential-asset', query: { pluginId, digest } };
        expect(await handleIntegrationRequest({ request: http, context: owner, integrations })).toMatchObject({ status: 200, body: bytes, contentType: 'image/svg+xml', headers: { 'x-content-type-options': 'nosniff' } });
        expect(await handleIntegrationRequest({ request: http, context: host, integrations })).toMatchObject({ status: 403 });
        expect(await integrations.credentialAsset({ context: host, pluginId, digest })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
        expect(await integrations.credentialAsset({ context: owner, pluginId: 'foreign', digest })).toMatchObject({ ok: false });
        expect(await integrations.credentialAsset({ context: owner, pluginId, digest: '0'.repeat(64) })).toMatchObject({ ok: false });
        corrupt = true;
        const degraded = unwrap({ result: await integrations.oauthStatus({ context: owner, pluginId }) });
        expect(degraded).toMatchObject({ credentialCards: [{ pluginId, actionSupported: true }], connections: [{ status: 'saved' }] });
        expect('credentialCards' in degraded && degraded.credentialCards[0]).not.toHaveProperty('icon');
        expect(await integrations.credentialAsset({ context: owner, pluginId, digest })).toMatchObject({ ok: false });
        unwrap({ result: await f.dependencies.repo.requireReconnect({ context: host, connectionId: request.connectionId }) });
        expect(await integrations.oauthStatus({ context: owner, pluginId })).toMatchObject({ value: { connections: [{ status: 'reconnect_required' }] } });
        unwrap({ result: await integrations.disconnect({ context: owner, request: { connectionId: request.connectionId } }) });
        expect(await integrations.oauthStatus({ context: owner, pluginId })).toMatchObject({ value: { connections: [{ status: 'disconnected' }] } });
    } finally { f.dispose(); }
});

it('preserves exact structured credential JSON and integer expiry through existing sealed token ingress', async () => {
    const f = fixture({}); const pluginId = 'fixture-bundle';
    const bundle = { clientId: 'fixture-client', accessToken: 'fixture-secret-token', expiresAt: 9999999, region: 'eu' };
    try {
        const plaintext = JSON.stringify(bundle);
        const saved = await f.http({ method: 'POST', path: '/api/addons/v1/integrations/token', body: { pluginId, connectionId: pluginId, plaintext } });
        expect(saved).toMatchObject({ status: 200, body: { value: { pluginId, status: 'saved' } } });
        const accessed = unwrap({ result: await f.integrations.access({ context: host, pluginId, connectionId: pluginId }) });
        expect(accessed.accessToken).toBe(plaintext); expect(JSON.parse(accessed.accessToken)).toEqual(bundle);
        expect(await f.integrations.access({ context: host, pluginId: 'foreign', connectionId: pluginId })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
        expect(JSON.stringify([saved, f.events])).not.toContain(bundle.accessToken);
    } finally { f.dispose(); }
});

function unwrap<T>(required: { result: Outcome<T> }): T {
    if (!required.result.ok) throw new Error(required.result.error.code);
    return required.result.value;
}

/** Owned in-memory native database, real sealing and inspectable metadata-only audit/observer. */
function fixture(required: { readCredentialCards?: IntegrationDependencies['readCredentialCards'] }) {
    const native = new Database(':memory:');
    native.exec(readFileSync(new URL('../../../features/credentials/migrations/0001_credentials.sql', import.meta.url), 'utf8'));
    const db: CredentialSqlPort = { async query<Row extends Record<string, unknown>>(input: { text: string; values?: unknown[] }) {
        const statement = native.prepare(input.text);
        const values = Object.fromEntries((input.values ?? []).map((entry, index) => [String(index + 1), entry]));
        if (statement.reader) {
            const rows = statement.all(values) as Row[];
            return { rows, rowCount: rows.length };
        }
        return { rows: [], rowCount: statement.run(values).changes };
    } };
    const keyring = createCredentialKeyring({ loadMaster: async () => ({ ok: true, value: new Uint8Array(32).fill(9) }) });
    let nonce = 0;
    const sealer = createAesGcmSecretSealer({ keyring, configuration, randomBytes: ({ size }) => new Uint8Array(size).fill(++nonce) });
    const locks = createMemoryCredentialLock({});
    const repo = createSqlCredentialRepo({ db, clock });
    const audit = createMemoryCredentialAudit({});
    const events: ObserverEvent[] = [];
    const observer = { observe(event: ObserverEvent) { events.push(event); } };
    const service = createCredentialService({ repo, sealer, keyring, locks, audit, clock, oauth: createMemoryOAuthClient({}) });
    const dependencies = { ...required, repo, sealer, locks, audit, service, db, observer, oauthProviders: new Map<string, unknown>(), broker: createCredentialBroker({ repo, sealer, locks, audit }) };
    const integrations = createIntegrations(dependencies);
    return { native, dependencies, integrations, events,
        withRefresh(input: { refresh: CredentialRefreshPort }) {
            return createIntegrations({ ...dependencies, broker: createCredentialBroker({ repo, sealer, locks, audit, ...input }) });
        },
        http(input: HttpRequest) { return handleIntegrationRequest({ request: input, context: owner, integrations }); },
        dispose() { native.close(); },
    };
}

it('connects, lists, accesses a saved credential and disconnects with secret-free HTTP/audit metadata', async () => {
    const f = fixture({});
    try {
        const saved = await f.http({ method: 'POST', path: '/api/addons/v1/integrations/token', body: request });
        expect(saved).toMatchObject({ status: 200, body: { ok: true, value: { connectionId: request.connectionId, pluginId: 'anthropic', status: 'saved' } } });
        expect(await f.http({ method: 'GET', path: '/api/addons/v1/integrations' })).toMatchObject({ status: 200, body: { ok: true, value: { items: [{ connectionId: request.connectionId, pluginId: 'anthropic', status: 'saved' }], cursor: null } } });
        expect(await f.integrations.access({ context: host, pluginId: 'anthropic', connectionId: request.connectionId })).toEqual({ ok: true, value: { accessToken: request.plaintext } });
        const disconnected = await f.http({ method: 'POST', path: '/api/addons/v1/integrations/disconnect', body: { connectionId: request.connectionId } });
        expect(disconnected).toMatchObject({ status: 200, body: { ok: true, value: { status: 'disconnected' } } });
        expect(f.native.prepare('SELECT ciphertext, status FROM om_credential_connection').get()).toEqual({ ciphertext: null, status: 'revoked' });
        expect(await f.integrations.access({ context: host, pluginId: 'anthropic', connectionId: request.connectionId })).toMatchObject({ ok: false, error: { code: 'unauthenticated' } });
        expect(await f.http({ method: 'GET', path: '/api/addons/v1/integrations' })).toMatchObject({ body: { value: { items: [{ status: 'disconnected' }] } } });
        expect(JSON.stringify([saved, disconnected, f.events, f.dependencies.audit.entries({})])).not.toContain(request.plaintext);
        expect(f.events).toContainEqual({ operation: 'integrations.connect', outcome: 'succeeded', correlationId: owner.correlationId, traceId: owner.traceId, runId: owner.runId });
    } finally { f.dispose(); }
});

it('denies agent/mismatched owner before lazy body reading and excludes client-supplied scope', async () => {
    const f = fixture({});
    try {
        let reads = 0;
        const httpRequest: HttpRequest = { method: 'POST', path: '/api/addons/v1/integrations/token', readBody: async () => { reads++; return { ok: true, value: request }; } };
        const contexts: CallContext[] = [{ ...owner, principal: { kind: 'agent', agentInstanceId: 'agent', runId: 'run' } }, { ...owner, principal: { kind: 'owner', ownerId: 'foreign-owner' } }, host];
        for (const context of contexts) expect(await handleIntegrationRequest({ request: httpRequest, context, integrations: f.integrations })).toMatchObject({ status: 403 });
        expect(reads).toBe(0);
        expect(await f.http({ ...httpRequest, readBody: undefined, body: { ...request, scope: { ownerId: 'foreign', workspaceId: 'foreign' } } })).toMatchObject({ status: 400 });
        expect(f.native.prepare('SELECT COUNT(*) AS total FROM om_credential_connection').get()).toEqual({ total: 0 });
    } finally { f.dispose(); }
});

it('rejects unknown fields, oversized UTF-8 and invalid list limits, and has no deferred routes', async () => {
    const f = fixture({});
    try {
        expect(await f.http({ method: 'POST', path: '/api/addons/v1/integrations/token', body: { ...request, plaintext: 'é'.repeat(32769) } })).toMatchObject({ status: 400 });
        expect(await f.http({ method: 'POST', path: '/api/addons/v1/integrations/token', body: { ...request, verified: true } })).toMatchObject({ status: 400 });
        expect(await f.http({ method: 'GET', path: '/api/addons/v1/integrations', query: { limit: '101' } })).toMatchObject({ status: 400 });
        expect(await f.http({ method: 'GET', path: '/api/addons/v1/integrations', query: { token: request.plaintext } })).toMatchObject({ status: 400 });
        for (const suffix of ['oauth/begin', 'oauth/complete', 'test']) expect(await f.http({ method: 'POST', path: '/api/addons/v1/integrations/' + suffix })).toMatchObject({ status: 404 });
        const badBody = await f.http({ method: 'POST', path: '/api/addons/v1/integrations/token', readBody: async () => { throw new Error(request.plaintext); } });
        expect(badBody).toMatchObject({ status: 400 });
        expect(JSON.stringify(badBody)).not.toContain(request.plaintext);
    } finally { f.dispose(); }
});

it('checks plugin ownership, host-only access and workspace scope at every access', async () => {
    const f = fixture({});
    try {
        unwrap({ result: await f.integrations.connect({ context: owner, request }) });
        expect(await f.integrations.access({ context: host, pluginId: 'meta-ads', connectionId: request.connectionId })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
        expect(await f.integrations.access({ context: owner, pluginId: 'anthropic', connectionId: request.connectionId })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
        const foreign = { ...host, scope: { ...host.scope, workspaceId: 'other-workspace' } };
        expect(await f.integrations.access({ context: foreign, pluginId: 'anthropic', connectionId: request.connectionId })).toMatchObject({ ok: false, error: { code: 'unauthenticated' } });
        unwrap({ result: await f.dependencies.repo.requireReconnect({ context: host, connectionId: request.connectionId }) });
        expect(await f.http({ method: 'GET', path: '/api/addons/v1/integrations' })).toMatchObject({ body: { value: { items: [{ status: 'reconnect_required' }] } } });
        expect(await f.integrations.access({ context: host, pluginId: 'anthropic', connectionId: request.connectionId })).toMatchObject({ ok: false, error: { code: 'unauthenticated' } });
    } finally { f.dispose(); }
});

it('unseals the refreshed version and reports reconnect required when refresh rejects authorization', async () => {
    const f = fixture({});
    try {
        unwrap({ result: await f.integrations.connect({ context: owner, request }) });
        const refresh = createMemoryCredentialRefresh({ sealer: f.dependencies.sealer, dueVersions: [1] });
        const integrations = f.withRefresh({ refresh });
        expect(await integrations.access({ context: host, pluginId: 'anthropic', connectionId: request.connectionId })).toEqual({ ok: true, value: { accessToken: 'test-refreshed-token' } });
        expect(refresh.calls({})).toBe(1);
        expect(f.native.prepare('SELECT version FROM om_credential_connection').get()).toEqual({ version: 2 });
        const revokedRefresh = createMemoryCredentialRefresh({ sealer: f.dependencies.sealer, revoked: true });
        expect(await f.withRefresh({ refresh: revokedRefresh }).access({ context: host, pluginId: 'anthropic', connectionId: request.connectionId })).toMatchObject({ ok: false, error: { code: 'unauthenticated' } });
        expect(await f.http({ method: 'GET', path: '/api/addons/v1/integrations' })).toMatchObject({ body: { value: { items: [{ status: 'reconnect_required' }] } } });
    } finally { f.dispose(); }
});

it('redacts exceptions from credential adapters', async () => {
    const f = fixture({});
    try {
        unwrap({ result: await f.integrations.connect({ context: owner, request }) });
        const integrations = createIntegrations({ ...f.dependencies, broker: { async use() { throw new Error(request.plaintext); } } });
        const failed = await integrations.access({ context: host, pluginId: 'anthropic', connectionId: request.connectionId });
        expect(failed).toMatchObject({ ok: false, error: { code: 'unavailable' } });
        expect(JSON.stringify([failed, f.events])).not.toContain(request.plaintext);
    } finally { f.dispose(); }
});

it('composition binds credential storage/audit to the existing SQLite handle with injected crypto', async () => {
    const f = fixture({});
    try {
        let sequence = 0;
        const nativeIo = createNodeBootIo({ projectRoot: '/fixture', studioRoot: '/fixture', ready() {} });
        const integrations = bindServerIntegrations({ db: f.dependencies.db, clock, ids: { next: () => 'event-' + ++sequence },
            observer: f.dependencies.observer, io: { ...nativeIo, randomToken: () => 'ab'.repeat(32), loadCredentialMaster: async () => ({ ok: true, value: new Uint8Array(32).fill(3) }) }, stateRoot: '/fixture' });
        expect(await integrations.connect({ context: owner, request })).toMatchObject({ ok: true, value: { status: 'saved' } });
        expect(await integrations.access({ context: host, pluginId: 'anthropic', connectionId: request.connectionId })).toEqual({ ok: true, value: { accessToken: request.plaintext } });
        expect(f.native.prepare('SELECT operation, correlation_id, trace_id, run_id FROM om_credential_audit ORDER BY rowid').all()).toEqual([
            { operation: 'credentials.connect', correlation_id: owner.correlationId, trace_id: owner.traceId, run_id: owner.runId },
            { operation: 'credentials.use', correlation_id: owner.correlationId, trace_id: owner.traceId, run_id: owner.runId },
        ]);
        expect(JSON.stringify(f.native.prepare('SELECT * FROM om_credential_connection').all())).not.toContain(request.plaintext);
    } finally { f.dispose(); }
});

it('provisions one private master key, reuses it and rejects malformed/insecure keys', async () => {
    const directory = await fs.mkdtemp(join(tmpdir(), 'om-d1-key-'));
    const config = { ...configuration, keyFilePath: join(directory, 'credentials.key') };
    try {
        const first = unwrap({ result: await loadCredentialMaster({ configuration: config, fs, randomToken: () => 'cd'.repeat(32) }) });
        expect(first).toEqual(new Uint8Array(32).fill(0xcd));
        expect((await fs.stat(config.keyFilePath)).mode & 0o777).toBe(0o600);
        expect(await loadCredentialMaster({ configuration: config, fs, randomToken: () => 'ef'.repeat(32) })).toEqual({ ok: true, value: first });
        await fs.chmod(config.keyFilePath, 0o644);
        expect(await loadCredentialMaster({ configuration: config, fs, randomToken: () => 'ef'.repeat(32) })).toMatchObject({ ok: false, error: { code: 'unavailable' } });
        await fs.chmod(config.keyFilePath, 0o600);
        await fs.writeFile(config.keyFilePath, 'malformed');
        expect(await loadCredentialMaster({ configuration: config, fs, randomToken: () => 'ef'.repeat(32) })).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
        expect(await fs.readFile(config.keyFilePath, 'utf8')).toBe('malformed');
        expect(await loadCredentialMaster({ configuration: config, masterHex: '01'.repeat(32), fs, randomToken: () => 'ef'.repeat(32) })).toEqual({ ok: true, value: new Uint8Array(32).fill(1) });
        expect(await loadCredentialMaster({ configuration: config, masterHex: request.plaintext, fs, randomToken: () => 'ef'.repeat(32) })).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

it('discovers disabled installed OAuth metadata and isolates absent, malformed, mismatched and failed reads', async () => {
    const metadata = fixtureOAuthProviders({ pluginIds: ['google-ads'] }).get('google-ads')!;
    const raw = JSON.stringify({ ...metadata, provider: { ...metadata.provider, label: 'fixture-oauth-file-text' } });
    const rows: AddonSummary[] = ['google-ads', 'absent', 'malformed', 'mismatched', 'failed'].map(id => ({
        id, kind: 'agent-plugin', name: id, description: '', version: '1.0.0', enabled: false, revision: 'fixture',
    }));
    const events: ObserverEvent[] = [];
    const readOAuthMetadata = vi.fn(async ({ pluginId }: { pluginId: string }): Promise<Outcome<string | null>> => {
        if (pluginId === 'absent') return { ok: true, value: null };
        if (pluginId === 'malformed') return { ok: true, value: '{fixture-oauth-file-text' };
        if (pluginId === 'failed') return { ok: false, error: { code: 'unavailable', message: 'fixture-oauth-file-text', retryable: false } };
        return { ok: true, value: raw };
    });
    const list = vi.fn(async () => ({ ok: true as const, value: { items: rows, cursor: null } }));
    const providers = await loadOAuthProviders({ context: owner, observer: { observe(event) { events.push(event); } },
        addons: { addons: { list }, readOAuthMetadata } });
    expect([...providers.keys()]).toEqual(['google-ads']);
    expect(providers.get('google-ads')!.provider.label).toBe('fixture-oauth-file-text');
    expect(readOAuthMetadata.mock.calls.map(([input]) => input.pluginId)).toEqual(rows.map(row => row.id));
    expect(events).toHaveLength(3);
    expect(events).toEqual(Array.from({ length: 3 }, () => ({ operation: 'server.boot.oauth', outcome: 'invalid',
        correlationId: owner.correlationId, traceId: owner.traceId })));
    expect(JSON.stringify(events)).not.toContain('fixture-oauth-file-text');
});

it('refuses OAuth before discovery without caching an empty-origin client, then starts from the same populated map', async () => {
    const f = fixture({}); let sequence = 0;
    const providers = new Map<string, IntegrationOAuthProvider>();
    const fetchFn = vi.fn(async () => Response.json({}));
    const io = { ...createNodeBootIo({ projectRoot: fileURLToPath(new URL('../../../', import.meta.url)), studioRoot: '/fixture', ready() {} }),
        randomToken: () => (++sequence).toString(16).padStart(2, '0').repeat(32),
        loadCredentialMaster: async () => ({ ok: true as const, value: new Uint8Array(32).fill(3) }),
        oauth: { guard: createOAuthUrlGuard({ assertAllowed() {} }, { allowLoopbackHttp: true }), fetchFn } };
    try {
        const integrations = bindServerIntegrations({ db: f.dependencies.db, clock, ids: { next: () => 'early-' + ++sequence },
            observer: f.dependencies.observer, io, providers, readCredentialCards: readInstalledFixtureCards, stateRoot: '/fixture',
            redirectUri: () => 'http://127.0.0.1:43120' + oauthCallbackPath });
        unwrap({ result: await integrations.setOAuthClient({ context: owner, request: { pluginId: 'google-ads',
            client: { clientId: 'fixture-client', clientSecret: 'fixture-client-secret' } } }) });
        expect(await integrations.startOAuth({ context: owner, request: { pluginId: 'google-ads' } })).toMatchObject({ ok: false });
        const metadata = fixtureOAuthProviders({ pluginIds: ['google-ads'] }).get('google-ads')!;
        providers.set('google-ads', metadata);
        const challenge = unwrap({ result: await integrations.startOAuth({ context: owner, request: { pluginId: 'google-ads' } }) });
        expect(new URL(challenge.authorizationUrl).origin).toBe(new URL(metadata.provider.authorizationEndpoint!).origin);
        expect(fetchFn).not.toHaveBeenCalled();
    } finally { f.dispose(); }
});

it('rebuilds challenge rules after late custom-provider discovery instead of caching empty rules', async () => {
    const f = fixture({}); let sequence = 0;
    const providers = new Map<string, IntegrationOAuthProvider>();
    const fetchFn = vi.fn(async () => Response.json({}));
    const io = { ...createNodeBootIo({ projectRoot: fileURLToPath(new URL('../../../', import.meta.url)), studioRoot: '/fixture', ready() {} }),
        randomToken: () => (++sequence).toString(16).padStart(2, '0').repeat(32),
        loadCredentialMaster: async () => ({ ok: true as const, value: new Uint8Array(32).fill(3) }),
        oauth: { guard: createOAuthUrlGuard({ assertAllowed() {} }, { allowLoopbackHttp: true }), fetchFn } };
    try {
        const integrations = bindServerIntegrations({ db: f.dependencies.db, clock, ids: { next: () => 'early-' + ++sequence },
            observer: f.dependencies.observer, io, providers, readCredentialCards: readInstalledFixtureCards, stateRoot: '/fixture',
            redirectUri: () => 'http://127.0.0.1:43120' + oauthCallbackPath });
        unwrap({ result: await integrations.setOAuthClient({ context: owner, request: { pluginId: 'meta-ads',
            client: { clientId: '12345', clientSecret: 'fixture-client-secret', configId: '999' } } }) });
        expect(await integrations.startOAuth({ context: owner, request: { pluginId: 'meta-ads' } })).toMatchObject({ ok: false });
        const metadata = fixtureOAuthProviders({ pluginIds: ['meta-ads'] }).get('meta-ads')!;
        providers.set('meta-ads', metadata);
        const challenge = unwrap({ result: await integrations.startOAuth({ context: owner, request: { pluginId: 'meta-ads' } }) });
        expect(new URL(challenge.authorizationUrl).origin).toBe(new URL(metadata.provider.authorizationEndpoint!).origin);
        const url = new URL(challenge.authorizationUrl);
        expect(url.searchParams.get('config_id')).toBe('999');
        expect(url.searchParams.has('scope')).toBe(false);
        expect(url.searchParams.has('code_challenge')).toBe(false);
        expect(url.searchParams.has('code_challenge_method')).toBe(false);
        expect(fetchFn).not.toHaveBeenCalled();
    } finally { f.dispose(); }
});

it.each(['google-ads', 'linkedin-ads'])('loads %s metadata, exchanges once, seals tokens and refreshes at plugin access', async pluginId => {
    const f = fixture({}); let now = 1000; let sequence = 0;
    const calls: { url: string; init?: RequestInit }[] = [];
    const io = { ...createNodeBootIo({ projectRoot: fileURLToPath(new URL('../../../', import.meta.url)), studioRoot: '/fixture', ready() {} }),
        randomToken: () => (++sequence).toString(16).padStart(2, '0').repeat(32),
        loadCredentialMaster: async () => ({ ok: true as const, value: new Uint8Array(32).fill(3) }),
        oauth: { guard: createOAuthUrlGuard({ assertAllowed() {} }, { allowLoopbackHttp: true }), async fetchFn(input: { url: string | URL | Request }, init?: RequestInit) {
            calls.push({ url: String(input.url), init });
            return Response.json(calls.length === 1 ? { access_token: 'fixture-access', refresh_token: 'fixture-refresh', expires_in: 3600, token_type: 'Bearer', refresh_token_expires_in: 86400 }
                : { access_token: 'fixture-refreshed', expires_in: 3600, token_type: 'Bearer' });
        } } };
    try {
        const providers = fixtureOAuthProviders({ pluginIds: [pluginId] });
        const integrations = bindServerIntegrations({ db: f.dependencies.db, clock: { now: () => now }, ids: { next: () => 'oauth-' + ++sequence }, observer: f.dependencies.observer,
            io, providers, readCredentialCards: readInstalledFixtureCards, stateRoot: '/fixture', redirectUri: () => 'http://127.0.0.1:43120' + oauthCallbackPath });
        expect(await integrations.startOAuth({ context: owner, request: { pluginId } })).toMatchObject({ ok: false });
        unwrap({ result: await integrations.setOAuthClient({ context: owner, request: { pluginId, client: { clientId: 'fixture-client', clientSecret: 'fixture-client-secret' } } }) });
        const challenge = unwrap({ result: await integrations.startOAuth({ context: owner, request: { pluginId } }) });
        const url = new URL(challenge.authorizationUrl);
        expect(url.searchParams.get('code_challenge_method')).toBe('S256');
        expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:43120' + oauthCallbackPath);
        if (pluginId === 'google-ads') { expect(url.searchParams.get('access_type')).toBe('offline'); expect(url.searchParams.get('prompt')).toBe('consent'); }
        const query = { state: url.searchParams.get('state')!, code: 'fixture-code', scope: 'provider-display-field' };
        const callback = await handleOAuthBrowserCallback({ context: owner, integrations, request: { method: 'GET', path: oauthCallbackPath, query } });
        expect(callback).toMatchObject({ status: 200, headers: { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
        expect(await integrations.oauthStatus({ context: owner, transactionId: challenge.transactionId })).toMatchObject({ ok: true, value: { status: 'complete', connection: { status: 'saved' } } });
        expect(await integrations.oauthStatus({ context: { ...owner, scope: { ...owner.scope, workspaceId: 'foreign' } }, transactionId: challenge.transactionId })).toMatchObject({ value: { status: 'expired' } });
        expect((await handleOAuthBrowserCallback({ context: owner, integrations, request: { method: 'GET', path: oauthCallbackPath, query } })).status).toBe(400);
        expect(calls).toHaveLength(1);
        expect(calls[0].init?.redirect).toBe('error');
        expect(new URLSearchParams(String(calls[0].init?.body)).get('code_verifier')).toBeTruthy();
        expect(await integrations.access({ context: host, pluginId, connectionId: challenge.transactionId })).toMatchObject({ ok: true, value: { accessToken: 'fixture-access', expiresAt: 3601000 } });
        now = 3600000;
        unwrap({ result: await integrations.setOAuthClient({ context: owner, request: { pluginId, client: { clientId: 'fixture-client', clientSecret: 'replacement-secret' } } }) });
        expect(await integrations.access({ context: host, pluginId, connectionId: challenge.transactionId })).toMatchObject({ ok: true, value: { accessToken: 'fixture-refreshed' } });
        expect(calls).toHaveLength(2);
        expect(new URLSearchParams(String(calls[1].init?.body)).get('client_secret')).toBe('replacement-secret');
        expect(new URLSearchParams(String(calls[1].init?.body)).get('refresh_token')).toBe('fixture-refresh');
        expect(f.native.prepare('SELECT version FROM om_credential_connection WHERE connection_id = ?').get(challenge.transactionId)).toEqual({ version: 2 });
        expect(JSON.stringify([callback, f.events, f.native.prepare('SELECT * FROM om_credential_connection').all()])).not.toMatch(/fixture-access|fixture-refresh|fixture-code|fixture-client-secret/);
        now = 7200000;
        unwrap({ result: await integrations.access({ context: host, pluginId, connectionId: challenge.transactionId }) });
        expect(new URLSearchParams(String(calls[2].init?.body)).get('refresh_token')).toBe('fixture-refresh');
        const denied = unwrap({ result: await integrations.startOAuth({ context: owner, request: { pluginId } }) });
        const state = new URL(denied.authorizationUrl).searchParams.get('state')!;
        expect(await integrations.completeOAuth({ context: owner, response: { state, code: 'both', error: 'access_denied' } })).toMatchObject({ ok: false });
        expect(await integrations.completeOAuth({ context: owner, response: { state, error: 'access_denied', error_description: 'fixture-secret' } })).toMatchObject({ ok: false });
        expect(await integrations.completeOAuth({ context: owner, response: { state, code: 'replay' } })).toMatchObject({ ok: false });
        expect(calls).toHaveLength(3);
        unwrap({ result: await integrations.setOAuthClient({ context: owner, request: { pluginId, client: null } }) });
        now = 10800000;
        expect(await integrations.access({ context: host, pluginId, connectionId: challenge.transactionId })).toMatchObject({ ok: false });
        expect(calls).toHaveLength(3);
    } finally { f.dispose(); }
});

it('denies OAuth management before reading unauthenticated bodies and rejects caller endpoints', async () => {
    const f = fixture({}); let reads = 0;
    try {
        for (const path of ['start', 'callback', 'client']) {
            expect(await handleIntegrationRequest({ context: host, integrations: f.integrations, request: { method: 'POST', path: '/api/addons/v1/integrations/oauth/' + path,
                async readBody() { reads++; return { ok: true, value: {} }; } } })).toMatchObject({ status: 403 });
        }
        expect(reads).toBe(0);
        expect(await f.http({ method: 'POST', path: '/api/addons/v1/integrations/oauth/start', body: { pluginId: 'google-ads', tokenEndpoint: 'https://attacker.test' } })).toMatchObject({ status: 400 });
        expect(await f.http({ method: 'GET', path: '/api/addons/v1/integrations/oauth/status', query: { transactionId: 'unknown' } })).toMatchObject({ status: 200, body: { value: { status: 'expired' } } });
    } finally { f.dispose(); }
});

it('permits HTTP only for the fixed loopback redirect and rejects token endpoint exceptions', () => {
    const { guard } = createOAuthHttp({});
    const raw = 'http://127.0.0.1:43120' + oauthCallbackPath;
    expect(guard.assertSafeUrl({ raw, label: 'redirect URI' }).href).toBe(raw);
    expect(() => guard.assertSafeUrl({ raw, label: 'token endpoint' })).toThrow();
    for (const redirect of [raw + '?code=tainted', raw + '/extra', 'https://attacker.test' + oauthCallbackPath]) {
        expect(() => guard.assertSafeUrl({ raw: redirect, label: 'redirect URI' })).toThrow();
    }
});

it('seals purpose-bound clients, isolates access, and supports clear then set without exposing secrets', async () => {
    const f = fixture({ readCredentialCards: readInstalledFixtureCards }); const pluginId = 'google-ads'; const path = '/api/addons/v1/integrations/oauth/client';
    const client = { clientId: 'fixture-client', clientSecret: 'fixture-client-secret' };
    try {
        const saved = await f.http({ method: 'POST', path, body: { pluginId, client } });
        expect(saved).toMatchObject({ status: 200, body: { ok: true, value: { configured: true, clientId: client.clientId } } });
        expect(await f.http({ method: 'GET', path: '/api/addons/v1/integrations/oauth/status', query: { pluginId } })).toMatchObject({ body: { value: { configured: true, clientId: client.clientId } } });
        expect(await f.integrations.oauthStatus({ context: { ...owner, scope: { ...owner.scope, workspaceId: 'other' } }, pluginId })).toMatchObject({ ok: true, value: { configured: false } });
        expect(await f.integrations.oauthStatus({ context: owner, pluginId: 'linkedin-ads' })).toMatchObject({ ok: true, value: { configured: false } });
        expect(await f.http({ method: 'GET', path: '/api/addons/v1/integrations' })).toMatchObject({ body: { value: { items: [], cursor: null } } });
        expect(await f.integrations.access({ context: host, pluginId, connectionId: 'oauth-client.' + pluginId })).toMatchObject({ ok: false });
        expect(await f.integrations.connect({ context: owner, request: { connectionId: 'oauth-client.' + pluginId, pluginId, plaintext: 'overwrite' } })).toMatchObject({ ok: false });
        expect(await f.integrations.disconnect({ context: owner, request: { connectionId: 'oauth-client.' + pluginId } })).toMatchObject({ ok: false });
        expect(await f.integrations.oauthStatus({ context: owner, transactionId: 'oauth-client.' + pluginId })).toMatchObject({ value: { status: 'expired' } });
        for (const invalid of [{ clientId: '' }, { clientId: 'x', clientSecret: 'x'.repeat(8193) }]) {
            expect(await f.http({ method: 'POST', path, body: { pluginId, client: invalid } })).toMatchObject({ status: 400 });
        }
        expect(await f.http({ method: 'POST', path, body: { pluginId, client: null } })).toMatchObject({ body: { value: { configured: false } } });
        expect(await f.http({ method: 'POST', path, body: { pluginId, client: { clientId: 'public-client' } } })).toMatchObject({ body: { value: { configured: true, clientId: 'public-client' } } });
        expect(JSON.stringify([saved, f.events, f.dependencies.audit.entries({}), f.native.prepare('SELECT * FROM om_credential_connection').all()])).not.toContain(client.clientSecret);
    } finally { f.dispose(); }
});

it.each(['GET', 'POST'] as const)('returns 404 for removed developer-token %s without reading the body', async method => {
    const f = fixture({}); let reads = 0;
    try {
        expect(await f.http({ method, path: '/api/addons/v1/integrations/developer-token', query: { pluginId: 'fixture-plugin' },
            async readBody() { reads++; throw new Error('Must not read deprecated body'); } })).toMatchObject({ status: 404 });
        expect(reads).toBe(0);
    } finally { f.dispose(); }
});

it.each([false, true])('completes Meta on O1, rejects replay and uses broker reconnect without refresh (non-expiring=%s)', async nonExpiring => {
    const f = fixture({}); let now = 1000; let sequence = 0; let exchanges = 0;
    const pluginId = 'meta-ads'; const client = { clientId: '12345', clientSecret: 'fixture-meta-secret', configId: '999' };
    const io = { ...createNodeBootIo({ projectRoot: fileURLToPath(new URL('../../../', import.meta.url)), studioRoot: '/fixture', ready() {} }),
        randomToken: () => (++sequence).toString(16).padStart(2, '0').repeat(32), loadCredentialMaster: async () => ({ ok: true as const, value: new Uint8Array(32).fill(3) }) };
    try {
        const providers = fixtureOAuthProviders({ pluginIds: [pluginId] }); const scopes = providers.get(pluginId)!.provider.defaultScopes;
        const integrations = bindServerIntegrations({ db: f.dependencies.db, clock: { now: () => now }, ids: { next: () => 'meta-' + ++sequence },
            agentPluginState: async () => ({ enabled: true, bundled: false, admitted: true, revision: 'fixture', entryUrl: 'file:///fixture/oauth.mjs', metadata: {} }),
            observer: f.dependencies.observer, stateRoot: '/fixture', providers, readCredentialCards: readInstalledFixtureCards, redirectUri: () => 'http://127.0.0.1:43120' + oauthCallbackPath,
            io: { ...io, agentPlugins: { ...io.agentPlugins!, moduleDigest: async () => 'a'.repeat(64), loadModule: async () => ({
                createOAuthExchange: (dependencies: Pick<PluginCapabilityDependencies, 'fetch' | 'clock'>) => ({ async exchange(_input: unknown, options?: CallOptions) {
                    for (const path of ['first', 'second', 'third']) await dependencies.fetch('https://fixture.example/' + path, { signal: options?.signal });
                    return { ok: true, value: { accessToken: 'fixture-meta-long', refreshToken: null, tokenType: 'Bearer', scopes: [...scopes, 'email'],
                        expiresAt: nonExpiring ? null : new Date(3601000).toISOString() } };
                } }),
            }) }, oauth: { guard: createOAuthUrlGuard({ assertAllowed() {} }, { allowLoopbackHttp: true }), async fetchFn() {
                exchanges++;
                return Response.json(exchanges === 3 ? { data: { app_id: client.clientId, type: 'USER', is_valid: true, expires_at: nonExpiring ? 0 : 3601,
                    data_access_expires_at: nonExpiring ? 0 : 3601, scopes: [...scopes, 'email'] } }
                    : { access_token: exchanges === 1 ? 'fixture-meta-short' : 'fixture-meta-long', token_type: 'bearer', expires_in: nonExpiring ? 0 : 3600 });
            } } } });
        const saved = unwrap({ result: await integrations.setOAuthClient({ context: owner, request: { pluginId, client } }) });
        expect(saved).toEqual({ configured: true, clientId: client.clientId });
        expect(await integrations.setOAuthClient({ context: owner, request: { pluginId, client: { clientId: client.clientId, clientSecret: client.clientSecret } } })).toMatchObject({ ok: true });
        expect(await integrations.startOAuth({ context: owner, request: { pluginId } })).toMatchObject({ ok: false, error: { code: 'unavailable' } });
        unwrap({ result: await integrations.setOAuthClient({ context: owner, request: { pluginId, client } }) });
        const challenge = unwrap({ result: await integrations.startOAuth({ context: owner, request: { pluginId } }) });
        const query = { state: new URL(challenge.authorizationUrl).searchParams.get('state')!, code: 'fixture-meta-code' };
        expect(await integrations.completeOAuth({ context: owner, response: { ...query, error: 'access_denied' } })).toMatchObject({ ok: false });
        expect(await integrations.completeOAuth({ context: owner, response: { ...query, state: 'foreign-state' } })).toMatchObject({ ok: false });
        const callback = await handleOAuthBrowserCallback({ context: owner, integrations, request: { method: 'GET', path: oauthCallbackPath, query } });
        expect(callback.status).toBe(200);
        expect(await integrations.completeOAuth({ context: owner, response: query })).toMatchObject({ ok: false });
        expect(await integrations.access({ context: host, pluginId, connectionId: challenge.transactionId })).toMatchObject({ ok: true, value: { accessToken: 'fixture-meta-long', scopes: [...scopes, 'email'] } });
        now = 10000000000;
        const used = await integrations.access({ context: host, pluginId, connectionId: challenge.transactionId });
        expect(used.ok).toBe(nonExpiring); expect(exchanges).toBe(3);
        expect(await integrations.list({ context: owner, query: { limit: 25 } })).toMatchObject({ value: { items: [{ status: nonExpiring ? 'saved' : 'reconnect_required' }] } });
        expect(await integrations.oauthStatus({ context: owner, pluginId: 'tiktok-ads' })).toMatchObject({ ok: true, value: { configured: false } });
        expect(await integrations.oauthStatus({ context: host, pluginId: 'tiktok-ads' })).toMatchObject({ ok: false });
        expect(await integrations.startOAuth({ context: owner, request: { pluginId: 'tiktok-ads' } })).toMatchObject({ ok: false });
        const denied = unwrap({ result: await integrations.startOAuth({ context: owner, request: { pluginId } }) });
        expect(await integrations.completeOAuth({ context: owner, response: { state: new URL(denied.authorizationUrl).searchParams.get('state')!, error: 'access_denied', error_description: 'fixture-meta-secret' } })).toMatchObject({ ok: false });
        expect(exchanges).toBe(3);
        expect(JSON.stringify([saved, callback, f.events, f.native.prepare('SELECT * FROM om_credential_connection').all()])).not.toMatch(/fixture-meta-secret|fixture-meta-code|fixture-meta-short|fixture-meta-long/);
    } finally { f.dispose(); }
});

it('denies admitted:false Meta through composed integrations with zero network and no saved connection', async () => {
    const f = fixture({}); let sequence = 0; let exchanges = 0; let admissionChecks = 0;
    const pluginId = 'meta-ads';
    const io = { ...createNodeBootIo({ projectRoot: fileURLToPath(new URL('../../../', import.meta.url)), studioRoot: '/fixture', ready() {} }),
        randomToken: () => (++sequence).toString(16).padStart(2, '0').repeat(32),
        loadCredentialMaster: async () => ({ ok: true as const, value: new Uint8Array(32).fill(3) }),
        oauth: { guard: createOAuthUrlGuard({ assertAllowed() {} }, { allowLoopbackHttp: true }), async fetchFn() {
            exchanges++; return Response.json({ access_token: 'fixture-token', token_type: 'bearer', expires_in: 3600 });
        } } };
    try {
        const integrations = bindServerIntegrations({ db: f.dependencies.db, clock, ids: { next: () => 'denied-' + ++sequence },
            observer: f.dependencies.observer, io, stateRoot: '/fixture', providers: fixtureOAuthProviders({ pluginIds: [pluginId] }), readCredentialCards: readInstalledFixtureCards,
            redirectUri: () => 'http://127.0.0.1:43120' + oauthCallbackPath,
            agentPluginState: async input => {
                expect(input).toEqual({ context: owner, pluginId }); admissionChecks++;
                return { enabled: true, bundled: true, admitted: false, revision: 'fixture', metadata: {} };
            } });
        unwrap({ result: await integrations.setOAuthClient({ context: owner, request: { pluginId,
            client: { clientId: '12345', clientSecret: 'fixture-meta-secret', configId: '999' } } }) });
        const challenge = unwrap({ result: await integrations.startOAuth({ context: owner, request: { pluginId } }) });
        const response = { state: new URL(challenge.authorizationUrl).searchParams.get('state')!, code: 'fixture-code' };
        expect(await integrations.completeOAuth({ context: owner, response })).toMatchObject({ ok: false, error: { code: 'forbidden', retryable: false } });
        expect(admissionChecks).toBe(1); expect(exchanges).toBe(0);
        expect(await integrations.completeOAuth({ context: owner, response })).toMatchObject({ ok: false });
        expect(admissionChecks).toBe(1); expect(exchanges).toBe(0);
        expect(await integrations.oauthStatus({ context: owner, transactionId: challenge.transactionId })).toEqual({ ok: true, value: { status: 'expired' } });
        expect(await integrations.list({ context: owner, query: { limit: 25 } })).toMatchObject({ value: { items: [] } });
        expect(f.native.prepare('SELECT COUNT(*) AS total FROM om_credential_connection WHERE connection_id = ?').get(challenge.transactionId)).toEqual({ total: 0 });
    } finally { f.dispose(); }
});

it('refuses GET outside the two Meta token paths before attempting network access', async () => {
    const http = createOAuthHttp({});
    for (const url of ['https://oauth2.googleapis.com/token', 'https://graph.facebook.com/v26.0/me', 'https://graph.facebook.com.attacker.test/v26.0/debug_token']) {
        await expect(http.fetchFn({ url }, { method: 'GET' })).rejects.toThrow('Invalid OAuth request');
    }
});

it.each(['oauth-client', 'developer-token', 'plugin-secret'])('refuses %s purpose IDs before any credential repository or broker read', async purpose => {
    const f = fixture({}); const connectionId = purpose + '.fixture-plugin';
    const getSecret = vi.fn(f.dependencies.repo.getSecret);
    const use = vi.fn(f.dependencies.broker.use);
    const integrations = createIntegrations({ ...f.dependencies, repo: { ...f.dependencies.repo, getSecret }, broker: { use } });
    try {
        expect(await integrations.access({ context: host, pluginId: 'fixture-plugin', connectionId })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
        expect(await integrations.disconnect({ context: owner, request: { connectionId } })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
        expect(await integrations.oauthStatus({ context: owner, transactionId: connectionId })).toEqual({ ok: true, value: { status: 'expired' } });
        expect(getSecret).not.toHaveBeenCalled(); expect(use).not.toHaveBeenCalled();
    } finally { f.dispose(); }
});

/** Small installed-card fixture; parsing binds fields/save targets exactly as production does. */
function declaredCards(required: { pluginId: string; cards: unknown[] }) {
    return parseCredentialCardManifest({ pluginId: required.pluginId, raw: JSON.stringify({ name: required.pluginId,
        extensions: { 'io.github.ainsep.openmarketing': { credentialCards: required.cards } } }) });
}
const fixtureCard = { target: 'fixture-card', title: 'Fixture', label: 'Save', category: 'Integration', intro: 'Fixture credentials.',
    usedFor: ['Fixture operation'], helpUrl: 'https://fixture.example/help', helpLabel: 'Help', baseUrl: 'https://fixture.example' };
const secretCards = [{ ...fixtureCard, saveKind: 'plugin-secret', secretFields: [{ name: 'firstSecret', label: 'First', required: true }] },
    { ...fixtureCard, target: 'fixture-second', saveKind: 'plugin-secret', secretFields: [{ name: 'secondSecret', label: 'Second', required: true }] }];

it('attaches only current bound plugin-secret fields and reads replacements and clears afresh', async () => {
    const pluginId = 'fixture-plugin'; const sentinel = 'W6_SECRET_SENTINEL_1028';
    let cards = [...secretCards, { ...fixtureCard, target: 'fixture-client', saveKind: 'oauth-client',
        secretFields: [{ name: 'clientSecret', label: 'Client secret', required: true }] }];
    const readCredentialCards = vi.fn(async (input: { pluginId: string }) => declaredCards({ ...input, cards }));
    const f = fixture({ readCredentialCards });
    try {
        unwrap({ result: await f.integrations.setPluginSecret({ context: owner, request: { pluginId, values: { firstSecret: sentinel, secondSecret: 'b' } } }) });
        unwrap({ result: await f.integrations.connect({ context: owner, request: { ...request, pluginId } }) });
        const input = { context: host, pluginId, connectionId: request.connectionId };
        expect(await f.integrations.access(input)).toEqual({ ok: true, value: { accessToken: request.plaintext, secrets: { firstSecret: sentinel, secondSecret: 'b' } } });
        expect(readCredentialCards).toHaveBeenLastCalledWith({ context: host, pluginId });
        cards = cards.map(card => card.target === 'fixture-second' ? { ...card, saveKind: 'oauth-client' } : card);
        expect(await f.integrations.access(input)).toEqual({ ok: true, value: { accessToken: request.plaintext, secrets: { firstSecret: sentinel } } });
        unwrap({ result: await f.integrations.setPluginSecret({ context: owner, request: { pluginId, values: { firstSecret: 'replacement' } } }) });
        expect(await f.integrations.access(input)).toEqual({ ok: true, value: { accessToken: request.plaintext, secrets: { firstSecret: 'replacement' } } });
        unwrap({ result: await f.integrations.setPluginSecret({ context: owner, request: { pluginId, values: null } }) });
        expect(await f.integrations.access(input)).toEqual({ ok: true, value: { accessToken: request.plaintext } });
        expect(JSON.stringify([f.events, f.dependencies.audit.entries({})])).not.toContain(sentinel);
    } finally { f.dispose(); }
});

it('isolates other plugins and omits secrets when records or card declarations are unavailable', async () => {
    const sentinel = 'W6_CARD_FAILURE_SENTINEL_1028';
    const f = fixture({ readCredentialCards: async input => declaredCards({ ...input, cards: input.pluginId === 'fixture-plugin' ? secretCards : [] }) });
    try {
        unwrap({ result: await f.integrations.setPluginSecret({ context: owner, request: { pluginId: 'fixture-plugin', values: { firstSecret: sentinel, secondSecret: 'b' } } }) });
        unwrap({ result: await f.integrations.connect({ context: owner, request: { ...request, pluginId: 'fixture-other' } }) });
        const input = { context: host, pluginId: 'fixture-other', connectionId: request.connectionId };
        expect(await f.integrations.access(input)).toEqual({ ok: true, value: { accessToken: request.plaintext } });
        const readers: NonNullable<IntegrationDependencies['readCredentialCards']>[] = [
            async input => declaredCards({ ...input, cards: secretCards }),
            async () => ({ ok: false, error: { code: 'unavailable', message: sentinel, retryable: false } }),
            async () => { throw new Error(sentinel); },
        ];
        for (const readCredentialCards of readers) {
            const integrations = createIntegrations({ ...f.dependencies, readCredentialCards });
            const result = await integrations.access(input);
            expect(result).toEqual({ ok: true, value: { accessToken: request.plaintext } });
            expect(JSON.stringify([result, f.events, f.dependencies.audit.entries({})])).not.toContain(sentinel);
        }
    } finally { f.dispose(); }
});

it('refuses declared secret-read failures without exposing the secret in errors or metadata', async () => {
    const sentinel = 'W6_READ_FAILURE_SENTINEL_1028'; const pluginId = 'fixture-plugin';
    const f = fixture({ readCredentialCards: async input => declaredCards({ ...input, cards: secretCards }) });
    try {
        unwrap({ result: await f.integrations.connect({ context: owner, request: { ...request, pluginId } }) });
        const integrations = createIntegrations({ ...f.dependencies, repo: { ...f.dependencies.repo, async getSecret(input, options) {
            if (input.connectionId.startsWith('plugin-secret.')) throw new Error(sentinel);
            return f.dependencies.repo.getSecret(input, options);
        } } });
        const result = await integrations.access({ context: host, pluginId, connectionId: request.connectionId });
        expect(result).toMatchObject({ ok: false, error: { code: 'unavailable' } });
        expect(JSON.stringify([result, f.events, f.dependencies.audit.entries({})])).not.toContain(sentinel);
    } finally { f.dispose(); }
});

it.each(['google-ads', 'microsoft-ads'])('exposes a supported generic developerToken secret card for %s', async pluginId => {
    const cards = unwrap({ result: await readInstalledFixtureCards({ pluginId }) }).credentialCards;
    const secrets = cards.filter(card => card.saveKind === 'plugin-secret');
    expect(secrets).toHaveLength(1);
    expect(secrets[0]).toMatchObject({ actionSupported: true });
    expect(secrets[0]?.secretFields?.map(field => field.name)).toEqual(['developerToken']);
    expect(cards.map(card => card.saveKind)).not.toContain('developer-token');
});

it('sets, checks and clears declared plugin secrets with secret-free Outcomes and observer events', async () => {
    const f = fixture({}); const pluginId = 'fixture-plugin'; const sentinel = 'VN_A4_SECRET_SENTINEL_7461028';
    const readCredentialCards = vi.fn(async (input: { pluginId: string }) => declaredCards({ ...input, cards: secretCards }));
    const integrations = createIntegrations({ ...f.dependencies, readCredentialCards });
    try {
        const results = [];
        results.push(await integrations.setPluginSecret({ context: owner, request: { pluginId, values: { firstSecret: sentinel, secondSecret: sentinel } } }));
        expect(results[0]).toEqual({ ok: true, value: { configured: true } });
        readCredentialCards.mockClear();
        results.push(await integrations.pluginSecretStatus({ context: owner, pluginId }));
        expect(results[1]).toEqual({ ok: true, value: { configured: true } });
        expect(readCredentialCards).not.toHaveBeenCalled();
        results.push(await integrations.setPluginSecret({ context: owner, request: { pluginId, values: null } }));
        expect(results[2]).toEqual({ ok: true, value: { configured: false } });
        expect(await integrations.pluginSecretStatus({ context: owner, pluginId })).toEqual({ ok: true, value: { configured: false } });
        results.push(await integrations.setPluginSecret({ context: owner, request: { pluginId, values: { firstSecret: sentinel } } }));
        expect(results[3]).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
        const tainted = createIntegrations({ ...f.dependencies, readCredentialCards: async () => { throw new Error(sentinel); } });
        results.push(await tainted.setPluginSecret({ context: owner, request: { pluginId, values: null } }));
        expect(results[4]).toMatchObject({ ok: false, error: { code: 'unavailable' } });
        expect(JSON.stringify([results, f.events, f.dependencies.audit.entries({})])).not.toContain(sentinel);
    } finally { f.dispose(); }
});

it('refuses undeclared/missing secret fields, absent declarations and non-owner service operations', async () => {
    const f = fixture({}); const pluginId = 'fixture-plugin';
    const readCredentialCards = vi.fn(async (input: { pluginId: string }) => declaredCards({ ...input, cards: secretCards }));
    const integrations = createIntegrations({ ...f.dependencies, readCredentialCards });
    try {
        for (const values of [{ firstSecret: 'first', secondSecret: 'second', undeclared: 'forbidden' }, { firstSecret: 'first' }]) {
            expect(await integrations.setPluginSecret({ context: owner, request: { pluginId, values } })).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
        }
        for (const context of [host, { ...owner, principal: { kind: 'owner' as const, ownerId: 'foreign' } }]) {
            readCredentialCards.mockClear();
            expect(await integrations.setPluginSecret({ context, request: { pluginId, values: null } })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
            expect(await integrations.pluginSecretStatus({ context, pluginId })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
            expect(readCredentialCards).not.toHaveBeenCalled();
        }
        const undeclared = createIntegrations({ ...f.dependencies, readCredentialCards: async input => declaredCards({ ...input, cards: [] }) });
        for (const values of [null, { firstSecret: 'first' }]) expect(await undeclared.setPluginSecret({ context: owner, request: { pluginId, values } })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
        expect(await f.integrations.setPluginSecret({ context: owner, request: { pluginId, values: null } })).toMatchObject({ ok: false, error: { code: 'unavailable' } });
        expect(await integrations.pluginSecretStatus({ context: owner, pluginId: '' })).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
        expect(f.native.prepare('SELECT COUNT(*) AS total FROM om_credential_connection').get()).toEqual({ total: 0 });
    } finally { f.dispose(); }
});

it('serves owner plugin-secret HTTP set/status/clear and refuses non-owners before lazy body reads', async () => {
    const f = fixture({}); const pluginId = 'fixture-plugin'; const path = '/api/addons/v1/integrations/plugin-secret'; let reads = 0;
    const sentinel = 'W12_PLUGIN_SECRET_FIRST'; const replacement = 'W12_PLUGIN_SECRET_REPLACEMENT';
    const integrations = createIntegrations({ ...f.dependencies, readCredentialCards: async input => declaredCards({ ...input, cards: secretCards }) });
    const request: HttpRequest = { method: 'POST', path, async readBody() { reads++; return { ok: true, value: { pluginId, values: { firstSecret: sentinel, secondSecret: sentinel } } }; } };
    try {
        for (const context of [host, { ...owner, principal: { kind: 'owner' as const, ownerId: 'foreign' } }]) {
            expect(await handleIntegrationRequest({ context, integrations, request })).toMatchObject({ status: 403 });
        }
        expect(reads).toBe(0);
        const saved = await handleIntegrationRequest({ context: owner, integrations, request });
        expect(saved).toMatchObject({ status: 200, body: { ok: true, value: { configured: true } } });
        expect(reads).toBe(1);
        expect(await integrations.pluginSecretStatus({ context: { ...owner, scope: { ...owner.scope, workspaceId: 'other' } }, pluginId })).toEqual({ ok: true, value: { configured: false } });
        expect(await integrations.list({ context: owner, query: { limit: 100 } })).toEqual({ ok: true, value: { items: [], cursor: null } });
        const replaced = await handleIntegrationRequest({ context: owner, integrations, request: { method: 'POST', path, body: { pluginId, values: { firstSecret: replacement, secondSecret: replacement } } } });
        expect(replaced).toMatchObject({ status: 200, body: { value: { configured: true } } });
        expect(await handleIntegrationRequest({ context: owner, integrations, request: { method: 'GET', path, query: { pluginId } } })).toMatchObject({ status: 200, body: { value: { configured: true } } });
        const cleared = await handleIntegrationRequest({ context: owner, integrations, request: { method: 'POST', path, body: { pluginId, values: null } } });
        expect(cleared).toMatchObject({ status: 200, body: { value: { configured: false } } });
        expect(await handleIntegrationRequest({ context: owner, integrations, request: { method: 'GET', path, query: { pluginId, token: 'forbidden' } } })).toMatchObject({ status: 400 });
        const publicMetadata = JSON.stringify([saved, replaced, cleared, f.events, f.dependencies.audit.entries({}), f.native.prepare('SELECT * FROM om_credential_connection').all()]);
        expect(publicMetadata).not.toContain(sentinel); expect(publicMetadata).not.toContain(replacement);
    } finally { f.dispose(); }
});

/** Existing file/manifest parser supplies installed card data for composed OAuth fixtures. */
async function readInstalledFixtureCards(required: { pluginId: string }) {
    return parseCredentialCardManifest({ ...required, raw: readFileSync(new URL('../../../content/agent-plugins/' + required.pluginId + '/plugin.json', import.meta.url), 'utf8') });
}

it('retains declared OAuth extras end to end and refuses plugins without an oauth-client declaration', async () => {
    const f = fixture({}); const pluginId = 'fixture-plugin';
    const cards = [{ ...fixtureCard, saveKind: 'oauth-client', fields: [{ name: 'clientId', label: 'ID' }, { name: 'tenant', label: 'Tenant' }],
        secretFields: [{ name: 'clientSecret', label: 'Secret' }, { name: 'notAnExtra', label: 'Other secret' }] }];
    const integrations = createIntegrations({ ...f.dependencies, readCredentialCards: async input => declaredCards({ ...input, cards }) });
    try {
        expect(await integrations.setOAuthClient({ context: owner, request: { pluginId, client: { clientId: 'public-client', clientSecret: 'fixture-client-secret', tenant: 'declared-tenant', notAnExtra: 'must-be-stripped', unknown: 'must-be-stripped' } } })).toEqual({ ok: true, value: { configured: true, clientId: 'public-client' } });
        const client = await readCredentialOAuthClient({ ...f.dependencies, context: host, pluginId, clientFields: ['tenant', 'notAnExtra', 'unknown'] });
        expect(client).toEqual({ ok: true, value: { clientId: 'public-client', clientSecret: 'fixture-client-secret', tenant: 'declared-tenant' } });
        const status = await integrations.oauthStatus({ context: owner, pluginId });
        expect(status).toMatchObject({ ok: true, value: { configured: true, clientId: 'public-client' } });
        expect(JSON.stringify([status, f.events])).not.toContain('fixture-client-secret');
        const undeclared = createIntegrations({ ...f.dependencies, readCredentialCards: async input => declaredCards({ ...input, cards: [] }) });
        expect(await undeclared.setOAuthClient({ context: owner, request: { pluginId, client: null } })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
        expect(await undeclared.oauthStatus({ context: owner, pluginId })).toEqual({ ok: true, value: { configured: false, credentialCards: [], connections: [], connectionsCursor: null } });
        expect(await f.integrations.setOAuthClient({ context: owner, request: { pluginId, client: null } })).toMatchObject({ ok: false, error: { code: 'unavailable' } });
        expect(await f.integrations.oauthStatus({ context: owner, pluginId })).toEqual({ ok: true, value: { configured: false } });
    } finally { f.dispose(); }
});

it.each([false, true])('offers OAuth card actions only for a registered plugin (registered=%s)', async registered => {
    const f = fixture({}); const pluginId = 'fixture-plugin';
    const cards = [{ ...fixtureCard, saveKind: 'oauth' }, { ...fixtureCard, target: 'fixture-client', saveKind: 'oauth-client' }];
    const integrations = createIntegrations({ ...f.dependencies, oauthProviders: new Map(registered ? [[pluginId, {}]] : []),
        readCredentialCards: async input => declaredCards({ ...input, cards }) });
    try {
        const status = unwrap({ result: await integrations.oauthStatus({ context: owner, pluginId }) });
        expect(status).toMatchObject({ configured: false, credentialCards: [
            { saveKind: 'oauth', actionSupported: registered }, { saveKind: 'oauth-client', actionSupported: registered },
        ] });
        expect(status).not.toHaveProperty('guidance');
    } finally { f.dispose(); }
});

/** Conversion settings use only fixture SQL and installed declaration parsing. */
function conversionFixture() {
    const declaration = { fields: [{ name: 'targets', label: 'Target IDs', kind: 'string-map', format: 'decimal-id' }] };
    const readCredentialCards = vi.fn(async (input: { pluginId: string }) => parseCredentialCardManifest({ ...input,
        raw: JSON.stringify({ name: input.pluginId, extensions: { 'io.github.ainsep.openmarketing': { conversionSettings: declaration } } }) }));
    const f = fixture({ readCredentialCards });
    f.native.exec(readFileSync(new URL('../migrations/0006_alerts.sql', import.meta.url), 'utf8'));
    return { ...f, readCredentialCards, declaration };
}

it('round-trips owner conversion settings through HTTP, isolates scopes and replaces/clears values without touching the catalog', async () => {
    const f = conversionFixture(); const pluginId = 'fixture-conversions'; const path = '/api/addons/v1/integrations/conversion-settings';
    f.native.exec(readFileSync(new URL('../migrations/0002_addons.sql', import.meta.url), 'utf8'));
    f.native.prepare('INSERT INTO addon_package VALUES (?,?,?,?,?)').run('owner', 'workspace', 'agent-plugin', pluginId, JSON.stringify({ enabled: false }));
    const catalog = f.native.prepare('SELECT * FROM addon_package').all();
    try {
        const values = { targets: { signup: '1234567890123456789' } };
        expect(await f.http({ method: 'POST', path, body: { pluginId, values } })).toMatchObject({ status: 200, body: { value: { pluginId, declaration: f.declaration, values } } });
        expect(await f.http({ method: 'GET', path, query: { pluginId } })).toMatchObject({ status: 200, body: { value: { values } } });
        expect(await f.integrations.conversionSettings({ context: host, pluginId })).toMatchObject({ ok: true, value: { values } });
        const other = { ...owner, scope: { ...owner.scope, workspaceId: 'other-workspace' } };
        expect(await f.integrations.conversionSettings({ context: other, pluginId })).toMatchObject({ ok: true, value: { values: null } });
        expect(await f.integrations.setConversionSettings({ context: owner, request: { pluginId, values: {} } })).toMatchObject({ ok: true, value: { values: {} } });
        expect(await f.integrations.conversionSettings({ context: owner, pluginId })).toMatchObject({ ok: true, value: { values: {} } });
        expect(f.native.prepare('SELECT * FROM addon_package').all()).toEqual(catalog);
    } finally { f.dispose(); }
});

it('refuses conversion settings writes by non-owners before manifest/SQL and HTTP body reads', async () => {
    const f = conversionFixture(); const sql = vi.spyOn(f.dependencies.db, 'query'); const readBody = vi.fn();
    try {
        for (const context of [host, { ...owner, principal: { kind: 'owner' as const, ownerId: 'other-owner' } }]) {
            expect(await f.integrations.setConversionSettings({ context, request: { pluginId: 'fixture-conversions', values: {} } })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
            expect(await handleIntegrationRequest({ context, integrations: f.integrations, request: { method: 'POST', path: '/api/addons/v1/integrations/conversion-settings', readBody } })).toMatchObject({ status: 403 });
        }
        expect(f.readCredentialCards).not.toHaveBeenCalled(); expect(sql).not.toHaveBeenCalled(); expect(readBody).not.toHaveBeenCalled();
    } finally { f.dispose(); }
});

it.each([
    { unexpected: '123' }, { targets: { signup: '0' } }, { targets: { signup: '1e9' } }, { targets: { signup: '-123' } },
    { targets: { signup: 'secret-invalid-value' } },
    { targets: Object.fromEntries(Array.from({ length: 101 }, (_, i) => ['key' + i, '123'])) },
    { targets: Object.fromEntries(Array.from({ length: 30 }, (_, i) => ['key' + i, '1'.repeat(128)])) },
])('rejects malformed/oversized replacement conversion settings without storing a row', async values => {
    const f = conversionFixture();
    try {
        const result = await f.integrations.setConversionSettings({ context: owner, request: { pluginId: 'fixture-conversions', values } });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(['invalid_input', 'limit_exceeded']).toContain(result.error.code);
        expect(f.native.prepare('SELECT * FROM om_owner_settings').all()).toEqual([]);
        expect(JSON.stringify([result, f.events])).not.toContain('secret-invalid-value');
    } finally { f.dispose(); }
});

it('isolates bad conversion declarations from credential cards and refuses undeclared settings', async () => {
    const f = conversionFixture();
    try {
        const readCredentialCards: NonNullable<IntegrationDependencies['readCredentialCards']> = async input => parseCredentialCardManifest({ ...input,
            raw: JSON.stringify({ name: input.pluginId, extensions: { 'io.github.ainsep.openmarketing': { credentialCards: [secretCards[0]], conversionSettings: { fields: 'invalid' } } } }) });
        const parsed = unwrap({ result: await readCredentialCards({ context: owner, pluginId: 'fixture-plugin' }) });
        expect(parsed.credentialCards).toHaveLength(1); expect(parsed.conversionSettings).toBeNull();
        const integrations = createIntegrations({ ...f.dependencies, readCredentialCards });
        expect(await integrations.setConversionSettings({ context: owner, request: { pluginId: 'fixture-plugin', values: {} } })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
        expect(f.native.prepare('SELECT * FROM om_owner_settings').all()).toEqual([]);
        const metadata = { conversionSettings: { fields: 'invalid' }, unrelated: 'preserved' };
        expect(await withConversionSettings({ context: owner, db: f.dependencies.db, pluginId: 'fixture-plugin', metadata })).toBe(metadata);
    } finally { f.dispose(); }
});

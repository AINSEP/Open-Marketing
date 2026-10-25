/** Written-only D1 coverage. Native SQLite, fixture secrets and injected effects; no vendor calls. */
import { readFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import type { CallContext, ObserverEvent, Outcome } from '@open-marketing/contracts';
import { createAesGcmSecretSealer, createCredentialBroker, createCredentialKeyring, createCredentialService,
    createMemoryCredentialAudit, createMemoryCredentialLock, createMemoryCredentialRefresh,
    createMemoryOAuthClient, createSqlCredentialRepo } from '@open-marketing/credentials';
import type { CredentialRefreshPort, CredentialSqlPort, KeyringConfiguration } from '@open-marketing/credentials';
import { createIntegrations, resolveProviderKey } from '../src/integrations.js';
import { handleIntegrationRequest } from '../src/inbound/integrations.js';
import { bindServerIntegrations, loadOAuthProviders } from '../src/composition/index.js';
import { fileURLToPath } from 'node:url';
import { createOAuthUrlGuard } from '@jini-ai/oauth';
import { handleOAuthBrowserCallback } from '../src/inbound/integrations.js';
import { oauthCallbackPath } from '../src/integration-oauth-contracts.js';
import { createNodeBootIo, createOAuthHttp, loadCredentialMaster } from '../src/composition/serve.js';
import type { HttpRequest } from '../src/ports.js';
import { createHash } from 'node:crypto';
import { parseCredentialCardManifest } from '../src/integration-credential-cards.js';

const owner: CallContext = { scope: { ownerId: 'owner', workspaceId: 'workspace' }, principal: { kind: 'owner', ownerId: 'owner' }, correlationId: 'fixture-correlation', traceId: 'fixture-trace', runId: 'fixture-run' };
const host: CallContext = { ...owner, principal: { kind: 'service', serviceId: 'model-broker' } };
const request = { connectionId: 'anthropic-fixture', pluginId: 'anthropic', plaintext: 'fixture-provider-token-never-live' };
const configuration: KeyringConfiguration = { hkdfSalt: 'fixture-integration-salt-v1', envVarName: 'OM_CREDENTIAL_KEY', keyFilePath: '/fixture/key' };
const clock = { now: () => 1000 };

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
function fixture(_required: Record<string, never>) {
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
    const dependencies = { repo, sealer, locks, audit, service, db, observer, broker: createCredentialBroker({ repo, sealer, locks, audit }) };
    const integrations = createIntegrations(dependencies);
    return { native, dependencies, integrations, events,
        withRefresh(input: { refresh: CredentialRefreshPort }) {
            return createIntegrations({ ...dependencies, broker: createCredentialBroker({ repo, sealer, locks, audit, ...input }) });
        },
        http(input: HttpRequest) { return handleIntegrationRequest({ request: input, context: owner, integrations }); },
        dispose() { native.close(); },
    };
}

it('connects, lists, resolves the provider key and disconnects with secret-free HTTP/audit metadata', async () => {
    const f = fixture({});
    try {
        const saved = await f.http({ method: 'POST', path: '/api/addons/v1/integrations/token', body: request });
        expect(saved).toMatchObject({ status: 200, body: { ok: true, value: { connectionId: request.connectionId, pluginId: 'anthropic', status: 'saved' } } });
        expect(await f.http({ method: 'GET', path: '/api/addons/v1/integrations' })).toMatchObject({ status: 200, body: { ok: true, value: { items: [{ connectionId: request.connectionId, pluginId: 'anthropic', status: 'saved' }], cursor: null } } });
        expect(await resolveProviderKey({ context: host, provider: 'anthropic', dependencies: f.dependencies })).toEqual({ ok: true, value: request.plaintext });
        expect(await f.integrations.access({ context: host, pluginId: 'anthropic', connectionId: request.connectionId })).toEqual({ ok: true, value: { accessToken: request.plaintext } });
        const disconnected = await f.http({ method: 'POST', path: '/api/addons/v1/integrations/disconnect', body: { connectionId: request.connectionId } });
        expect(disconnected).toMatchObject({ status: 200, body: { ok: true, value: { status: 'disconnected' } } });
        expect(f.native.prepare('SELECT ciphertext, status FROM om_credential_connection').get()).toEqual({ ciphertext: null, status: 'revoked' });
        expect(await f.integrations.resolveProviderKey({ context: host, provider: 'anthropic' })).toMatchObject({ ok: false, error: { code: 'unauthenticated' } });
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
        expect(await f.integrations.resolveProviderKey({ context: owner, provider: 'anthropic' })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
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

it('denies ambiguous provider keys and redacts exceptions from credential adapters', async () => {
    const f = fixture({});
    try {
        unwrap({ result: await f.integrations.connect({ context: owner, request }) });
        unwrap({ result: await f.integrations.connect({ context: owner, request: { ...request, connectionId: 'second-key' } }) });
        expect(await f.integrations.resolveProviderKey({ context: host, provider: 'anthropic' })).toMatchObject({ ok: false, error: { code: 'conflict' } });
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
        expect(await integrations.resolveProviderKey({ context: host, provider: 'anthropic' })).toEqual({ ok: true, value: request.plaintext });
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
        const providers = await loadOAuthProviders({ io });
        const integrations = bindServerIntegrations({ db: f.dependencies.db, clock: { now: () => now }, ids: { next: () => 'oauth-' + ++sequence }, observer: f.dependencies.observer,
            io, providers, stateRoot: '/fixture', redirectUri: () => 'http://127.0.0.1:43120' + oauthCallbackPath });
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
    const f = fixture({}); const pluginId = 'google-ads'; const path = '/api/addons/v1/integrations/oauth/client';
    const client = { clientId: 'fixture-client', clientSecret: 'fixture-client-secret' };
    try {
        const saved = await f.http({ method: 'POST', path, body: { pluginId, client } });
        expect(saved).toMatchObject({ status: 200, body: { ok: true, value: { configured: true, clientId: client.clientId } } });
        expect(await f.http({ method: 'GET', path: '/api/addons/v1/integrations/oauth/status', query: { pluginId } })).toMatchObject({ body: { value: { configured: true, clientId: client.clientId } } });
        expect(await f.integrations.oauthStatus({ context: { ...owner, scope: { ...owner.scope, workspaceId: 'other' } }, pluginId })).toEqual({ ok: true, value: { configured: false } });
        expect(await f.integrations.oauthStatus({ context: owner, pluginId: 'linkedin-ads' })).toEqual({ ok: true, value: { configured: false } });
        expect(await f.http({ method: 'GET', path: '/api/addons/v1/integrations' })).toMatchObject({ body: { value: { items: [], cursor: null } } });
        expect(await f.integrations.access({ context: host, pluginId, connectionId: 'oauth-client.' + pluginId })).toMatchObject({ ok: false });
        expect(await f.integrations.connect({ context: owner, request: { connectionId: 'oauth-client.' + pluginId, pluginId, plaintext: 'overwrite' } })).toMatchObject({ ok: false });
        expect(await f.integrations.disconnect({ context: owner, request: { connectionId: 'oauth-client.' + pluginId } })).toMatchObject({ ok: false });
        expect(await f.integrations.oauthStatus({ context: owner, transactionId: 'oauth-client.' + pluginId })).toMatchObject({ value: { status: 'expired' } });
        for (const invalid of [{ ...client, extra: true }, { clientId: '' }, { clientId: 'x', clientSecret: 'x'.repeat(8193) }]) {
            expect(await f.http({ method: 'POST', path, body: { pluginId, client: invalid } })).toMatchObject({ status: 400 });
        }
        expect(await f.http({ method: 'POST', path, body: { pluginId, client: null } })).toMatchObject({ body: { value: { configured: false } } });
        expect(await f.http({ method: 'POST', path, body: { pluginId, client: { clientId: 'public-client' } } })).toMatchObject({ body: { value: { configured: true, clientId: 'public-client' } } });
        expect(JSON.stringify([saved, f.events, f.dependencies.audit.entries({}), f.native.prepare('SELECT * FROM om_credential_connection').all()])).not.toContain(client.clientSecret);
    } finally { f.dispose(); }
});

it('seals/replaces/clears the optional Google developer token with configured-only HTTP status', async () => {
    const f = fixture({}); const path = '/api/addons/v1/integrations/developer-token'; const pluginId = 'google-ads';
    const token = 'A'.repeat(22), replacement = 'B'.repeat(22);
    try {
        expect(await f.http({ method: 'GET', path, query: { pluginId } })).toMatchObject({ status: 200, body: { value: { configured: false } } });
        expect(await f.integrations.resolveDeveloperToken({ context: host, pluginId })).toEqual({ ok: true, value: null });
        const saved = await f.http({ method: 'POST', path, body: { pluginId, token } });
        expect(saved).toMatchObject({ status: 200, body: { ok: true, value: { configured: true } } });
        expect(await f.http({ method: 'POST', path, body: { pluginId, token: replacement } })).toMatchObject({ body: { value: { configured: true } } });
        expect(await f.integrations.resolveDeveloperToken({ context: host, pluginId })).toEqual({ ok: true, value: replacement });
        expect(await f.integrations.resolveDeveloperToken({ context: host, pluginId: 'meta-ads' })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
        expect(await f.integrations.resolveDeveloperToken({ context: owner, pluginId })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
        expect(await f.integrations.access({ context: host, pluginId, connectionId: 'developer-token.google-ads' })).toMatchObject({ ok: false });
        expect(await f.integrations.disconnect({ context: owner, request: { connectionId: 'developer-token.google-ads' } })).toMatchObject({ ok: false });
        expect(await f.integrations.oauthStatus({ context: owner, transactionId: 'developer-token.google-ads' })).toMatchObject({ value: { status: 'expired' } });
        expect(await f.http({ method: 'GET', path: '/api/addons/v1/integrations' })).toMatchObject({ body: { value: { items: [] } } });
        expect(await f.http({ method: 'GET', path, query: { pluginId, token } })).toMatchObject({ status: 400 });
        expect(await f.http({ method: 'POST', path, body: { pluginId, token: 'bad\r\nvalue' } })).toMatchObject({ status: 400 });
        expect(await f.http({ method: 'POST', path, body: { pluginId: 'linkedin-ads', token } })).toMatchObject({ status: 400 });
        expect(await f.integrations.developerTokenStatus({ context: { ...owner, scope: { ...owner.scope, workspaceId: 'other' } }, pluginId })).toEqual({ ok: true, value: { configured: false } });
        const cleared = await f.http({ method: 'POST', path, body: { pluginId, token: null } });
        expect(cleared).toMatchObject({ status: 200, body: { value: { configured: false } } });
        expect(await f.integrations.resolveDeveloperToken({ context: host, pluginId })).toEqual({ ok: true, value: null });
        expect(JSON.stringify([saved, cleared, f.events, f.dependencies.audit.entries({}), f.native.prepare('SELECT * FROM om_credential_connection').all()])).not.toMatch(new RegExp(token + '|' + replacement));
    } finally { f.dispose(); }
});
it('refuses developer-token bodies before reading them for non-owners', async () => {
    const f = fixture({}); let reads = 0;
    try {
        expect(await handleIntegrationRequest({ context: host, integrations: f.integrations, request: { method: 'POST', path: '/api/addons/v1/integrations/developer-token',
            async readBody() { reads++; return { ok: true, value: { pluginId: 'google-ads', token: 'A'.repeat(22) } }; } } })).toMatchObject({ status: 403 });
        expect(reads).toBe(0);
    } finally { f.dispose(); }
});

it.each([false, true])('completes Meta on O1, rejects replay and uses broker reconnect without refresh (non-expiring=%s)', async nonExpiring => {
    const f = fixture({}); let now = 1000; let sequence = 0; let exchanges = 0;
    const pluginId = 'meta-ads'; const client = { clientId: '12345', clientSecret: 'fixture-meta-secret', configId: '999' };
    const io = { ...createNodeBootIo({ projectRoot: fileURLToPath(new URL('../../../', import.meta.url)), studioRoot: '/fixture', ready() {} }),
        randomToken: () => (++sequence).toString(16).padStart(2, '0').repeat(32), loadCredentialMaster: async () => ({ ok: true as const, value: new Uint8Array(32).fill(3) }) };
    try {
        const providers = await loadOAuthProviders({ io }); const scopes = providers.get(pluginId)!.provider.defaultScopes;
        const integrations = bindServerIntegrations({ db: f.dependencies.db, clock: { now: () => now }, ids: { next: () => 'meta-' + ++sequence },
            agentPluginState: async () => ({ enabled: true, bundled: true, admitted: true, revision: 'fixture', metadata: {} }),
            observer: f.dependencies.observer, stateRoot: '/fixture', providers, redirectUri: () => 'http://127.0.0.1:43120' + oauthCallbackPath,
            io: { ...io, oauth: { guard: createOAuthUrlGuard({ assertAllowed() {} }, { allowLoopbackHttp: true }), async fetchFn() {
                exchanges++;
                return Response.json(exchanges === 3 ? { data: { app_id: client.clientId, type: 'USER', is_valid: true, expires_at: nonExpiring ? 0 : 3601,
                    data_access_expires_at: nonExpiring ? 0 : 3601, scopes: [...scopes, 'email'] } }
                    : { access_token: exchanges === 1 ? 'fixture-meta-short' : 'fixture-meta-long', token_type: 'bearer', expires_in: nonExpiring ? 0 : 3600 });
            } } } });
        const saved = unwrap({ result: await integrations.setOAuthClient({ context: owner, request: { pluginId, client } }) });
        expect(saved).toMatchObject({ configured: true, guidance: expect.stringContaining('Strict Mode/Enforce HTTPS') });
        expect(await integrations.setOAuthClient({ context: owner, request: { pluginId, client: { clientId: client.clientId, clientSecret: client.clientSecret } } })).toMatchObject({ ok: false });
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
        expect(await integrations.oauthStatus({ context: owner, pluginId: 'tiktok-ads' })).toMatchObject({ ok: true, value: { configured: false, guidance: expect.stringContaining('paste-token') } });
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
            observer: f.dependencies.observer, io, stateRoot: '/fixture', providers: await loadOAuthProviders({ io }),
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

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
import { bindServerIntegrations } from '../src/composition/index.js';
import { createNodeBootIo, loadCredentialMaster } from '../src/composition/serve.js';
import type { HttpRequest } from '../src/ports.js';

const owner: CallContext = { scope: { ownerId: 'owner', workspaceId: 'workspace' }, principal: { kind: 'owner', ownerId: 'owner' }, correlationId: 'fixture-correlation', traceId: 'fixture-trace', runId: 'fixture-run' };
const host: CallContext = { ...owner, principal: { kind: 'service', serviceId: 'model-broker' } };
const request = { connectionId: 'anthropic-fixture', pluginId: 'anthropic', plaintext: 'fixture-provider-token-never-live' };
const configuration: KeyringConfiguration = { hkdfSalt: 'fixture-integration-salt-v1', envVarName: 'OM_CREDENTIAL_KEY', keyFilePath: '/fixture/key' };
const clock = { now: () => 1000 };

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

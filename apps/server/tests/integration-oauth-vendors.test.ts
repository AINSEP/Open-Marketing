/** Host lifecycle and guarded module fixtures only; plugin owns vendor protocol tests. Written, not run. */
import { expect, it, vi } from 'vitest';
import { createOAuthUrlGuard, createPendingAuthorizationStore } from '@jini-ai/oauth';
import type { OAuthFetch } from '@jini-ai/oauth';
import { connectCredentialToken, createMemoryCredentialRepo, createMemorySecretSealer, createMemoryCredentialLock,
    createMemoryCredentialAudit, createCredentialBroker } from '@open-marketing/credentials';
import type { OAuthHostBindings } from '@open-marketing/credentials';
import type { CallContext, CallOptions, ObserverEvent, Outcome, PluginCapabilityDependencies } from '@open-marketing/contracts';
import type { AgentPluginState } from '../src/composition/agent-plugin-backends.js';
import { createVendorOAuthBindings } from '../src/integration-oauth-vendors.js';
import { credentialOAuthClientFields, parseCredentialCardManifest } from '../src/integration-credential-cards.js';
import { oauthCallbackPath, oauthMetadataSchema } from '../src/integration-oauth-contracts.js';

const pluginId = 'fixture-custom';
const metadata = oauthMetadataSchema.parse({ provider: { providerId: pluginId, label: 'Fixture', supportedGrants: ['authorization_code'],
    authorizationEndpoint: 'https://fixture.example/dialog', tokenEndpoint: 'https://fixture.example/token', defaultScopes: ['read'], usesPkce: false, clientAuth: 'none' },
    exchange: { authorizationScopes: [], authorizationParams: { config_id: 'configId' } } });
const cardManifest = value(parseCredentialCardManifest({ pluginId, raw: JSON.stringify({ name: pluginId, extensions: { 'io.github.ainsep.openmarketing': {
    credentialCards: [{ target: pluginId, title: 'Fixture', label: 'Save', category: 'Advertising', intro: 'Fixture', usedFor: [], helpUrl: 'https://fixture.example/help', helpLabel: 'Help', baseUrl: 'https://fixture.example', saveKind: 'oauth-client',
        fields: [{ name: 'clientId', label: 'App ID', required: true }, { name: 'configId', label: 'Configuration', required: true }],
        secretFields: [{ name: 'clientSecret', label: 'Secret', required: true }] }],
} } }) }));
const context: CallContext = { scope: { ownerId: 'owner', workspaceId: 'workspace' }, principal: { kind: 'owner', ownerId: 'owner' }, correlationId: 'correlation', traceId: 'trace', runId: 'run' };
const client = { clientId: '12345', clientSecret: 'fixture-client-secret', configId: '999' };
const reference = { scope: context.scope, connectionId: 'connection', version: 1 };
const request = { pluginId, returnUri: 'http://127.0.0.1:43120' + oauthCallbackPath };
const tokens = { accessToken: 'fixture-token', refreshToken: null, tokenType: 'Bearer', scopes: ['read'], expiresAt: null };
function value<T>(outcome: Outcome<T>): T { if (!outcome.ok) throw new Error(outcome.error.code); return outcome.value; }

/** Synthetic plugin deliberately supplies a POST/body: host must enforce the exchange's GET transport. */
function createOAuthExchange(required: Pick<PluginCapabilityDependencies, 'fetch' | 'clock'>) {
    return { async exchange(_input: unknown, optional?: CallOptions) {
        for (const path of ['first', 'second', 'third']) await required.fetch('https://fixture.example/' + path, { method: 'POST', body: 'discard', signal: optional?.signal });
        return { ok: true, value: tokens };
    } };
}

async function fixture(required: { fetch?: OAuthFetch; client?: unknown; cardsAvailable?: boolean; module?: object;
    state?: () => Promise<AgentPluginState | null>; digest?: () => Promise<string>;
    deadline?: Parameters<typeof createVendorOAuthBindings>[0]['deadline'] } = {}) {
    const repo = createMemoryCredentialRepo({}); const sealer = createMemorySecretSealer({});
    const audit = createMemoryCredentialAudit({}); const locks = createMemoryCredentialLock({});
    const broker = createCredentialBroker({ repo, sealer, locks, audit });
    value(await connectCredentialToken({ context, connectionId: 'oauth-client.' + pluginId, pluginId,
        plaintext: JSON.stringify(required.client === undefined ? client : required.client), purpose: 'oauth-client',
        clientFields: credentialOAuthClientFields({ cards: cardManifest.credentialCards }), repo, sealer, locks, audit }));
    const seal = vi.spyOn(sealer, 'seal');
    const events: ObserverEvent[] = []; const calls: { url: URL; init?: RequestInit }[] = [];
    const pending = createPendingAuthorizationStore({ clock: { nowMs: () => 1000 }, randomBytesFn: ({ byteLength }) => new Uint8Array(byteLength).fill(7) });
    const standard: OAuthHostBindings = { authorize: vi.fn(), exchange: vi.fn() };
    const deadlines: { signal: AbortSignal; dispose: ReturnType<typeof vi.fn> }[] = [];
    const createDeadline = vi.fn((input: { timeoutMs: number }) => {
        const entry = required.deadline?.create(input) ?? { signal: new AbortController().signal, dispose() {} };
        const deadline = { signal: entry.signal, dispose: vi.fn(() => entry.dispose()) };
        deadlines.push(deadline); return deadline;
    });
    const state = vi.fn(required.state ?? (async () => ({ enabled: true, bundled: false, admitted: true, revision: 'r1', entryUrl: 'file:///fixture/index.mjs', metadata: {} })));
    const loadModule = vi.fn(async () => required.module ?? { createOAuthExchange });
    const moduleDigest = vi.fn(required.digest ?? (async () => 'a'.repeat(64)));
    const bindings = createVendorOAuthBindings({ standard, providers: new Map([[pluginId, metadata]]), repo, sealer, broker, pending,
        readCredentialCards: required.cardsAvailable === false ? undefined : async () => ({ ok: true, value: cardManifest }), clock: { now: () => 1000 },
        agentPluginState: state, loadModule, moduleDigest, deadline: { create: createDeadline },
        randomBytesFn: ({ byteLength }) => new Uint8Array(byteLength).fill(7), observer: { observe: event => { events.push(event); } },
        http: { guard: createOAuthUrlGuard({ assertAllowed() {} }, { allowLoopbackHttp: true }), fetchFn: async (input, init) => {
            calls.push({ url: new URL(String(input.url)), init });
            expect(await pending.size({})).toBe(0);
            if (required.fetch) return required.fetch(input, init);
            return Response.json({});
        } } });
    return { bindings, calls, events, standard, pending, deadlines, createDeadline, loadModule, moduleDigest, state, seal,
        async authorize() { return bindings.authorize({ context, reference, request }); },
        async exchange(input: { signal?: AbortSignal } = {}) {
            const challenge = value(await bindings.authorize({ context, reference, request }));
            const callback = { transactionId: reference.connectionId, state: new URL(challenge.authorizationUrl).searchParams.get('state')!, redirectUri: request.returnUri, code: 'fixture-code' };
            return bindings.exchange({ context, reference, request, callback }, input);
        },
        async payload(input: { secret: Parameters<typeof sealer.open>[0]['secret'] }) {
            return JSON.parse(value(await sealer.open({ reference, secret: input.secret })).slice('om.oauth.v1:'.length));
        },
    };
}

it('uses declared config_id without scope/PKCE and loads the admitted uploaded module per call', async () => {
    const f = await fixture(); const url = new URL(value(await f.authorize()).authorizationUrl);
    expect(url.origin + url.pathname).toBe('https://fixture.example/dialog');
    expect(Object.fromEntries(url.searchParams)).toEqual({ response_type: 'code', client_id: client.clientId, redirect_uri: request.returnUri, state: expect.any(String), config_id: client.configId });
    const result = await f.bindings.exchange({ context, reference, request, callback: { transactionId: reference.connectionId, state: url.searchParams.get('state')!, redirectUri: request.returnUri, code: 'fixture-code' } });
    expect(await f.payload({ secret: value(result) })).toEqual(tokens);
    expect(f.calls).toHaveLength(3); expect(f.loadModule).toHaveBeenCalledWith({ moduleUrl: 'file:///fixture/index.mjs?revision=r1' });
    expect(f.state).toHaveBeenCalledTimes(4); expect(f.moduleDigest).toHaveBeenCalledTimes(4);
    expect(f.createDeadline).toHaveBeenCalledTimes(2);
    for (const deadline of f.deadlines) expect(deadline.dispose).toHaveBeenCalledTimes(1);
    for (const call of f.calls) {
        expect(call.init).toMatchObject({ method: 'GET', redirect: 'error' }); expect(call.init?.body).toBeUndefined();
        expect(new Headers(call.init?.headers).get('x-om-run-id')).toBe('run');
        expect(new Headers(call.init?.headers).get('x-om-correlation-id')).toBe('correlation');
        expect(new Headers(call.init?.headers).get('x-om-trace-id')).toBe('trace');
    }
    expect(JSON.stringify([result, f.events])).not.toMatch(/fixture-code|fixture-token|fixture-client-secret/);
});

it('consumes state before HTTP failure and rejects replay and redirect/provider binding drift', async () => {
    const f = await fixture({ fetch: async () => { throw new Error(client.clientSecret); } });
    const state = new URL(value(await f.authorize()).authorizationUrl).searchParams.get('state')!;
    const input = { context, reference, request, callback: { state, transactionId: 'connection', redirectUri: request.returnUri, code: 'fixture-code' } };
    const failed = await f.bindings.exchange(input);
    expect(failed).toMatchObject({ ok: false, error: { code: 'unavailable' } });
    expect(await f.bindings.exchange(input)).toMatchObject({ ok: false, error: { code: 'expired' } });
    expect(f.calls).toHaveLength(1); expect(f.seal).not.toHaveBeenCalled(); expect(JSON.stringify(failed)).not.toContain(client.clientSecret);
    for (const drift of ['redirect', 'provider']) {
        const other = await fixture();
        const entry = await other.pending.put({ ownerKey: JSON.stringify([context.scope.ownerId, context.scope.workspaceId, reference.connectionId]),
            providerId: drift === 'provider' ? 'foreign' : pluginId, redirectUri: request.returnUri, codeVerifier: 'fixture', scopes: [] });
        expect(await other.bindings.exchange({ ...input, callback: { ...input.callback, state: entry.state,
            redirectUri: drift === 'redirect' ? request.returnUri + '/wrong' : request.returnUri } })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
        expect(other.calls).toHaveLength(0); expect(other.loadModule).not.toHaveBeenCalled();
    }
});

it('delegates standard providers unchanged', async () => {
    const f = await fixture(); const input = { context, reference, request: { ...request, pluginId: 'fixture-standard' } };
    await f.bindings.authorize(input); expect(f.standard.authorize).toHaveBeenCalledWith(input, undefined);
    const exchange = { ...input, callback: { transactionId: 'connection', state: 'state', redirectUri: request.returnUri, code: 'code' } };
    await f.bindings.exchange(exchange); expect(f.standard.exchange).toHaveBeenCalledWith(exchange, undefined);
});

it.each([{ cardsAvailable: false }, { client: null }, { client: { clientId: client.clientId, clientSecret: client.clientSecret } }])('denies missing cards/client/public mapping without module load: %j', async options => {
    const f = await fixture(options);
    expect(await f.authorize()).toMatchObject({ ok: false, error: { code: 'unavailable' } });
    const entry = await f.pending.put({ ownerKey: JSON.stringify([context.scope.ownerId, context.scope.workspaceId, reference.connectionId]),
        providerId: pluginId, redirectUri: request.returnUri, codeVerifier: 'fixture', scopes: [] });
    // Missing mapped public fields deny authorize; callback still delegates client parsing to the plugin.
    if (options.client && options.client !== null) {
        expect(f.loadModule).not.toHaveBeenCalled(); expect(f.calls).toEqual([]); return;
    }
    expect(await f.bindings.exchange({ context, reference, request, callback: { transactionId: 'connection', state: entry.state, redirectUri: request.returnUri, code: 'fixture-code' } })).toMatchObject({ ok: false, error: { code: 'unavailable' } });
    expect(f.loadModule).not.toHaveBeenCalled(); expect(f.calls).toEqual([]);
});

it('uses a single 15-second deadline and stops the sequence on cancellation', async () => {
    const deadline = new AbortController(); let calls = 0;
    const f = await fixture({ deadline: { create: () => ({ signal: deadline.signal, dispose() {} }) },
        fetch: async () => { if (++calls === 2) deadline.abort(); return Response.json({}); } });
    expect(await f.exchange()).toMatchObject({ ok: false, error: { code: 'unavailable' } });
    expect(f.createDeadline).toHaveBeenCalledTimes(2); expect(f.createDeadline).toHaveBeenNthCalledWith(2, { timeoutMs: 15000 });
    expect(f.calls).toHaveLength(2); expect(f.seal).not.toHaveBeenCalled();
    for (const entry of f.deadlines) expect(entry.dispose).toHaveBeenCalledTimes(1);
    const cancelled = await fixture(); const controller = new AbortController(); controller.abort();
    expect(await cancelled.exchange({ signal: controller.signal })).toMatchObject({ ok: false, error: { code: 'cancelled' } });
    expect(cancelled.calls).toHaveLength(0); expect(cancelled.loadModule).not.toHaveBeenCalled();
});

it.each(['admission', 'digest', 'revision', 'entry'])('refuses a second fetch after %s changes and never seals', async change => {
    let changed = false;
    const f = await fixture({ fetch: async () => { changed = true; return Response.json({}); }, digest: async () => (changed && change === 'digest' ? 'b' : 'a').repeat(64),
        state: async () => ({ enabled: true, bundled: false, admitted: !(changed && change === 'admission'),
            revision: changed && change === 'revision' ? 'r2' : 'r1', entryUrl: changed && change === 'entry' ? 'file:///fixture/other.mjs' : 'file:///fixture/index.mjs', metadata: {} }) });
    expect(await f.exchange()).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    expect(f.calls).toHaveLength(1); expect(f.seal).not.toHaveBeenCalled();
    expect(JSON.stringify(f.events)).not.toContain(client.clientSecret);
});

it.each([0, 1, 2])('rechecks admission before every request and stops after %s admitted requests', async allowed => {
    let checks = 0;
    const f = await fixture({ state: async () => ({ enabled: true, bundled: false, admitted: ++checks <= allowed + 1,
        revision: 'r1', entryUrl: 'file:///fixture/index.mjs', metadata: {} }) });
    expect(await f.exchange()).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    expect(f.calls).toHaveLength(allowed); expect(f.seal).not.toHaveBeenCalled();
});

it('refuses unadmitted state before module loading', async () => {
    const f = await fixture({ state: async () => ({ enabled: true, bundled: true, admitted: false, revision: 'r1', metadata: {} }) });
    expect(await f.exchange()).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    expect(f.loadModule).not.toHaveBeenCalled(); expect(f.calls).toHaveLength(0); expect(f.seal).not.toHaveBeenCalled();
});

it('returns unavailable for a missing fixed export', async () => {
    const f = await fixture({ module: {} });
    expect(await f.exchange()).toMatchObject({ ok: false, error: { code: 'unavailable' } });
    expect(f.calls).toHaveLength(0); expect(f.seal).not.toHaveBeenCalled();
});

it.each(['forbidden', 'unknown-code'])('discards secret-bearing plugin failures and accepts only known error codes: %s', async code => {
    const f = await fixture({ module: { createOAuthExchange: () => ({ exchange: async () => ({ ok: false, error: { code, message: client.clientSecret + tokens.accessToken } }) }) } });
    const result = await f.exchange();
    expect(result).toMatchObject({ ok: false, error: { code: code === 'forbidden' ? code : 'unavailable' } });
    expect(JSON.stringify([result, f.events])).not.toMatch(/fixture-client-secret|fixture-token/); expect(f.seal).not.toHaveBeenCalled();
});

it('rejects normalized plugin results that fail readCredentialAccess before sealing', async () => {
    const f = await fixture({ module: { createOAuthExchange: () => ({ exchange: async () => ({ ok: true, value: { ...tokens, expiresAt: client.clientSecret } }) }) } });
    const result = await f.exchange();
    expect(result).toMatchObject({ ok: false, error: { code: 'protocol_mismatch' } });
    expect(f.seal).not.toHaveBeenCalled(); expect(JSON.stringify([result, f.events])).not.toContain(client.clientSecret);
});

it('bounds replacement HTTP response bodies with the shared Jini reader', async () => {
    const f = await fixture({ fetch: async () => new Response('x'.repeat(65537)) });
    expect(await f.exchange()).toMatchObject({ ok: false }); expect(f.calls).toHaveLength(1); expect(f.seal).not.toHaveBeenCalled();
});

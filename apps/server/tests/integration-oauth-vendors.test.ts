/** Fixture-only protocol coverage; written for the integrator, not executed in O2-R2. */
import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { createOAuthUrlGuard, createPendingAuthorizationStore } from '@jini-ai/oauth';
import type { OAuthFetch } from '@jini-ai/oauth';
import { connectCredentialToken, createMemoryCredentialRepo, createMemorySecretSealer, createMemoryCredentialLock,
    createMemoryCredentialAudit, createCredentialBroker } from '@open-marketing/credentials';
import type { OAuthHostBindings } from '@open-marketing/credentials';
import type { CallContext, ObserverEvent, Outcome } from '@open-marketing/contracts';
import { createVendorOAuthBindings } from '../src/integration-oauth-vendors.js';
import { oauthCallbackPath, oauthMetadataSchema } from '../src/integration-oauth-contracts.js';

const metadata = oauthMetadataSchema.parse(JSON.parse(readFileSync(new URL('../../../content/agent-plugins/meta-ads/io.github.ainsep.openmarketing/oauth.json', import.meta.url), 'utf8')));
const context: CallContext = { scope: { ownerId: 'owner', workspaceId: 'workspace' }, principal: { kind: 'owner', ownerId: 'owner' }, correlationId: 'correlation', traceId: 'trace', runId: 'run' };
const client = { clientId: '12345', clientSecret: 'fixture-client-secret', configId: '999' };
const reference = { scope: context.scope, connectionId: 'connection', version: 1 };
const request = { pluginId: 'meta-ads', returnUri: 'http://127.0.0.1:43120' + oauthCallbackPath };
const short = { access_token: 'fixture-short', token_type: 'bearer', expires_in: 3600 };
const long = { access_token: 'fixture-long', token_type: 'bearer', expires_in: 7200 };
const debug = { app_id: client.clientId, type: 'USER', is_valid: true, expires_at: 7000, data_access_expires_at: 6500,
    scopes: [...metadata.provider.defaultScopes, 'email'], granular_scopes: [{ scope: 'ads_read', target_ids: ['123', 456] }] };
function value<T>(outcome: Outcome<T>): T { if (!outcome.ok) throw new Error(outcome.error.code); return outcome.value; }

async function fixture(required: { replies?: unknown[]; fetch?: OAuthFetch; client?: unknown;
    admission?: Parameters<typeof createVendorOAuthBindings>[0]['admission'];
    deadline?: Parameters<typeof createVendorOAuthBindings>[0]['deadline'] } = {}) {
    const repo = createMemoryCredentialRepo({}); const sealer = createMemorySecretSealer({});
    const audit = createMemoryCredentialAudit({}); const locks = createMemoryCredentialLock({});
    const broker = createCredentialBroker({ repo, sealer, locks, audit });
    value(await connectCredentialToken({ context, connectionId: 'oauth-client.meta-ads', pluginId: 'meta-ads',
        plaintext: JSON.stringify(required.client === undefined ? client : required.client), purpose: 'oauth-client', repo, sealer, locks, audit }));
    const events: ObserverEvent[] = []; const calls: { url: URL; init?: RequestInit }[] = [];
    const pending = createPendingAuthorizationStore({ clock: { nowMs: () => 1000 }, randomBytesFn: ({ byteLength }) => new Uint8Array(byteLength).fill(7) });
    const standard: OAuthHostBindings = { authorize: vi.fn(), exchange: vi.fn() };
    const deadlines: { signal: AbortSignal; dispose: ReturnType<typeof vi.fn> }[] = [];
    const createDeadline = vi.fn((input: { timeoutMs: number }) => {
        const entry = required.deadline?.create(input) ?? { signal: new AbortController().signal, dispose() {} };
        const deadline = { signal: entry.signal, dispose: vi.fn(() => entry.dispose()) };
        deadlines.push(deadline);
        return deadline;
    });
    const bindings = createVendorOAuthBindings({ standard, metadata, repo, sealer, broker, pending, clock: { now: () => 1000 },
        admission: required.admission ?? (async () => true), deadline: { create: createDeadline },
        randomBytesFn: ({ byteLength }) => new Uint8Array(byteLength).fill(7), observer: { observe: event => { events.push(event); } },
        http: { guard: createOAuthUrlGuard({ assertAllowed() {} }, { allowLoopbackHttp: true }), fetchFn: async (input, init) => {
            calls.push({ url: new URL(String(input.url)), init });
            if (required.fetch) return required.fetch(input, init);
            const reply = (required.replies ?? [short, long, { data: debug }])[calls.length - 1];
            return reply instanceof Response ? reply : Response.json(reply);
        } } });
    return { bindings, calls, events, standard, pending, deadlines, createDeadline,
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

it('uses config_id without scope/PKCE, exchanges three GETs and seals granted scopes with the earliest expiry', async () => {
    const f = await fixture(); const url = new URL(value(await f.authorize()).authorizationUrl);
    expect(url.origin + url.pathname).toBe('https://www.facebook.com/v26.0/dialog/oauth');
    expect(Object.fromEntries(url.searchParams)).toEqual({ response_type: 'code', client_id: client.clientId, redirect_uri: request.returnUri, state: expect.any(String), config_id: client.configId });
    // Consume the first authorization before another deterministic-state fixture is created.
    const result = await f.bindings.exchange({ context, reference, request, callback: { transactionId: reference.connectionId, state: url.searchParams.get('state')!, redirectUri: request.returnUri, code: 'fixture-code' } });
    expect(await f.payload({ secret: value(result) })).toEqual({ accessToken: long.access_token, tokenType: 'Bearer', refreshToken: null, scopes: debug.scopes, expiresAt: new Date(6500000).toISOString() });
    expect(f.calls).toHaveLength(3);
    expect(f.createDeadline).toHaveBeenCalledTimes(2);
    for (const deadline of f.deadlines) expect(deadline.dispose).toHaveBeenCalledTimes(1);
    expect(new Set(f.calls.map(call => call.init?.signal)).size).toBe(1);
    expect(f.calls[0].url.searchParams.get('code')).toBe('fixture-code');
    expect(f.calls[0].url.searchParams.get('redirect_uri')).toBe(request.returnUri);
    expect(f.calls[1].url.searchParams.get('grant_type')).toBe('fb_exchange_token');
    expect(f.calls[1].url.searchParams.get('fb_exchange_token')).toBe(short.access_token);
    expect(f.calls[2].url.searchParams.get('input_token')).toBe(long.access_token);
    expect(f.calls[2].url.searchParams.get('access_token')).toBe(client.clientId + '|' + client.clientSecret);
    for (const call of f.calls) {
        expect(call.init).toMatchObject({ method: 'GET', redirect: 'error' }); expect(call.init?.body).toBeUndefined();
        expect(new Headers(call.init?.headers).get('x-om-run-id')).toBe('run');
        expect(call.init?.signal).toBe(f.calls[0].init?.signal);
    }
    expect(JSON.stringify([result, f.events])).not.toMatch(/fixture-code|fixture-short|fixture-long|fixture-client-secret/);
});

it.each([
    { app_id: 'foreign' }, { type: 'SYSTEM_USER' }, { is_valid: false }, { expires_at: 1 }, { data_access_expires_at: 1 },
    { scopes: undefined }, { scopes: debug.scopes.slice(1) }, { granular_scopes: [{ scope: 'ungranted' }] },
    { granular_scopes: [{ scope: 'ads_read', target_ids: [true] }] },
])('rejects invalid inspection evidence %j without accepting requested scopes', async invalid => {
    const f = await fixture({ replies: [short, long, { data: { ...debug, ...invalid } }] });
    expect(await f.exchange()).toMatchObject({ ok: false, error: { code: 'protocol_mismatch' } });
    expect(await f.pending.size({})).toBe(0);
});

it.each([
    { token: { ...long, expires_in: 0 }, inspected: { ...debug, expires_at: 0, data_access_expires_at: 0 }, expiry: null },
    { token: { ...long, expires_in: 0 }, inspected: { ...debug, expires_at: 0 }, expiry: new Date(6500000).toISOString() },
    { token: { ...long, expires_in: 50 }, inspected: debug, expiry: new Date(51000).toISOString() },
])('derives expiry from provider evidence, including zero: $expiry', async ({ token, inspected, expiry }) => {
    const f = await fixture({ replies: [short, token, { data: inspected }] });
    expect(await f.payload({ secret: value(await f.exchange()) })).toMatchObject({ expiresAt: expiry });
});

it.each([{}, { ...long, expires_in: -1 }, { ...long, expires_in: '7200' }, { ...long, token_type: 'other' }, { ...long, access_token: '' },
    new Response('not-json'), new Response('x'.repeat(65537)), new Response('provider-secret', { status: 400 }),
])('fails closed on malformed/oversized/rejected exchange responses', async reply => {
    const f = await fixture({ replies: [short, reply] }); const result = await f.exchange();
    expect(result.ok).toBe(false); expect(f.calls).toHaveLength(2);
    expect(JSON.stringify([result, f.events])).not.toContain('provider-secret');
});

it('consumes state before HTTP failure and rejects replay and redirect/provider binding drift', async () => {
    const f = await fixture({ fetch: async () => { throw new Error('fixture-client-secret'); } });
    const state = new URL(value(await f.authorize()).authorizationUrl).searchParams.get('state')!;
    const input = { context, reference, request, callback: { state, transactionId: 'connection', redirectUri: request.returnUri, code: 'fixture-code' } };
    const failed = await f.bindings.exchange(input);
    expect(failed).toMatchObject({ ok: false, error: { code: 'unavailable' } });
    expect(await f.bindings.exchange(input)).toMatchObject({ ok: false, error: { code: 'expired' } });
    expect(f.calls).toHaveLength(1); expect(JSON.stringify(failed)).not.toContain(client.clientSecret);
    const other = await fixture(); const otherState = new URL(value(await other.authorize()).authorizationUrl).searchParams.get('state')!;
    expect(await other.bindings.exchange({ ...input, callback: { ...input.callback, state: otherState, redirectUri: request.returnUri + '/wrong' } })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    expect(other.calls).toHaveLength(0);
});

it('delegates standard providers unchanged and denies missing Meta confidential configuration', async () => {
    const f = await fixture(); const input = { context, reference, request: { ...request, pluginId: 'google-ads' } };
    await f.bindings.authorize(input); expect(f.standard.authorize).toHaveBeenCalledWith(input, undefined);
    const exchange = { ...input, callback: { transactionId: 'connection', state: 'state', redirectUri: request.returnUri, code: 'code' } };
    await f.bindings.exchange(exchange); expect(f.standard.exchange).toHaveBeenCalledWith(exchange, undefined);
    const missing = await fixture({ client: { clientId: client.clientId, configId: client.configId } });
    expect(await missing.authorize()).toMatchObject({ ok: false }); expect(missing.calls).toEqual([]);
});

it('uses a single 15-second deadline across the sequence and stops after cancellation', async () => {
    const deadline = new AbortController(); let calls = 0;
    const f = await fixture({ deadline: { create: () => ({ signal: deadline.signal, dispose() {} }) },
        fetch: async () => { calls++; if (calls === 2) deadline.abort(); return Response.json(calls === 1 ? short : long); } });
    expect(await f.exchange()).toMatchObject({ ok: false, error: { code: 'unavailable' } });
    expect(f.createDeadline).toHaveBeenCalledTimes(2); // authorize and the complete exchange, never per HTTP request
    expect(f.createDeadline).toHaveBeenNthCalledWith(2, { timeoutMs: 15000 }); expect(f.calls).toHaveLength(2);
    for (const entry of f.deadlines) expect(entry.dispose).toHaveBeenCalledTimes(1);
    expect(new Set(f.calls.map(call => call.init?.signal)).size).toBe(1);
    const cancelled = await fixture(); const controller = new AbortController(); controller.abort();
    expect(await cancelled.exchange({ signal: controller.signal })).toMatchObject({ ok: false, error: { code: 'cancelled' } });
    expect(cancelled.calls).toHaveLength(0);
    for (const entry of cancelled.deadlines) expect(entry.dispose).toHaveBeenCalledTimes(1);
});

it.each([0, 1, 2])('rechecks admission before every request and stops after %s admitted requests', async allowed => {
    let checks = 0;
    const admission = vi.fn(async () => ++checks <= allowed);
    const f = await fixture({ admission });
    const result = await f.exchange();
    expect(result).toMatchObject({ ok: false, error: { code: 'forbidden', retryable: false } });
    expect(f.calls).toHaveLength(allowed);
    expect(admission).toHaveBeenCalledTimes(allowed + 1);
    expect(admission).toHaveBeenLastCalledWith({ context, pluginId: 'meta-ads' });
    expect(JSON.stringify([result, f.events])).not.toMatch(/fixture-client-secret|fixture-short|fixture-long/);
    for (const deadline of f.deadlines) expect(deadline.dispose).toHaveBeenCalledTimes(1);
});

it('cancels a stalled response body without continuing the exchange', async () => {
    const controller = new AbortController(); let cancelled = false;
    const f = await fixture({ fetch: async () => {
        const body = new ReadableStream({ pull() { controller.abort(); }, cancel() { cancelled = true; } });
        return new Response(body);
    } });
    expect(await f.exchange({ signal: controller.signal })).toMatchObject({ ok: false, error: { code: 'cancelled' } });
    expect(f.calls).toHaveLength(1); expect(cancelled).toBe(true);
});

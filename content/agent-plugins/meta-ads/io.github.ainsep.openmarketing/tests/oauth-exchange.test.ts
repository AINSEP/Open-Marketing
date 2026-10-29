/** Fixture-only protocol regressions; written, never run in this job. */
import { expect, it } from 'vitest';
import { createOAuthExchange } from '../src/oauth-exchange.js';

const client = { clientId: '12345', clientSecret: 'fixture-client-secret', configId: '999' };
const input = { client, code: 'fixture-code', redirectUri: 'http://127.0.0.1:43120/callback', requiredScopes: ['ads_read'] };
const short = { access_token: 'fixture-short', token_type: 'bearer', expires_in: 3600 };
const long = { access_token: 'fixture-long', token_type: 'bearer', expires_in: 7200 };
const debug = { app_id: client.clientId, type: 'USER', is_valid: true, expires_at: 7000, data_access_expires_at: 6500,
    scopes: ['ads_read', 'email'], granular_scopes: [{ scope: 'ads_read', target_ids: ['123', 456] }] };

function fixture(required: { replies?: unknown[]; fetch?: typeof fetch } = {}) {
    const calls: { url: URL; init?: RequestInit }[] = [];
    const exchange = createOAuthExchange({ clock: { now: () => 1000 }, fetch: async (url, init) => {
        calls.push({ url: new URL(String(url)), init });
        if (required.fetch) return required.fetch(url, init);
        const reply = (required.replies ?? [short, long, { data: debug }])[calls.length - 1];
        return reply instanceof Response ? reply : Response.json(reply);
    } });
    return { calls, exchange: () => exchange.exchange(input) };
}

function expectRedacted(required: { result: unknown }): void {
    expect(JSON.stringify(required.result)).not.toMatch(/fixture-client-secret|fixture-short|fixture-long|fixture-code/);
}

it('performs the exact three GETs and returns actual granted scopes with the earliest expiry', async () => {
    const f = fixture();
    expect(await f.exchange()).toEqual({ ok: true, value: { accessToken: long.access_token, tokenType: 'Bearer', refreshToken: null,
        scopes: debug.scopes, expiresAt: new Date(6500000).toISOString() } });
    expect(f.calls.map(call => call.url.origin + call.url.pathname)).toEqual([
        'https://graph.facebook.com/v26.0/oauth/access_token', 'https://graph.facebook.com/v26.0/oauth/access_token', 'https://graph.facebook.com/v26.0/debug_token',
    ]);
    expect(f.calls.map(call => Object.fromEntries(call.url.searchParams))).toEqual([
        { client_id: client.clientId, client_secret: client.clientSecret, redirect_uri: input.redirectUri, code: input.code },
        { client_id: client.clientId, client_secret: client.clientSecret, grant_type: 'fb_exchange_token', fb_exchange_token: short.access_token },
        { input_token: long.access_token, access_token: client.clientId + '|' + client.clientSecret },
    ]);
    for (const call of f.calls) { expect(call.init).toMatchObject({ method: 'GET', redirect: 'error' }); expect(call.init?.body).toBeUndefined(); }
});

it.each([
    { app_id: 'foreign' }, { type: 'SYSTEM_USER' }, { is_valid: false }, { expires_at: 1 }, { data_access_expires_at: 1 },
    { scopes: undefined }, { scopes: ['email'] }, { granular_scopes: [{ scope: 'ungranted' }] },
    { granular_scopes: [{ scope: 'ads_read', target_ids: [true] }] },
])('rejects invalid inspection evidence %j without substituting requested scopes', async invalid => {
    const f = fixture({ replies: [short, long, { data: { ...debug, ...invalid } }] });
    const result = await f.exchange();
    expect(result).toMatchObject({ ok: false, error: { code: 'protocol_mismatch' } }); expectRedacted({ result });
});

it.each([
    { token: { ...long, expires_in: 0 }, inspected: { ...debug, expires_at: 0, data_access_expires_at: 0 }, expiry: null },
    { token: { ...long, expires_in: 0 }, inspected: { ...debug, expires_at: 0 }, expiry: new Date(6500000).toISOString() },
    { token: { ...long, expires_in: 50 }, inspected: debug, expiry: new Date(51000).toISOString() },
])('derives expiry from all provider evidence including zero: $expiry', async ({ token, inspected, expiry }) => {
    expect(await fixture({ replies: [short, token, { data: inspected }] }).exchange()).toMatchObject({ ok: true, value: { expiresAt: expiry } });
});

it.each([{}, { ...long, expires_in: -1 }, { ...long, expires_in: '7200' }, { ...long, token_type: 'other' }, { ...long, access_token: '' },
    new Response('not-json'), new Response('fixture-client-secret fixture-long', { status: 400 }),
])('fails closed on malformed or rejected responses with redacted errors', async reply => {
    const f = fixture({ replies: [short, reply] }); const result = await f.exchange();
    expect(result).toMatchObject({ ok: false, error: { code: 'protocol_mismatch' } });
    expect(f.calls).toHaveLength(2); expectRedacted({ result });
});

it('rejects malformed confidential client data before any HTTP without echoing it', async () => {
    const fetch = async () => { throw new Error('unexpected fetch'); };
    const exchange = createOAuthExchange({ fetch, clock: { now: () => 1000 } });
    for (const invalid of [{ clientId: client.clientId, clientSecret: client.clientSecret }, { ...client, configId: 'invalid' }, client.clientSecret]) {
        const result = await exchange.exchange({ ...input, client: invalid });
        expect(result).toMatchObject({ ok: false, error: { code: 'protocol_mismatch' } }); expectRedacted({ result });
    }
});

it('redacts thrown transport failures and stops the sequence', async () => {
    const f = fixture({ fetch: async () => { throw new Error(client.clientSecret + long.access_token); } });
    const result = await f.exchange();
    expect(result).toMatchObject({ ok: false, error: { code: 'unavailable' } });
    expect(f.calls).toHaveLength(1); expectRedacted({ result });
});

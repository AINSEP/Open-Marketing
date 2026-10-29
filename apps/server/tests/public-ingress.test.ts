import { describe, expect, it, vi } from 'vitest';
import type { Outcome } from '@open-marketing/contracts';
import { handlePublicRequest, omConsentBanner, OM_CONSENT_POLICY } from '../src/inbound/public.js';

const scope = { ownerId: 'owner', workspaceId: 'workspace' };
const context = { scope, principal: { kind: 'owner' as const, ownerId: 'owner' }, correlationId: 'c', traceId: 't' };
const NOW = 1792000000123;
const clock = { now: () => NOW };
const ok = <T>(value: T): Outcome<T> => ({ ok: true, value });
const fail = (code: string): Outcome<never> => ({ ok: false, error: { code, message: code, retryable: false } } as Outcome<never>);

function grant(required: { marketing?: boolean } = {}): string {
    const marketing = required.marketing ?? true;
    const choice = { v: 1, p: OM_CONSENT_POLICY, c: { functional: marketing, analytics: marketing, marketing }, t: NOW, a: marketing ? 'accept' : 'reject', r: 'fixture-receipt-0001' };
    return 'jini_choices=' + encodeURIComponent(JSON.stringify(choice));
}
const publication = { publicationId: 'pub', fields: [{ id: 'email', type: 'email' }, { id: 'agree', type: 'checkbox' }] };
function services(over: Record<string, unknown> = {}) {
    const saved: unknown[] = [];
    const touches: unknown[] = [];
    const base = {
        context, clock,
        forms: { forms: { renderHostedForm: vi.fn(async () => ok({ html: '<form></form>' })), submitPublic: vi.fn(async () => ok({ received: true })) },
            publications: { findBySlug: vi.fn(async () => ok(publication)) } },
        identity: { webRepo: { saveVisit: vi.fn(async (input: unknown) => { saved.push(input); return ok(undefined); }) },
            webEvents: { recordTouch: vi.fn(async (input: unknown) => { touches.push(input); return ok(undefined); }) } },
        visits: { issue: () => ({ token: 'issued-token', visit: { anonymousId: 'anon' } }),
            tokens: { verify: vi.fn(async ({ visitToken }: { visitToken: string }) => visitToken === 'bad' ? fail('forbidden') : ok({ anonymousId: 'known' })) } },
        campaigns: { get: vi.fn(async () => ok({ campaignId: 'campaign' })) },
        links: { resolve: vi.fn(async () => ok({ campaignId: 'campaign' })) },
        consent: { store: { save: vi.fn(async () => undefined) }, ids: () => 'nonce-1' },
    };
    return { ...base, ...over, saved, touches } as typeof base & { saved: unknown[]; touches: unknown[] };
}
const landing = (over: Record<string, unknown> = {}) => ({ consent: true, eventId: 'event-1', schema: 'om.web.landing', version: 1, source: 'first-party', name: 'landing', occurredAt: NOW, properties: {}, ...over });
async function call(required: { s: ReturnType<typeof services>; request: Record<string, unknown>; publicOrigin?: string }) {
    return handlePublicRequest({ ...required.s, publicOrigin: required.publicOrigin, request: required.request } as never);
}

describe('public routes', () => {
    it('serves the snippet, the consent client and a bounded 404', async () => {
        const s = services();
        expect(await call({ s, request: { method: 'GET', path: '/web-events.js' } })).toMatchObject({ status: 200, contentType: expect.stringContaining('javascript') });
        const client = await call({ s, request: { method: 'GET', path: '/consent/client.min.js' } });
        expect(client.status).toBe(200); expect(client.body).toEqual(expect.any(String));
        expect(await call({ s, request: { method: 'GET', path: '/nowhere' } })).toMatchObject({ status: 404, body: { ok: false } });
    });
    it('renders both banner modes with and without a nonce', () => {
        expect(omConsentBanner({ mode: 'jini' }, { nonce: 'n1' }).head).toContain('n1');
        expect(omConsentBanner({ mode: 'headless' }).head).toContain('headless');
    });
    it('delegates agent-plugin webhooks and refuses unknown webhook shapes', async () => {
        const s = services();
        expect((await call({ s, request: { method: 'GET', path: '/hooks/agent-plugins/x/y/z' } })).status).toBe(404);
        expect((await call({ s, request: { method: 'POST', path: '/hooks/agent-plugins/x/y/z' } })).status).toBe(404);
    });
    it('withdraws by clearing only the visit cookie, adding Secure on the public host', async () => {
        const s = services();
        const plain = await call({ s, request: { method: 'DELETE', path: '/c', headers: { host: 'localhost:8080' } } });
        expect(plain).toMatchObject({ status: 204, body: '' });
        expect(plain.headers?.['set-cookie']).toContain('om_visit_8080=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
        expect(plain.headers?.['set-cookie']).not.toContain('Secure');
        const secure = await call({ s, publicOrigin: 'https://public.example', request: { method: 'DELETE', path: '/c', headers: { host: 'public.example' } } });
        expect(secure.headers?.['set-cookie']).toContain('; Secure');
        const noHost = await call({ s, request: { method: 'DELETE', path: '/c' } });
        expect(noHost.headers?.['set-cookie']).toContain('om_visit_local=');
    });
});

describe('consent receipt endpoint', () => {
    const receipt = (over: Record<string, unknown> = {}) => ({ method: 'POST', path: '/consent', headers: { host: 'localhost:9', origin: 'http://localhost:9', 'content-type': 'application/json', cookie: grant() },
        readRawBody: async () => ok(new TextEncoder().encode('{}')), remoteAddress: '203.0.113.9', ...over });
    it('never stores a malformed receipt and never caches the response', async () => {
        const s = services();
        const response = await call({ s, request: receipt() });
        expect(response.status).toBeGreaterThanOrEqual(400); expect(response.status).toBeLessThan(500);
        expect(response.headers).toEqual({ 'cache-control': 'no-store' });
        expect(s.consent.store.save).not.toHaveBeenCalled();
    });
    it('falls back to the parsed body, the default host and the public origin when no raw reader exists', async () => {
        const s = services();
        const bare = await call({ s, request: receipt({ readRawBody: undefined, body: { not: 'a receipt' }, headers: { 'content-type': 'application/json' } }) });
        expect(bare.status).toBeGreaterThanOrEqual(400);
        const publicHost = await call({ s, publicOrigin: 'https://public.example', request: receipt({ headers: { host: 'public.example', origin: 'https://public.example', 'content-type': 'application/json' } }) });
        expect(publicHost.status).toBeGreaterThanOrEqual(400);
        expect(s.consent.store.save).not.toHaveBeenCalled();
    });
    it('returns the transport failure when the raw body cannot be read', async () => {
        const s = services();
        const response = await call({ s, request: receipt({ readRawBody: async () => fail('limit_exceeded') }) });
        expect(response).toMatchObject({ status: 400, body: { ok: false, error: { code: 'limit_exceeded' } } });
    });
    it('asks the limiter per remote address and denies when it refuses', async () => {
        const allow = vi.fn(() => false);
        const s = services({ consent: { store: { save: vi.fn(async () => undefined) }, ids: () => 'id', limiter: { allow } } });
        const response = await call({ s, request: receipt() });
        expect(allow).toHaveBeenCalledWith({ address: '203.0.113.9' });
        expect(response.status).toBe(429);
        expect(s.consent.store.save).not.toHaveBeenCalled();
    });
});

describe('landing collection', () => {
    const collect = (body: unknown, headers: Record<string, string> = { cookie: grant() }) => ({ method: 'POST', path: '/c', headers: { host: 'localhost:7', ...headers }, body });
    it('maps boundary failures to unavailable/conflict/forbidden/invalid statuses', async () => {
        for (const [code, status] of [['unavailable', 503], ['conflict', 409], ['forbidden', 403], ['invalid_input', 400]] as const) {
            const s = services({ links: { resolve: async () => fail(code) } });
            const response = await call({ s, request: collect(landing({ properties: { linkId: 'link' } })) });
            expect(response.status).toBe(status);
            expect(s.touches).toEqual([]);
        }
    });
    it('rejects future events and unconsented visitors before any write', async () => {
        const s = services();
        expect(await call({ s, request: collect(landing({ occurredAt: NOW + 120000 })) })).toMatchObject({ status: 400, body: { error: { message: 'Landing time is in the future' } } });
        expect(await call({ s, request: collect(landing(), { cookie: grant({ marketing: false }) }) })).toMatchObject({ status: 403 });
        expect(await call({ s, request: collect(landing(), {}) })).toMatchObject({ status: 403 });
        expect((await call({ s, request: collect(landing({ consent: false })) })).status).toBe(400);
        expect(s.saved).toEqual([]); expect(s.touches).toEqual([]);
    });
    it('reads the body through the transport reader and surfaces its failure', async () => {
        const s = services();
        const request = { ...collect(landing()), readBody: async () => fail('limit_exceeded') };
        expect(await call({ s, request })).toMatchObject({ status: 400, body: { error: { code: 'limit_exceeded' } } });
        const fine = await call({ s, request: { ...collect(landing()), readBody: async () => ok(landing()) } });
        expect(fine.status).toBe(202);
    });
    it('issues a visit once, then reuses a verified cookie and rejects duplicates or bad tokens', async () => {
        const s = services();
        const issued = await call({ s, request: collect(landing()) });
        expect(issued).toMatchObject({ status: 202, body: { ok: true, value: { accepted: true } } });
        expect(issued.headers?.['set-cookie']).toContain('om_visit_7=issued-token; Path=/; HttpOnly');
        expect(s.saved).toHaveLength(1);
        const reused = await call({ s, request: collect(landing(), { cookie: grant() + '; om_visit_7=good' }) });
        expect(reused.status).toBe(202); expect(reused.headers).toEqual({}); expect(s.saved).toHaveLength(1);
        expect((await call({ s, request: collect(landing(), { cookie: grant() + '; om_visit_7=bad' }) })).status).toBe(403);
        expect((await call({ s, request: collect(landing(), { cookie: grant() + '; om_visit_7=a; om_visit_7=b' }) })).status).toBe(400);
    });
    it('fails when the visit cannot be stored', async () => {
        const s = services({ identity: { webRepo: { saveVisit: async () => fail('unavailable') }, webEvents: { recordTouch: async () => ok(undefined) } } });
        expect((await call({ s, request: collect(landing()) })).status).toBe(503);
    });
    it('reports a failed touch write without claiming acceptance', async () => {
        const s = services({ identity: { webRepo: { saveVisit: async () => ok(undefined) }, webEvents: { recordTouch: async () => fail('conflict') } } });
        expect(await call({ s, request: collect(landing()) })).toMatchObject({ status: 409, body: { ok: false } });
    });
    it('keeps only first-party metadata: server user agent, origin-bound page URL, verified link campaign', async () => {
        const s = services();
        const response = await call({ s, request: collect(landing({ properties: { linkId: 'link', utm_source: 'src', gclid: 'g1', pageUrl: 'https://site.example/p?secret=1#x' } }),
            { cookie: grant(), origin: 'https://site.example', 'user-agent': ' Agent/1.0 ' }) });
        expect(response.status).toBe(202);
        const event = (s.touches[0] as { event: { properties: Record<string, string> } }).event;
        expect(event.properties).toEqual({ utm_source: 'src', gclid: 'g1', pageUrl: 'https://site.example/p', client_user_agent: 'Agent/1.0', linkId: 'link', campaignId: 'campaign' });
        const overlong = await call({ s, request: collect(landing(), { cookie: grant(), 'user-agent': 'x'.repeat(1025) }) });
        expect(overlong.status).toBe(202);
        expect(JSON.stringify(s.touches[1])).not.toContain('client_user_agent');
    });
    it('checks link and campaign claims in scope', async () => {
        const noLookup = services({ links: {} });
        expect(await call({ s: noLookup, request: collect(landing({ properties: { linkId: 'link' } })) })).toMatchObject({ status: 503, body: { error: { message: 'Tracked link lookup unavailable' } } });
        const s = services();
        expect(await call({ s, request: collect(landing({ properties: { linkId: 'link', campaignId: 'other' } })) })).toMatchObject({ status: 403 });
        const missing = services({ campaigns: { get: async () => ok(null) } });
        expect(await call({ s: missing, request: collect(landing({ properties: { campaignId: 'unknown' } })) })).toMatchObject({ status: 403, body: { error: { message: 'Campaign unavailable in scope' } } });
        const failing = services({ campaigns: { get: async () => fail('unavailable') } });
        expect((await call({ s: failing, request: collect(landing({ properties: { campaignId: 'unknown' } })) })).status).toBe(503);
        const composite = services();
        expect((await call({ s: composite, request: collect(landing({ properties: { campaignId: 'ck1:abc' } })) })).status).toBe(202);
        expect(composite.campaigns.get).not.toHaveBeenCalled();
    });
});

describe('hosted forms', () => {
    const post = (fields: Record<string, string>, over: Record<string, unknown> = {}) => ({ method: 'POST', path: '/f/lead', headers: { host: 'localhost:7' }, body: { om_publication: 'pub', _attempt: 'attempt-1', ...fields }, ...over });
    it('renders the nonce banner page and surfaces render failures', async () => {
        const s = services();
        const page = await call({ s, request: { method: 'GET', path: '/f/lead' } });
        expect(page.status).toBe(200); expect(page.headers?.['content-security-policy']).toContain("style-src 'nonce-nonce-1'");
        const broken = services({ forms: { forms: { renderHostedForm: async () => fail('unavailable') }, publications: {} } });
        expect((await call({ s: broken, request: { method: 'GET', path: '/f/lead' } })).status).toBe(503);
    });
    it('answers 404 for an unknown publication and passes the failure of the lookup through', async () => {
        const none = services({ forms: { forms: {}, publications: { findBySlug: async () => ok(null) } } });
        expect((await call({ s: none, request: post({}) })).status).toBe(404);
        const failing = services({ forms: { forms: {}, publications: { findBySlug: async () => fail('unavailable') } } });
        expect((await call({ s: failing, request: post({}) })).status).toBe(503);
    });
    it('rejects transport failures, oversized or malformed bodies and wrong metadata', async () => {
        const s = services();
        expect((await call({ s, request: post({}, { readBody: async () => fail('limit_exceeded') }) })).status).toBe(400);
        expect((await call({ s, request: post({}, { body: { a: 1 } }) })).status).toBe(400);
        expect((await call({ s, request: post({}, { body: Object.fromEntries(Array.from({ length: 26 }, (_, i) => ['f' + i, 'v'])) }) })).status).toBe(400);
        expect(await call({ s, request: post({ om_publication: 'other' }) })).toMatchObject({ status: 400, body: { error: { message: 'Invalid form metadata' } } });
        expect(s.forms.forms.submitPublic).not.toHaveBeenCalled();
    });
    it('rejects unknown fields and non-browser checkbox values before submission', async () => {
        const s = services();
        expect(await call({ s, request: post({ email: 'a@example.test', surprise: 'x' }) })).toMatchObject({ status: 400, body: { error: { message: 'Unknown form field' } } });
        expect(await call({ s, request: post({ agree: 'maybe' }) })).toMatchObject({ status: 400, body: { error: { message: 'Invalid checkbox choice' } } });
        expect(s.forms.forms.submitPublic).not.toHaveBeenCalled();
    });
    it('submits answers with missing checkboxes false, forwards the honeypot, and honours Accept: text/html', async () => {
        const s = services();
        const json = await call({ s, request: post({ email: 'a@example.test', _hp: '' }) });
        expect(json).toMatchObject({ status: 202, body: { ok: true } });
        expect(s.forms.forms.submitPublic).toHaveBeenLastCalledWith(expect.objectContaining({ slug: 'lead', attemptId: 'attempt-1', body: { email: 'a@example.test', agree: false, _hp: '' } }));
        const checked = await call({ s, request: post({ email: 'a@example.test', agree: 'on' }, { headers: { host: 'localhost:7', accept: 'text/html' } }) });
        expect(checked).toMatchObject({ status: 202, contentType: expect.stringContaining('text/html') });
        expect(s.forms.forms.submitPublic).toHaveBeenLastCalledWith(expect.objectContaining({ body: { email: 'a@example.test', agree: true } }));
        const refused = services({ forms: { forms: { submitPublic: async () => fail('conflict') }, publications: { findBySlug: async () => ok(publication) } } });
        expect((await call({ s: refused, request: post({}, { headers: { accept: 'text/html' } }) })).status).toBe(409);
    });
    it('attributes only with a stored grant: explicit tokens must verify, cookies fall back to unattributed', async () => {
        const s = services();
        const token = (value: string, headers: Record<string, string> = { cookie: grant() }) => call({ s, request: post({ om_vt: value }, { headers: { host: 'localhost:7', ...headers } }) });
        expect((await token('good')).status).toBe(202);
        expect(s.forms.forms.submitPublic).toHaveBeenLastCalledWith(expect.objectContaining({ visitToken: 'good' }));
        expect((await token('bad')).status).toBe(403);
        expect((await token('good', {})).status).toBe(202);
        expect(s.forms.forms.submitPublic).toHaveBeenLastCalledWith(expect.objectContaining({ visitToken: undefined }));
        const viaCookie = await call({ s, request: post({}, { headers: { host: 'localhost:7', cookie: grant() + '; om_visit_7=good' } }) });
        expect(viaCookie.status).toBe(202);
        expect(s.forms.forms.submitPublic).toHaveBeenLastCalledWith(expect.objectContaining({ visitToken: 'good' }));
        await call({ s, request: post({}, { headers: { host: 'localhost:7', cookie: grant() + '; om_visit_7=bad' } }) });
        expect(s.forms.forms.submitPublic).toHaveBeenLastCalledWith(expect.objectContaining({ visitToken: undefined }));
        await call({ s, request: post({}, { headers: { host: 'localhost:7', cookie: grant() + '; om_visit_7=a; om_visit_7=b' } }) });
        expect(s.forms.forms.submitPublic).toHaveBeenLastCalledWith(expect.objectContaining({ visitToken: undefined }));
    });
});

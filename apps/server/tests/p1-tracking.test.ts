/** Written-only tracking regressions; all plugins and network effects are fixtures. */
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { createServer, request as nodeRequest } from 'node:http';
import { expect, it, vi } from 'vitest';
import { encodeCampaignKey, type CallContext } from '@open-marketing/contracts';
import { bindServerDatabase } from '../src/composition/database.js';
import { bindIdentity, observedCampaignMembership } from '../src/composition/identity.js';
import { createSubjectLane } from '../src/composition/subject-lane.js';
import { bindTracking } from '../src/composition/tracking.js';
import { createNodeHttpListener } from '../src/inbound/http.js';
import { bootServer, type ServerBootIo } from '../src/composition/index.js';
import { OM_CONSENT_POLICY } from '../src/inbound/public.js';

const context: CallContext = { scope: { ownerId: 'owner', workspaceId: 'workspace' }, principal: { kind: 'owner', ownerId: 'owner' }, correlationId: 'correlation', traceId: 'trace' };
const key = { pluginId: 'fixture-ads', accountId: 'account', vendorCampaignId: 'campaign' };
const binding = { id: 'binding', scope: context.scope, connectionId: 'connection', externalAccountId: key.accountId };

it.each(['observed', 'unadmitted', 'disabled', 'unbound', 'foreign-owner', 'foreign-workspace', 'unobserved'])(
    'projects a ck1 claim only with current admission, scoped binding and observation: %s', async scenario => {
        const native = new Database(':memory:');
        native.exec(readFileSync(new URL('../../../features/web-events/migrations/0001_web_events.sql', import.meta.url), 'utf8'));
        const clock = { now: () => 1000 }, ids = { next: () => 'touch' }, observer = { observe() {} };
        const database = bindServerDatabase({ native, context, observer });
        const observedCampaigns = vi.fn(async () => ({ ok: true as const, value: scenario === 'unobserved' ? [] : [key] }));
        const accounts = { find: vi.fn(async () => ({ ok: true as const, value: scenario === 'unbound' ? null : { ...binding,
            scope: { ownerId: scenario === 'foreign-owner' ? 'foreign' : context.scope.ownerId, workspaceId: scenario === 'foreign-workspace' ? 'foreign' : context.scope.workspaceId } } })) };
        const state = vi.fn(async () => ({ admitted: scenario !== 'unadmitted', enabled: scenario !== 'disabled' }));
        const membership = observedCampaignMembership({ metrics: { observedCampaigns }, accounts, state });
        const identity = bindIdentity({ unit: database.unit, clock, ids, observer, digestKey: new Uint8Array(32),
            tokens: { async verify() { throw new Error('No visit binding in this test'); } },
            subjectLane: createSubjectLane({ async resolveSubject() { throw new Error('No subject access'); } }) }, { observedCampaigns: membership });
        const encoded = encodeCampaignKey({ key });
        if (!encoded.ok) throw new Error('Invalid fixture key');
        try {
            const result = await identity.webEvents.recordTouch({ context, event: { eventId: 'landing', schema: 'om.web.landing', version: 1,
                source: 'first-party', anonymousId: 'visit', name: 'landing', properties: { campaignId: encoded.value, gclid: 'click' }, occurredAt: 100,
                receivedAt: 0, cursor: 0, traceId: 'trace' } });
            expect(result).toMatchObject({ ok: true, value: { campaignId: scenario === 'observed' ? encoded.value : null, clickIdentifiers: { gclid: 'click' } } });
            expect(observedCampaigns).toHaveBeenCalledTimes(['observed', 'unobserved'].includes(scenario) ? 1 : 0);
            // The adapter has no credential port; any identity/subject access above throws.
        } finally { native.close(); }
    });

it('filters a mixed membership batch before SQL and propagates cancellation', async () => {
    const other = { ...key, pluginId: 'disabled-plugin' };
    const metrics = { observedCampaigns: vi.fn(async () => ({ ok: true as const, value: [key] })) };
    const accounts = { async find() { return { ok: true as const, value: binding }; } };
    const membership = observedCampaignMembership({ metrics, accounts, state: async input => ({ enabled: true, admitted: input.pluginId === key.pluginId }) });
    const options = { signal: new AbortController().signal };
    expect(await membership.observed({ context, keys: [other, key] }, options)).toEqual({ ok: true, value: [key] });
    expect(metrics.observedCampaigns).toHaveBeenCalledWith({ context, keys: [key] }, options);
});

/** Structural doubles cover only the existing ports, with distinct refusal and publication paths. */
function trackingFixture(required: { bound?: boolean; foreign?: boolean; published?: boolean; publicOrigin?: string; hostMissing?: boolean } = {}) {
    type Host = NonNullable<Parameters<typeof bindTracking>[0]['host']>;
    const host: Host = { async invokeCapability() { throw new Error('Unconfigured fixture'); } };
    const tag = { snippet: '<script>fixtureTag();</script>', campaignUrlTemplate: 'https://site.example/landing?fixture=campaign' };
    const invoke = vi.spyOn(host, 'invokeCapability').mockResolvedValue({ ok: true, value: tag });
    const find = vi.fn(async () => ({ ok: true as const, value: required.bound === false ? null : { ...binding, scope: required.foreign ? { ...context.scope, ownerId: 'foreign' } : context.scope } }));
    const destinationReadiness = vi.fn(async () => ({ ok: true as const, value: { status: 'missing' as const, heartbeatAt: null } }));
    const renderHostedForm = vi.fn(async () => required.published === false
        ? { ok: false as const, error: { code: 'invalid_input' as const, message: 'Unpublished', retryable: false } }
        : { ok: true as const, value: { html: '<form></form>', publicationId: 'publication' } });
    return { invoke, find, renderHostedForm, destinationReadiness, tag, service: bindTracking({ host: required.hostMissing ? undefined : host,
        accounts: { find }, webEvents: { destinationReadiness }, forms: { renderHostedForm }, publicOrigin: required.publicOrigin }) };
}

it('resolves each connection on the server and invokes plugin tags sequentially with cancellation', async () => {
    const f = trackingFixture();
    const second = { ...key, vendorCampaignId: 'second' };
    const options = { signal: new AbortController().signal };
    const pending = Promise.withResolvers<{ ok: true; value: typeof f.tag }>();
    f.invoke.mockReturnValueOnce(pending.promise);
    const result = f.service.snippet({ context, destinationUrl: 'https://site.example/landing', campaignKeys: [key, second] }, options);
    await vi.waitFor(() => expect(f.invoke).toHaveBeenCalledTimes(1));
    expect(f.find).toHaveBeenCalledTimes(1);
    pending.resolve({ ok: true, value: f.tag });
    expect(await result).toMatchObject({ ok: true, value: { source: expect.stringContaining('omGrantConsent'), campaignUrlTemplates: [
        { campaignKey: key, template: f.tag.campaignUrlTemplate }, { campaignKey: second, template: f.tag.campaignUrlTemplate },
    ] } });
    expect(f.invoke).toHaveBeenNthCalledWith(1, { context, pluginId: key.pluginId, capabilityId: 'tracking.tag.v1', connection: { connectionId: 'connection', accountId: key.accountId },
        input: { campaignKey: key, destinationUrl: 'https://site.example/landing' } }, options);
    expect(f.find).toHaveBeenCalledTimes(2);
});

it.each([{ bound: false }, { foreign: true }])('rejects unbound or foreign tracking keys before the host: %j', async input => {
    const f = trackingFixture(input);
    expect(await f.service.snippet({ context, destinationUrl: 'https://site.example/landing', campaignKeys: [key] })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    expect(f.invoke).not.toHaveBeenCalled();
});
it('allows tag-free snippets without a host and preserves plugin refusals', async () => {
    const missing = trackingFixture({ hostMissing: true });
    for (const campaignKeys of [undefined, []]) {
        expect(await missing.service.snippet({ context, destinationUrl: 'https://site.example/landing', campaignKeys })).toMatchObject({
            ok: true, value: { source: expect.stringContaining('omGrantConsent'), campaignUrlTemplates: [] },
        });
    }
    expect(await missing.service.snippet({ context, destinationUrl: 'https://site.example/landing', campaignKeys: [key] })).toMatchObject({ ok: false, error: { code: 'unavailable' } });
    expect(missing.find).not.toHaveBeenCalled();
    expect(missing.invoke).not.toHaveBeenCalled();
    const f = trackingFixture();
    const refused = { ok: false as const, error: { code: 'forbidden' as const, message: 'Plugin unavailable', retryable: false } };
    f.invoke.mockResolvedValue(refused);
    expect(await f.service.snippet({ context, destinationUrl: 'https://site.example/landing', campaignKeys: [key] })).toEqual(refused);
    f.invoke.mockResolvedValue({ ok: true, value: { snippet: '', campaignUrlTemplate: '' } });
    expect(await f.service.snippet({ context, destinationUrl: 'https://site.example/landing', campaignKeys: [key] })).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
});
it.each([
    { consentBanner: undefined, banner: '"banner":"jini"', body: true },
    { consentBanner: true, banner: '"banner":"jini"', body: true },
    { consentBanner: false, banner: '"banner":"headless"', body: false },
])('renders the shared Jini consent banner for both modes: %j', async ({ consentBanner, banner, body }) => {
    const f = trackingFixture({ hostMissing: true });
    const result = await f.service.snippet({ context, destinationUrl: 'https://site.example/landing', ...(consentBanner === undefined ? {} : { consentBanner }) });
    if (!result.ok) throw new Error('Snippet fixture failed');
    expect(result.value.consentBanner.head).toContain(banner);
    expect(result.value.consentBanner.head).toContain('"policy":"' + OM_CONSENT_POLICY + '"');
    expect(result.value.consentBanner.head).toContain('<script src="/consent/client.min.js"');
    expect(result.value.consentBanner.head).toContain('"endpoint":"/consent"');
    expect(result.value.consentBanner.body.includes('id="jini-consent"')).toBe(body);
    expect(result.value.source).toContain('jiniConsentQueue');
    expect(result.value.source).toContain('"marketing"');
});
it.each([
    { published: true, publicOrigin: 'https://public.example', expected: 'https://public.example/f/lead' },
    { published: false, publicOrigin: 'https://public.example', expected: null },
    { published: true, publicOrigin: undefined, expected: null },
])('returns only a published, public-origin fallback: %j', async input => {
    const f = trackingFixture(input);
    expect(await f.service.readiness({ context, destinationUrl: 'https://site.example/landing', fallbackSlug: 'lead' })).toEqual({ ok: true, value: { status: 'missing', heartbeatAt: null, fallbackUrl: input.expected } });
    expect(f.destinationReadiness).toHaveBeenCalledWith({ context, destinationUrl: 'https://site.example/landing' }, undefined);
    expect(f.renderHostedForm).toHaveBeenCalledTimes(input.publicOrigin ? 1 : 0);
});

/** Real HTTP metadata transport with explicit Host; no reverse proxy or vendor connection. */
async function publicRequest(required: { origin: string; path: string; method?: 'GET' | 'POST'; headers: Record<string, string | undefined> }): Promise<number> {
    return new Promise((resolve, reject) => {
        const request = nodeRequest(required.origin + required.path, { method: required.method ?? 'GET', headers: required.headers, agent: false }, response => {
            response.resume();
            response.on('end', () => resolve(response.statusCode!));
        });
        request.on('error', reject);
        request.end();
    });
}

it('admits only exact public routes and ignores forwarded host claims', async () => {
    const listener = createNodeHttpListener({ host: '127.0.0.1', port: 0, publicOrigin: 'https://public.example', ids: { next: () => 'request' }, observer: { observe() {} },
        effects: { createServer, schedule: () => () => {} } });
    const handle = vi.fn(async () => ({ status: 200, body: { fixture: true } }));
    expect(await listener.start({ handle })).toEqual({ ok: true, value: undefined });
    const origin = listener.origin({})!;
    try {
        for (const path of ['/web-events.js', '/f/lead']) expect(await publicRequest({ origin, path, headers: { host: 'public.example' } })).toBe(200);
        for (const path of ['/c', '/f/lead']) expect(await publicRequest({ origin, path, method: 'POST', headers: { host: 'public.example', origin: 'https://public.example' } })).toBe(200);
        expect(handle).toHaveBeenCalledTimes(4);
        for (const path of ['/api/tools/call', '/bootstrap', '/assets/studio.js', '/', '/web-events.js/extra', '/f/lead/extra', '/c']) {
            expect(await publicRequest({ origin, path, headers: { host: 'public.example' } })).toBe(403);
        }
        for (const headers of [{ host: 'public.example', origin: 'https://evil.example' }, { host: 'public.example' },
            { host: 'evil.example', origin: 'https://public.example', 'x-forwarded-host': 'public.example', 'x-forwarded-proto': 'https' }]) {
            expect(await publicRequest({ origin, path: '/c', method: 'POST', headers })).toBe(403);
        }
        expect(handle).toHaveBeenCalledTimes(4);
        expect(await publicRequest({ origin, path: '/api/tools/call', headers: { host: new URL(origin).host } })).toBe(200);
    } finally { await listener.stop({}); }
});

it.each(['http://public.example', 'https://public.example/path', 'https://user:secret@public.example', 'not-an-origin'])(
    'rejects invalid OM_PUBLIC_ORIGIN before opening any resource: %s', async publicOrigin => {
        const result = await bootServer({ env: { OM_STATE_ROOT: '/fixture/state', OM_PUBLIC_ORIGIN: publicOrigin }, io: {} as ServerBootIo,
            clock: { now: () => 1000 }, ids: { next: () => 'fixture' }, observer: { observe() {} } });
        expect(result).toMatchObject({ ok: false, error: { code: 'invalid_input', message: 'Invalid OM_PUBLIC_ORIGIN' } });
        expect(JSON.stringify(result)).not.toContain('secret');
    });

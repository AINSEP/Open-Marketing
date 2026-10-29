/** First-party public ingress. Scope, time, visit identity and authority come from server composition. */
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { z } from 'zod';
import { renderBanner } from '@jini-ai/cookie-consent/render';
import { handleReceipt, readConsent, type ConsentRecordPort } from '@jini-ai/cookie-consent/server';
import { epochSchema, idSchema, parseBoundary } from '@open-marketing/contracts';
import type { CallContext, ClockPort, ObserverPort, Outcome } from '@open-marketing/contracts';
import type { FormPublication } from '@open-marketing/forms';
import type { CampaignRepoPort } from '@open-marketing/campaigns';
import type { TrackedLinkPort } from '@open-marketing/measure';
import { landingPropertiesSchema, webEventInstallSource } from '@open-marketing/web-events';
import type { HttpRequest, HttpResponse } from '../ports.js';
import type { bindForms } from '../composition/forms.js';
import type { bindIdentity, createVisitTokens } from '../composition/identity.js';
import { localFailure } from '../composition/local-auth.js';
import { handleMessagingWebhook } from './messaging-webhooks.js';

type PublicInput = { request: HttpRequest; context: CallContext; forms: ReturnType<typeof bindForms>;
    identity: ReturnType<typeof bindIdentity>; visits: ReturnType<typeof createVisitTokens>; clock: ClockPort;
    campaigns: CampaignRepoPort; links: TrackedLinkPort; observer?: ObserverPort; publicOrigin?: string;
    webhooks?: Parameters<typeof handleMessagingWebhook>[0]['webhooks']; consent: { store: ConsentRecordPort; ids: () => string } };
/** One OM privacy-policy version for every visitor consent receipt (no per-workspace setting yet). */
export const OM_CONSENT_POLICY = '2026-10-29';
/** Shared Jini banner render for hosted pages and owner-installed sites: 'jini' is the built-in banner,
 * 'headless' keeps the site's own CMP driving window.jiniConsent. Grants wait for a stored receipt.
 * @example omConsentBanner({ mode: 'jini' }, { nonce }) */
export function omConsentBanner(required: { mode: 'jini' | 'headless' }, optional?: { nonce?: string }): { head: string; body: string } {
    const { head, body } = renderBanner({ mode: required.mode, client: { contract: 1, policy: OM_CONSENT_POLICY, regionMode: 'auto' }, copy: {} },
        { clientSrc: '/consent/client.min.js', evidence: { mode: 'durable', endpoint: '/consent' }, ...(optional?.nonce ? { nonce: optional.nonce } : {}) });
    return { head, body };
}
/** Server-side gate: the visitor's own Jini choice cookie, GPC/DNT and policy version decide; the
 * browser payload never does. No receipt read per event (Jini readConsent design). @complexity O(cookie header). */
function marketingAllowed(required: { request: HttpRequest; clock: ClockPort }): boolean {
    const headers = required.request.headers ?? {};
    return readConsent({ cookieHeader: headers.cookie, policy: OM_CONSENT_POLICY, regionMode: 'auto' },
        { secGpc: headers['sec-gpc'], dnt: headers.dnt, nowMs: required.clock.now({}) }).allowed.marketing;
}
const clickIdentifier = z.string().min(1).max(2048).regex(/^[A-Za-z0-9._-]+$/);
const landingSchema = z.strictObject({ consent: z.literal(true), eventId: idSchema, schema: z.literal('om.web.landing'), version: z.literal(1),
    source: z.literal('first-party'), name: z.literal('landing'), occurredAt: epochSchema,
    properties: landingPropertiesSchema.omit({ client_user_agent: true }).extend({ fbc: clickIdentifier.optional(), fbp: clickIdentifier.optional() }) });
function response<T>(required: { result: Outcome<T>; status?: number }): HttpResponse {
    if (required.result.ok) return { status: required.status ?? 200, body: required.result };
    const status = required.result.error.code === 'unavailable' ? 503 : required.result.error.code === 'conflict' ? 409 : required.result.error.code === 'forbidden' ? 403 : 400;
    return { status, body: required.result };
}
function cookieName(required: { request: HttpRequest }): string {
    return 'om_visit_' + (required.request.headers?.host?.split(':')[1] ?? 'local');
}
/** Duplicate visit cookies fail closed; never inspect/log owner credentials here. */
function visitCookie(required: { request: HttpRequest }): Outcome<string | undefined> {
    const name = cookieName(required);
    const values = (required.request.headers?.cookie ?? '').split(';').map(item => item.trim()).filter(item => item.startsWith(name + '='));
    if (values.length > 1) return localFailure({ code: 'invalid_input', message: 'Duplicate visit cookie' });
    return { ok: true, value: values[0]?.slice(name.length + 1) };
}
/** Issue a new scoped visit on consented collection only, or validate the current cookie.
 * HMAC token has a one-hour lifetime; the only stored row is the web-events visit itself. */
async function visit(required: PublicInput): Promise<Outcome<{ token: string; anonymousId: string; headers: Record<string, string> }>> {
    const cookie = visitCookie(required);
    if (!cookie.ok) return cookie;
    if (cookie.value) {
        const verified = await required.visits.tokens.verify({ context: required.context, visitToken: cookie.value });
        if (!verified.ok) return verified;
        return { ok: true, value: { token: cookie.value, anonymousId: verified.value.anonymousId, headers: {} } };
    }
    const issued = required.visits.issue({ context: required.context });
    const stored = await required.identity.webRepo.saveVisit({ context: required.context, visit: issued.visit });
    if (!stored.ok) return stored;
    return { ok: true, value: { token: issued.token, anonymousId: issued.visit.anonymousId,
        headers: { 'set-cookie': cookieName(required) + '=' + issued.token + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=3600' + secureFlag(required) } } };
}
function secureFlag(required: { request: HttpRequest; publicOrigin?: string }): string {
    return required.publicOrigin && required.request.headers?.host === new URL(required.publicOrigin).host ? '; Secure' : '';
}
/** Withdrawal (Jini adapter revoke): clear OM's HttpOnly visit cookie; nothing else is written. */
function withdraw(required: PublicInput): HttpResponse {
    return { status: 204, contentType: 'text/plain; charset=utf-8', body: '',
        headers: { 'set-cookie': cookieName(required) + '=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0' + secureFlag(required) } };
}
/** Jini receipt endpoint. The Request URL uses the public origin (or the local host) so Jini's origin check is meaningful. */
async function consentReceipt(required: PublicInput): Promise<HttpResponse> {
    const headers = required.request.headers ?? {};
    const base = required.publicOrigin && headers.host === new URL(required.publicOrigin).host ? required.publicOrigin : 'http://' + (headers.host ?? '127.0.0.1');
    const raw = required.request.readRawBody ? await required.request.readRawBody({}) : { ok: true as const, value: new TextEncoder().encode(JSON.stringify(required.request.body ?? null)) };
    if (!raw.ok) return response({ result: raw });
    const forwarded = ['origin', 'content-type', 'cookie', 'sec-gpc', 'dnt'].flatMap(name => headers[name] === undefined ? [] : [[name, headers[name]] as [string, string]]);
    const request = new Request(new URL(required.request.path, base), { method: 'POST', headers: forwarded, body: new Uint8Array(raw.value) });
    const result = await handleReceipt({ request, ports: { store: required.consent.store, policy: () => OM_CONSENT_POLICY, ids: required.consent.ids, now: () => required.clock.now({}) } }, { regionMode: 'auto' });
    return { status: result.status, contentType: result.headers.get('content-type') ?? 'application/json', body: await result.text() };
}
let consentClient: Promise<string> | undefined;
/** Serve the published Jini client as an inert asset, read once on first request. */
async function consentClientScript(): Promise<HttpResponse> {
    consentClient ??= readFile(createRequire(import.meta.url).resolve('@jini-ai/cookie-consent/client.min.js'), 'utf8');
    try { return { status: 200, contentType: 'text/javascript; charset=utf-8', body: await consentClient }; }
    catch { consentClient = undefined; return { status: 503, body: localFailure({ message: 'Consent client unavailable' }) }; }
}
/** Render the hosted form and the Jini banner without issuing visits or cookies; collection waits for a stored marketing grant. */
async function formGet(required: PublicInput & { slug: string }): Promise<HttpResponse> {
    const rendered = await required.forms.forms.renderHostedForm({ context: required.context, slug: required.slug });
    if (!rendered.ok) return response({ result: rendered });
    const nonce = required.consent.ids();
    const banner = omConsentBanner({ mode: 'jini' }, { nonce });
    return { status: 200, contentType: 'text/html; charset=utf-8', body: '<!doctype html><html><head><meta charset="utf-8"><title>OM sandbox lead</title>' + banner.head + '</head><body><h1>Local sandbox lead</h1><p>Stored only in this local sandbox.</p>' + rendered.value.html + '<script src="/web-events.js" defer></script>' + banner.body + '</body></html>',
        headers: { 'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'nonce-" + nonce + "'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" } };
}
/** Unique URL-encoded fields from transport; immutable descriptors define the answer allowlist.
 * Server metadata is separated before the owning forms validation/digest boundary.
 * Attribution uses the verified explicit token or consented cookie, when available. */
async function formPost(required: PublicInput & { slug: string }): Promise<HttpResponse> {
    const saved = await required.forms.publications.findBySlug({ context: required.context, slug: required.slug });
    if (!saved.ok) return response({ result: saved });
    if (!saved.value) return { status: 404, body: localFailure({ message: 'Form unavailable' }) };
    const raw = required.request.readBody ? await required.request.readBody({}) : { ok: true as const, value: required.request.body };
    if (!raw.ok) return response({ result: raw });
    const parsed = parseBoundary({ schema: z.record(z.string().max(256), z.string().max(4096)).refine(input => Object.keys(input).length <= 25), input: raw.value });
    if (!parsed.ok) return response({ result: parsed });
    const fields = parsed.value;
    const metadata = z.strictObject({ publicationId: z.literal(saved.value.publicationId), attemptId: idSchema, visitToken: z.string().max(1024).optional() }).safeParse({ publicationId: fields.om_publication, attemptId: fields._attempt, visitToken: fields.om_vt });
    if (!metadata.success) return { status: 400, body: localFailure({ code: 'invalid_input', message: 'Invalid form metadata' }) };
    const verified = await verifyOptionalVisit({ request: required.request, visits: required.visits, context: required.context, token: metadata.data.visitToken, consented: marketingAllowed(required) });
    if (!verified.ok) return response({ result: verified });
    const body = answers({ fields, publication: saved.value });
    if (!body.ok) return response({ result: body });
    const result = await required.forms.forms.submitPublic({ context: required.context, slug: required.slug, ...metadata.data, visitToken: verified.value, body: body.value });
    if (!result.ok || !required.request.headers?.accept?.includes('text/html')) return response({ result, status: 202 });
    return { status: 202, contentType: 'text/html; charset=utf-8', body: '<!doctype html><title>Received</title><h1>Received</h1><p>Your local sandbox submission will be processed in the background.</p>' };
}
/** Without a stored marketing grant the lead stays unattributed (enquiry still accepted).
 * Explicit tokens must authenticate; absent/invalid cookies keep the lead unattributed.
 * Returns the verified token without writing visits; at most one scoped verification.
 * @complexity O(h), h is the bounded request-cookie header length; no storage writes. */
async function verifyOptionalVisit(required: { request: HttpRequest; visits: ReturnType<typeof createVisitTokens>; context: CallContext; token?: string; consented: boolean }): Promise<Outcome<string | undefined>> {
    if (!required.consented) return { ok: true, value: undefined };
    if (required.token !== undefined) {
        const result = await required.visits.tokens.verify({ context: required.context, visitToken: required.token });
        return result.ok ? { ok: true, value: required.token } : result;
    }
    const cookie = visitCookie(required);
    if (!cookie.ok || !cookie.value) return { ok: true, value: undefined };
    const result = await required.visits.tokens.verify({ context: required.context, visitToken: cookie.value });
    return { ok: true, value: result.ok ? cookie.value : undefined };
}

function answers(required: { fields: Record<string, string>; publication: FormPublication }): Outcome<Record<string, string | boolean>> {
    if (!required.publication) return localFailure({ message: 'Publication unavailable' });
    const metadata = ['om_publication', '_attempt', 'om_vt', '_hp'];
    const allowed = new Set([...metadata, ...required.publication.fields.map(field => field.id)]);
    if (Object.keys(required.fields).some(key => !allowed.has(key))) return localFailure({ code: 'invalid_input', message: 'Unknown form field' });
    const body: Record<string, string | boolean> = {};
    for (const field of required.publication.fields) {
        const answer = answerValue({ field, raw: required.fields[field.id] });
        if (!answer.ok) return answer;
        if (answer.value !== undefined) body[field.id] = answer.value;
    }
    if (required.fields._hp !== undefined) body._hp = required.fields._hp;
    return { ok: true, value: body };
}
/** Missing checkboxes are false; reject non-browser scalar choices before submission writes. */
function answerValue(required: { field: FormPublication['fields'][number]; raw: string | undefined }): Outcome<string | boolean | undefined> {
    if (required.field.type !== 'checkbox') return { ok: true, value: required.raw };
    if (required.raw !== undefined && !['on', 'true', '1'].includes(required.raw)) return localFailure({ code: 'invalid_input', message: 'Invalid checkbox choice' });
    return { ok: true, value: required.raw !== undefined };
}

/** Caller IDs are claims: a tracked link and its campaign must exist in this workspace.
 * No provider lookup is made; only the four approved first-party click IDs are retained. */
async function landingProperties(required: PublicInput & { properties: z.infer<typeof landingSchema>['properties'] }): Promise<Outcome<Record<string, string>>> {
    const { linkId } = required.properties;
    const linked = await linkedCampaign(required);
    if (!linked.ok) return linked;
    const campaign = linked.value;
    if (campaign && !campaign.startsWith('ck1:')) {
        const found = await required.campaigns.get({ context: required.context, campaignId: campaign });
        if (!found.ok) return found;
        if (!found.value) return localFailure({ code: 'forbidden', message: 'Campaign unavailable in scope' });
    }
    const { utm_source, utm_medium, om_a, utm_id, gclid, gbraid, wbraid, fbclid } = required.properties;
    const metadata = Object.fromEntries(Object.entries({ utm_source, utm_medium, om_a, utm_id, gclid, gbraid, wbraid, fbclid }).filter((entry): entry is [string, string] => entry[1] !== undefined));
    return { ok: true, value: { ...metadata, ...heartbeatProperties(required), ...userAgentProperty(required), ...(linkId ? { linkId } : {}), ...(campaign ? { campaignId: campaign } : {}) } };
}
/** Server-captured only after the consent gate; a browser-supplied client_user_agent is rejected by landingSchema. */
function userAgentProperty(required: { request: HttpRequest }): Record<string, string> {
    const agent = required.request.headers?.['user-agent']?.trim();
    return agent && agent.length <= 1024 ? { client_user_agent: agent } : {};
}
/** Only the transport-validated Origin can bind readiness; absent/mismatched evidence
 * drops page metadata without discarding the landing. O(u), URL <=2048 characters. */
function heartbeatProperties(required: PublicInput & { properties: z.infer<typeof landingSchema>['properties'] }): Record<string, string> {
    if (!required.properties.pageUrl) return {};
    const page = new URL(required.properties.pageUrl);
    return page.origin === required.request.headers?.origin ? { pageUrl: page.origin + page.pathname } : {};
}
/** Resolve scoped tracked links before campaign lookup; a caller campaign claim must match. */
async function linkedCampaign(required: PublicInput & { properties: z.infer<typeof landingSchema>['properties'] }): Promise<Outcome<string | undefined>> {
    const { linkId, campaignId } = required.properties;
    if (!linkId) return { ok: true, value: campaignId };
    if (!required.links.resolve) return localFailure({ message: 'Tracked link lookup unavailable' });
    const link = await required.links.resolve({ context: required.context, linkId });
    if (!link.ok) return link;
    if (campaignId && campaignId !== link.value.campaignId) return localFailure({ code: 'forbidden', message: 'Link campaign mismatch' });
    return { ok: true, value: link.value.campaignId };
}

/** A stored Jini marketing grant (cookie, policy, GPC/DNT) is required before visit/cookie/touch effects;
 * the body's literal consent is still parsed but authorises nothing. */
async function collect(required: PublicInput): Promise<HttpResponse> {
    const raw = required.request.readBody ? await required.request.readBody({}) : { ok: true as const, value: required.request.body };
    if (!raw.ok) return response({ result: raw });
    const parsed = parseBoundary({ schema: landingSchema, input: raw.value });
    if (!parsed.ok) return response({ result: parsed });
    if (parsed.value.occurredAt > required.clock.now({}) + 60000) return { status: 400, body: localFailure({ code: 'invalid_input', message: 'Landing time is in the future' }) };
    if (!marketingAllowed(required)) return { status: 403, body: localFailure({ code: 'forbidden', message: 'Visitor marketing consent required' }) };
    const properties = await landingProperties({ ...required, properties: parsed.value.properties });
    if (!properties.ok) return response({ result: properties });
    const current = await visit(required);
    if (!current.ok) return response({ result: current });
    const { consent: _consent, ...landing } = parsed.value;
    const result = await required.identity.webEvents.recordTouch({ context: required.context, event: { ...landing, properties: properties.value,
        anonymousId: current.value.anonymousId, receivedAt: required.clock.now({}), cursor: 0, traceId: required.context.traceId } });
    return { ...response({ result: result.ok ? { ok: true, value: { accepted: true } } : result, status: 202 }), headers: current.value.headers };
}
/** Small same-origin invocation wrapper; the snippet supplies only allowlisted query metadata.
 * Browser APIs are the snippet's explicit environment, never server runtime dependencies. */
function snippet(): HttpResponse {
    const source = webEventInstallSource({ collectionPath: '/c' });
    if (!source.ok) return response({ result: source });
    return { status: 200, contentType: 'text/javascript; charset=utf-8', body: source.value };
}
const fixedRoutes = new Map<string, (required: PublicInput) => HttpResponse | Promise<HttpResponse>>([
    ['GET /web-events.js', snippet], ['POST /c', collect], ['DELETE /c', withdraw],
    ['POST /consent', consentReceipt], ['GET /consent/client.min.js', consentClientScript]]);
/** Public paths only; transport enforces the local or configured public Host/Origin before parsing.
 * No owner credential, caller scope/subject or marketing permission enters this boundary.
 * @example handlePublicRequest({ request, context: serverScope, forms, identity, visits, ... });
 * @complexity Bounded body/fields, fixed route set, <=2 ID lookups and one collection write. */
export async function handlePublicRequest(required: PublicInput): Promise<HttpResponse> {
    if (required.request.path.startsWith('/hooks/agent-plugins/')) return handleMessagingWebhook({ ...required, observer: required.observer ?? { observe() {} } });
    const fixed = fixedRoutes.get(required.request.method + ' ' + required.request.path);
    if (fixed) return fixed(required);
    const slug = /^\/f\/([A-Za-z0-9_-]{1,100})$/.exec(required.request.path)?.[1];
    if (!slug) return { status: 404, body: localFailure({ code: 'invalid_input', message: 'Public route unavailable' }) };
    return required.request.method === 'GET' ? formGet({ ...required, slug }) : formPost({ ...required, slug });
}

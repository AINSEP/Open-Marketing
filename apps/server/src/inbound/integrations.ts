/** Owner-only integration HTTP boundary; authentication must precede the lazy body reader. */
import { z } from 'zod';
import { setConversionSettingsSchema, pluginSecretQuerySchema, callContextSchema, connectIntegrationTokenSchema, disconnectIntegrationSchema, digestSchema, idSchema,
    pageQuerySchema, parseBoundary } from '@open-marketing/contracts';
import type { CallContext, Outcome } from '@open-marketing/contracts';
import type { Integrations } from '../integrations.js';
import type { HttpRequest, HttpResponse } from '../ports.js';
import type { OmTools } from '../om-tool-types.js';
import { oauthCallbackPath, oauthStartSchema, oauthStatusQuerySchema } from '../integration-oauth-contracts.js';

/** Owner integration management. Trusted boot supplies authenticated scope; never take it from JSON.
 * Rechecks the principal before any body read, including direct/test callers.
 * @example handleIntegrationRequest({ request, context: authenticatedOwner, integrations });
 * @complexity Fixed route set, <=100 summaries or <=64 KiB UTF-8 token; no vendor effects.
 */
export async function handleIntegrationRequest(required: {
    request: HttpRequest; context: CallContext; integrations: Integrations; services?: { tools?: Pick<OmTools, 'dispatch'> };
}): Promise<HttpResponse> {
    const context = callContextSchema.safeParse(required.context);
    if (!context.success) return denied({ code: 'invalid_input' });
    if (context.data.principal.kind !== 'owner' || context.data.principal.ownerId !== context.data.scope.ownerId) return denied({ code: 'forbidden' });
    switch (required.request.method + ' ' + required.request.path) {
        case 'GET /api/addons/v1/integrations/conversion-settings': return conversionSettings(required);
        case 'POST /api/addons/v1/integrations/conversion-settings': return setConversionSettings(required);
        case 'GET /api/addons/v1/integrations/credential-asset': return credentialAsset(required);
        case 'POST /api/addons/v1/integrations/plugin-secret': return setPluginSecret(required);
        case 'GET /api/addons/v1/integrations/plugin-secret': return pluginSecretStatus(required);
        case 'POST /api/addons/v1/integrations/oauth/client': {
            const body = await readBody(required);
            return respond({ outcome: body.ok ? await required.integrations.setOAuthClient({ context: required.context, request: body.value }, { signal: required.request.signal }) : body });
        }
        case 'GET /api/addons/v1/integrations': return list(required);
        case 'POST /api/addons/v1/integrations/token': return token(required);
        case 'POST /api/addons/v1/integrations/disconnect': return disconnect(required);
        case 'POST /api/addons/v1/integrations/oauth/start': return startOAuth(required);
        case 'GET /api/addons/v1/integrations/oauth/status': {
            const query = parseBoundary({ schema: oauthStatusQuerySchema, input: required.request.query ?? {} });
            return respond({ outcome: query.ok ? await required.integrations.oauthStatus({ context: required.context, ...query.value }, { signal: required.request.signal }) : query });
        }
        case 'POST ' + oauthCallbackPath: {
            const body = await readBody(required);
            return respond({ outcome: body.ok ? await required.integrations.completeOAuth({ context: required.context, response: body.value }, { signal: required.request.signal }) : body });
        }
        default: return { status: 404, body: { ok: false, error: { code: 'not_implemented', message: 'Integration route unavailable', retryable: false } } };
    }
}

type IntegrationInput = Parameters<typeof handleIntegrationRequest>[0];

/** Owner HTTP read; assistant scoped reads use the same service through the tool catalog. */
async function conversionSettings(required: IntegrationInput): Promise<HttpResponse> {
    const query = parseBoundary({ schema: setConversionSettingsSchema.pick({ pluginId: true }), input: required.request.query ?? {} });
    return respond({ outcome: query.ok ? await required.integrations.conversionSettings({ context: required.context, ...query.value }, { signal: required.request.signal }) : query });
}

/** Owner replacement; the body is read only after the owner check in handleIntegrationRequest. */
async function setConversionSettings(required: IntegrationInput): Promise<HttpResponse> {
    const body = await readBody(required);
    return respond({ outcome: body.ok ? await required.integrations.setConversionSettings({ context: required.context, request: body.value }, { signal: required.request.signal }) : body });
}

/** Binary icon delivery only; specimens are never executed. CSP also confines direct SVG views. */
async function credentialAsset(required: IntegrationInput): Promise<HttpResponse> {
    const query = parseBoundary({ schema: z.strictObject({ pluginId: idSchema, digest: digestSchema }), input: required.request.query ?? {} });
    if (!query.ok) return respond({ outcome: query });
    const result = await required.integrations.credentialAsset({ context: required.context, ...query.value }, { signal: required.request.signal });
    if (!result.ok) return respond({ outcome: result });
    return { status: 200, body: Buffer.from(result.value.bytes), contentType: result.value.contentType,
        headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox; frame-ancestors 'none'" } };
}

/** Authenticated owner ingress; the service parses declared fields inside its redacted boundary. */
async function setPluginSecret(required: IntegrationInput): Promise<HttpResponse> {
    const body = await readBody(required);
    return respond({ outcome: body.ok ? await required.integrations.setPluginSecret({ context: required.context, request: body.value }, { signal: required.request.signal }) : body });
}

/** Secret-free status accepts only a plugin identity, never credential material. */
async function pluginSecretStatus(required: IntegrationInput): Promise<HttpResponse> {
    const query = parseBoundary({ schema: pluginSecretQuerySchema, input: required.request.query ?? {} });
    return respond({ outcome: query.ok ? await required.integrations.pluginSecretStatus({ context: required.context, ...query.value }, { signal: required.request.signal }) : query });
}

/** Policy owns start approval and idempotency; callback continues only its single-use state. */
async function startOAuth(required: IntegrationInput): Promise<HttpResponse> {
    const body = await readBody(required);
    if (!body.ok) return respond({ outcome: body });
    const input = parseBoundary({ schema: oauthStartSchema, input: body.value });
    if (!input.ok) return respond({ outcome: input });
    if (!required.services?.tools) return { status: 503, body: { ok: false, error: { code: 'unavailable', message: 'Sign-in policy unavailable', retryable: false } } };
    return respond({ outcome: await required.services.tools.dispatch({ context: required.context, signal: required.request.signal,
        call: { name: 'integrations_oauth_start', input: input.value, operationId: required.request.headers?.['idempotency-key'] ?? required.context.correlationId } }) });
}

/** Exact cookie-free GET only. Fixed HTML never reflects provider queries, errors or secrets. */
export async function handleOAuthBrowserCallback(required: IntegrationInput): Promise<HttpResponse> {
    if (required.request.method !== 'GET' || required.request.path !== oauthCallbackPath) return { status: 404, body: '' };
    const result = await required.integrations.completeOAuth({ context: required.context, response: required.request.query ?? {} }, { signal: required.request.signal });
    return { status: result.ok ? 200 : 400, contentType: 'text/html; charset=utf-8',
        headers: { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'none'; frame-ancestors 'none'" },
        body: result.ok ? '<!doctype html><title>Open Marketing</title><p>Sign-in saved. You can close this window.</p>'
            : '<!doctype html><title>Open Marketing</title><p>Sign-in failed or expired. Return to Open Marketing to try again.</p>' };
}

async function list(required: IntegrationInput): Promise<HttpResponse> {
    const query = parseBoundary({ schema: z.strictObject({ limit: z.string().regex(/^\d{1,3}$/).default('25').transform(Number), cursor: idSchema.optional() }).pipe(pageQuerySchema), input: required.request.query ?? {} });
    if (!query.ok) return respond({ outcome: query });
    return respond({ outcome: await required.integrations.list({ context: required.context, query: query.value }) });
}

async function token(required: IntegrationInput): Promise<HttpResponse> {
    const body = await readBody(required);
    if (!body.ok) return respond({ outcome: body });
    const parsed = parseBoundary({ schema: connectIntegrationTokenSchema, input: body.value });
    if (!parsed.ok) return respond({ outcome: parsed });
    if (Buffer.byteLength(parsed.value.plaintext) > 65536) return denied({ code: 'invalid_input' });
    return respond({ outcome: await required.integrations.connect({ context: required.context, request: parsed.value }) });
}

async function disconnect(required: IntegrationInput): Promise<HttpResponse> {
    const body = await readBody(required);
    if (!body.ok) return respond({ outcome: body });
    const parsed = parseBoundary({ schema: disconnectIntegrationSchema, input: body.value });
    if (!parsed.ok) return respond({ outcome: parsed });
    return respond({ outcome: await required.integrations.disconnect({ context: required.context, request: parsed.value }) });
}

/** Owner ingress already bounds JSON at the shared listener; redacts body-reader errors here. */
async function readBody(required: { request: HttpRequest }): Promise<Outcome<unknown>> {
    try {
        const result = required.request.readBody ? await required.request.readBody({}) : { ok: true as const, value: required.request.body };
        if (!result.ok) return { ok: false, error: { code: 'invalid_input', message: 'Invalid integration request', retryable: false } };
        return result;
    } catch { return { ok: false, error: { code: 'invalid_input', message: 'Invalid integration request', retryable: false } }; }
}

function respond(required: { outcome: Outcome<unknown> }): HttpResponse {
    if (required.outcome.ok) return { status: 200, body: required.outcome, headers: { 'cache-control': 'no-store' } };
    const status = { invalid_input: 400, unauthenticated: 401, forbidden: 403, expired: 409, conflict: 409,
        limit_exceeded: 413, unavailable: 503, not_implemented: 503, cancelled: 409, protocol_mismatch: 502 }[required.outcome.error.code];
    return { status, body: required.outcome, headers: { 'cache-control': 'no-store' } };
}

function denied(required: { code: 'forbidden' | 'invalid_input' }): HttpResponse {
    return respond({ outcome: { ok: false, error: { code: required.code, message: 'Invalid integration request or owner scope', retryable: false } } });
}

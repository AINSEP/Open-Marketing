/** Owner-only integration HTTP boundary; authentication must precede the lazy body reader. */
import { z } from 'zod';
import { callContextSchema, connectIntegrationTokenSchema, disconnectIntegrationSchema, idSchema,
    pageQuerySchema, parseBoundary } from '@open-marketing/contracts';
import type { CallContext, Outcome } from '@open-marketing/contracts';
import type { Integrations } from '../integrations.js';
import type { HttpRequest, HttpResponse } from '../ports.js';

/** Three paste-token routes. Trusted boot supplies authenticated owner scope; never take it from JSON.
 * Rechecks the principal before any body read, including direct/test callers.
 * @example handleIntegrationRequest({ request, context: authenticatedOwner, integrations });
 * @complexity Fixed route set, <=100 summaries or <=64 KiB UTF-8 token; no vendor effects.
 */
export async function handleIntegrationRequest(required: {
    request: HttpRequest; context: CallContext; integrations: Integrations;
}): Promise<HttpResponse> {
    const context = callContextSchema.safeParse(required.context);
    if (!context.success) return denied({ code: 'invalid_input' });
    if (context.data.principal.kind !== 'owner' || context.data.principal.ownerId !== context.data.scope.ownerId) return denied({ code: 'forbidden' });
    switch (required.request.method + ' ' + required.request.path) {
        case 'GET /api/addons/v1/integrations': return list(required);
        case 'POST /api/addons/v1/integrations/token': return token(required);
        case 'POST /api/addons/v1/integrations/disconnect': return disconnect(required);
        default: return { status: 404, body: { ok: false, error: { code: 'not_implemented', message: 'Integration route unavailable', retryable: false } } };
    }
}

type IntegrationInput = Parameters<typeof handleIntegrationRequest>[0];

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

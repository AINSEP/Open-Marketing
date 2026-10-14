/** Authenticated owner routes for the one add-on upload/lifecycle flow. */
import { z } from 'zod';
import { addonKindSchema, addonListRequestSchema, callContextSchema, idSchema, installAddonSchema,
    parseBoundary, setAddonEnabledSchema, uninstallAddonSchema } from '@open-marketing/contracts';
import type { CallContext, Outcome } from '@open-marketing/contracts';
import type { Addons } from '../addons.js';
import { addonFailure } from '../addons.js';
import type { HttpRequest, HttpResponse } from '../ports.js';

/** Rechecks trusted owner scope before the lazy body reader, including direct/test callers.
 * Shared listener bounds only install JSON at 48 MiB; decoded bytes remain capped at 32 MiB.
 * @example await handleAddonRequest({ request, context: authenticatedOwner, addons });
 */
export async function handleAddonRequest(required: { request: HttpRequest; context: CallContext; addons: Addons }): Promise<HttpResponse> {
    const context = callContextSchema.safeParse(required.context);
    if (!context.success) return respond({ outcome: addonFailure({ code: 'invalid_input' }) });
    if (context.data.principal.kind !== 'owner' || context.data.principal.ownerId !== context.data.scope.ownerId) return respond({ outcome: addonFailure({ code: 'forbidden' }) });
    try {
        switch (required.request.method + ' ' + required.request.path) {
            case 'GET /api/addons/v1/packages': return list(required);
            case 'POST /api/addons/v1/install': return mutation({ ...required, schema: installAddonSchema, invoke: ({ value: request }) => required.addons.install({ context: required.context, request }) });
            case 'POST /api/addons/v1/set-enabled': return mutation({ ...required, schema: setAddonEnabledSchema, invoke: ({ value: request }) => required.addons.setEnabled({ context: required.context, request }) });
            case 'POST /api/addons/v1/uninstall': return mutation({ ...required, schema: uninstallAddonSchema, invoke: ({ value: request }) => required.addons.uninstall({ context: required.context, request }) });
            default: return { status: 404, body: addonFailure({ code: 'not_implemented' }) };
        }
    } catch { return respond({ outcome: addonFailure({ code: 'unavailable' }) }); }
}

async function list(required: { request: HttpRequest; context: CallContext; addons: Addons }): Promise<HttpResponse> {
    const schema = z.strictObject({ limit: z.string().regex(/^\d{1,3}$/).default('25').transform(Number), cursor: idSchema.optional(), kind: addonKindSchema.optional() }).pipe(addonListRequestSchema);
    const parsed = parseBoundary({ schema, input: required.request.query ?? {} });
    return respond({ outcome: parsed.ok ? await required.addons.list({ context: required.context, query: parsed.value }) : parsed });
}

async function mutation<T>(required: { request: HttpRequest; schema: z.ZodType<T>; invoke(input: { value: T }): Promise<Outcome<unknown>> }): Promise<HttpResponse> {
    const body = required.request.readBody ? await required.request.readBody({}) : { ok: true as const, value: required.request.body };
    if (!body.ok) return respond({ outcome: body });
    const parsed = parseBoundary({ schema: required.schema, input: body.value });
    return respond({ outcome: parsed.ok ? await required.invoke({ value: parsed.value }) : addonFailure({ code: 'invalid_input' }) });
}

function respond(required: { outcome: Outcome<unknown> }): HttpResponse {
    if (required.outcome.ok) return { status: 200, body: required.outcome, headers: { 'cache-control': 'no-store' } };
    const status = { invalid_input: 400, unauthenticated: 401, forbidden: 403, expired: 409, conflict: 409,
        limit_exceeded: 413, unavailable: 503, not_implemented: 503, cancelled: 409, protocol_mismatch: 502 }[required.outcome.error.code];
    return { status, body: addonFailure({ code: required.outcome.error.code }), headers: { 'cache-control': 'no-store' } };
}

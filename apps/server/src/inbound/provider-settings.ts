/** Owner-only mail-provider settings; authentication precedes body/catalog/storage reads. */
import { callContextSchema, mailProviderSelectionSchema, parseBoundary } from '@open-marketing/contracts';
import type { CallContext, Outcome } from '@open-marketing/contracts';
import { getMailProviderSettings, putMailProviderSettings, type ProviderReaders } from '../alerts/index.js';
import type { HttpRequest, HttpResponse } from '../ports.js';

/** GET displays readiness; POST selects/clears a provider using authenticated server scope.
 * Unknown routes return 404. No credential access or module loading is possible here.
 * @example handleProviderSettingsRequest({ request, context, unit, addons, agentPluginState });
 * @complexity Two fixed routes; service reuses bounded catalog and connection readers.
 */
export async function handleProviderSettingsRequest(required: ProviderReaders & { request: HttpRequest; context: CallContext }): Promise<HttpResponse> {
    const context = callContextSchema.safeParse(required.context);
    if (!context.success) return denied({ code: 'invalid_input' });
    if (context.data.principal.kind !== 'owner' || context.data.principal.ownerId !== context.data.scope.ownerId) return denied({ code: 'forbidden' });
    switch (required.request.method + ' ' + required.request.path) {
        case 'GET /api/addons/v1/provider-settings/mail': return respond({ outcome: await getMailProviderSettings(required) });
        case 'POST /api/addons/v1/provider-settings/mail': {
            const body = await readBody(required);
            if (!body.ok) return respond({ outcome: body });
            const parsed = parseBoundary({ schema: mailProviderSelectionSchema, input: body.value });
            return respond({ outcome: parsed.ok ? await putMailProviderSettings({ ...required, ...parsed.value }) : parsed });
        }
        default: return { status: 404, body: { ok: false, error: { code: 'not_implemented', message: 'Provider settings route unavailable', retryable: false } } };
    }
}

/** The listener bounds JSON; opaque body-reader failures are redacted at this boundary. */
async function readBody(required: { request: HttpRequest }): Promise<Outcome<unknown>> {
    try {
        const result = required.request.readBody ? await required.request.readBody({}) : { ok: true as const, value: required.request.body };
        if (result.ok) return result;
    } catch { /* Body errors must not expose input. */ }
    return { ok: false, error: { code: 'invalid_input', message: 'Invalid provider settings request', retryable: false } };
}

function respond(required: { outcome: Outcome<unknown> }): HttpResponse {
    if (required.outcome.ok) return { status: 200, body: required.outcome, headers: { 'cache-control': 'no-store' } };
    const status = { invalid_input: 400, unauthenticated: 401, forbidden: 403, expired: 409, conflict: 409,
        limit_exceeded: 413, unavailable: 503, not_implemented: 503, cancelled: 409, protocol_mismatch: 502 }[required.outcome.error.code];
    return { status, body: required.outcome, headers: { 'cache-control': 'no-store' } };
}

function denied(required: { code: 'forbidden' | 'invalid_input' }): HttpResponse {
    return respond({ outcome: { ok: false, error: { code: required.code, message: 'Invalid provider settings request or owner scope', retryable: false } } });
}

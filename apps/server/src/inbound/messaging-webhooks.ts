/** Vendor-neutral signed callback ingress. Raw identifiers are transient; only suppression is stored. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { epochSchema, idSchema } from '@open-marketing/contracts';
import type { CallContext, ClockPort, ObserverPort } from '@open-marketing/contracts';
import type { bindIdentity } from '../composition/identity.js';
import type { bindAgentPluginBackends } from '../composition/agent-plugin-backends.js';
import { localFailure } from '../composition/local-auth.js';
import type { HttpRequest, HttpResponse } from '../ports.js';

const stopSchema = z.object({ kind: z.literal('stop'), eventId: z.string().min(1).max(544),
    channel: z.string().min(1).max(100).regex(/^[a-z][a-z0-9_-]*$/), recipient: z.string().regex(/^\+[1-9][0-9]{7,14}$/).optional() });
const batchSchema = z.object({ events: z.array(z.unknown()).max(100) });
const deliverySchema = z.object({ kind: z.literal('delivery') });
type Input = { request: HttpRequest; context: CallContext; clock: ClockPort; observer: ObserverPort;
    identity: Pick<ReturnType<typeof bindIdentity>, 'contacts' | 'policy'>;
    webhooks?: ReturnType<typeof bindAgentPluginBackends>['ingestWebhook'] };

/** Fixed replies never expose plugin/storage exceptions, identifiers or credentials. */
function failed(required: { status: number }): HttpResponse {
    return { status: required.status, body: localFailure({ message: 'Webhook unavailable' }) };
}

/** Resolve phone-bearing STOPs and append deterministic suppression through the existing lane.
 * Exact or conflicting STOP replays are safe: suppression is never removed by a callback.
 * @complexity One contact lookup and one policy append per event, <=100 sequential events. */
async function suppress(required: Input & { pluginId: string; connectionId: string; event: z.infer<typeof stopSchema> }): Promise<boolean> {
    const { event, context, identity } = required;
    if (!event.recipient) return true;
    const found = await identity.contacts.resolve({ context, identifier: { kind: 'phone', raw: event.recipient } }, { signal: required.request.signal });
    if (!found.ok) return found.error.code === 'unavailable' && found.error.message === 'Subject not found';
    const now = required.clock.now({});
    const result = await identity.policy.appendEvidence({ context, evidence: { kind: 'suppression', scope: context.scope,
        id: createHash('sha256').update([required.pluginId, required.connectionId, event.eventId].join('|')).digest('hex'),
        subjectId: found.value.subjectId, sourceId: required.pluginId, recordedAt: now,
        suppression: { channel: event.channel, start: now, end: 253402300799999 } } }, { signal: required.request.signal });
    return result.ok || result.error.code === 'conflict';
}

/** Validate the whole batch before any mutation; delivery observations are deliberately discarded.
 * A phone-less preference is acknowledged with one PII-free count, pending verified alias capture.
 * @complexity O(n) validation/space, n<=100; at most two owning-service calls per STOP. */
async function applyEvents(required: Input & { pluginId: string; connectionId: string; output: unknown }): Promise<HttpResponse> {
    const batch = batchSchema.safeParse(required.output);
    if (!batch.success) return failed({ status: 400 });
    const stops = z.array(stopSchema).max(100).safeParse(batch.data.events.filter(event => !deliverySchema.safeParse(event).success));
    if (!stops.success || !epochSchema.safeParse(required.clock.now({})).success) return failed({ status: 400 });
    const unmapped = stops.data.filter(event => !event.recipient).length;
    if (unmapped > 0) {
        try { required.observer.observe({ operation: 'server.messaging.webhook.unmapped_count', outcome: String(unmapped),
            correlationId: required.context.correlationId, traceId: required.context.traceId, runId: required.context.runId }); }
        catch { /* Telemetry cannot change a safety-increasing callback result. */ }
    }
    for (const event of stops.data) {
        if (!await suppress({ ...required, event })) return failed({ status: 503 });
    }
    return { status: 204, contentType: 'text/plain; charset=utf-8', body: '' };
}

/** Accept signed POSTs only through installed, admitted, account-bound plugin exports.
 * @returns Empty 204 after durable suppression, fixed 404 for unavailable plugins, otherwise non-2xx.
 * @example handleMessagingWebhook({ request, context, identity, clock, observer, webhooks });
 * @complexity Body<=128KiB, <=100 events; no external writes, second inbox or retries. */
export async function handleMessagingWebhook(required: Input): Promise<HttpResponse> {
    const match = /^\/hooks\/agent-plugins\/([a-z0-9]+(?:-[a-z0-9]+)*)\/([^/]{1,256})\/([^/]{1,256})$/.exec(required.request.path);
    if (!match || required.request.method !== 'POST' || !required.webhooks) return failed({ status: 404 });
    const connection = z.object({ connectionId: idSchema, accountId: idSchema }).safeParse({ connectionId: match[2], accountId: match[3] });
    if (!connection.success || Object.keys(required.request.query ?? {}).length > 0) return failed({ status: 400 });
    if (!required.request.readRawBody) return failed({ status: 400 });
    try {
        const bytes = await required.request.readRawBody({});
        if (!bytes.ok) return failed({ status: webhookStatus({ code: bytes.error.code }) });
        if (bytes.value.byteLength > 131072) return failed({ status: 413 });
        const result = await required.webhooks({ context: required.context, pluginId: match[1], connection: connection.data,
            path: required.request.path, rawBody: bytes.value, headers: required.request.headers ?? {} }, { signal: required.request.signal });
        if (!result.ok) return failed({ status: webhookStatus({ code: result.error.code }) });
        return await applyEvents({ ...required, pluginId: match[1], connectionId: connection.data.connectionId, output: result.value });
    } catch { return failed({ status: 503 }); }
}

/** Boundary codes select fixed HTTP statuses; plugin messages never cross public ingress. */
function webhookStatus(required: { code: string }): number {
    switch (required.code) {
        case 'not_implemented': return 404;
        case 'unauthenticated': return 401;
        case 'forbidden': return 403;
        case 'invalid_input': return 400;
        case 'limit_exceeded': return 413;
        default: return 503;
    }
}

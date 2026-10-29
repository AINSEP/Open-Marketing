/** Server-only offline SIGN_UP delivery; no assistant tool or implicit web-event relabeling. */
import { z } from "zod";
import { epochSchema, idSchema, scopeSchema } from "@open-marketing/contracts";
import type { CallOptions, Outcome, ServiceContext } from "@open-marketing/contracts";
import { failure, vendorId } from "./commands.js";
import { beforeEgress, boundInput, configurationSchema, requestSnapchat, resolveCredential } from "./transport.js";
import type { SnapchatCapiDependencies } from "./ports.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const eventSchema = z.strictObject({ eventId: idSchema, definitionId: idSchema, subjectId: idSchema, occurredAt: epochSchema,
  destination: idSchema, purpose: idSchema, identifiers: z.strictObject({ email: digest }), identifierDigests: z.strictObject({ email: digest }) });
const grantSchema = z.strictObject({ kind: z.literal("measurement"), grantId: idSchema, scope: scopeSchema, connectionId: idSchema,
  accountId: idSchema, definitionIds: z.array(idSchema).min(1).max(16), destination: idSchema, purpose: idSchema, payloadSchema: idSchema,
  payloadVersion: z.literal(1), expiresAt: epochSchema, revoked: z.boolean() });
const requestSchema = z.strictObject({ context: z.strictObject({ scope: scopeSchema, serviceId: idSchema, correlationId: idSchema, traceId: idSchema }),
  event: eventSchema, grant: grantSchema, deliveryId: idSchema });
const capiConfigurationSchema = configurationSchema.extend({ accountId: vendorId, mode: z.literal("production-server"),
  destination: idSchema, purpose: idSchema, payloadSchema: idSchema, pixelId: vendorId, pixelAccountId: vendorId,
  definition: z.strictObject({ id: idSchema, actionSource: z.literal("OFFLINE"), eventName: z.literal("SIGN_UP") }) });
/** Server verifies a genuinely offline definition and owned Pixel; missing mapping denies locally. */
export type SnapchatCapiConfiguration = z.infer<typeof capiConfigurationSchema>;
/** Transient contacts destination SHA-256 plus internal evidence digest; never hash or send the HMAC. */
export type SnapchatCapiRequest = z.infer<typeof requestSchema>;
/** Exact single-event payload, copied to the authority fence; occurrence remains milliseconds. */
export interface SnapchatCapiPayload { data: [{ event_name: "SIGN_UP"; event_time: number; event_id: string; action_source: "OFFLINE"; user_data: { em: [string] } }] }
/** Delivered means documented VALID acknowledgement, not attribution. */
export interface SnapchatConversionOutcome { status: "delivered" | "unknown" }
/** Reconciliation never sends, resolves credentials or infers delivery. */
export interface SnapchatCapiBackend {
  deliver(required: SnapchatCapiRequest, optional?: CallOptions): Promise<Outcome<SnapchatConversionOutcome>>;
  reconcile(required: SnapchatCapiRequest, optional?: CallOptions): Promise<Outcome<SnapchatConversionOutcome>>;
}
type Prepared = { request: SnapchatCapiRequest; configuration: SnapchatCapiConfiguration; payload: SnapchatCapiPayload; body: string };

/** Inert factory for one durable server job/event; host owns current grant/consent/outbox/audit.
 * @param required - Explicit offline mapping, authority, Pixel credential broker and I/O.
 * @returns Typed preflight denials, delivered or unknown. Unknown never authorizes resending.
 * @example createSnapchatCapiBackend({ configuration, authority, credentials, fetch, clock, observer })
 * @complexity O(b) time/space, <=64KiB input and <=16 granted definitions; one <=15s POST, zero retries.
 */
export function createSnapchatCapiBackend(required: SnapchatCapiDependencies): SnapchatCapiBackend {
  const dependencies = { ...required, configuration: structuredClone(required.configuration) };
  return {
    async deliver(input, options = {}) {
      const prepared = prepare({ dependencies, input }, options);
      if (!prepared.ok) return prepared;
      const result = await dispatch({ dependencies, prepared: prepared.value }, options);
      observe({ dependencies, context: prepared.value.request.context, result });
      return result;
    },
    async reconcile(input, options = {}) {
      const prepared = prepare({ dependencies, input }, options);
      return prepared.ok ? unknown() : prepared;
    },
  };
}
/** Bound/copy strict input and config before awaiting; no raw identifiers or unmapped events. O(b). */
function prepare(required: { dependencies: SnapchatCapiDependencies; input: SnapchatCapiRequest }, optional: CallOptions): Outcome<Prepared> {
  if (optional.signal?.aborted) return failure({ code: "cancelled" });
  const bounded = boundInput({ input: { request: required.input, configuration: required.dependencies.configuration } });
  if (!bounded.ok) return bounded;
  const parsed = z.strictObject({ request: requestSchema, configuration: capiConfigurationSchema }).safeParse(bounded.value);
  if (!parsed.success) return failure({ code: "not_implemented" });
  const { request, configuration } = parsed.data;
  const checked = checkAuthority({ request, configuration, now: required.dependencies.clock.now({}) });
  if (!checked.ok) return checked;
  const event = request.event;
  const payload: SnapchatCapiPayload = { data: [{ event_name: "SIGN_UP", action_source: "OFFLINE", event_time: event.occurredAt,
    event_id: event.eventId, user_data: { em: [event.identifiers.email] } }] };
  return { ok: true, value: { request, configuration, payload, body: JSON.stringify(payload) } };
}
/** Bind definition, destination, purpose, mode and owned Pixel; local checks never establish consent. O(k<=16). */
function checkAuthority(required: { request: SnapchatCapiRequest; configuration: SnapchatCapiConfiguration; now: number }): Outcome<void> {
  const { request, configuration, now } = required;
  if (!grantMatches(required) || configuration.pixelAccountId !== configuration.accountId) return failure({ code: "forbidden" });
  if (request.grant.revoked || now >= request.grant.expiresAt) return failure({ code: "forbidden" });
  if (!Number.isSafeInteger(now) || now < request.event.occurredAt || now - request.event.occurredAt > 7 * 86400000) return failure({ code: "expired" });
  return { ok: true, value: undefined };
}
/** Exact scoped measurement binding, including offline definition; pure O(k<=16). */
function grantMatches(required: { request: SnapchatCapiRequest; configuration: SnapchatCapiConfiguration }): boolean {
  const { request, configuration } = required, { grant, context, event } = request;
  const scopes = [configuration.scope, grant.scope].every(scope => scope.ownerId === context.scope.ownerId && scope.workspaceId === context.scope.workspaceId);
  return scopes && grant.connectionId === configuration.connectionId && grant.accountId === configuration.accountId
    && event.destination === configuration.destination && grant.destination === configuration.destination
    && event.purpose === configuration.purpose && grant.purpose === configuration.purpose && grant.payloadSchema === configuration.payloadSchema
    && event.definitionId === configuration.definition.id && grant.definitionIds.includes(event.definitionId);
}
/** Credentials resolve before current server consent/authority; callback is single-use and rechecks at fetch.
 * Copies isolate reviewed bytes. Every ambiguous post-egress result remains unknown. O(b), one POST.
 */
async function dispatch(required: { dependencies: SnapchatCapiDependencies; prepared: Prepared }, optional: CallOptions): Promise<Outcome<SnapchatConversionOutcome>> {
  const { dependencies, prepared } = required;
  let executed = false, sent = false;
  try {
    const credential = await resolveCredential({ dependencies, configuration: prepared.configuration }, optional);
    if (!credential.ok) return credential;
    return await dependencies.authority.dispatch({ ...structuredClone(prepared.request), configuration: structuredClone(prepared.configuration), payload: structuredClone(prepared.payload),
      execute: async fence => {
        if (executed) return failure({ code: "conflict" });
        executed = true;
        const current = beforeEgress({ dependencies, credential: credential.value }, optional);
        if (!current.ok) return current;
        const checked = checkAuthority({ ...prepared, now: dependencies.clock.now({}) });
        if (!checked.ok) return checked;
        if (!fence.isCurrent()) return failure({ code: "forbidden" });
        sent = true;
        const response = await requestSnapchat({ fetch: dependencies.fetch, credential: credential.value,
          request: { method: "POST", url: "https://tr.snapchat.com/v3/" + prepared.configuration.pixelId + "/events", authentication: "query", body: prepared.body } }, optional);
        if (!response.ok) return unknown();
        const accepted = response.value.status >= 200 && response.value.status < 300 && z.object({ status: z.literal("VALID") }).safeParse(response.value.body).success;
        return { ok: true, value: { status: accepted ? "delivered" : "unknown" } };
      } }, optional);
  } catch { return sent ? unknown() : failure({ code: "unavailable" }); }
}
/** Never emit URL, token, email digest or provider body. Host egress audit is authoritative. O(1). */
function observe(required: { dependencies: SnapchatCapiDependencies; context: ServiceContext; result: Outcome<SnapchatConversionOutcome> }): void {
  try { required.dependencies.observer.observe({ operation: "snapchat-ads.capi", outcome: required.result.ok ? required.result.value.status : required.result.error.code,
    correlationId: required.context.correlationId, traceId: required.context.traceId }); } catch { /* Telemetry cannot rewrite receipts. */ }
}
function unknown(): Outcome<SnapchatConversionOutcome> { return { ok: true, value: { status: "unknown" } }; }

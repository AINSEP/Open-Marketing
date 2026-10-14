import { createHash } from "node:crypto";
import { z } from "zod";
import { digestSchema, epochSchema, idSchema, measurementGrantSchema, parseBoundary, scopeSchema } from "@open-marketing/contracts";
import type { CallOptions, ClockPort, MeasurementGrant, ObserverPort, Outcome, ServiceContext } from "@open-marketing/contracts";
import { boundTikTokJson, decodeTikTokAcknowledgement, failure, tiktokUrlSchema, vendorIdSchema } from "./commands.js";
import { tiktokEventsPayloadSchema } from "./events-payload.js";
import type { TikTokEventsPayload } from "./events-payload.js";
import type { TikTokEgressPort } from "./ports.js";

export { tiktokEventsPayloadSchema } from "./events-payload.js";
export type { TikTokEventsPayload } from "./events-payload.js";

const identifiersSchema = z.strictObject({ email: digestSchema.optional(), phone: digestSchema.optional(), external_id: digestSchema.optional(), event_source_url: tiktokUrlSchema }).refine(value => value.email !== undefined || value.phone !== undefined || value.external_id !== undefined);
const eventSchema = z.strictObject({ eventId: idSchema, eventType: z.enum(["signup", "trial"]), subjectId: idSchema, occurredAt: epochSchema, destination: idSchema, purpose: idSchema, identifiers: identifiersSchema });
export const tiktokServiceContextSchema = z.strictObject({ scope: scopeSchema, serviceId: idSchema, correlationId: idSchema, traceId: idSchema });
const requestSchema = z.strictObject({ context: tiktokServiceContextSchema, event: eventSchema, grant: measurementGrantSchema, deliveryId: idSchema });
const configurationSchema = z.strictObject({ connectionId: idSchema, accountId: vendorIdSchema, pixelId: z.string().regex(/^[A-Za-z0-9_-]{1,256}$/), pluginDigest: digestSchema, destination: idSchema, purpose: idSchema, payloadSchema: idSchema, mode: z.enum(["production-server", "local-sandbox", "read-only"]) });
/** Payload fingerprint for host grant/admission metadata; conversions are backend jobs only. */
export const tiktokEventsSchemaFingerprint = createHash("sha256").update(JSON.stringify(z.toJSONSchema(tiktokEventsPayloadSchema))).digest("hex");
export type TikTokEventsConfiguration = z.infer<typeof configurationSchema>;
export interface TikTokConversionEvent { readonly eventId: string; readonly eventType: "signup" | "trial"; readonly subjectId: string; readonly occurredAt: number; readonly destination: string; readonly purpose: string; readonly identifiers: Readonly<Record<string, string>> }
export interface TikTokEventsRequest { readonly context: ServiceContext; readonly event: TikTokConversionEvent; readonly grant: MeasurementGrant; readonly deliveryId: string }
export interface TikTokConversionOutcome { readonly status: "delivered" | "unknown" }
/** Host owns current grant/consent for the exact identifiers/page/pixel payload, account,
 * scope, admission, durable delivery claim and append-only audit. Recheck after token
 * resolution through isCurrent; execute at most once under the live dispatch fence.
 * No local journals, policy grants or background worker are constructed here.
 */
export interface TikTokConversionAuthorityPort {
  dispatch(required: { context: ServiceContext; event: TikTokConversionEvent; payload: TikTokEventsPayload; grant: MeasurementGrant; deliveryId: string; configuration: TikTokEventsConfiguration; execute: (required: { isCurrent: () => boolean }) => Promise<Outcome<TikTokConversionOutcome>> }, optional?: CallOptions): Promise<Outcome<TikTokConversionOutcome>>;
}
export interface TikTokEventsBackend {
  deliver(required: TikTokEventsRequest, optional?: CallOptions): Promise<Outcome<TikTokConversionOutcome>>;
  reconcile(required: TikTokEventsRequest, optional?: CallOptions): Promise<Outcome<{ status: "unknown" }>>;
}
type Dependencies = { configuration: TikTokEventsConfiguration; authority: TikTokConversionAuthorityPort; egress: TikTokEgressPort; clock: ClockPort; observer: ObserverPort };
type Prepared = { request: z.infer<typeof requestSchema>; configuration: TikTokEventsConfiguration; payload: TikTokEventsPayload };

/** Inert backend-only delivery; no agent tool, credential construction or resend.
 * @param required - Server configuration, authority, credentialed egress, clock/observer.
 * @returns Typed acceptance/unknown, or preflight denial; delivered means request accepted only.
 * @example createTikTokEventsBackend({ configuration, authority, egress, clock, observer })
 * @complexity O(b) bounded validation/assembly, <=1MiB response; one POST, no retries.
 */
export function createTikTokEventsBackend(required: Dependencies): TikTokEventsBackend {
  const dependencies = { ...required, configuration: Object.freeze({ ...required.configuration }) };
  return { async deliver(input, options) {
    const prepared = prepare({ dependencies, input }, options);
    if (!prepared.ok) return prepared;
    return dispatch({ dependencies, prepared: prepared.value }, options);
  }, async reconcile(input, options) {
    const prepared = prepare({ dependencies, input }, options);
    if (!prepared.ok) return prepared;
    // No verified per-event receipt endpoint. Reconciliation never sends again.
    return { ok: true, value: { status: "unknown" } };
  } };
}

/** Validate atomically before authority/credentials; OM bounds event age to seven days. O(b), bounded fields. */
function prepare(required: { dependencies: Dependencies; input: TikTokEventsRequest }, optional?: CallOptions): Outcome<Prepared> {
  if (optional?.signal?.aborted) return failure({ code: "cancelled", message: "TikTok conversion cancelled before dispatch" });
  const bounded = boundTikTokJson({ input: required.input });
  if (!bounded.ok) return bounded;
  const request = parseBoundary({ schema: requestSchema, input: bounded.value });
  if (!request.ok) return request;
  const configuration = parseBoundary({ schema: configurationSchema, input: required.dependencies.configuration });
  if (!configuration.ok) return configuration;
  let now: number;
  try { now = required.dependencies.clock.now({}); }
  catch { return failure({ code: "unavailable", message: "TikTok conversion clock unavailable" }); }
  const checked = checkAuthority({ request: request.value, configuration: configuration.value, now });
  if (!checked.ok) return checked;
  const event = request.value.event;
  const { event_source_url, ...user } = event.identifiers;
  const payload: TikTokEventsPayload = { event_source: "web", event_source_id: configuration.value.pixelId, data: [{ event: event.eventType === "signup" ? "CompleteRegistration" : "StartTrial", event_time: Math.floor(event.occurredAt / 1000), event_id: event.eventId, user, page: { url: event_source_url } }] };
  return { ok: true, value: { request: request.value, configuration: configuration.value, payload } };
}

/** Local grant checks constrain dispatch; only host authority can establish current consent. O(1). */
function checkAuthority(required: { request: Prepared["request"]; configuration: TikTokEventsConfiguration; now: number }): Outcome<void> {
  const { request, configuration, now } = required;
  if (configuration.mode !== "production-server") return failure({ code: "forbidden", message: "TikTok conversions require always-on server mode" });
  if (!Number.isSafeInteger(now) || now < request.event.occurredAt || now - request.event.occurredAt > 604800000) return failure({ code: "expired", message: "TikTok event outside allowed occurrence age" });
  if (request.grant.revoked || now >= request.grant.expiresAt) return failure({ code: "forbidden", message: "TikTok measurement grant revoked or expired" });
  if (!grantMatches(required)) return failure({ code: "forbidden", message: "TikTok measurement grant binding mismatch" });
  return { ok: true, value: undefined };
}
/** Exact scope/destination/purpose/event/payload binding; no inferred consent. O(1), <=2 event types. */
function grantMatches(required: { request: Prepared["request"]; configuration: TikTokEventsConfiguration }): boolean {
  const { configuration, request } = required;
  const { grant, event, context } = request;
  return grant.scope.ownerId === context.scope.ownerId && grant.scope.workspaceId === context.scope.workspaceId && grant.connectionId === configuration.connectionId && grant.accountId === configuration.accountId && grant.destination === configuration.destination && event.destination === configuration.destination && grant.purpose === configuration.purpose && event.purpose === configuration.purpose && grant.payloadSchema === configuration.payloadSchema && grant.eventTypes.includes(event.eventType);
}

/** One authority handoff, no retry; post-egress exceptions remain unknown. O(b), one bounded POST. */
async function dispatch(required: { dependencies: Dependencies; prepared: Prepared }, optional?: CallOptions): Promise<Outcome<TikTokConversionOutcome>> {
  const { dependencies, prepared } = required;
  let handedOff = false;
  let executed = false;
  let result: Outcome<TikTokConversionOutcome>;
  try {
    result = await dependencies.authority.dispatch({ configuration: prepared.configuration, payload: prepared.payload, context: prepared.request.context, event: prepared.request.event, grant: prepared.request.grant, deliveryId: prepared.request.deliveryId, execute: async fence => {
      if (executed) return failure({ code: "conflict", message: "TikTok conversion callback already consumed" });
      executed = true;
      if (!fence.isCurrent()) return failure({ code: "forbidden", message: "TikTok conversion authority withdrawn" });
      if (optional?.signal?.aborted) return failure({ code: "cancelled", message: "TikTok conversion cancelled before egress" });
      handedOff = true;
      return send({ dependencies, prepared, isCurrent: fence.isCurrent }, optional);
    } }, optional);
  } catch { result = handedOff ? unknown() : failure({ code: "unavailable", message: "TikTok conversion authority unavailable" }); }
  const context = prepared.request.context;
  try { dependencies.observer.observe({ operation: "tiktok-ads.events", outcome: result.ok ? result.value.status : result.error.code, correlationId: context.correlationId, traceId: context.traceId }); }
  catch { /* Durable audit is host-owned; telemetry cannot rewrite an outcome. */ }
  return result;
}

/** Credentials remain inside egress; malformed/ambiguous receipts never authorize a resend. O(b). */
async function send(required: { dependencies: Dependencies; prepared: Prepared; isCurrent: () => boolean }, optional?: CallOptions): Promise<Outcome<TikTokConversionOutcome>> {
  const { request, configuration, payload } = required.prepared;
  try {
    const response = await required.dependencies.egress.send({ context: request.context, connectionId: configuration.connectionId, accountId: configuration.accountId, operationId: request.deliveryId, request: { kind: "track-event", payload }, isCurrent: required.isCurrent }, optional);
    if (!response.ok) return uncertainFailure({ response });
    return decodeTikTokAcknowledgement({ input: response.value }).ok ? { ok: true, value: { status: "delivered" } } : unknown();
  } catch { return unknown(); }
}
/** Only explicit host/preflight denials prove no effect; network loss requires reconciliation. O(1). */
export function uncertainFailure(required: { response: Extract<Outcome<unknown>, { ok: false }> }): Outcome<never> | Outcome<{ status: "unknown" }> {
  if (["unavailable", "protocol_mismatch", "cancelled", "limit_exceeded"].includes(required.response.error.code)) return unknown();
  return failure({ code: required.response.error.code, message: "TikTok dispatch denied before egress" });
}
function unknown(): Outcome<{ status: "unknown" }> { return { ok: true, value: { status: "unknown" } }; }

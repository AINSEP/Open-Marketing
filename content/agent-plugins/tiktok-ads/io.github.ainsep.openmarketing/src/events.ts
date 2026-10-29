import { createHash } from "node:crypto";
import { z } from "zod";
import { digestSchema, epochSchema, idSchema, measurementGrantSchema, moneySchema, parseBoundary, pluginConfigurationSchema, serviceContextSchema } from "@open-marketing/contracts";
import type { CallOptions, Outcome, PluginCapabilityDependencies } from "@open-marketing/contracts";
import { boundTikTokJson, decodeTikTokAcknowledgement, failure, tiktokUrlSchema, vendorIdSchema } from "./commands.js";
import { tiktokEventsPayloadSchema } from "./events-payload.js";
import type { TikTokEventsPayload } from "./events-payload.js";
import { createTikTokCredentials, createTikTokFetchEgress } from "./transport.js";

export { tiktokEventsPayloadSchema } from "./events-payload.js";
export type { TikTokEventsPayload } from "./events-payload.js";

const identifierMap = z.record(idSchema, z.string().max(2048)).refine(value => Object.keys(value).length <= 16);
const digestMap = z.record(idSchema, digestSchema).refine(value => Object.keys(value).length <= 16);
const eventSchema = z.strictObject({ eventId: idSchema, definitionId: idSchema, subjectId: idSchema, occurredAt: epochSchema, destination: idSchema, purpose: idSchema, identifiers: identifierMap, identifierDigests: digestMap, value: moneySchema.optional(), orderRef: idSchema.optional() });
const requestSchema = z.strictObject({ context: serviceContextSchema, event: eventSchema, grant: measurementGrantSchema, deliveryId: idSchema });
const configurationSchema = pluginConfigurationSchema.extend({ accountId: vendorIdSchema, settings: z.object({ conversionConfiguration: z.strictObject({ pixelId: z.string().regex(/^[A-Za-z0-9_-]{1,256}$/) }) }) });
const outcomeSchema = z.strictObject({ status: z.enum(["delivered", "unknown"]), diagnostics: z.strictObject({ accepted: z.boolean().nullable(), processed: z.boolean().nullable(), attributed: z.boolean().nullable(), observedAt: epochSchema }).optional() });
const identifiersSchema = z.object({ email: digestSchema.optional(), phone: digestSchema.optional(), external_id: digestSchema.optional(), event_source_url: tiktokUrlSchema.optional() });
const eventNames: Readonly<Record<string, "CompleteRegistration" | "StartTrial">> = { signup: "CompleteRegistration", trial: "StartTrial" };
const maxEventAgeMs = 604800000;
/** Payload fingerprint for host grant/admission metadata; conversions are backend jobs only. */
export const tiktokEventsSchemaFingerprint = createHash("sha256").update(JSON.stringify(z.toJSONSchema(tiktokEventsPayloadSchema))).digest("hex");
export type TikTokEventsConfiguration = z.infer<typeof configurationSchema>;
export type TikTokConversionEvent = z.infer<typeof eventSchema>;
export type TikTokEventsRequest = z.infer<typeof requestSchema>;
export type TikTokConversionOutcome = z.infer<typeof outcomeSchema>;
/** Host owns current grant/consent for the exact identifiers/page/pixel payload, account,
 * scope, admission, durable delivery claim and append-only audit. Recheck after token
 * resolution through isCurrent; execute at most once under the live dispatch fence.
 * No local journals, policy grants or background worker are constructed here.
 */
export interface TikTokConversionAuthorityPort {
  dispatch(required: { context: TikTokEventsRequest["context"]; event: TikTokConversionEvent; payload: TikTokEventsPayload; grant: TikTokEventsRequest["grant"]; deliveryId: string; configuration: TikTokEventsConfiguration; execute: (required: { isCurrent: () => boolean }) => Promise<Outcome<TikTokConversionOutcome>> }, optional?: CallOptions): Promise<Outcome<TikTokConversionOutcome>>;
}
export interface TikTokEventsBackend {
  deliver(required: TikTokEventsRequest, optional?: CallOptions): Promise<Outcome<TikTokConversionOutcome>>;
  reconcile(required: TikTokEventsRequest, optional?: CallOptions): Promise<Outcome<TikTokConversionOutcome>>;
}
type Dependencies = PluginCapabilityDependencies & { authority: TikTokConversionAuthorityPort };
type Prepared = { request: z.infer<typeof requestSchema>; configuration: TikTokEventsConfiguration; payload: TikTokEventsPayload };

/** Inert backend-only delivery; no agent tool, credential construction or resend.
 * @param required - Canonical configuration and injected authority, credentials, fetch, clock/observer.
 * @returns Typed acceptance/unknown, or preflight denial; delivered means request accepted only.
 * @example createConversionDelivery(dependencies).deliver({ context, event, grant, deliveryId })
 * @complexity O(b) bounded validation/assembly, <=1MiB response; one POST, no retries.
 */
export function createConversionDelivery(required: PluginCapabilityDependencies & { authority: TikTokConversionAuthorityPort }): TikTokEventsBackend {
  const configuration = parseBoundary({ schema: configurationSchema, input: required.configuration });
  return { async deliver(input, options) {
    const prepared = prepareConversion({ dependencies: required, configuration, input }, options);
    if (!prepared.ok) return prepared;
    return dispatch({ dependencies: required, prepared: prepared.value }, options);
  }, async reconcile(input, options) {
    const prepared = prepareConversion({ dependencies: required, configuration, input }, options);
    if (!prepared.ok) return prepared;
    // No verified per-event receipt endpoint. Reconciliation never sends again.
    return { ok: true, value: { status: "unknown" } };
  } };
}

/** Validate atomically before authority/credentials; OM bounds event age to seven days. O(b), bounded fields. */
function prepareConversion(required: { dependencies: Dependencies; configuration: Outcome<TikTokEventsConfiguration>; input: TikTokEventsRequest }, optional?: CallOptions): Outcome<Prepared> {
  if (optional?.signal?.aborted) return failure({ code: "cancelled", message: "TikTok conversion cancelled before dispatch" });
  if (!required.configuration.ok) return required.configuration;
  const bounded = boundTikTokJson({ input: required.input });
  if (!bounded.ok) return bounded;
  const request = parseBoundary({ schema: requestSchema, input: bounded.value });
  if (!request.ok) return request;
  const configuration = required.configuration.value;
  let now: number;
  try { now = required.dependencies.clock.now({}); }
  catch { return failure({ code: "unavailable", message: "TikTok conversion clock unavailable" }); }
  const checked = checkConversionAuthority({ request: request.value, configuration, now });
  if (!checked.ok) return checked;
  const payload = mapPayload({ event: request.value.event, configuration });
  if (!payload.ok) return payload;
  return { ok: true, value: { request: request.value, configuration, payload: payload.value } };
}

/** Project consented contacts data onto TikTok's keys, then strictly validate one web event.
 * Phone is the E.164 plus-form hash; money uses its currency's minor-unit exponent. O(1) time/space.
 */
function mapPayload(required: { event: TikTokConversionEvent; configuration: TikTokEventsConfiguration }): Outcome<TikTokEventsPayload> {
  const { event, configuration } = required;
  const eventName = Object.hasOwn(eventNames, event.definitionId) ? eventNames[event.definitionId] : undefined;
  if (!eventName) return failure({ code: "invalid_input", message: "TikTok conversion not sent: no supported TikTok event for this definition" });
  const identifiers = identifiersSchema.safeParse(event.identifiers);
  if (!identifiers.success) return failure({ code: "invalid_input", message: "TikTok conversion not sent: invalid supported identifier or event_source_url" });
  const { event_source_url, ...user } = identifiers.data;
  if (!event_source_url || !(user.email || user.phone || user.external_id)) return failure({ code: "invalid_input", message: "TikTok web event not sent: missing event_source_url or a supported identifier" });
  const properties = event.value === undefined ? undefined : { value: event.value.minorUnits / 10 ** new Intl.NumberFormat("en", { style: "currency", currency: event.value.currency }).resolvedOptions().maximumFractionDigits!, currency: event.value.currency };
  return parseBoundary({ schema: tiktokEventsPayloadSchema, input: { event_source: "web", event_source_id: configuration.settings.conversionConfiguration.pixelId, data: [{ event: eventName, event_time: Math.floor(event.occurredAt / 1000), event_id: event.eventId, user, page: { url: event_source_url }, ...(properties === undefined ? {} : { properties }) }] } });
}

/** Local grant checks constrain dispatch; only host authority can establish current consent. O(1). */
function checkConversionAuthority(required: { request: Prepared["request"]; configuration: TikTokEventsConfiguration; now: number }): Outcome<void> {
  const { request, configuration, now } = required;
  if (!Number.isSafeInteger(now) || now < request.event.occurredAt || now - request.event.occurredAt > maxEventAgeMs) return failure({ code: "expired", message: "TikTok event outside allowed occurrence age" });
  if (request.grant.revoked || now >= request.grant.expiresAt) return failure({ code: "forbidden", message: "TikTok measurement grant revoked or expired" });
  if (!grantMatches(required)) return failure({ code: "forbidden", message: "TikTok measurement grant binding mismatch" });
  return { ok: true, value: undefined };
}
/** Configuration, service and grant share a scope; bind account/definition/purpose. O(k), k<=16. */
function grantMatches(required: { request: Prepared["request"]; configuration: TikTokEventsConfiguration }): boolean {
  const { configuration, request } = required;
  const { grant, event, context } = request;
  const scopeMatches = configuration.scope.ownerId === context.scope.ownerId && configuration.scope.workspaceId === context.scope.workspaceId
    && grant.scope.ownerId === context.scope.ownerId && grant.scope.workspaceId === context.scope.workspaceId;
  return scopeMatches && grant.connectionId === configuration.connectionId && grant.accountId === configuration.accountId
    && grant.destination === event.destination && grant.purpose === event.purpose && grant.definitionIds.includes(event.definitionId);
}

/** One authority handoff, no retry; post-egress exceptions remain unknown. O(b), one bounded POST. */
async function dispatch(required: { dependencies: Dependencies; prepared: Prepared }, optional?: CallOptions): Promise<Outcome<TikTokConversionOutcome>> {
  const { dependencies, prepared } = required;
  let handedOff = false;
  let executed = false;
  let result: Outcome<TikTokConversionOutcome>;
  try {
    result = await dependencies.authority.dispatch({ ...prepared.request, configuration: prepared.configuration, payload: prepared.payload, execute: async fence => {
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
  const dependencies = required.dependencies;
  try {
    const egress = createTikTokFetchEgress({ fetch: dependencies.fetch, credentials: createTikTokCredentials(dependencies), observer: dependencies.observer });
    const response = await egress.send({ context: request.context, connectionId: configuration.connectionId, accountId: configuration.accountId, operationId: request.deliveryId, request: { kind: "track-event", payload }, isCurrent: required.isCurrent }, optional);
    if (!response.ok) return uncertainFailure({ response });
    return decodeTikTokAcknowledgement({ input: response.value }).ok ? { ok: true, value: { status: "delivered", diagnostics: { accepted: true, processed: null, attributed: null, observedAt: dependencies.clock.now({}) } } } : unknown();
  } catch { return unknown(); }
}
/** Only explicit host/preflight denials prove no effect; network loss requires reconciliation. O(1). */
export function uncertainFailure(required: { response: Extract<Outcome<unknown>, { ok: false }> }): Outcome<never> | Outcome<{ status: "unknown" }> {
  if (["unavailable", "protocol_mismatch", "cancelled", "limit_exceeded"].includes(required.response.error.code)) return unknown();
  return failure({ code: required.response.error.code, message: "TikTok dispatch denied before egress" });
}
function unknown(): Outcome<{ status: "unknown" }> { return { ok: true, value: { status: "unknown" } }; }

import { z } from "zod";
import { digestSchema, epochSchema, idSchema, measurementGrantSchema, scopeSchema } from "@open-marketing/contracts";
import type { CallOptions, ClockPort, MeasurementGrant, ObserverPort, Outcome, ServiceContext } from "@open-marketing/contracts";
import { boundedJson, failure, isUncertainFailure, parse } from "./boundary.js";
import { identifiersSchema, normalizeMetaIdentifiers } from "./capi-normalization.js";
import type { MetaUserData } from "./capi-normalization.js";
import { vendorIdSchema } from "./commands.js";

const serviceContext = z.strictObject({ scope: scopeSchema, serviceId: idSchema, correlationId: idSchema, traceId: idSchema });
const eventSchema = z.strictObject({ eventId: idSchema, eventType: z.enum(["signup", "trial"]), subjectId: idSchema, occurredAt: epochSchema, destination: idSchema, purpose: idSchema, identifiers: identifiersSchema });
const requestSchema = z.strictObject({ context: serviceContext, event: eventSchema, grant: measurementGrantSchema, deliveryId: idSchema });
const configurationSchema = z.strictObject({ connectionId: idSchema, accountId: vendorIdSchema, pixelId: vendorIdSchema, apiVersion: z.string().regex(/^v[1-9][0-9]{0,2}\.[0-9]{1,2}$/), pluginDigest: digestSchema, destination: idSchema, purpose: idSchema, payloadSchema: idSchema, mode: z.enum(["production-server", "local-sandbox", "read-only"]), timeoutMs: z.number().int().min(1).max(60000), maxEventAgeMs: z.number().int().min(1000).max(604800000) });
export type MetaCapiConfiguration = z.infer<typeof configurationSchema>;
/** Structurally compatible with measure ConversionInput/ConversionDeliveryPort. Backend-only. */
export interface MetaConversionInput { readonly eventId: string; readonly eventType: "signup" | "trial"; readonly subjectId: string; readonly occurredAt: number; readonly destination: string; readonly purpose: string; readonly identifiers: Readonly<Record<string, string>> }
export interface MetaCapiRequest { readonly context: ServiceContext; readonly event: MetaConversionInput; readonly grant: MeasurementGrant; readonly deliveryId?: string }
export interface MetaCapiPayload { readonly data: readonly { readonly event_name: "CompleteRegistration" | "StartTrial"; readonly event_time: number; readonly event_id: string; readonly action_source: "website"; readonly event_source_url: string; readonly user_data: MetaUserData }[] }
export interface MetaConversionOutcome { readonly status: "delivered" | "unknown" }

/** Server fence MUST read current grant/consent for all identifier keys, verify scope/connection/dataset,
 * capability/API-version admission, enforce production-server mode, append pre-egress audit, and
 * keep authority through execute. Jobs/measure own durable dedupe; this plugin adds no outbox.
 */
export interface MetaConversionAuthorityPort {
  dispatch(required: { context: ServiceContext; event: MetaConversionInput; grant: MeasurementGrant; deliveryId: string; configuration: MetaCapiConfiguration; execute: (required: { isCurrent: () => boolean }) => Promise<Outcome<MetaConversionOutcome>> }, optional?: CallOptions): Promise<Outcome<MetaConversionOutcome>>;
}
/** Guarded server credentialed I/O. Recheck isCurrent AFTER credential resolution, immediately before
 * POST; enforce byte/timeout/cancellation limits and never redirect credentials or retry implicitly.
 * The endpoint is plugin-constructed; credentials are injected by the server, never present in payload.
 */
export interface MetaCapiEgressPort {
  send(required: { context: ServiceContext; connectionId: string; operationId: string; endpoint: string; payload: MetaCapiPayload; timeoutMs: number; isCurrent: () => boolean }, optional?: CallOptions): Promise<Outcome<unknown>>;
}
export interface MetaCapiBackend {
  deliver(required: MetaCapiRequest, optional?: CallOptions): Promise<Outcome<MetaConversionOutcome>>;
  reconcile(required: MetaCapiRequest, optional?: CallOptions): Promise<Outcome<MetaConversionOutcome>>;
}
interface Dependencies { configuration: MetaCapiConfiguration; authority: MetaConversionAuthorityPort; egress: MetaCapiEgressPort; clock: ClockPort; observer: ObserverPort }
type ParsedRequest = z.infer<typeof requestSchema>;

/** Typed CAPI backend, never an agent/MCP tool. One occurrence ID survives retries and channel dedupe.
 * @param required - Pinned dataset/version, injected server authority, credentialed egress, clock/observer.
 * @returns Inert delivery/reconciliation seam. Timeout or ambiguous ACK returns unknown without retry.
 * @example createMetaCapiBackend({ configuration, authority, egress, clock, observer })
 * @complexity O(n) bounded normalization, one POST, no batch fan-out or internal retry/store.
 */
export function createMetaCapiBackend(required: Dependencies): MetaCapiBackend {
  const dependencies: Dependencies = { ...required, configuration: Object.freeze({ ...required.configuration }) };
  return { async deliver(input, options) {
    const prepared = prepareConversion({ dependencies, input }, options);
    if (!prepared.ok) return prepared;
    return dispatchConversion({ dependencies, request: prepared.value.request, payload: prepared.value.payload }, options);
  }, async reconcile(input, options) {
    const prepared = prepareConversion({ dependencies, input }, options);
    if (!prepared.ok) return prepared;
    // CAPI has no verified per-event readback here. Never resend as reconciliation.
    return { ok: true, value: { status: "unknown" } };
  } };
}

/** Validate full request atomically before any authority/egress callback. @complexity O(n), bounded <=16KiB. */
function prepareConversion(required: { dependencies: Dependencies; input: MetaCapiRequest }, optional?: CallOptions): Outcome<{ request: ParsedRequest; payload: MetaCapiPayload }> {
  if (optional?.signal?.aborted) return failure({ code: "cancelled", message: "Meta conversion cancelled before dispatch" });
  const configuration = parse({ schema: configurationSchema, input: required.dependencies.configuration });
  if (!configuration.ok) return configuration;
  const bounded = boundedJson({ input: required.input, maxBytes: 16384 });
  if (!bounded.ok) return bounded;
  const request = parse({ schema: requestSchema, input: bounded.value });
  if (!request.ok) return request;
  const checked = checkConversionAuthority({ configuration: configuration.value, request: request.value, now: required.dependencies.clock.now({}) });
  if (!checked.ok) return checked;
  const normalized = normalizeMetaIdentifiers({ input: request.value.event.identifiers });
  if (!normalized.ok) return normalized;
  const event = request.value.event;
  const eventName = event.eventType === "signup" ? "CompleteRegistration" : "StartTrial";
  const payload: MetaCapiPayload = { data: [{ event_name: eventName, event_time: Math.floor(event.occurredAt / 1000), event_id: event.eventId, action_source: "website", event_source_url: normalized.value.sourceUrl, user_data: normalized.value.userData }] };
  return { ok: true, value: { request: request.value, payload } };
}

/** Local checks add constraints; only the server fence can establish CURRENT consent or authority.
 * maxEventAgeMs is OM's conservative bound, not a verified promise of Meta acceptance. @complexity O(1).
 */
function checkConversionAuthority(required: { configuration: MetaCapiConfiguration; request: ParsedRequest; now: number }): Outcome<void> {
  const { configuration, request, now } = required;
  const grant = request.grant;
  if (configuration.mode !== "production-server") return failure({ code: "forbidden", message: "Meta production conversions require always-on server mode" });
  if (!Number.isSafeInteger(now) || now < request.event.occurredAt || now - request.event.occurredAt > configuration.maxEventAgeMs) return failure({ code: "expired", message: "Meta conversion occurrence outside allowed age" });
  if (grant.revoked || now >= grant.expiresAt) return failure({ code: "forbidden", message: "Meta measurement grant revoked or expired" });
  if (!grantMatches({ configuration, request })) return failure({ code: "forbidden", message: "Meta measurement grant binding mismatch" });
  return { ok: true, value: undefined };
}

/** Every scope, destination, event type and payload pin must agree. @complexity O(1), <=2 grant event types. */
function grantMatches(required: { configuration: MetaCapiConfiguration; request: ParsedRequest }): boolean {
  const { configuration, request } = required;
  const { grant, event, context } = request;
  return grant.scope.ownerId === context.scope.ownerId && grant.scope.workspaceId === context.scope.workspaceId && grant.connectionId === configuration.connectionId && grant.accountId === configuration.accountId && grant.destination === configuration.destination && event.destination === configuration.destination && grant.purpose === configuration.purpose && event.purpose === configuration.purpose && grant.payloadSchema === configuration.payloadSchema && grant.eventTypes.includes(event.eventType);
}

/** Preserve uncertainty if an authority callback throws after handoff; no second send. @complexity O(n), one fenced call. */
async function dispatchConversion(required: { dependencies: Dependencies; request: ParsedRequest; payload: MetaCapiPayload }, optional?: CallOptions): Promise<Outcome<MetaConversionOutcome>> {
  const { dependencies, request } = required;
  let handedOff = false;
  let result: Outcome<MetaConversionOutcome>;
  try {
    result = await dependencies.authority.dispatch({ context: request.context, event: request.event, grant: request.grant, deliveryId: request.deliveryId, configuration: dependencies.configuration, execute: async fence => {
      if (!fence.isCurrent()) return failure({ code: "forbidden", message: "Meta conversion authority withdrawn" });
      if (optional?.signal?.aborted) return failure({ code: "cancelled", message: "Meta conversion cancelled before egress" });
      handedOff = true;
      return sendConversion({ ...required, isCurrent: fence.isCurrent }, optional);
    } }, optional);
  } catch {
    result = handedOff ? { ok: true, value: { status: "unknown" } } : failure({ code: "unavailable", message: "Meta conversion authority unavailable" });
  }
  observeConversion({ dependencies, request, result });
  return result;
}

/** Guarded egress with stable operation/event IDs; raw response errors never escape. @complexity One bounded POST/O(n) ACK parsing. */
async function sendConversion(required: { dependencies: Dependencies; request: ParsedRequest; payload: MetaCapiPayload; isCurrent: () => boolean }, optional?: CallOptions): Promise<Outcome<MetaConversionOutcome>> {
  const { dependencies, request } = required;
  const configuration = dependencies.configuration;
  try {
    const response = await dependencies.egress.send({ context: request.context, connectionId: configuration.connectionId, operationId: request.deliveryId, endpoint: `https://graph.facebook.com/${configuration.apiVersion}/${configuration.pixelId}/events`, payload: required.payload, timeoutMs: configuration.timeoutMs, isCurrent: required.isCurrent }, optional);
    if (!response.ok) return capiFailure({ response });
    return decodeMetaCapiAcknowledgement({ input: response.value });
  } catch { return { ok: true, value: { status: "unknown" } }; }
}

/** Only a typed preflight denial proves no egress; transport loss leaves delivery unknown. @complexity O(1). */
function capiFailure(required: { response: Extract<Outcome<unknown>, { ok: false }> }): Outcome<MetaConversionOutcome> {
  if (isUncertainFailure({ error: required.response.error })) return { ok: true, value: { status: "unknown" } };
  return required.response;
}

/** Only a validated single-event ACK means delivered; malformed/partial acknowledgements stay unknown.
 * @example decodeMetaCapiAcknowledgement({ input: { events_received: 1, fbtrace_id: "fixture" } })
 * @complexity O(n) time/space, <=16KiB response. No provider reconciliation is invented.
 */
export function decodeMetaCapiAcknowledgement(required: { input: unknown }): Outcome<MetaConversionOutcome> {
  const bounded = boundedJson({ input: required.input, maxBytes: 16384 });
  if (!bounded.ok) return { ok: true, value: { status: "unknown" } };
  const schema = z.strictObject({ events_received: z.literal(1), fbtrace_id: idSchema.optional(), messages: z.array(z.string().max(1024)).max(10).optional() });
  const parsed = schema.safeParse(bounded.value);
  return { ok: true, value: { status: parsed.success ? "delivered" : "unknown" } };
}

/** Redacted conversion telemetry; failure cannot erase a vendor receipt or authorize a resend. @complexity O(1). */
function observeConversion(required: { dependencies: Dependencies; request: ParsedRequest; result: Outcome<MetaConversionOutcome> }): void {
  const context = required.request.context;
  const outcome = required.result.ok ? required.result.value.status : required.result.error.code;
  try { required.dependencies.observer.observe({ operation: "meta-ads.capi", outcome, correlationId: context.correlationId, traceId: context.traceId }); }
  catch { /* Host durable audit retains the authoritative result. */ }
}

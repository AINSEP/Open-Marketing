import { z } from "zod";
import { digestSchema, epochSchema, idSchema, measurementGrantSchema, moneySchema, pluginConfigurationSchema, serviceContextSchema } from "@open-marketing/contracts";
import type { CallOptions, Outcome, PluginCapabilityDependencies } from "@open-marketing/contracts";
import { boundedJson, digest, failure, parse } from "./boundary.js";
import { mapMetaIdentifiers } from "./capi-normalization.js";
import type { MetaUserData } from "./capi-normalization.js";
import { vendorIdSchema } from "./commands.js";
import { adsGraphVersion, bindDispatch } from "./instagram-fetch.js";

const identifierMap = z.record(idSchema, z.string().max(2048)).refine(value => Object.keys(value).length <= 16);
const digestMap = z.record(idSchema, digestSchema).refine(value => Object.keys(value).length <= 16);
const eventSchema = z.strictObject({ eventId: idSchema, definitionId: idSchema, subjectId: idSchema, occurredAt: epochSchema, destination: idSchema, purpose: idSchema, identifiers: identifierMap, identifierDigests: digestMap, value: moneySchema.optional(), orderRef: idSchema.optional() });
const requestSchema = z.strictObject({ context: serviceContextSchema, event: eventSchema, grant: measurementGrantSchema, deliveryId: idSchema });
const configurationSchema = pluginConfigurationSchema.extend({ accountId: vendorIdSchema, settings: z.object({ conversionConfiguration: z.strictObject({ datasetId: vendorIdSchema }) }) });
const outcomeSchema = z.strictObject({ status: z.enum(["delivered", "unknown"]), diagnostics: z.strictObject({ accepted: z.boolean().nullable(), processed: z.boolean().nullable(), attributed: z.boolean().nullable(), observedAt: epochSchema }).optional() });
const eventNames: Readonly<Record<string, "CompleteRegistration" | "StartTrial">> = { signup: "CompleteRegistration", trial: "StartTrial" };
const maxEventAgeMs = 7 * 86400000;
export type MetaCapiConfiguration = z.infer<typeof configurationSchema>;
export type MetaConversionInput = z.infer<typeof eventSchema>;
export type MetaCapiRequest = z.infer<typeof requestSchema>;
export type MetaConversionOutcome = z.infer<typeof outcomeSchema>;
/** One website event per POST; contacts owns hashes and eventId supplies vendor deduplication. */
export interface MetaCapiPayload { readonly data: readonly { readonly event_name: "CompleteRegistration" | "StartTrial"; readonly event_time: number; readonly event_id: string; readonly action_source: "website"; readonly event_source_url: string; readonly user_data: MetaUserData; readonly custom_data?: { readonly value: number; readonly currency: string } }[] }
/** The server owns current consent, halt, production mode, durable dispatch and egress audit. */
export interface MetaConversionAuthorityPort {
  dispatch(required: { context: MetaCapiRequest["context"]; event: MetaConversionInput; payload: MetaCapiPayload; grant: MetaCapiRequest["grant"]; deliveryId: string; configuration: MetaCapiConfiguration; execute: (required: { isCurrent: () => boolean }) => Promise<Outcome<MetaConversionOutcome>> }, optional?: CallOptions): Promise<Outcome<MetaConversionOutcome>>;
}
export interface MetaCapiBackend {
  deliver(required: MetaCapiRequest, optional?: CallOptions): Promise<Outcome<MetaConversionOutcome>>;
  reconcile(required: MetaCapiRequest, optional?: CallOptions): Promise<Outcome<MetaConversionOutcome>>;
}
type Dependencies = PluginCapabilityDependencies & { authority: MetaConversionAuthorityPort };
type Prepared = { request: MetaCapiRequest; configuration: MetaCapiConfiguration; payload: MetaCapiPayload };

/** Bind A3 dependencies without I/O. Send at most one website event; reconciliation never resends.
 * @param required - Canonical configuration and injected server authority, credentials, fetch and clock.
 * @returns Typed delivery/reconciliation; invalid inputs refuse before credentials, lost ACKs stay unknown.
 * @example createConversionDelivery(dependencies).deliver({ context, event, grant, deliveryId })
 * @complexity O(b) bounded parsing/space (16 KiB); one <=15s POST, no retry or local journal.
 */
export function createConversionDelivery(required: Dependencies): MetaCapiBackend {
  const configuration = parse({ schema: configurationSchema, input: required.configuration });
  return { async deliver(input, options) {
    const prepared = prepareConversion({ configuration, input, now: required.clock.now({}) }, options);
    if (!prepared.ok) return prepared;
    const result = await dispatchConversion({ dependencies: required, prepared: prepared.value }, options);
    observeConversion({ dependencies: required, request: prepared.value.request, result });
    return result;
  }, async reconcile(input, options) {
    const prepared = prepareConversion({ configuration, input, now: required.clock.now({}) }, options);
    if (!prepared.ok) return prepared;
    return { ok: true, value: { status: "unknown" } };
  } };
}

/** Parse one immutable request and map only supported website events before any effect. O(b), <=16KiB. */
function prepareConversion(required: { configuration: Outcome<MetaCapiConfiguration>; input: MetaCapiRequest; now: number }, optional?: CallOptions): Outcome<Prepared> {
  if (optional?.signal?.aborted) return failure({ code: "cancelled", message: "Meta conversion cancelled before dispatch" });
  if (!required.configuration.ok) return required.configuration;
  const bounded = boundedJson({ input: required.input, maxBytes: 16384 });
  if (!bounded.ok) return bounded;
  const request = parse({ schema: requestSchema, input: bounded.value });
  if (!request.ok) return request;
  const configuration = required.configuration.value;
  const checked = checkConversionAuthority({ configuration, request: request.value, now: required.now });
  if (!checked.ok) return checked;
  const payload = mapPayload({ event: request.value.event });
  if (!payload.ok) return payload;
  return { ok: true, value: { configuration, request: request.value, payload: payload.value } };
}

/** No invented Meta lead origin or website metadata; money is converted from its currency's minor units. O(1). */
function mapPayload(required: { event: MetaConversionInput }): Outcome<MetaCapiPayload> {
  const { event } = required;
  const eventName = Object.hasOwn(eventNames, event.definitionId) ? eventNames[event.definitionId] : undefined;
  if (!eventName) return failure({ code: "invalid_input", message: "Meta conversion not sent: no supported Meta event for this definition (Conversion Leads requires a Meta lead-ad lead_id)" });
  if (!event.identifiers.client_user_agent || !event.identifiers.event_source_url) return failure({ code: "invalid_input", message: "Meta website event not sent: missing required client_user_agent or event_source_url" });
  const mapped = mapMetaIdentifiers({ input: event.identifiers });
  if (!mapped.ok) return mapped;
  if (Number(event.identifiers.click_time_ms ?? 0) > event.occurredAt) return failure({ code: "invalid_input", message: "Meta click time follows conversion occurrence" });
  const customData = event.value === undefined ? undefined : { value: event.value.minorUnits / 10 ** new Intl.NumberFormat("en", { style: "currency", currency: event.value.currency }).resolvedOptions().maximumFractionDigits!, currency: event.value.currency };
  return { ok: true, value: { data: [{ event_name: eventName, event_time: Math.floor(event.occurredAt / 1000), event_id: event.eventId, action_source: "website", event_source_url: mapped.value.sourceUrl, user_data: mapped.value.userData, ...(customData === undefined ? {} : { custom_data: customData }) }] } };
}

/** Local constraints cannot establish current consent; the injected server fence remains authoritative. O(1). */
function checkConversionAuthority(required: { configuration: MetaCapiConfiguration; request: MetaCapiRequest; now: number }): Outcome<void> {
  const { configuration, request, now } = required;
  if (!Number.isSafeInteger(now) || now < request.event.occurredAt || now - request.event.occurredAt > maxEventAgeMs) return failure({ code: "expired", message: "Meta conversion occurrence outside allowed age" });
  if (request.grant.revoked || now >= request.grant.expiresAt) return failure({ code: "forbidden", message: "Meta measurement grant revoked or expired" });
  if (!grantMatches({ configuration, request })) return failure({ code: "forbidden", message: "Meta measurement grant binding mismatch" });
  return { ok: true, value: undefined };
}

/** Configuration, service and grant share one scope; grant binds connection/account/definition/purpose. O(k), k<=16. */
function grantMatches(required: { configuration: MetaCapiConfiguration; request: MetaCapiRequest }): boolean {
  const { configuration, request } = required;
  const { grant, event, context } = request;
  const scopeMatches = configuration.scope.ownerId === context.scope.ownerId && configuration.scope.workspaceId === context.scope.workspaceId
    && grant.scope.ownerId === context.scope.ownerId && grant.scope.workspaceId === context.scope.workspaceId;
  return scopeMatches && grant.connectionId === configuration.connectionId && grant.accountId === configuration.accountId
    && grant.destination === event.destination && grant.purpose === event.purpose && grant.definitionIds.includes(event.definitionId);
}

/** Preserve uncertainty if authority throws after handoff; no implicit second send. O(1), one fenced call. */
async function dispatchConversion(required: { dependencies: Dependencies; prepared: Prepared }, optional?: CallOptions): Promise<Outcome<MetaConversionOutcome>> {
  const { dependencies, prepared } = required;
  let handedOff = false;
  try {
    return await dependencies.authority.dispatch({ ...prepared.request, configuration: prepared.configuration, payload: prepared.payload, execute: async ({ isCurrent }) => {
      if (!isCurrent()) return failure({ code: "forbidden", message: "Meta conversion authority withdrawn" });
      if (optional?.signal?.aborted) return failure({ code: "cancelled", message: "Meta conversion cancelled before egress" });
      handedOff = true;
      return sendConversion({ ...required, isCurrent }, optional);
    } }, optional);
  } catch { return handedOff ? { ok: true, value: { status: "unknown" } } : failure({ code: "unavailable", message: "Meta conversion authority unavailable" }); }
}

/** Reuse credentialed Graph dispatch; its fetch wrapper checks the fence AFTER credential resolution.
 * Definite pre-send refusals pass through; uncertain transport/ACK never claims processing. O(b), one <=15s POST.
 */
async function sendConversion(required: { dependencies: Dependencies; prepared: Prepared; isCurrent: () => boolean }, optional?: CallOptions): Promise<Outcome<MetaConversionOutcome>> {
  const { dependencies, prepared } = required;
  let refusal: Outcome<never> | undefined;
  const dispatch = bindDispatch({ accountId: prepared.configuration.accountId, dependencies: { ...dependencies, fetch: async (url, options) => {
    if (!required.isCurrent()) refusal = failure({ code: "forbidden", message: "Meta conversion authority withdrawn" });
    if (options?.signal?.aborted) refusal = failure({ code: "cancelled", message: "Meta conversion cancelled before egress" });
    if (refusal) throw new Error("Meta conversion not sent");
    return dependencies.fetch(url, options);
  } } });
  const operationId = prepared.request.deliveryId;
  const configuration = prepared.configuration;
  const argumentsDigest = digest({ value: prepared.payload });
  const response = await dispatch({ context: { ...prepared.request.context, principal: { kind: "service", serviceId: prepared.request.context.serviceId } }, connectionId: configuration.connectionId, operationId,
    effect: { operationId, connectionId: configuration.connectionId, accountId: configuration.accountId, effects: ["conversion"], argumentsDigest, moneyExposure: null, requiredLimit: null },
    request: { method: "POST", endpoint: `https://graph.facebook.com/${adsGraphVersion}/${configuration.settings.conversionConfiguration.datasetId}/events`, parameters: { data: JSON.stringify(prepared.payload.data) } }, timeoutMs: 15000,
  }, optional);
  if (refusal) return refusal;
  if (!response.ok) return response.error.code === "cancelled" || response.error.code === "forbidden" ? response : { ok: true, value: { status: "unknown" } };
  const decoded = decodeMetaCapiAcknowledgement({ input: response.value });
  if (!decoded.ok || decoded.value.status !== "delivered") return decoded;
  return { ok: true, value: { status: "delivered", diagnostics: { accepted: true, processed: null, attributed: null, observedAt: dependencies.clock.now({}) } } };
}

/** Only a validated single-event ACK means accepted; partial/malformed responses remain unknown.
 * @example decodeMetaCapiAcknowledgement({ input: { events_received: 1 } })
 * @complexity O(b) time/space, <=16KiB; no vendor readback or processing inference.
 */
export function decodeMetaCapiAcknowledgement(required: { input: unknown }): Outcome<MetaConversionOutcome> {
  const bounded = boundedJson({ input: required.input, maxBytes: 16384 });
  if (!bounded.ok) return { ok: true, value: { status: "unknown" } };
  const schema = z.strictObject({ events_received: z.literal(1), fbtrace_id: idSchema.optional(), messages: z.array(z.string().max(1024)).max(10).optional() });
  const parsed = schema.safeParse(bounded.value);
  return { ok: true, value: { status: parsed.success ? "delivered" : "unknown" } };
}

/** Context IDs/outcomes only; telemetry failure cannot erase a vendor receipt. O(1). */
function observeConversion(required: { dependencies: Dependencies; request: MetaCapiRequest; result: Outcome<MetaConversionOutcome> }): void {
  const context = required.request.context;
  const outcome = required.result.ok ? required.result.value.status : required.result.error.code;
  try { required.dependencies.observer.observe({ operation: "meta-ads.capi", outcome, correlationId: context.correlationId, traceId: context.traceId }); }
  catch { /* Host durable audit retains the authoritative result. */ }
}

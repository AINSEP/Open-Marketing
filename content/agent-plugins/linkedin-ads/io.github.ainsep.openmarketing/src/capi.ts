/** Server-only single-event conversion backend; contacts and the host retain identity/authority ownership. */
import { z } from "zod";
import { epochSchema, idSchema, parseBoundary, pluginConfigurationSchema, scopeSchema } from "@open-marketing/contracts";
import type { CallOptions, Outcome, PluginCapabilityDependencies, ServiceContext } from "@open-marketing/contracts";
import { boundInput, configurationSchema, failure, linkedInApiVersion, requestLinkedIn, resolveCredential } from "./transport.js";
import { vendorIdSchema } from "./commands.js";
import type { LinkedInDependencies, LinkedInWireRequest } from "./ports.js";

const conversionUrn = z.string().regex(/^urn:lla:llaPartnerConversion:[1-9][0-9]{0,18}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const eventSchema = z.strictObject({
  eventId: idSchema, definitionId: idSchema, subjectId: idSchema, occurredAt: epochSchema,
  destination: idSchema, purpose: idSchema,
  identifiers: z.strictObject({ email: digest }), identifierDigests: z.strictObject({ email: digest }),
});
// Structurally matches measure's open definitionIds grant, without importing another feature.
const grantSchema = z.strictObject({
  kind: z.literal("measurement"), grantId: idSchema, scope: scopeSchema,
  connectionId: idSchema, accountId: idSchema, definitionIds: z.array(idSchema).min(1).max(16),
  destination: idSchema, purpose: idSchema, payloadSchema: idSchema,
  payloadVersion: z.literal(1), expiresAt: epochSchema, revoked: z.boolean(),
});
const requestSchema = z.strictObject({ context: z.strictObject({ scope: scopeSchema, serviceId: idSchema, correlationId: idSchema, traceId: idSchema }), event: eventSchema, grant: grantSchema, deliveryId: idSchema });
const conversionRules = z.record(idSchema, conversionUrn).refine(value => Object.keys(value).length > 0 && Object.keys(value).length <= 100);
const capiConfigurationSchema = configurationSchema.pick({ scope: true, connectionId: true, accountId: true, pluginDigest: true }).extend({ destination: idSchema, purpose: idSchema, payloadSchema: idSchema, conversionRules });
const conversionSettingsSchema = z.object({ conversionConfiguration: z.strictObject({ accountId: vendorIdSchema, purpose: idSchema, payloadSchema: idSchema, conversionRules }) });
/** Server maps open OM definitions to account-owned, enabled CONVERSIONS_API rules. */
export type LinkedInCapiConfiguration = z.infer<typeof capiConfigurationSchema>;
/** Transient contacts email hash plus its committed internal digest. No hashing or raw PII here. */
export type LinkedInConversionInput = z.infer<typeof eventSchema>;
/** Narrow current measure grant; definition IDs remain open rather than signup/trial enums. */
export type LinkedInMeasurementGrant = z.infer<typeof grantSchema>;
/** Backend-only durable single event. deliveryId is the host outbox key, eventId is vendor dedupe. */
export interface LinkedInCapiRequest { readonly context: ServiceContext; readonly event: LinkedInConversionInput; readonly grant: LinkedInMeasurementGrant; readonly deliveryId: string }
/** Only the contacts SHA-256 email digest is eligible; occurrence remains milliseconds. */
export interface LinkedInCapiPayload { readonly conversion: string; readonly conversionHappenedAt: number; readonly eventId: string; readonly user: { readonly userIds: readonly { readonly idType: "SHA256_EMAIL"; readonly idValue: string }[] } }
/** Delivered means LinkedIn accepted the event (201), not that a campaign attributed it. */
export interface LinkedInConversionOutcome { readonly status: "delivered" | "unknown" }
/** Server MUST enforce current admission, scope/account/rule ownership, connection, mode, grant
 * and consent for event AND actual payload, after credentials resolve. Claim deliveryId + exact
 * payload/version in the ONE durable jobs outbox; never execute an already dispatched claim again.
 * Verify committed identifierDigests against contacts evidence; they are not the destination hash.
 * Append egress audit with delivery/correlation/trace IDs and hold authority through execute.
 * isCurrent synchronously rechecks that fence at fetch. This callback is a host ABI, not a tool.
 */
export interface LinkedInConversionAuthorityPort {
  dispatch(required: { context: ServiceContext; event: LinkedInConversionInput; payload: LinkedInCapiPayload; grant: LinkedInMeasurementGrant; deliveryId: string; configuration: LinkedInCapiConfiguration; execute: (required: { isCurrent: () => boolean }) => Promise<Outcome<LinkedInConversionOutcome>> }, optional?: CallOptions): Promise<Outcome<LinkedInConversionOutcome>>;
}
/** Inject server authority/token broker/fetch/clock/telemetry; factory performs no effects. */
export type LinkedInCapiDependencies = Pick<LinkedInDependencies, "credentials" | "fetch" | "clock" | "observer"> & { readonly configuration: LinkedInCapiConfiguration; readonly authority: LinkedInConversionAuthorityPort };
/** No assistant tool, retries, batching or invented delivery-readback endpoint. */
export interface LinkedInCapiBackend {
  deliver(required: LinkedInCapiRequest, optional?: CallOptions): Promise<Outcome<LinkedInConversionOutcome>>;
  reconcile(required: LinkedInCapiRequest, optional?: CallOptions): Promise<Outcome<LinkedInConversionOutcome>>;
}
interface Prepared { request: LinkedInCapiRequest; configuration: LinkedInCapiConfiguration; payload: LinkedInCapiPayload; wire: LinkedInWireRequest }

/** One server-job event per POST. Uncertain outcomes never authorize a resend; reconciliation
 * validates input and reports unknown without credentials or vendor I/O.
 * @param required - Server-resolved rule mappings, current authority, token broker and injected I/O.
 * @returns Inert deliver/reconcile methods; typed preflight/vendor denials or accepted/unknown status.
 * @example createConversionDelivery({ configuration, authority, credentials, fetch: serverFetch, clock, observer, wait })
 * @complexity O(b) time/space for <=64KiB input, <=100 mappings; one bounded 15s POST, zero retries.
 */
export function createConversionDelivery(required: PluginCapabilityDependencies & { authority: LinkedInConversionAuthorityPort }): LinkedInCapiBackend {
  return createBackend({ ...required, configuration: parseConversionConfiguration(required.configuration) });
}

/** Parse plugin-owned install settings, bind their account, and keep vendor constants private.
 * O(k), k<=100 rule mappings; no credentials, authority or fetch on malformed settings. */
function parseConversionConfiguration(required: PluginCapabilityDependencies["configuration"]): Outcome<LinkedInCapiConfiguration> {
  const configuration = pluginConfigurationSchema.extend({ accountId: vendorIdSchema }).safeParse(required);
  if (!configuration.success) return failure({ code: "invalid_input" });
  const settings = conversionSettingsSchema.safeParse(configuration.data.settings);
  if (!settings.success) return failure({ code: "invalid_input" });
  const mapping = settings.data.conversionConfiguration;
  if (mapping.accountId !== configuration.data.accountId) return failure({ code: "forbidden" });
  const { scope, connectionId, pluginDigest } = configuration.data;
  return { ok: true, value: { scope, connectionId, pluginDigest, ...mapping, destination: "linkedin-ads" } };
}

/** Shared backend returns invalid configuration as a typed value, before any effect. O(b<=64KiB). */
function createBackend(required: Omit<LinkedInCapiDependencies, "configuration"> & { configuration: Outcome<LinkedInCapiConfiguration> }): LinkedInCapiBackend {
  return {
    async deliver(input, options) {
      if (!required.configuration.ok) return required.configuration;
      const dependencies = { ...required, configuration: required.configuration.value };
      const prepared = prepare({ dependencies, input }, options);
      if (!prepared.ok) return prepared;
      const result = await dispatch({ dependencies, prepared: prepared.value }, options);
      observe({ dependencies, context: prepared.value.request.context, result });
      return result;
    },
    async reconcile(input, options) {
      if (!required.configuration.ok) return required.configuration;
      const dependencies = { ...required, configuration: required.configuration.value };
      const prepared = prepare({ dependencies, input }, options);
      return prepared.ok ? unknown() : prepared;
    },
  };
}

/** Freeze the exact wire bytes before awaiting host code. Strict keys reject raw email, phone,
 * click IDs, unapproved metadata and mixed-validity identifiers before any I/O. @complexity O(b).
 */
function prepare(required: { dependencies: LinkedInCapiDependencies; input: LinkedInCapiRequest }, optional?: CallOptions): Outcome<Prepared> {
  if (optional?.signal?.aborted) return failure({ code: "cancelled" });
  const configuration = parseBoundary({ schema: capiConfigurationSchema, input: required.dependencies.configuration });
  if (!configuration.ok) return configuration;
  const bounded = boundInput({ input: required.input });
  if (!bounded.ok) return bounded;
  const request = parseBoundary({ schema: requestSchema, input: bounded.value });
  if (!request.ok) return request;
  const checked = checkAuthority({ request: request.value, configuration: configuration.value, now: required.dependencies.clock.now({}) });
  if (!checked.ok) return checked;
  const conversion = Object.hasOwn(configuration.value.conversionRules, request.value.event.definitionId) ? configuration.value.conversionRules[request.value.event.definitionId] : undefined;
  if (!conversion) return failure({ code: "invalid_input" });
  const event = request.value.event;
  const payload: LinkedInCapiPayload = { conversion, conversionHappenedAt: event.occurredAt, eventId: event.eventId, user: { userIds: [{ idType: "SHA256_EMAIL", idValue: event.identifiers.email }] } };
  return { ok: true, value: { request: request.value, configuration: configuration.value, payload, wire: { url: "https://api.linkedin.com/rest/conversionEvents", method: "POST", restliMethod: "CREATE", body: JSON.stringify(payload) } } };
}

/** Local constraints never establish live consent; the server fence is authoritative. @complexity O(k), k<=16 grant definitions. */
function checkAuthority(required: { request: LinkedInCapiRequest; configuration: LinkedInCapiConfiguration; now: number }): Outcome<void> {
  const { request, configuration, now } = required;
  if (!grantMatches({ request, configuration })) return failure({ code: "forbidden" });
  if (request.grant.revoked || now >= request.grant.expiresAt) return failure({ code: "forbidden" });
  if (!Number.isSafeInteger(now) || now < request.event.occurredAt || now - request.event.occurredAt > 90 * 86400000) return failure({ code: "expired" });
  return { ok: true, value: undefined };
}
/** Scope, purpose, destination, schema and definition all bind the exact job. @complexity O(k), k<=16. */
function grantMatches(required: { request: LinkedInCapiRequest; configuration: LinkedInCapiConfiguration }): boolean {
  const { request, configuration } = required;
  const { context, grant, event } = request;
  const scopesMatch = context.scope.ownerId === configuration.scope.ownerId
    && context.scope.workspaceId === configuration.scope.workspaceId
    && grant.scope.ownerId === context.scope.ownerId && grant.scope.workspaceId === context.scope.workspaceId;
  return scopesMatch && grant.connectionId === configuration.connectionId && grant.accountId === configuration.accountId
    && grant.destination === configuration.destination && event.destination === configuration.destination
    && grant.purpose === configuration.purpose && event.purpose === configuration.purpose
    && grant.payloadSchema === configuration.payloadSchema && grant.definitionIds.includes(event.definitionId);
}

/** Resolve credentials first, then enter the current server fence; callback cannot send twice.
 * Copies isolate reviewed bytes from host/input mutation. Unknown after egress remains unknown.
 * @complexity O(b) time/space, one credential lookup, one host claim and at most one vendor call.
 */
async function dispatch(required: { dependencies: LinkedInCapiDependencies; prepared: Prepared }, optional?: CallOptions): Promise<Outcome<LinkedInConversionOutcome>> {
  const { dependencies, prepared } = required;
  let executed = false;
  let sent = false;
  try {
    const credential = await resolveCredential({ credentials: dependencies.credentials, configuration: prepared.configuration }, optional);
    if (!credential.ok) return credential;
    return await dependencies.authority.dispatch({ ...structuredClone({ context: prepared.request.context, event: prepared.request.event, payload: prepared.payload, grant: prepared.request.grant, deliveryId: prepared.request.deliveryId, configuration: prepared.configuration }), execute: async fence => {
      if (executed) return failure({ code: "conflict" });
      executed = true;
      if (optional?.signal?.aborted) return failure({ code: "cancelled" });
      const now = dependencies.clock.now({});
      const checked = checkAuthority({ ...prepared, now });
      if (!checked.ok) return checked;
      if (credential.value.expiresAt !== undefined && now >= credential.value.expiresAt) return failure({ code: "expired" });
      if (!fence.isCurrent()) return failure({ code: "forbidden" });
      sent = true;
      const response = await requestLinkedIn({ fetch: dependencies.fetch, request: prepared.wire, credential: credential.value, apiVersion: linkedInApiVersion }, optional);
      if (!response.ok) return response.error.code === "unavailable" ? unknown() : response;
      return { ok: true, value: { status: response.value.response.status === 201 ? "delivered" : "unknown" } };
    } }, optional);
  } catch { return sent ? unknown() : failure({ code: "unavailable" }); }
}
function unknown(): Outcome<LinkedInConversionOutcome> { return { ok: true, value: { status: "unknown" } }; }

/** Outcomes and context IDs only; telemetry failure cannot erase the delivery receipt. @complexity O(1). */
function observe(required: { dependencies: LinkedInCapiDependencies; context: ServiceContext; result: Outcome<LinkedInConversionOutcome> }): void {
  try { required.dependencies.observer.observe({ operation: "linkedin-ads.capi", outcome: required.result.ok ? required.result.value.status : required.result.error.code, correlationId: required.context.correlationId, traceId: required.context.traceId }); }
  catch { /* Durable egress audit belongs to the server authority. */ }
}

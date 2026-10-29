import { z } from "zod";
import { canonicalizeArguments, digestSchema, epochSchema, idSchema, measurementGrantSchema, moneySchema, parseBoundary, pluginConfigurationSchema, serviceContextSchema } from "@open-marketing/contracts";
import type { CallOptions, Outcome, PluginCapabilityDependencies } from "@open-marketing/contracts";
import { failure, success } from "./schema.ts";
import { createCallTransport } from "./transport.ts";

const customerId = z.string().regex(/^[1-9][0-9]{9}$/);
const actionIds = z.record(idSchema, z.string().regex(/^[1-9][0-9]{0,18}$/)).refine(value => Object.keys(value).length >= 1 && Object.keys(value).length <= 100);
const configurationSchema = pluginConfigurationSchema.extend({ accountId: customerId, settings: z.object({ conversionConfiguration: z.strictObject({ actionIds }), loginCustomerId: customerId.optional() }) });
const identifierMap = z.record(idSchema, z.string().max(2048)).refine(value => Object.keys(value).length <= 16);
const identifiersSchema = z.object({ email: digestSchema.optional(), phone: digestSchema.optional(), gclid: z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/).optional() });
const digestMap = z.record(idSchema, digestSchema).refine(value => Object.keys(value).length <= 16);
const eventSchema = z.strictObject({ eventId: idSchema, definitionId: idSchema, subjectId: idSchema, occurredAt: epochSchema, destination: idSchema, purpose: idSchema, identifierDigests: digestMap, identifiers: identifierMap, value: moneySchema.optional(), orderRef: idSchema.optional() });
const requestSchema = z.strictObject({ context: serviceContextSchema, event: eventSchema, grant: measurementGrantSchema, deliveryId: idSchema });
const reconciliationSchema = requestSchema.extend({ event: eventSchema.partial({ identifiers: true }), receiptId: idSchema.optional() });
const outcomeSchema = z.strictObject({ status: z.enum(["delivered", "unknown"]), receiptId: idSchema.optional(), diagnostics: z.strictObject({ accepted: z.boolean().nullable(), processed: z.boolean().nullable(), attributed: z.boolean().nullable(), observedAt: epochSchema }).optional() });
const receiptSchema = z.object({ requestId: idSchema });
const requestStatusSchema = z.object({ requestStatusPerDestination: z.array(z.object({
  destination: z.object({ operatingAccount: z.object({ accountId: customerId.optional() }).optional() }).optional(),
  requestStatus: z.enum(["REQUEST_STATUS_UNKNOWN", "SUCCESS", "PROCESSING", "FAILED", "PARTIAL_SUCCESS"]),
})).length(1) });
type ConversionConfiguration = z.infer<typeof configurationSchema>;
type ConversionEvent = z.infer<typeof eventSchema>;
type ConversionRequest = z.infer<typeof requestSchema>;
type ReconciliationRequest = z.infer<typeof reconciliationSchema>;
type ConversionResult = z.infer<typeof outcomeSchema>;
/** A3 owns current consent, halt, admission, dispatch identity and the single durable outbox. */
interface ConversionAuthorityPort {
  dispatch(required: { context: ConversionRequest["context"]; event: ConversionEvent; grant: ConversionRequest["grant"]; deliveryId: string; configuration: ConversionConfiguration; payload: Record<string, unknown>; execute(required: { isCurrent(): boolean }): Promise<Outcome<ConversionResult>> }, optional?: CallOptions): Promise<Outcome<ConversionResult>>;
}
type Dependencies = PluginCapabilityDependencies & { authority: ConversionAuthorityPort };
type Prepared = { configuration: ConversionConfiguration; request: ConversionRequest; payload: Record<string, unknown> };
type ConversionBackend = {
  deliver(required: ConversionRequest, optional?: CallOptions): Promise<Outcome<ConversionResult>>;
  reconcile(required: ReconciliationRequest, optional?: CallOptions): Promise<Outcome<ConversionResult>>;
};

/** Bind A3 dependencies without I/O; one Data Manager ingestion, no preflight, journal or retry.
 * @param required - Canonical configuration, current server authority and injected per-call effects.
 * @returns Delivered means accepted only; saved receipts support one explicit status GET.
 * @example createConversionDelivery(dependencies).deliver({ context, event, grant, deliveryId })
 * @complexity O(b + a) bounded parsing/space, <=64KiB JSON and <=100 actions; one <=15s POST.
 */
export function createConversionDelivery(required: Dependencies): ConversionBackend {
  const configuration = parseBoundary({ schema: configurationSchema, input: required.configuration });
  return {
    async deliver(input, options) {
      const prepared = prepareConversion({ configuration, input, now: required.clock.now({}) }, options);
      if (!prepared.ok) return prepared;
      return dispatchConversion({ dependencies: required, prepared: prepared.value }, options);
    },
    async reconcile(input, options) {
      return readConversion({ dependencies: required, configuration, input }, options);
    },
  };
}

/** Parse a complete definition-bound request; unknown identifiers are ignored, known formats stay strict. O(b+a). */
function prepareConversion(required: { configuration: Outcome<ConversionConfiguration>; input: ConversionRequest; now: number }, optional?: CallOptions): Outcome<Prepared> {
  if (optional?.signal?.aborted) return failure({ code: "cancelled", message: "Google conversion cancelled before dispatch" });
  if (!required.configuration.ok) return required.configuration;
  const bounded = canonicalizeArguments({ arguments: required.input });
  if (!bounded.ok) return bounded;
  const request = parseBoundary({ schema: requestSchema, input: JSON.parse(bounded.value) as unknown });
  if (!request.ok) return request;
  const configuration = required.configuration.value;
  const checked = checkAuthority({ configuration, request: request.value, now: required.now });
  if (!checked.ok) return checked;
  const identifiers = parseBoundary({ schema: identifiersSchema, input: request.value.event.identifiers });
  if (!identifiers.ok) return identifiers;
  if (!identifiers.value.email && !identifiers.value.phone && !identifiers.value.gclid) return failure({ code: "invalid_input", message: "Google conversion not sent: no supported identifier" });
  return success({ value: { configuration, request: request.value, payload: mapConversion({ configuration, event: request.value.event }) } });
}

/** Local binding checks constrain the request; current consent is established only by A3. O(k), k<=16 definitions. */
function checkAuthority(required: { configuration: ConversionConfiguration; request: ReconciliationRequest; now: number }): Outcome<void> {
  const { configuration, request, now } = required;
  if (!grantMatches({ configuration, request }) || request.grant.revoked || now >= request.grant.expiresAt) return failure({ code: "forbidden", message: "Google measurement grant binding mismatch, revoked or expired" });
  if (!Number.isSafeInteger(now) || request.event.occurredAt > now) return failure({ code: "invalid_input", message: "Google conversion occurrence is in the future" });
  if (!Object.hasOwn(configuration.settings.conversionConfiguration.actionIds, request.event.definitionId)) return failure({ code: "unavailable", message: "Conversion definition has no configured action" });
  return success({ value: undefined });
}

/** Service/configuration/grant share a scope; destination, purpose and definition bind the exact event. O(k). */
function grantMatches(required: { configuration: ConversionConfiguration; request: ReconciliationRequest }): boolean {
  const { configuration, request } = required;
  const { context, grant, event } = request;
  const scopeMatches = context.scope.ownerId === configuration.scope.ownerId && context.scope.workspaceId === configuration.scope.workspaceId
    && grant.scope.ownerId === context.scope.ownerId && grant.scope.workspaceId === context.scope.workspaceId;
  return scopeMatches && grant.connectionId === configuration.connectionId && grant.accountId === configuration.accountId
    && grant.destination === event.destination && grant.purpose === event.purpose && grant.definitionIds.includes(event.definitionId);
}

/** Validate saved-receipt readback without identifier mapping or write authority.
 * Current configuration/grant binding still applies. Missing receipts do no I/O.
 * @complexity O(b+a) bounded parsing; one existing <=15s/1MiB GET, no retries. */
async function readConversion(required: { dependencies: Dependencies; configuration: Outcome<ConversionConfiguration>; input: ReconciliationRequest }, optional?: CallOptions): Promise<Outcome<ConversionResult>> {
  if (optional?.signal?.aborted) return failure({ code: "cancelled", message: "Google conversion readback cancelled" });
  if (!required.configuration.ok) return required.configuration;
  const bounded = canonicalizeArguments({ arguments: required.input });
  if (!bounded.ok) return bounded;
  const parsed = parseBoundary({ schema: reconciliationSchema, input: JSON.parse(bounded.value) as unknown });
  if (!parsed.ok) return parsed;
  const request = parsed.value;
  const configuration = required.configuration.value;
  const checked = checkAuthority({ configuration, request, now: required.dependencies.clock.now({}) });
  if (!checked.ok) return checked;
  if (!request.receiptId) return success({ value: { status: "unknown" } });
  const transport = createCallTransport({ dependencies: { ...required.dependencies, configuration } }, optional);
  if (!transport.ok) return transport;
  const context = { ...request.context, principal: { kind: "service" as const, serviceId: request.context.serviceId } };
  const response = await transport.value.transport.request({ method: "request_status", body: { requestId: request.receiptId }, context, operationId: request.deliveryId });
  return success({ value: { status: "delivered", receiptId: request.receiptId, diagnostics: {
    accepted: true, processed: processingStatus({ response, accountId: configuration.accountId }), attributed: null, observedAt: required.dependencies.clock.now({}),
  } } });
}
/** A single destination's explicit status is processing evidence only. Unknown,
 * malformed, partial or mismatched observations cannot confirm processing.
 * @complexity O(1) after the existing bounded response reader; no vendor text retained. */
function processingStatus(required: { response: Outcome<unknown>; accountId: string }): boolean | null {
  if (!required.response.ok) return null;
  const parsed = requestStatusSchema.safeParse(required.response.value);
  if (!parsed.success) return null;
  const entry = parsed.data.requestStatusPerDestination[0];
  const accountId = entry.destination?.operatingAccount?.accountId;
  if (accountId !== undefined && accountId !== required.accountId) return null;
  if (entry.requestStatus === "SUCCESS") return true;
  if (entry.requestStatus === "FAILED") return false;
  return null;
}

/** Wrap the single send in server authority; an exception after handoff cannot prove no egress. O(1). */
async function dispatchConversion(required: { dependencies: Dependencies; prepared: Prepared }, optional?: CallOptions): Promise<Outcome<ConversionResult>> {
  const { dependencies, prepared } = required;
  let handedOff = false;
  try {
    return await dependencies.authority.dispatch({ ...prepared.request, configuration: prepared.configuration, payload: prepared.payload, execute: async ({ isCurrent }) => {
      if (!isCurrent()) return failure({ code: "forbidden", message: "Google conversion authority withdrawn" });
      if (optional?.signal?.aborted) return failure({ code: "cancelled", message: "Google conversion cancelled before egress" });
      handedOff = true;
      return sendConversion({ ...required, isCurrent }, optional);
    } }, optional);
  } catch { return handedOff ? success({ value: { status: "unknown" } }) : failure({ code: "unavailable", message: "Google conversion authority unavailable" }); }
}

/** Fresh canonical credentials and bounded REST transport. The wrapper rechecks after credentials;
 * failures are redacted and a lost/malformed ACK remains unknown. O(b), one <=15s/1MiB POST.
 */
async function sendConversion(required: { dependencies: Dependencies; prepared: Prepared; isCurrent(): boolean }, optional?: CallOptions): Promise<Outcome<ConversionResult>> {
  const { dependencies, prepared } = required;
  let refusal: Outcome<never> | undefined;
  const transport = createCallTransport({ dependencies: { ...dependencies, configuration: prepared.configuration, fetch: async (url, options) => {
    if (!required.isCurrent()) refusal = failure({ code: "forbidden", message: "Google conversion authority withdrawn" });
    if (options?.signal?.aborted) refusal = failure({ code: "cancelled", message: "Google conversion cancelled before egress" });
    if (refusal) throw new Error("Google conversion not sent");
    return dependencies.fetch(url, options);
  } } }, optional);
  if (!transport.ok) return transport;
  const context = { ...prepared.request.context, principal: { kind: "service" as const, serviceId: prepared.request.context.serviceId } };
  const response = await transport.value.transport.request({ method: "ingest", body: prepared.payload, context, operationId: prepared.request.deliveryId });
  if (refusal) return refusal;
  if (!response.ok) return response.error.code === "forbidden" || response.error.code === "cancelled" ? failure({ code: response.error.code, message: "Google conversion not sent" }) : success({ value: { status: "unknown" } });
  const receipt = receiptSchema.safeParse(response.value);
  if (!receipt.success) return success({ value: { status: "unknown" } });
  return success({ value: { status: "delivered", receiptId: receipt.data.requestId, diagnostics: { accepted: true, processed: null, attributed: null, observedAt: dependencies.clock.now({}) } } });
}

/** Map an already-checked event to one definition-selected UPLOAD_CLICKS destination.
 * Only supported contacts digests/click IDs are copied; no normalization, account lookup or hashing.
 * Consent reflects the server's dispatch-time fence; personalization remains unspecified.
 * @param required - Parsed canonical settings and event; money is in currency minor units.
 * @returns Fixed Data Manager HEX request; only supplied money adds conversionValue/currency.
 * @example mapConversion({ configuration, event })
 * @complexity O(1) time/space; at most two user identifiers and one click ID.
 */
export function mapConversion(required: { configuration: ConversionConfiguration; event: ConversionEvent }): Record<string, unknown> {
  const { configuration, event } = required;
  const userIdentifiers = [];
  if (event.identifiers.email) userIdentifiers.push({ emailAddress: event.identifiers.email });
  if (event.identifiers.phone) userIdentifiers.push({ phoneNumber: event.identifiers.phone });
  const destination: Record<string, unknown> = { operatingAccount: { accountType: "GOOGLE_ADS", accountId: configuration.accountId }, productDestinationId: configuration.settings.conversionConfiguration.actionIds[event.definitionId] };
  if (configuration.settings.loginCustomerId) destination.loginAccount = { accountType: "GOOGLE_ADS", accountId: configuration.settings.loginCustomerId };
  const conversion: Record<string, unknown> = { transactionId: event.eventId, eventTimestamp: new Date(event.occurredAt).toISOString(), eventSource: "WEB", consent: { adUserData: "CONSENT_GRANTED" } };
  if (event.value) {
    const exponent = new Intl.NumberFormat("en", { style: "currency", currency: event.value.currency }).resolvedOptions().maximumFractionDigits!;
    conversion.conversionValue = event.value.minorUnits / 10 ** exponent;
    conversion.currency = event.value.currency;
  }
  if (event.identifiers.gclid) conversion.adIdentifiers = { gclid: event.identifiers.gclid };
  if (userIdentifiers.length) conversion.userData = { userIdentifiers };
  return { destinations: [destination], events: [conversion], encoding: "HEX", validateOnly: false };
}

import type { CallContext, MeasurementGrant, Outcome } from "@open-marketing/contracts";
import { epoch, failure, id, micros, numericId, object, parse, protect, success, currency } from "./schema.ts";
import type { Schema } from "./schema.ts";
import { bindingSchema, contextSchema } from "./schemas.ts";
import { digest, operationIdentity } from "./rules.ts";
import { asRecord } from "./readback.ts";
import type { AccountBinding, GoogleTransportPort } from "./types.ts";

/** Verified web event. Contacts alone prepares digests; raw PII/extra fields reject.
 * eventType is the grant category; definitionId selects the OM conversion definition. */
export interface ConversionEvent {
  eventId: string; definitionId: string; eventType: string; occurredAt: number; destination: string; purpose: string;
  gclid?: string; hashedEmail?: string; hashedPhoneNumber?: string;
  adUserData: "GRANTED" | "DENIED"; adPersonalization?: "GRANTED" | "DENIED";
  valueMicros: string; currency: string;
}
/** Host independently verifies project, action owner/type UPLOAD_CLICKS and access.
 * No legacy API fallback. At most 100 OM definition-to-action mappings. */
export interface ConversionConfiguration {
  api: "data-manager-v1"; cloudProjectId: string; eligibility: "verified" | "unavailable";
  actionIds: Record<string, string>; loginCustomerId?: string;
}
/** Durable append-only outbox metadata. Missing requestId can never authorize resend. */
export interface DeliveryRecord {
  identity: string; digest: string; status: "unknown" | "delivered";
  requestId?: string; diagnosticStatus?: "PROCESSING" | "SUCCESS" | "FAILED" | "PARTIAL_SUCCESS" | "REQUEST_STATUS_UNKNOWN";
}
/** Adapt measure delivery state in the ONE outbox. claim is atomic; get reads latest
 * appended evidence. A crash between claim and receipt persists unknown forever. */
export interface ConversionJournalPort {
  get(required: { identity: string }): Promise<Outcome<DeliveryRecord | null>>;
  claim(required: { record: DeliveryRecord }): Promise<Outcome<{ acquired: boolean; record: DeliveryRecord }>>;
  append(required: { record: DeliveryRecord }): Promise<Outcome<void>>;
}
/** Host checks CURRENT consent/grant/source/account/project/audit before execute.
 * One dispatch holds authority serialization through preflight + ingest, including
 * async waits; withdrawal must cancel egress or wait for this critical section.
 * Reconcile uses the same seam with a callback that only reads request diagnostics.
 * execute is a foreign callback ABI, never an agent-supplied callback. */
export interface ConversionAuthorityPort {
  dispatchConversion<T>(required: { context: CallContext; binding: AccountBinding; grant: MeasurementGrant; event: ConversionEvent; configuration: ConversionConfiguration; deliveryId: string; execute: () => Promise<Outcome<T>> }): Promise<Outcome<T>>;
}
const hashed: Schema = { type: "string", pattern: "^[a-f0-9]{64}$", minLength: 64, maxLength: 64 };
const consent: Schema = { type: "string", enum: ["GRANTED", "DENIED"] };
const eventSchema = object({ properties: {
  eventId: id, definitionId: id, eventType: id, occurredAt: epoch, destination: id, purpose: id,
  gclid: { type: "string", minLength: 1, maxLength: 256, pattern: "^[A-Za-z0-9_-]+$" },
  hashedEmail: hashed, hashedPhoneNumber: hashed, adUserData: consent, adPersonalization: consent,
  valueMicros: { ...micros, pattern: "^[0-9]+$" }, currency,
}, optional: ["gclid", "hashedEmail", "hashedPhoneNumber", "adPersonalization"] });
const grantSchema = object({ properties: {
  kind: { type: "string", enum: ["measurement"] }, grantId: id, scope: object({ properties: { ownerId: id, workspaceId: id } }),
  connectionId: id, accountId: numericId, eventTypes: { type: "array", items: id, minItems: 1, maxItems: 100 },
  destination: id, purpose: id, payloadSchema: id, payloadVersion: { type: "integer", minimum: 1, maximum: 1 },
  expiresAt: epoch, revoked: { type: "boolean" },
} });
const receiptSchema = object({ properties: { requestId: id, fieldWarnings: { type: "array", items: object({ properties: {} }), maxItems: 0 } }, optional: ["requestId", "fieldWarnings"] });
const diagnosticStatus: Schema = { type: "string", enum: ["PROCESSING", "SUCCESS", "FAILED", "PARTIAL_SUCCESS", "REQUEST_STATUS_UNKNOWN"] };
const diagnosticCount = object({ properties: { reason: id, recordCount: { type: "string", minLength: 1, maxLength: 19, pattern: "^[0-9]+$" } } });
const diagnosticAccount = object({ properties: { accountType: { type: "string", enum: ["GOOGLE_ADS"] }, accountId: { ...numericId, minLength: 10, maxLength: 10 } } });
const diagnosticSchema = object({ properties: { requestStatusPerDestination: { type: "array", minItems: 1, maxItems: 1, items: object({ properties: {
  destination: object({ properties: { operatingAccount: diagnosticAccount, loginAccount: diagnosticAccount, productDestinationId: numericId }, optional: ["loginAccount"] }),
  requestStatus: diagnosticStatus,
  eventsIngestionStatus: object({ properties: { recordCount: { type: "string", minLength: 1, maxLength: 19, pattern: "^[0-9]+$" } } }),
  errorInfo: object({ properties: { errorCounts: { type: "array", items: diagnosticCount, maxItems: 100 } }, optional: ["errorCounts"] }),
  warningInfo: object({ properties: { warningCounts: { type: "array", items: diagnosticCount, maxItems: 100 } }, optional: ["warningCounts"] }),
}, optional: ["eventsIngestionStatus", "errorInfo", "warningInfo"] }) } } });
type Diagnostic = { destination: Record<string, unknown>; requestStatus: NonNullable<DeliveryRecord["diagnosticStatus"]>; eventsIngestionStatus?: { recordCount: string }; errorInfo?: unknown; warningInfo?: unknown };
type Dependencies = { binding: AccountBinding; configuration: ConversionConfiguration; transport: GoogleTransportPort; journal: ConversionJournalPort; authority: ConversionAuthorityPort; now: (required: Record<string, never>) => number };
type Input = { context: CallContext; grant: MeasurementGrant; event: ConversionEvent; deliveryId: string };
type DeliveryOutcome = Outcome<{ status: "delivered" | "unknown" }>;
type Request = Input & { dependencies: Dependencies };
type MappedRequest = Request & { mapping: Record<string, unknown>; record: DeliveryRecord };
/** Server-only single-event Data Manager delivery and bounded diagnostics. No polling
 * or retries. Inputs are checked before effects; opaque adapters become typed failures.
 * @complexity O(k log k), k<=100 config entries, bounded space; two POSTs or one GET.
 * @example createConversionBinding(dependencies).deliver({ context, grant, event, deliveryId }) */
export function createConversionBinding(required: Dependencies): { deliver(input: Input): Promise<DeliveryOutcome>; reconcile(input: Input): Promise<DeliveryOutcome> } {
  return {
    deliver: input => protect({ work: () => conversion({ dependencies: required, ...input }, { reconcileOnly: false }) }),
    reconcile: input => protect({ work: () => conversion({ dependencies: required, ...input }, { reconcileOnly: true }) }),
  };
}
/** Read durable evidence first. Identity ignores deliveryId and includes definition,
 * event and account scope; changed configuration/purpose/data conflicts. */
async function conversion(required: Request, optional: { reconcileOnly: boolean }): Promise<DeliveryOutcome> {
  const checked = checkConversion(required);
  if (!checked.ok) return checked;
  const { dependencies, event } = required;
  const mapping = mapConversion({ binding: dependencies.binding, configuration: dependencies.configuration, event });
  const identity = operationIdentity({ binding: dependencies.binding, operationId: JSON.stringify(["conversion", event.definitionId, event.eventId]) }).key;
  const record: DeliveryRecord = { identity, digest: conversionDigest({ mapping, event, configuration: dependencies.configuration }), status: "unknown" };
  const existing = await dependencies.journal.get({ identity });
  if (!existing.ok) return existing;
  if (existing.value) return existingDelivery({ ...required, mapping, record, existing: existing.value });
  if (optional.reconcileOnly) return success({ value: { status: "unknown" } });
  return dispatchDelivery({ ...required, mapping, record });
}
/** Existing claims only return evidence or perform a read; never repeat ingestion. */
async function existingDelivery(required: MappedRequest & { existing: DeliveryRecord }): Promise<DeliveryOutcome> {
  if (required.existing.digest !== required.record.digest) return failure({ code: "conflict", message: "Conversion identity reused with different data" });
  if (required.existing.status === "delivered") return success({ value: { status: "delivered" } });
  if (!required.existing.requestId) return success({ value: { status: "unknown" } });
  const { dependencies, context, grant, event, deliveryId } = required;
  return dependencies.authority.dispatchConversion({ context, grant, event, deliveryId, binding: dependencies.binding, configuration: dependencies.configuration,
    execute: () => reconcileReceipt({ ...required, record: required.existing }),
  });
}
/** One host authority critical section covers both POSTs and the atomic claim. */
async function dispatchDelivery(required: MappedRequest): Promise<DeliveryOutcome> {
  const { dependencies, context, grant, event, deliveryId } = required;
  return dependencies.authority.dispatchConversion({ context, grant, event, deliveryId, binding: dependencies.binding, configuration: dependencies.configuration,
    execute: () => preflightAndIngest(required),
  });
}
/** Validation failures do not claim an event. Concurrent validations may run, but
 * exactly one atomic claim can ingest. Same immutable body, validateOnly differs. */
async function preflightAndIngest(required: MappedRequest): Promise<DeliveryOutcome> {
  const response = await required.dependencies.transport.request({ method: "ingest", body: { ...structuredClone(required.mapping), validateOnly: true }, cloudProjectId: required.dependencies.configuration.cloudProjectId, context: required.context, operationId: required.deliveryId });
  if (!response.ok) return response;
  const preflight = parse({ schema: receiptSchema, input: response.value });
  if (!preflight.ok) return failure({ code: "invalid_input", message: "Data Manager preflight rejected or returned warnings/malformed data" });
  const current = checkConversion(required);
  if (!current.ok) return current;
  const { binding, configuration } = required.dependencies;
  const currentMapping = mapConversion({ binding, configuration, event: required.event });
  if (conversionDigest({ mapping: currentMapping, event: required.event, configuration }) !== required.record.digest) return failure({ code: "conflict", message: "Conversion data changed during preflight" });
  const claimed = await required.dependencies.journal.claim({ record: required.record });
  if (!claimed.ok) return claimed;
  if (claimed.value.record.digest !== required.record.digest) return failure({ code: "conflict", message: "Conversion identity reused with different data" });
  if (!claimed.value.acquired) return success({ value: { status: claimed.value.record.status } });
  return ingest(required);
}
/** Bind the prepared body and host OAuth project to immutable delivery evidence.
 * @complexity O(n log n) time, O(n) space for bounded single-event JSON keys. */
function conversionDigest(required: { mapping: Record<string, unknown>; event: ConversionEvent; configuration: ConversionConfiguration }): string {
  return digest({ value: { mapping: required.mapping, eventType: required.event.eventType, destination: required.event.destination, purpose: required.event.purpose, cloudProjectId: required.configuration.cloudProjectId } });
}
/** Claim precedes irreversible egress. Acceptance is unknown until diagnostics;
 * receipt is appended before returning. Lost/malformed receipts never trigger resend. */
async function ingest(required: MappedRequest): Promise<DeliveryOutcome> {
  const response = await required.dependencies.transport.request({ method: "ingest", body: { ...structuredClone(required.mapping), validateOnly: false }, cloudProjectId: required.dependencies.configuration.cloudProjectId, context: required.context, operationId: required.deliveryId });
  if (!response.ok) return success({ value: { status: "unknown" } });
  const receipt = asRecord({ value: response.value });
  const requestId = parse<string>({ schema: id, input: receipt.requestId });
  if (!requestId.ok) return success({ value: { status: "unknown" } });
  // Preserve the valid receipt even if warnings/other fields need owner inspection.
  const saved = await required.dependencies.journal.append({ record: { ...required.record, requestId: requestId.value } });
  if (!saved.ok) return success({ value: { status: "unknown" } });
  return success({ value: { status: "unknown" } });
}
/** Closed schemas plus trusted scope, consent, grant and value checks before I/O.
 * @complexity O(k), k<=100 configuration entries; O(k) schema space. */
function checkConversion(required: Request): Outcome<void> {
  const checks = [
    parse({ schema: eventSchema, input: required.event }), parse({ schema: grantSchema, input: required.grant }),
    parse({ schema: contextSchema, input: required.context }), parse({ schema: bindingSchema, input: required.dependencies.binding }),
    parse({ schema: id, input: required.deliveryId }), checkConfiguration({ configuration: required.dependencies.configuration }),
  ];
  const invalid = checks.find(result => !result.ok);
  if (invalid) return invalid;
  if (required.dependencies.configuration.eligibility !== "verified") return failure({ code: "unavailable", message: "Data Manager production eligibility unverified" });
  return conversionAuthorityFields(required);
}
/** Validate a bounded definition map without extending the shared schema shim. */
function checkConfiguration(required: { configuration: ConversionConfiguration }): Outcome<void> {
  const value = asRecord({ value: required.configuration });
  const keys = Object.keys(asRecord({ value: value.actionIds }));
  if (keys.length < 1 || keys.length > 100) return failure({ code: "invalid_input", message: "Configure 1 to 100 conversion definitions" });
  if (keys.some(key => !parse({ schema: id, input: key }).ok)) return failure({ code: "invalid_input", message: "Invalid conversion definition id" });
  const schema = object({ properties: {
    api: { type: "string", enum: ["data-manager-v1"] }, cloudProjectId: id,
    eligibility: { type: "string", enum: ["verified", "unavailable"] },
    actionIds: object({ properties: Object.fromEntries(keys.map(key => [key, numericId])) }),
    loginCustomerId: { ...numericId, minLength: 10, maxLength: 10 },
  }, optional: ["loginCustomerId"] });
  const parsed = parse({ schema, input: required.configuration });
  return parsed.ok ? success({ value: undefined }) : parsed;
}
function conversionAuthorityFields(required: Request): Outcome<void> {
  const scopes = conversionScopes(required);
  if (!scopes.ok) return scopes;
  const grant = conversionGrant(required);
  if (!grant.ok) return grant;
  return conversionData(required);
}
function conversionScopes(required: Request): Outcome<void> {
  const { dependencies, context, grant } = required;
  const binding = dependencies.binding;
  if (context.scope.ownerId !== binding.scope.ownerId || context.scope.workspaceId !== binding.scope.workspaceId) return failure({ code: "forbidden", message: "Conversion context scope mismatch" });
  if (grant.scope.ownerId !== binding.scope.ownerId || grant.scope.workspaceId !== binding.scope.workspaceId) return failure({ code: "forbidden", message: "Conversion grant scope mismatch" });
  if (grant.connectionId !== binding.connectionId || grant.accountId !== binding.customerId) return failure({ code: "forbidden", message: "Conversion grant account mismatch" });
  return success({ value: undefined });
}
function conversionGrant(required: Request): Outcome<void> {
  const { dependencies, grant, event } = required;
  if (grant.revoked || grant.expiresAt <= dependencies.now({})) return failure({ code: "expired", message: "Measurement grant expired or revoked" });
  if (!grant.eventTypes.some(type => type === event.eventType) || grant.destination !== event.destination || grant.purpose !== event.purpose) return failure({ code: "forbidden", message: "Measurement grant purpose or event mismatch" });
  if (!Object.hasOwn(dependencies.configuration.actionIds, event.definitionId)) return failure({ code: "unavailable", message: "Conversion definition has no configured action" });
  return success({ value: undefined });
}
function conversionData(required: Request): Outcome<void> {
  const { dependencies, event } = required;
  const binding = dependencies.binding;
  if (binding.mode !== "production") return failure({ code: "unavailable", message: "Conversions require always-on production host mode" });
  if (event.adUserData !== "GRANTED") return failure({ code: "forbidden", message: "Ad user data consent is absent" });
  if (!event.gclid && !event.hashedEmail && !event.hashedPhoneNumber) return failure({ code: "invalid_input", message: "Conversion has no supported identifier" });
  if (event.currency !== binding.currency || event.occurredAt > dependencies.now({})) return failure({ code: "invalid_input", message: "Invalid conversion currency or future event" });
  if (BigInt(event.valueMicros) > BigInt(Number.MAX_SAFE_INTEGER)) return failure({ code: "limit_exceeded", message: "Conversion value exceeds safe precision" });
  return success({ value: undefined });
}
/** Pure mapping of an already-checked web event to one Google Ads destination.
 * Digests copy unchanged to emailAddress/phoneNumber; no normalization or hashing.
 * @complexity O(1) time/space; at most two user identifiers.
 * @example mapConversion({ binding, configuration, event }) */
export function mapConversion(required: { binding: AccountBinding; configuration: ConversionConfiguration; event: ConversionEvent }): Record<string, unknown> {
  const { binding, configuration, event } = required;
  const userIdentifiers = [];
  if (event.hashedEmail) userIdentifiers.push({ emailAddress: event.hashedEmail });
  if (event.hashedPhoneNumber) userIdentifiers.push({ phoneNumber: event.hashedPhoneNumber });
  const destination: Record<string, unknown> = { operatingAccount: { accountType: "GOOGLE_ADS", accountId: binding.customerId }, productDestinationId: configuration.actionIds[event.definitionId] };
  if (configuration.loginCustomerId) destination.loginAccount = { accountType: "GOOGLE_ADS", accountId: configuration.loginCustomerId };
  const mappedConsent: Record<string, string> = { adUserData: "CONSENT_" + event.adUserData };
  if (event.adPersonalization) mappedConsent.adPersonalization = "CONSENT_" + event.adPersonalization;
  const conversion: Record<string, unknown> = {
    transactionId: event.eventId, eventTimestamp: new Date(event.occurredAt).toISOString(), eventSource: "WEB",
    conversionValue: Number(BigInt(event.valueMicros)) / 1000000, currency: event.currency, consent: mappedConsent,
  };
  if (event.gclid) conversion.adIdentifiers = { gclid: event.gclid };
  if (userIdentifiers.length) conversion.userData = { userIdentifiers };
  return { destinations: [destination], events: [conversion], encoding: "HEX", validateOnly: false };
}
/** One read-only diagnostic call by durable requestId; never lookup/resend by eventId.
 * O(1) requests, parsed response remains bounded by the transport's 1MiB ceiling. */
async function reconcileReceipt(required: MappedRequest): Promise<DeliveryOutcome> {
  if (required.record.diagnosticStatus === "FAILED" || required.record.diagnosticStatus === "PARTIAL_SUCCESS") return failure({ code: "unavailable", message: "Data Manager processing failed; owner recovery required" });
  const response = await required.dependencies.transport.request({ method: "request_status", body: { requestId: required.record.requestId }, cloudProjectId: required.dependencies.configuration.cloudProjectId, context: required.context, operationId: required.deliveryId });
  if (!response.ok) return success({ value: { status: "unknown" } });
  const diagnostic = diagnosticRecord({ mapping: required.mapping, record: required.record, response: response.value });
  if (!diagnostic.ok) return success({ value: { status: "unknown" } });
  const appended = await required.dependencies.journal.append({ record: diagnostic.value });
  if (!appended.ok) return success({ value: { status: "unknown" } });
  if (diagnostic.value.diagnosticStatus === "FAILED" || diagnostic.value.diagnosticStatus === "PARTIAL_SUCCESS") return failure({ code: "unavailable", message: "Data Manager processing failed; owner recovery required" });
  return success({ value: { status: diagnostic.value.status } });
}
/** Project only the documented single-destination event status. Wrong destination,
 * conflicting fields or errors cannot establish processing success. O(1) projection. */
function diagnosticRecord(required: { mapping: Record<string, unknown>; record: DeliveryRecord; response: unknown }): Outcome<DeliveryRecord> {
  const parsed = parse<{ requestStatusPerDestination: [Diagnostic] }>({ schema: diagnosticSchema, input: required.response });
  if (!parsed.ok) return parsed;
  const row = parsed.value.requestStatusPerDestination[0];
  const destinations = required.mapping.destinations as Record<string, unknown>[];
  if (digest({ value: row.destination }) !== digest({ value: destinations[0] })) return failure({ code: "invalid_input", message: "Data Manager destination mismatch" });
  if (row.requestStatus !== "SUCCESS") return success({ value: { ...required.record, diagnosticStatus: row.requestStatus } });
  if (row.eventsIngestionStatus?.recordCount !== "1" || Object.hasOwn(row, "errorInfo")) return failure({ code: "invalid_input", message: "Processing success lacks clean single-event evidence" });
  return success({ value: { ...required.record, status: "delivered", diagnosticStatus: "SUCCESS" } });
}

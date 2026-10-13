import { createHash } from "node:crypto";
import type { CallContext, MeasurementGrant, Outcome } from "@open-marketing/contracts";
import { epoch, failure, id, micros, numericId, object, parse, protect, success, currency } from "./schema.ts";
import { contextSchema } from "./schemas.ts";
import { digest, operationIdentity } from "./rules.ts";
import { asRecord } from "./readback.ts";
import type { AccountBinding, GoogleTransportPort } from "./types.ts";

/** Only verified signup/trial events enter this server backend. No raw PII, IP or sessions. */
export interface ConversionEvent {
  eventId: string; eventType: "signup" | "trial"; occurredAt: number; destination: string; purpose: string;
  gclid?: string; hashedEmail?: string; hashedPhoneNumber?: string;
  adUserData: "GRANTED" | "DENIED"; valueMicros: string; currency: string;
}
/** Eligibility is explicitly unavailable until host supplies documented Cloud-project
 * evidence. Test accounts cannot verify conversion uploads. Data Manager is deferred. */
export interface ConversionConfiguration {
  cloudProjectId: string; legacyUploadEligibility: "verified" | "unavailable"; eligibilityEvidenceId: string | null;
  actionIds: { signup: string; trial: string };
}
interface DeliveryRecord { identity: string; digest: string; status: "unknown" | "delivered" }
/** Adapt the existing measure delivery journal / ONE outbox; not a second queue. */
export interface ConversionJournalPort {
  claim(required: { record: DeliveryRecord }): Promise<Outcome<{ acquired: boolean; record: DeliveryRecord }>>;
  append(required: { record: DeliveryRecord }): Promise<Outcome<void>>;
}
/** Host rechecks CURRENT consent, grant, source identity, OAuth project, account,
 * production mode and egress audit immediately before execute. */
export interface ConversionAuthorityPort {
  dispatchConversion<T>(required: { context: CallContext; binding: AccountBinding; grant: MeasurementGrant; event: ConversionEvent; configuration: ConversionConfiguration; deliveryId: string; execute: () => Promise<Outcome<T>> }): Promise<Outcome<T>>;
}
const hashed: import("./schema.ts").Schema = { type: "string", pattern: "^[a-f0-9]{64}$", maxLength: 64 };
const eventSchema = object({ properties: {
  eventId: id, eventType: { type: "string", enum: ["signup", "trial"] }, occurredAt: epoch,
  destination: id, purpose: id, gclid: { type: "string", minLength: 1, maxLength: 256, pattern: "^[A-Za-z0-9_-]+$" },
  hashedEmail: hashed, hashedPhoneNumber: hashed, adUserData: { type: "string", enum: ["GRANTED", "DENIED"] },
  valueMicros: { ...micros, pattern: "^[0-9]+$" }, currency,
}, optional: ["gclid", "hashedEmail", "hashedPhoneNumber"] });
const configurationSchema = object({ properties: {
  cloudProjectId: id, legacyUploadEligibility: { type: "string", enum: ["verified", "unavailable"] },
  actionIds: object({ properties: { signup: numericId, trial: numericId } }),
}, optional: [] });
const grantSchema = object({ properties: {
  kind: { type: "string", enum: ["measurement"] }, grantId: id, scope: object({ properties: { ownerId: id, workspaceId: id } }),
  connectionId: id, accountId: numericId, eventTypes: { type: "array", items: { type: "string", enum: ["signup", "trial"] }, minItems: 1, maxItems: 2 },
  destination: id, purpose: id, payloadSchema: id, payloadVersion: { type: "integer", minimum: 1, maximum: 1 },
  expiresAt: epoch, revoked: { type: "boolean" },
} });
type Dependencies = { binding: AccountBinding; configuration: ConversionConfiguration; transport: GoogleTransportPort; journal: ConversionJournalPort; authority: ConversionAuthorityPort; now: (required: Record<string, never>) => number };
/** Server-only, one conversion per request with stable orderId. A duplicate, timeout or
 * partial error never causes a fresh send. Not exported through tools/list.
 * @example createConversionBinding(dependencies).deliver({ context, grant, event, deliveryId }) */
export function createConversionBinding(required: Dependencies): { deliver(input: { context: CallContext; grant: MeasurementGrant; event: ConversionEvent; deliveryId: string }): Promise<Outcome<{ status: "delivered" | "unknown" }>> } {
  return { deliver: input => protect({ work: () => deliver({ dependencies: required, ...input }) }) };
}
async function deliver(required: { dependencies: Dependencies; context: CallContext; grant: MeasurementGrant; event: ConversionEvent; deliveryId: string }): Promise<Outcome<{ status: "delivered" | "unknown" }>> {
  const checked = checkConversion(required);
  if (!checked.ok) return checked;
  const { dependencies, event, context, grant, deliveryId } = required;
  const mapping = mapConversion({ binding: dependencies.binding, configuration: dependencies.configuration, event });
  const actionId = dependencies.configuration.actionIds[event.eventType];
  const identity = operationIdentity({ binding: dependencies.binding, operationId: "conversion:" + actionId + ":" + event.eventId }).key;
  const record: DeliveryRecord = { identity, digest: digest({ value: mapping }), status: "unknown" };
  const claimed = await dependencies.journal.claim({ record });
  if (!claimed.ok) return claimed;
  if (claimed.value.record.digest !== record.digest) return failure({ code: "conflict", message: "Conversion dedupe identity reused with different data" });
  if (!claimed.value.acquired) return success({ value: { status: claimed.value.record.status } });
  const result = await dependencies.authority.dispatchConversion({ context, binding: dependencies.binding, configuration: dependencies.configuration, grant, event, deliveryId,
    execute: () => upload({ transport: dependencies.transport, mapping, context, deliveryId }),
  });
  if (!result.ok) return result;
  const appended = await dependencies.journal.append({ record: { ...record, status: result.value.status } });
  if (!appended.ok) return success({ value: { status: "unknown" } });
  return result;
}
function checkConversion(required: { dependencies: Dependencies; context: CallContext; grant: MeasurementGrant; event: ConversionEvent; deliveryId: string }): Outcome<void> {
  const event = parse<ConversionEvent>({ schema: eventSchema, input: required.event });
  if (!event.ok) return event;
  const grant = parse<MeasurementGrant>({ schema: grantSchema, input: required.grant });
  if (!grant.ok) return grant;
  const context = parse<CallContext>({ schema: contextSchema, input: required.context });
  if (!context.ok) return context;
  const delivery = parse<string>({ schema: id, input: required.deliveryId });
  if (!delivery.ok) return delivery;
  const config = required.dependencies.configuration;
  const configResult = parse({ schema: configurationSchema, input: { cloudProjectId: config.cloudProjectId, legacyUploadEligibility: config.legacyUploadEligibility, actionIds: config.actionIds } });
  if (!configResult.ok) return configResult;
  if (config.legacyUploadEligibility !== "verified" || !config.eligibilityEvidenceId) return failure({ code: "unavailable", message: "UploadClickConversions eligibility unverified; Data Manager API is required for new integrations" });
  const evidence = parse<string>({ schema: id, input: config.eligibilityEvidenceId });
  if (!evidence.ok) return evidence;
  return conversionAuthorityFields(required);
}
function conversionAuthorityFields(required: { dependencies: Dependencies; context: CallContext; grant: MeasurementGrant; event: ConversionEvent }): Outcome<void> {
  const scopes = conversionScopes(required);
  if (!scopes.ok) return scopes;
  const grant = conversionGrant(required);
  if (!grant.ok) return grant;
  return conversionData(required);
}
function conversionScopes(required: { dependencies: Dependencies; context: CallContext; grant: MeasurementGrant }): Outcome<void> {
  const { dependencies, context, grant } = required;
  const binding = dependencies.binding;
  if (context.scope.ownerId !== binding.scope.ownerId || context.scope.workspaceId !== binding.scope.workspaceId) return failure({ code: "forbidden", message: "Conversion context scope mismatch" });
  if (grant.scope.ownerId !== binding.scope.ownerId || grant.scope.workspaceId !== binding.scope.workspaceId) return failure({ code: "forbidden", message: "Conversion grant scope mismatch" });
  if (grant.connectionId !== binding.connectionId || grant.accountId !== binding.customerId) return failure({ code: "forbidden", message: "Conversion grant account mismatch" });
  return success({ value: undefined });
}
function conversionGrant(required: { dependencies: Dependencies; grant: MeasurementGrant; event: ConversionEvent }): Outcome<void> {
  const { dependencies, grant, event } = required;
  if (grant.revoked || grant.expiresAt <= dependencies.now({})) return failure({ code: "expired", message: "Measurement grant expired or revoked" });
  if (!grant.eventTypes.includes(event.eventType) || grant.destination !== event.destination || grant.purpose !== event.purpose) return failure({ code: "forbidden", message: "Measurement grant purpose or event mismatch" });
  return success({ value: undefined });
}
function conversionData(required: { dependencies: Dependencies; event: ConversionEvent }): Outcome<void> {
  const { dependencies, event } = required;
  const binding = dependencies.binding;
  if (binding.mode !== "production") return failure({ code: "unavailable", message: "Conversions require always-on production host mode" });
  if (event.adUserData !== "GRANTED") return failure({ code: "forbidden", message: "Ad user data consent is absent" });
  if (!event.gclid && !event.hashedEmail && !event.hashedPhoneNumber) return failure({ code: "invalid_input", message: "Conversion has no supported identifier" });
  if (event.currency !== binding.currency || event.occurredAt > dependencies.now({})) return failure({ code: "invalid_input", message: "Invalid conversion currency or future event" });
  if (BigInt(event.valueMicros) > BigInt(Number.MAX_SAFE_INTEGER)) return failure({ code: "limit_exceeded", message: "Conversion value exceeds safe precision" });
  return success({ value: undefined });
}
/** Exact Google ClickConversion mapping. adPersonalization is NOT supported by this
 * API path and is not emitted. GCLID/orderId/time remain stable across attempts. */
export function mapConversion(required: { binding: AccountBinding; configuration: ConversionConfiguration; event: ConversionEvent }): Record<string, unknown> {
  const { binding, configuration, event } = required;
  const userIdentifiers = [];
  if (event.hashedEmail) userIdentifiers.push({ hashedEmail: event.hashedEmail });
  if (event.hashedPhoneNumber) userIdentifiers.push({ hashedPhoneNumber: event.hashedPhoneNumber });
  const conversion: Record<string, unknown> = {
    conversionAction: `customers/${binding.customerId}/conversionActions/${configuration.actionIds[event.eventType]}`,
    conversionDateTime: new Date(event.occurredAt).toISOString().slice(0, 19).replace("T", " ") + "+00:00",
    conversionValue: Number(BigInt(event.valueMicros)) / 1000000, currencyCode: event.currency,
    orderId: event.eventId, consent: { adUserData: event.adUserData }, userIdentifiers,
  };
  if (event.gclid) conversion.gclid = event.gclid;
  return { conversions: [conversion], partialFailure: true, validateOnly: false };
}
async function upload(required: { transport: GoogleTransportPort; mapping: Record<string, unknown>; context: CallContext; deliveryId: string }): Promise<Outcome<{ status: "delivered" | "unknown" }>> {
  const response = await required.transport.request({ method: "upload", body: required.mapping, context: required.context, operationId: required.deliveryId });
  if (!response.ok) return success({ value: { status: "unknown" } });
  const body = asRecord({ value: response.value });
  if (body.partialFailureError || !Array.isArray(body.results) || body.results.length !== 1) return success({ value: { status: "unknown" } });
  const result = asRecord({ value: body.results[0] });
  const conversion = (required.mapping.conversions as Record<string, unknown>[])[0];
  if (result.conversionAction !== conversion.conversionAction || result.conversionDateTime !== conversion.conversionDateTime) return success({ value: { status: "unknown" } });
  return success({ value: { status: "delivered" } });
}
/** Google normalization before SHA-256; a typed backend may prepare hashes locally.
 * @example hashEmail({ email: "First.Last@gmail.com" }) */
export function hashEmail(required: { email: string }): Outcome<string> {
  const email = required.email.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return failure({ code: "invalid_input", message: "Invalid email identifier" });
  const [local, domain] = email.split("@");
  const normalized = ["gmail.com", "googlemail.com"].includes(domain) ? local.replaceAll(".", "") + "@" + domain : email;
  return success({ value: createHash("sha256").update(normalized).digest("hex") });
}
/** Phone normalization requires a supplied E.164 number; guessing region is forbidden. */
export function hashPhone(required: { e164: string }): Outcome<string> {
  const phone = required.e164.trim();
  if (!/^\+[1-9][0-9]{7,14}$/.test(phone)) return failure({ code: "invalid_input", message: "Phone identifier must be E.164" });
  return success({ value: createHash("sha256").update(phone).digest("hex") });
}

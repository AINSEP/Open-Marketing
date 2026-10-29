import { createHash } from "node:crypto";
import { z } from "zod";
import { appErrorSchema, callContextSchema, digestSchema, epochSchema, idSchema, measurementGrantSchema, moneySchema, parseBoundary, scopeSchema, timeWindowSchema } from "@open-marketing/contracts";
import type { AppError, CallContext, IdPort, Outcome, Scope } from "@open-marketing/contracts";
import type { ConversionInput, VerifiedConversionSource } from "./types.js";
import { conversionDiagnosticsSchema, conversionDeliveryOutcomeSchema, conversionSchema, sourceSchema } from "./types.js";

export { conversionSchema, sourceSchema } from "./types.js";

const boundedString = z.string().min(1).max(1024);
const identifierMap = z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/), boundedString).refine(value => Object.keys(value).length <= 16);
export const measureGrantSchema = measurementGrantSchema;
/** Strict mutation inputs shared by memory and SQL grant stores. */
export const grantInputSchema = z.strictObject({ context: callContextSchema, grant: measureGrantSchema });
export const revokeInputSchema = z.strictObject({ context: callContextSchema, grantId: idSchema });
/** Strict schemas reject extra authority and platform totals rather than stripping them. */
export const resolvedConversionSchema = conversionSchema.extend({ identifiers: identifierMap });
export const identifierLookupSchema = z.strictObject({ subjectId: idSchema, identifiers: identifierMap, identifierDigests: conversionSchema.shape.identifierDigests });
export const linkRequestSchema = z.strictObject({ destinationUrl: z.string().min(1).max(4096), campaignId: idSchema, utm: z.record(z.string().regex(/^utm_(source|medium|campaign|term|content)$/), z.string().min(1).max(256)).refine(value => Object.keys(value).length <= 5) });
export const linkInputSchema = z.strictObject({ context: callContextSchema, request: linkRequestSchema });
export const querySchema = z.strictObject({ definitionId: idSchema, accountId: idSchema, attributionWindow: idSchema, window: timeWindowSchema, currency: z.string().regex(/^[A-Z]{3}$/), timezone: idSchema, attributionModel: idSchema });
export const reportInputSchema = z.strictObject({ context: callContextSchema, query: querySchema });
export const snapshotSchema = z.strictObject({ snapshotId: idSchema, accountId: idSchema, window: timeWindowSchema, spend: moneySchema, timezone: idSchema, attributionWindow: idSchema, retrievedAt: epochSchema, restatementOf: idSchema.optional() });
export const attributionSchema = z.strictObject({ resultId: idSchema, eventId: idSchema, modelVersion: idSchema, accountId: idSchema, campaignId: idSchema.nullable() });
export const attributionInputSchema = z.strictObject({ context: callContextSchema, sourceId: idSchema, result: attributionSchema });
export const summarySchema = z.strictObject({ conversions: epochSchema, modelVersion: idSchema, watermark: epochSchema });
export const receiptSchema = z.strictObject({ eventId: idSchema, status: z.enum(["accepted", "duplicate"]), jobId: idSchema });
export const dispatchRecordSchema = z.strictObject({ deliveryId: idSchema, subjectId: idSchema, eventId: idSchema, identity: digestSchema, status: z.enum(["dispatching", "delivered", "unknown", "not_sent"]), recordedAt: epochSchema, diagnostics: conversionDiagnosticsSchema.optional(), reason: appErrorSchema.shape.code.optional(), receiptId: idSchema.optional() });
export const auditInputSchema = z.strictObject({ context: callContextSchema, operationId: idSchema, outcome: idSchema });
export const claimSchema = z.strictObject({ acquired: z.boolean(), record: dispatchRecordSchema });
export const deliveryStatusSchema = conversionDeliveryOutcomeSchema;
export const assessmentSchema = z.strictObject({ allowed: z.boolean(), reason: z.string().max(256).optional() });
export const authenticationSchema = z.strictObject({ authenticated: z.boolean() });
export const verificationSchema = z.strictObject({ verified: z.boolean() });
export const serviceContextSchema = z.strictObject({ scope: scopeSchema, serviceId: idSchema, correlationId: idSchema, traceId: idSchema });
export const deliveryStateInputSchema = z.object({ context: serviceContextSchema, record: dispatchRecordSchema });
/** Parse both halves before deriving context or performing I/O. Reject a source's
 * contradictory context at every repo/jobs boundary as well as at ingress.
 * @complexity O(k) time/space for the bounded identifier map. */
export function parseSourceEvent(required: { input: { source: VerifiedConversionSource; event: ConversionInput } }): Outcome<{ source: VerifiedConversionSource; event: ConversionInput }> {
  const parsed = parseBoundary({ schema: z.strictObject({ source: sourceSchema, event: conversionSchema }), input: required.input });
  if (!parsed.ok) return parsed;
  const context = parsed.value.source.context;
  if (context && !sameScope({ left: context.scope, right: parsed.value.source.scope })) return failure({ code: "forbidden", message: "Source context scope mismatch" });
  return parsed;
}

/** Controlled error; payload/vendor exception text never escapes. */
export function failure<T>(required: { code: AppError["code"]; message: string; retryable?: boolean }): Outcome<T> {
  return { ok: false, error: { code: required.code, message: required.message, retryable: required.retryable ?? false } };
}
/** Digest-only canonical event identity; digest insertion order is irrelevant.
 * @complexity O(k log k) time/O(k) space for at most 16 keys. */
export function eventIdentity(required: { event: ConversionInput }): string {
  const event = required.event;
  const digests = Object.keys(event.identifierDigests).sort().map(key => [key, event.identifierDigests[key]]);
  const value = event.value ? [event.value.currency, event.value.minorUnits] : null;
  return createHash("sha256").update(JSON.stringify([event.eventId, event.definitionId, event.subjectId, event.occurredAt, event.destination, event.purpose, digests, value, event.orderRef ?? null])).digest("hex");
}
export function scopeKey(required: { scope: Scope }): string { return JSON.stringify([required.scope.ownerId, required.scope.workspaceId]); }
export function conversionKey(required: { source: VerifiedConversionSource; event: ConversionInput }): string {
  return JSON.stringify([scopeKey({ scope: required.source.scope }), required.source.sourceId, required.event.eventId]);
}
export function sameScope(required: { left: Scope; right: Scope }): boolean { return scopeKey({ scope: required.left }) === scopeKey({ scope: required.right }); }
/** Preserve server trace evidence; context-free callers receive event correlation,
 * never a fabricated agent session. Production ingress should always supply context. */
export function ingestionContext(required: { source: VerifiedConversionSource; event: ConversionInput }): CallContext {
  return required.source.context ?? { scope: required.source.scope, principal: { kind: "service", serviceId: required.source.sourceId }, correlationId: required.event.eventId, traceId: required.event.eventId };
}
export function validTimezone(required: { timezone: string }): boolean {
  try { new Intl.DateTimeFormat("en", { timeZone: required.timezone }); return true; }
  catch { return false; }
}
/** Detach domain data so caller mutation cannot alter stored evidence. */
export function clone<T>(required: { value: T }): T { return structuredClone(required.value); }
/** Invalid limits deny storage; caller config cannot accidentally create an
 * unbounded double via NaN/Infinity. @complexity O(1). */
export function storageLimit(required: { maxRecords?: number }): number {
  const value = required.maxRecords ?? 10000;
  return Number.isSafeInteger(value) && value >= 0 && value <= 100000 ? value : 0;
}
/** Translate ID-generator failure and validate its output before committing state.
 * @complexity One injected ID call and bounded string validation. */
export function nextId(required: { ids?: IdPort; fallback: string }): Outcome<string> {
  try {
    let value = required.fallback;
    if (required.ids) value = required.ids.next({});
    return parseBoundary({ schema: idSchema, input: value });
  }
  catch { return failure({ code: "unavailable", message: "Measurement ID allocation failed" }); }
}

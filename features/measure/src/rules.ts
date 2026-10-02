import { z } from "zod";
import { callContextSchema, epochSchema, idSchema, moneySchema, scopeSchema, timeWindowSchema } from "@open-marketing/contracts";
import type { AppError, CallContext, Outcome, Scope } from "@open-marketing/contracts";
import type { ConversionInput, VerifiedConversionSource } from "./types.js";

const boundedString = z.string().min(1).max(1024);
const identifierMap = z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/), boundedString).refine(value => Object.keys(value).length <= 16);
/** Strict schemas reject extra authority and platform totals rather than stripping them. */
export const conversionSchema = z.strictObject({ eventId: idSchema, eventType: z.enum(["signup", "trial"]), subjectId: idSchema, occurredAt: epochSchema, destination: idSchema, purpose: idSchema, identifiers: identifierMap });
export const sourceSchema = z.strictObject({ sourceId: idSchema, scope: scopeSchema, authenticationRevision: epochSchema, context: callContextSchema.optional() });
export const linkRequestSchema = z.strictObject({ destinationUrl: z.string().min(1).max(4096), campaignId: idSchema, utm: z.record(z.string().regex(/^utm_(source|medium|campaign|term|content)$/), z.string().min(1).max(256)).refine(value => Object.keys(value).length <= 5) });
export const querySchema = z.strictObject({ window: timeWindowSchema, currency: z.string().regex(/^[A-Z]{3}$/), timezone: idSchema, attributionModel: idSchema });
export const snapshotSchema = z.strictObject({ snapshotId: idSchema, accountId: idSchema, window: timeWindowSchema, spend: moneySchema, timezone: idSchema, attributionWindow: idSchema, retrievedAt: epochSchema, restatementOf: idSchema.optional() });
export const attributionSchema = z.strictObject({ resultId: idSchema, eventId: idSchema, modelVersion: idSchema, campaignId: idSchema.nullable() });
export const summarySchema = z.strictObject({ conversions: epochSchema, modelVersion: idSchema, watermark: epochSchema });
export const receiptSchema = z.strictObject({ eventId: idSchema, status: z.enum(["accepted", "duplicate"]), jobId: idSchema });
export const dispatchRecordSchema = z.strictObject({ deliveryId: idSchema, identity: z.string().min(1).max(32768), status: z.enum(["dispatching", "delivered", "unknown"]), recordedAt: epochSchema });
export const deliveryStatusSchema = z.strictObject({ status: z.enum(["delivered", "unknown"]) });
export const assessmentSchema = z.strictObject({ allowed: z.boolean(), reason: z.string().max(256).optional() });
export const authenticationSchema = z.strictObject({ authenticated: z.boolean() });
export const serviceContextSchema = z.strictObject({ scope: scopeSchema, serviceId: idSchema, correlationId: idSchema, traceId: idSchema });

/** Controlled error; payload/vendor exception text never escapes. */
export function failure<T>(required: { code: AppError["code"]; message: string; retryable?: boolean }): Outcome<T> {
  return { ok: false, error: { code: required.code, message: required.message, retryable: required.retryable ?? false } };
}
/** Canonical flat event identity; identifier insertion order is irrelevant.
 * @complexity O(k log k) time/O(k) space for at most 16 keys. */
export function eventIdentity(required: { event: ConversionInput }): string {
  const event = required.event;
  const identifiers = Object.keys(event.identifiers).sort().map(key => [key, event.identifiers[key]]);
  return JSON.stringify([event.eventId, event.eventType, event.subjectId, event.occurredAt, event.destination, event.purpose, identifiers]);
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

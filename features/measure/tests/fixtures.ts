import { z } from "zod";
import { idSchema, parseBoundary } from "@open-marketing/contracts";
import { serviceContextSchema, failure, sameScope } from "../src/rules.js";
import type { CallContext, IdPort, ServiceContext } from "@open-marketing/contracts";
import type { ConversionIdentifiersPort, MeasureGrant, ResolvedConversionInput, CacQuery, ConversionInput, PlatformMetricSnapshot, VerifiedConversionSource } from "../index.js";
import type { MemoryConsentEvidence } from "../index.js";
export const scope = { ownerId: "owner", workspaceId: "workspace" };
export const context: CallContext = { scope, principal: { kind: "service", serviceId: "measure" }, correlationId: "correlation", traceId: "trace" };
export const serviceContext: ServiceContext = { scope, serviceId: "measure-worker", correlationId: "correlation", traceId: "trace" };
export const source: VerifiedConversionSource = { sourceId: "signup-api", scope, authenticationRevision: 1, context };
export const event: ConversionInput = { eventId: "signup-1", definitionId: "signup", subjectId: "subject-1", occurredAt: 100, destination: "account:google", purpose: "conversion_measurement", identifierDigests: { click_id: "a".repeat(64) } };
export const query: CacQuery = { definitionId: "signup", accountId: "account-1", attributionWindow: "30d_click", window: { start: 100, end: 200 }, currency: "USD", timezone: "America/Los_Angeles", attributionModel: "last_touch_v1" };
export const snapshot: PlatformMetricSnapshot = { snapshotId: "snapshot-1", accountId: "account-1", window: query.window, spend: { minorUnits: 600, currency: "USD" }, timezone: query.timezone, attributionWindow: "30d_click", retrievedAt: 300 };
export const grant: MeasureGrant = { kind: "measurement", grantId: "grant-1", scope, connectionId: "connection-1", accountId: "account-1", definitionIds: ["signup", "trial"], destination: event.destination, purpose: event.purpose, payloadSchema: "om.conversion", payloadVersion: 1, expiresAt: 1000, revoked: false };
export const consent: MemoryConsentEvidence = { scope, subjectId: event.subjectId, destination: event.destination, purpose: event.purpose, identifierKeys: ["click_id"], expiresAt: 1000, withdrawn: false };
/** IDs are injected and deterministic; no system clock or randomness in fixtures. */
export function createIds(required: { prefix?: string }): IdPort {
  let sequence = 0;
  return { next() { return (required.prefix ?? "id") + "-" + ++sequence; } };
}

export const resolvedEvent: ResolvedConversionInput = { ...event, identifiers: { click_id: "click-1" } };
const lookupInputSchema = z.strictObject({ context: serviceContextSchema, subjectId: idSchema, destination: idSchema, purpose: idSchema });
/** Scoped contacts lookup double; replace(null) models erasure without changing evidence.
 * Contacts' normalization/hash behavior is deliberately outside this fixture. */
export function createIdentifiers(required: { event?: ResolvedConversionInput }): ConversionIdentifiersPort & { replace(required: { event: ResolvedConversionInput | null }): void } {
  let current: ResolvedConversionInput | null = structuredClone(required.event ?? resolvedEvent);
  return {
    replace(input) { current = structuredClone(input.event); },
    async identifiersFor(input) {
      const parsed = parseBoundary({ schema: lookupInputSchema, input });
      if (!parsed.ok) return parsed;
      const value = parsed.value;
      if (!current || !sameScope({ left: scope, right: value.context.scope }) || current.subjectId !== value.subjectId || current.destination !== value.destination || current.purpose !== value.purpose) return failure({ code: "forbidden", message: "Current identifiers unavailable" });
      return { ok: true, value: structuredClone({ subjectId: current.subjectId, identifiers: current.identifiers, identifierDigests: current.identifierDigests }) };
    },
  };
}

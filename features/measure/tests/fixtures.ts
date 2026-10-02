import type { CallContext, IdPort, MeasurementGrant, ServiceContext } from "@open-marketing/contracts";
import type { CacQuery, ConversionInput, PlatformMetricSnapshot, VerifiedConversionSource } from "../index.js";
import type { MemoryConsentEvidence } from "../index.js";
export const scope = { ownerId: "owner", workspaceId: "workspace" };
export const context: CallContext = { scope, principal: { kind: "service", serviceId: "measure" }, correlationId: "correlation", traceId: "trace" };
export const serviceContext: ServiceContext = { scope, serviceId: "measure-worker", correlationId: "correlation", traceId: "trace" };
export const source: VerifiedConversionSource = { sourceId: "signup-api", scope, authenticationRevision: 1, context };
export const event: ConversionInput = { eventId: "signup-1", eventType: "signup", subjectId: "subject-1", occurredAt: 100, destination: "account:google", purpose: "conversion_measurement", identifiers: { click_id: "click-1" } };
export const query: CacQuery = { window: { start: 100, end: 200 }, currency: "USD", timezone: "America/Los_Angeles", attributionModel: "last_touch_v1" };
export const snapshot: PlatformMetricSnapshot = { snapshotId: "snapshot-1", accountId: "account-1", window: query.window, spend: { minorUnits: 600, currency: "USD" }, timezone: query.timezone, attributionWindow: "30d_click", retrievedAt: 300 };
export const grant: MeasurementGrant = { kind: "measurement", grantId: "grant-1", scope, connectionId: "connection-1", accountId: "account-1", eventTypes: ["signup", "trial"], destination: event.destination, purpose: event.purpose, payloadSchema: "om.conversion", payloadVersion: 1, expiresAt: 1000, revoked: false };
export const consent: MemoryConsentEvidence = { scope, subjectId: event.subjectId, destination: event.destination, purpose: event.purpose, identifierKeys: ["click_id"], expiresAt: 1000, withdrawn: false };
/** IDs are injected and deterministic; no system clock or randomness in fixtures. */
export function createIds(required: { prefix?: string }): IdPort {
  let sequence = 0;
  return { next() { return (required.prefix ?? "id") + "-" + ++sequence; } };
}

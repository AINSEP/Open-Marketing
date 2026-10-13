import { parseBoundary } from "@open-marketing/contracts";
import type { CallContext, CallOptions, ClockPort, Outcome, ServiceContext } from "@open-marketing/contracts";
import type { ConversionIdentifiersPort, ConversionDeliveryPort, ConversionDeliveryStatePort, ConversionVerificationPort, MeasureAuditPort, MeasurementGrantPort, MeasurementShareabilityPort, MeasureObserverPort } from "../ports.js";
import type { ConversionDispatcher, ConversionDispatchRecord, ConversionInput, MeasureGrant } from "../types.js";
import { runBoundary } from "../boundary.js";
import { assessmentSchema, claimSchema, deliveryStatusSchema, dispatchRecordSchema, eventIdentity, failure, identifierLookupSchema, measureGrantSchema, sameScope, verificationSchema } from "../rules.js";
import { deliveryIdentity, parseDeliveryInput, parseResolvedDeliveryInput } from "./input.js";

import type { ResolvedDeliveryInput } from "./input.js";

type DispatchInput = { context: ServiceContext; event: ConversionInput; grant: MeasureGrant; deliveryId: string };
type Dependencies = { identifiers: ConversionIdentifiersPort; delivery: ConversionDeliveryPort; ledger: ConversionDeliveryStatePort; verification: ConversionVerificationPort; policy: MeasurementShareabilityPort; grants: MeasurementGrantPort; audit: MeasureAuditPort; clock: ClockPort; runtimeMode: "production-server" | "local-sandbox" | "read-only"; payloadSchema: string };
/** Independent typed server worker. No agent/studio grant, generic export or MCP path.
 * Claims persist before egress; interrupted/unknown claims only reconcile. Audit and
 * current consent/grant gates run immediately before every capability call.
 * @example createConversionDispatcher({ identifiers, delivery, ledger, verification, policy, grants, audit, clock, runtimeMode: "production-server", payloadSchema: "om.conversion" })
 * @complexity O(k) bounded payload; O(1) ledger calls, no internal retries. */
export function createConversionDispatcher(required: Dependencies, optional?: { observer?: MeasureObserverPort }): ConversionDispatcher {
  return {
    async dispatch(input, options) {
      const parsed = parseDeliveryInput({ input });
      if (!parsed.ok) return parsed;
      const context = auditContext({ context: parsed.value.context });
      return runBoundary({ operation: "measure.dispatchConversion", context, observer: optional?.observer, work: () => dispatchOnce({ dependencies: required, input: parsed.value }, options) }, options);
    },
  };
}
async function dispatchOnce(required: { dependencies: Dependencies; input: DispatchInput }, optional?: CallOptions): Promise<Outcome<{ status: "delivered" | "unknown" }>> {
  const deps = required.dependencies;
  if (deps.runtimeMode !== "production-server") return failure({ code: "forbidden", message: "Production conversion delivery requires the always-on server" });
  const verified = await verifyConversion({ dependencies: deps, input: required.input }, optional);
  if (!verified.ok) return verified;
  const eligible = await checkAuthority({ dependencies: deps, input: required.input }, optional);
  if (!eligible.ok) return eligible;
  const resolved = await resolveIdentifiers(required, optional);
  if (!resolved.ok) return resolved;
  const record: ConversionDispatchRecord = { deliveryId: required.input.deliveryId, subjectId: required.input.event.subjectId, eventId: required.input.event.eventId, identity: deliveryIdentity({ input: required.input }), status: "dispatching", recordedAt: deps.clock.now({}) };
  const claimed = await claimDelivery({ dependencies: deps, input: required.input, record }, optional);
  if (!claimed.ok) return claimed;
  if (!claimed.value.acquired && claimed.value.record.status === "delivered") return { ok: true, value: { status: "delivered" } };
  const action = claimed.value.acquired ? "dispatch" : "reconcile";
  const authorized = await authorizeEgress({ ...required, record, action }, optional);
  if (!authorized.ok) return authorized;
  return perform({ dependencies: deps, input: resolved.value, record, action }, optional);
}
/** Resolve current contacts evidence before final gates. Contacts alone normalizes/hashes;
 * measure compares committed digests and never persists the resolved identifiers.
 * @complexity One lookup; O(k log k) comparison for at most 16 keys. */
async function resolveIdentifiers(required: { dependencies: Dependencies; input: DispatchInput }, optional?: CallOptions): Promise<Outcome<ResolvedDeliveryInput>> {
  const event = required.input.event;
  const outcome = await required.dependencies.identifiers.identifiersFor({ context: required.input.context, subjectId: event.subjectId, destination: event.destination, purpose: event.purpose }, optional);
  if (!outcome.ok) return outcome;
  const parsed = parseBoundary({ schema: identifierLookupSchema, input: outcome.value });
  if (!parsed.ok) return parsed;
  const evidence = parsed.value;
  const resolved = { ...event, identifierDigests: evidence.identifierDigests };
  if (evidence.subjectId !== event.subjectId || eventIdentity({ event: resolved }) !== eventIdentity({ event })) return failure({ code: "forbidden", message: "Identifier evidence does not match the committed event" });
  return parseResolvedDeliveryInput({ input: { ...required.input, event: { ...event, identifiers: evidence.identifiers } } });
}
/** Audit before the final authority read; do not await another external operation
 * between those gates and capability invocation. @complexity Two gates and one audit. */
async function authorizeEgress(required: { dependencies: Dependencies; input: DispatchInput; record: ConversionDispatchRecord; action: "dispatch" | "reconcile" }, optional?: CallOptions): Promise<Outcome<void>> {
  const audit = await required.dependencies.audit.record({ context: auditContext({ context: required.input.context }), operationId: required.record.deliveryId, outcome: required.action + "_pending" }, optional);
  if (!audit.ok) return audit;
  const current = await checkAuthority(required, optional);
  if (!current.ok) return current;
  if (optional?.signal?.aborted) return failure({ code: "cancelled", message: "Conversion delivery cancelled before egress" });
  return { ok: true, value: undefined };
}
/** Only committed events reach the grant/consent/claim path. @complexity One indexed inbox read. */
async function verifyConversion(required: { dependencies: Dependencies; input: DispatchInput }, optional?: CallOptions): Promise<Outcome<void>> {
  const outcome = await required.dependencies.verification.verify({ context: required.input.context, event: required.input.event }, optional);
  if (!outcome.ok) return outcome;
  const parsed = parseBoundary({ schema: verificationSchema, input: outcome.value });
  if (!parsed.ok) return parsed;
  if (!parsed.value.verified) return failure({ code: "forbidden", message: "Conversion is not in the verified inbox" });
  return { ok: true, value: undefined };
}
/** Reject tainted ledger evidence before it can select send versus reconciliation.
 * @complexity O(k) bounded identity comparison; one durable claim call. */
async function claimDelivery(required: { dependencies: Dependencies; input: DispatchInput; record: ConversionDispatchRecord }, optional?: CallOptions): Promise<Outcome<{ acquired: boolean; record: ConversionDispatchRecord }>> {
  const outcome = await required.dependencies.ledger.begin({ context: required.input.context, record: required.record }, optional);
  if (!outcome.ok) return outcome;
  const parsed = parseBoundary({ schema: claimSchema, input: outcome.value });
  if (!parsed.ok) return parsed;
  const record = parsed.value.record;
  if (record.deliveryId !== required.record.deliveryId || record.identity !== required.record.identity || record.subjectId !== required.record.subjectId || record.eventId !== required.record.eventId) return failure({ code: "conflict", message: "Delivery claim identity mismatch" });
  if (parsed.value.acquired && record.status !== "dispatching") return failure({ code: "conflict", message: "Acquired delivery claim is not dispatching" });
  return parsed;
}
/** Refresh BOTH consent and grant. Requested grant never overrides current authority. */
async function checkAuthority(required: { dependencies: Dependencies; input: DispatchInput }, optional?: CallOptions): Promise<Outcome<void>> {
  const deps = required.dependencies;
  const current = await deps.grants.current({ context: required.input.context, grantId: required.input.grant.grantId }, optional);
  if (!current.ok) return current;
  const parsed = parseBoundary({ schema: measureGrantSchema, input: current.value });
  if (!parsed.ok) return parsed;
  const gate = validateGrant({ grant: parsed.value, input: required.input, now: deps.clock.now({}), payloadSchema: deps.payloadSchema });
  if (!gate.ok) return gate;
  const assessed = await deps.policy.assess({ context: auditContext({ context: required.input.context }), event: required.input.event }, optional);
  if (!assessed.ok) return assessed;
  const consent = parseBoundary({ schema: assessmentSchema, input: assessed.value });
  if (!consent.ok) return consent;
  if (!consent.value.allowed) return failure({ code: "forbidden", message: "Measurement consent withdrawn or unavailable" });
  return { ok: true, value: undefined };
}
function validateGrant(required: { grant: MeasureGrant; input: DispatchInput; now: number; payloadSchema: string }): Outcome<void> {
  const grant = required.grant;
  const input = required.input;
  if (grant.revoked || grant.expiresAt <= required.now) return failure({ code: "forbidden", message: "Measurement grant expired or revoked" });
  if (!sameScope({ left: grant.scope, right: input.context.scope })) return failure({ code: "forbidden", message: "Measurement grant scope mismatch" });
  if (grant.destination !== input.event.destination || grant.purpose !== input.event.purpose || !grant.definitionIds.includes(input.event.definitionId)) return failure({ code: "forbidden", message: "Measurement grant does not cover the event" });
  if (grant.payloadSchema !== required.payloadSchema || grant.payloadVersion !== 1) return failure({ code: "forbidden", message: "Measurement payload schema is not authorized" });
  if (grantFingerprint({ grant }) !== grantFingerprint({ grant: input.grant })) return failure({ code: "forbidden", message: "Measurement grant changed since enqueue" });
  return { ok: true, value: undefined };
}
function grantFingerprint(required: { grant: MeasureGrant }): string {
  const grant = required.grant;
  return JSON.stringify([grant.kind, grant.grantId, grant.scope.ownerId, grant.scope.workspaceId, grant.connectionId, grant.accountId, [...grant.definitionIds].sort(), grant.destination, grant.purpose, grant.payloadSchema, grant.payloadVersion, grant.expiresAt, grant.revoked]);
}
/** Any thrown/failed/malformed capability outcome is uncertain after possible egress. */
async function perform(required: { dependencies: Dependencies; input: ResolvedDeliveryInput; record: ConversionDispatchRecord; action: "dispatch" | "reconcile" }, optional?: CallOptions): Promise<Outcome<{ status: "delivered" | "unknown" }>> {
  const result = await invokeCapability(required, optional);
  const status = result.ok ? result.value.status : "unknown";
  // Cancellation stops egress, but cannot discard evidence after possible egress.
  const recorded = await required.dependencies.ledger.append({ context: required.input.context, record: { ...required.record, status, recordedAt: required.dependencies.clock.now({}) } });
  if (!recorded.ok) return recorded;
  const evidence = parseBoundary({ schema: dispatchRecordSchema, input: recorded.value });
  if (!evidence.ok) return evidence;
  if (evidence.value.deliveryId !== required.record.deliveryId || evidence.value.identity !== required.record.identity || evidence.value.status !== status || evidence.value.subjectId !== required.record.subjectId || evidence.value.eventId !== required.record.eventId) return failure({ code: "conflict", message: "Delivery outcome evidence mismatch" });
  const audit = await required.dependencies.audit.record({ context: auditContext({ context: required.input.context }), operationId: required.record.deliveryId, outcome: required.action + "_" + status });
  if (!audit.ok) return audit;
  return { ok: true, value: { status } };
}
async function invokeCapability(required: { dependencies: Dependencies; input: ResolvedDeliveryInput; action: "dispatch" | "reconcile" }, optional?: CallOptions): Promise<Outcome<{ status: "delivered" | "unknown" }>> {
  try {
    const port = required.dependencies.delivery;
    if (required.action === "reconcile" && !port.reconcile) return { ok: true, value: { status: "unknown" } };
    const result = required.action === "dispatch" ? await port.deliver(required.input, optional) : await port.reconcile!(required.input, optional);
    if (!result.ok) return result;
    return parseBoundary({ schema: deliveryStatusSchema, input: result.value });
  } catch { return { ok: true, value: { status: "unknown" } }; }
}
function auditContext(required: { context: ServiceContext }): CallContext {
  return { scope: required.context.scope, principal: { kind: "service", serviceId: required.context.serviceId }, correlationId: required.context.correlationId, traceId: required.context.traceId };
}

import { idSchema, measurementGrantSchema, parseBoundary } from "@open-marketing/contracts";
import type { CallContext, CallOptions, ClockPort, MeasurementGrant, Outcome, ServiceContext } from "@open-marketing/contracts";
import type { ConversionDeliveryPort, ConversionDeliveryStatePort, MeasureAuditPort, MeasurementGrantPort, MeasurementShareabilityPort, MeasureObserverPort } from "../ports.js";
import type { ConversionDispatcher, ConversionDispatchRecord, ConversionInput } from "../types.js";
import { runBoundary } from "../boundary.js";
import { assessmentSchema, conversionSchema, deliveryStatusSchema, eventIdentity, failure, sameScope, serviceContextSchema } from "../rules.js";

type DispatchInput = { context: ServiceContext; event: ConversionInput; grant: MeasurementGrant; deliveryId: string };
type Dependencies = { delivery: ConversionDeliveryPort; ledger: ConversionDeliveryStatePort; policy: MeasurementShareabilityPort; grants: MeasurementGrantPort; audit: MeasureAuditPort; clock: ClockPort; runtimeMode: "production-server" | "local-sandbox" | "read-only"; payloadSchema: string };
/** Independent typed server worker. No agent/studio grant, generic export or MCP path.
 * Claims persist before egress; interrupted/unknown claims only reconcile. Audit and
 * current consent/grant gates run immediately before every capability call.
 * @example createConversionDispatcher({ delivery, ledger, policy, grants, audit, clock, runtimeMode: "production-server", payloadSchema: "om.conversion" })
 * @complexity O(k) bounded payload; O(1) ledger calls, no internal retries. */
export function createConversionDispatcher(required: Dependencies, optional?: { observer?: MeasureObserverPort }): ConversionDispatcher {
  return {
    async dispatch(input, options) {
      const parsed = validateDispatch({ input });
      if (!parsed.ok) return parsed;
      const context = auditContext({ context: parsed.value.context });
      return runBoundary({ operation: "measure.dispatchConversion", context, observer: optional?.observer, work: () => dispatchOnce({ dependencies: required, input: parsed.value }, options) }, options);
    },
  };
}
function validateDispatch(required: { input: DispatchInput }): Outcome<DispatchInput> {
  const context = parseBoundary({ schema: serviceContextSchema, input: required.input.context });
  if (!context.ok) return context;
  const event = parseBoundary({ schema: conversionSchema, input: required.input.event });
  if (!event.ok) return event;
  const grant = parseBoundary({ schema: measurementGrantSchema, input: required.input.grant });
  if (!grant.ok) return grant;
  const deliveryId = parseBoundary({ schema: idSchema, input: required.input.deliveryId });
  if (!deliveryId.ok) return deliveryId;
  return { ok: true, value: { context: context.value, event: event.value, grant: grant.value, deliveryId: deliveryId.value } };
}
/** Immutable identity excludes trace and current time, which legitimately change on retries. */
function dispatchIdentity(required: { input: DispatchInput }): string {
  const input = required.input;
  return JSON.stringify([input.context.scope.ownerId, input.context.scope.workspaceId, input.grant.grantId, input.grant.connectionId, input.grant.accountId, input.grant.payloadSchema, input.grant.payloadVersion, eventIdentity({ event: input.event })]);
}
async function dispatchOnce(required: { dependencies: Dependencies; input: DispatchInput }, optional?: CallOptions): Promise<Outcome<{ status: "delivered" | "unknown" }>> {
  const deps = required.dependencies;
  if (deps.runtimeMode !== "production-server") return failure({ code: "forbidden", message: "Production conversion delivery requires the always-on server" });
  const eligible = await checkAuthority({ dependencies: deps, input: required.input }, optional);
  if (!eligible.ok) return eligible;
  const record: ConversionDispatchRecord = { deliveryId: required.input.deliveryId, identity: dispatchIdentity({ input: required.input }), status: "dispatching", recordedAt: deps.clock.now({}) };
  const claimed = await deps.ledger.begin({ context: required.input.context, record }, optional);
  if (!claimed.ok) return claimed;
  if (!claimed.value.acquired && claimed.value.record.status === "delivered") return { ok: true, value: { status: "delivered" } };
  const action = claimed.value.acquired ? "dispatch" : "reconcile";
  const audit = await deps.audit.record({ context: auditContext({ context: required.input.context }), operationId: record.deliveryId, outcome: action + "_pending" }, optional);
  if (!audit.ok) return audit;
  const current = await checkAuthority({ dependencies: deps, input: required.input }, optional);
  if (!current.ok) return current;
  if (optional?.signal?.aborted) return failure({ code: "cancelled", message: "Conversion delivery cancelled before egress" });
  return perform({ dependencies: deps, input: required.input, record, action }, optional);
}
/** Refresh BOTH consent and grant. Requested grant never overrides current authority. */
async function checkAuthority(required: { dependencies: Dependencies; input: DispatchInput }, optional?: CallOptions): Promise<Outcome<void>> {
  const deps = required.dependencies;
  const current = await deps.grants.current({ context: required.input.context, grantId: required.input.grant.grantId }, optional);
  if (!current.ok) return current;
  const parsed = parseBoundary({ schema: measurementGrantSchema, input: current.value });
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
function validateGrant(required: { grant: MeasurementGrant; input: DispatchInput; now: number; payloadSchema: string }): Outcome<void> {
  const grant = required.grant;
  const input = required.input;
  if (grant.revoked || grant.expiresAt <= required.now) return failure({ code: "forbidden", message: "Measurement grant expired or revoked" });
  if (!sameScope({ left: grant.scope, right: input.context.scope })) return failure({ code: "forbidden", message: "Measurement grant scope mismatch" });
  if (grant.destination !== input.event.destination || grant.purpose !== input.event.purpose || !grant.eventTypes.includes(input.event.eventType)) return failure({ code: "forbidden", message: "Measurement grant does not cover the event" });
  if (grant.payloadSchema !== required.payloadSchema || grant.payloadVersion !== 1) return failure({ code: "forbidden", message: "Measurement payload schema is not authorized" });
  if (grantFingerprint({ grant }) !== grantFingerprint({ grant: input.grant })) return failure({ code: "forbidden", message: "Measurement grant changed since enqueue" });
  return { ok: true, value: undefined };
}
function grantFingerprint(required: { grant: MeasurementGrant }): string {
  const grant = required.grant;
  return JSON.stringify([grant.kind, grant.grantId, grant.scope.ownerId, grant.scope.workspaceId, grant.connectionId, grant.accountId, [...grant.eventTypes].sort(), grant.destination, grant.purpose, grant.payloadSchema, grant.payloadVersion, grant.expiresAt, grant.revoked]);
}
/** Any thrown/failed/malformed capability outcome is uncertain after possible egress. */
async function perform(required: { dependencies: Dependencies; input: DispatchInput; record: ConversionDispatchRecord; action: "dispatch" | "reconcile" }, optional?: CallOptions): Promise<Outcome<{ status: "delivered" | "unknown" }>> {
  const result = await invokeCapability(required, optional);
  const status = result.ok ? result.value.status : "unknown";
  const recorded = await required.dependencies.ledger.append({ context: required.input.context, record: { ...required.record, status, recordedAt: required.dependencies.clock.now({}) } }, optional);
  if (!recorded.ok) return recorded;
  const audit = await required.dependencies.audit.record({ context: auditContext({ context: required.input.context }), operationId: required.record.deliveryId, outcome: required.action + "_" + status }, optional);
  if (!audit.ok) return audit;
  return { ok: true, value: { status } };
}
async function invokeCapability(required: { dependencies: Dependencies; input: DispatchInput; action: "dispatch" | "reconcile" }, optional?: CallOptions): Promise<Outcome<{ status: "delivered" | "unknown" }>> {
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

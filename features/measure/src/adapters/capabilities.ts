import { z } from "zod";
import { appErrorSchema, callContextSchema, parseBoundary } from "@open-marketing/contracts";
import type { Outcome } from "@open-marketing/contracts";
import type { ConversionDeliveryPort, ConversionSourceAuthenticationPort, MeasurementShareabilityPort, MeasureObserverPort, PlatformReportingPort } from "../ports.js";
import { runBoundary } from "../boundary.js";
import { parseDeliveryInput } from "../delivery/input.js";
import { assessmentSchema, authenticationSchema, conversionSchema, deliveryStatusSchema, querySchema, snapshotSchema, sourceSchema } from "../rules.js";

/** Parse the entire outcome, including failures, before trusting plugin output.
 * @complexity Schema-dependent bounded traversal, no external effects. */
async function capabilityOutcome<T>(required: { schema: z.ZodType<T>; work: () => Promise<Outcome<T>> }): Promise<Outcome<T>> {
  const schema = z.discriminatedUnion("ok", [z.strictObject({ ok: z.literal(true), value: required.schema }), z.strictObject({ ok: z.literal(false), error: appErrorSchema })]);
  const parsed = parseBoundary({ schema, input: await required.work() });
  if (!parsed.ok) return parsed;
  return parsed.value as Outcome<T>;
}

/** Typed server/plugin capability wrapper; credentials, guarded HTTP and provider
 * codecs belong to the injected plugin. Both send/reconcile validate detached inputs
 * and tainted outcomes; thrown effects are unavailable/uncertain, never retried here.
 * @example createConversionDeliveryAdapter({ capability }, { observer })
 * @complexity O(k) bounded payload; one capability call and no internal retry. */
export function createConversionDeliveryAdapter(required: { capability: ConversionDeliveryPort }, optional?: { observer?: MeasureObserverPort }): ConversionDeliveryPort {
  return {
    async deliver(input, options) {
      const parsed = parseDeliveryInput({ input });
      if (!parsed.ok) return parsed;
      const context = deliveryContext({ input: parsed.value });
      return runBoundary({ context, operation: "measure.capability.deliver", observer: optional?.observer, work: () => capabilityOutcome({ schema: deliveryStatusSchema, work: () => required.capability.deliver(parsed.value, options) }) }, options);
    },
    async reconcile(input, options) {
      const parsed = parseDeliveryInput({ input });
      if (!parsed.ok) return parsed;
      const context = deliveryContext({ input: parsed.value });
      return runBoundary({ context, operation: "measure.capability.reconcile", observer: optional?.observer, work: async () => {
        if (!required.capability.reconcile) return { ok: true, value: { status: "unknown" as const } };
        return capabilityOutcome({ schema: deliveryStatusSchema, work: () => required.capability.reconcile!(parsed.value, options) });
      } }, options);
    },
  };
}
function deliveryContext(required: { input: Parameters<ConversionDeliveryPort["deliver"]>[0] }) {
  const context = required.input.context;
  return { scope: context.scope, principal: { kind: "service" as const, serviceId: context.serviceId }, correlationId: context.correlationId, traceId: context.traceId };
}

/** Provider normalization stays outside measure; extra platform totals reject.
 * @complexity O(1) observation; one injected capability call. */
export function createPlatformReportingAdapter(required: { capability: PlatformReportingPort }, optional?: { observer?: MeasureObserverPort }): PlatformReportingPort {
  return {
    async snapshot(input, options) {
      const parsed = parseBoundary({ schema: z.strictObject({ context: callContextSchema, query: querySchema }), input });
      if (!parsed.ok) return parsed;
      return runBoundary({ context: parsed.value.context, operation: "measure.capability.snapshot", observer: optional?.observer, work: () => capabilityOutcome({ schema: snapshotSchema, work: () => required.capability.snapshot(parsed.value, options) }) }, options);
    },
  };
}

/** Trusted transport adapter authenticates scope/revision; this wrapper validates
 * its output and redacts thrown messages. @complexity One bounded source/port call. */
export function createConversionSourceAuthenticationAdapter(required: { capability: ConversionSourceAuthenticationPort }, optional?: { observer?: MeasureObserverPort }): ConversionSourceAuthenticationPort {
  return {
    async verify(input, options) {
      const parsed = parseBoundary({ schema: z.strictObject({ source: sourceSchema }), input });
      if (!parsed.ok) return parsed;
      const source = parsed.value.source;
      const context = source.context ?? { scope: source.scope, principal: { kind: "service" as const, serviceId: source.sourceId }, correlationId: source.sourceId, traceId: source.sourceId };
      return runBoundary({ context, operation: "measure.capability.authenticateSource", observer: optional?.observer, work: () => capabilityOutcome({ schema: authenticationSchema, work: () => required.capability.verify(parsed.value, options) }) }, options);
    },
  };
}

/** Canonical policy owns the decision. No inferred consent from hashing or an
 * admitted endpoint. @complexity O(k) bounded identifiers; one policy call. */
export function createMeasurementShareabilityAdapter(required: { capability: MeasurementShareabilityPort }, optional?: { observer?: MeasureObserverPort }): MeasurementShareabilityPort {
  return {
    async assess(input, options) {
      const parsed = parseBoundary({ schema: z.strictObject({ context: callContextSchema, event: conversionSchema }), input });
      if (!parsed.ok) return parsed;
      return runBoundary({ context: parsed.value.context, operation: "measure.capability.consent", observer: optional?.observer, work: () => capabilityOutcome({ schema: assessmentSchema, work: () => required.capability.assess(parsed.value, options) }) }, options);
    },
  };
}

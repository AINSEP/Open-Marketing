import { measurementGrantSchema, parseBoundary } from "@open-marketing/contracts";
import type { ConversionDeliveryPort, ConversionSourceAuthenticationPort, MeasurementShareabilityPort, PlatformReportingPort } from "../ports.js";
import { assessmentSchema, authenticationSchema, conversionSchema, deliveryStatusSchema, failure, querySchema, snapshotSchema, sourceSchema } from "../rules.js";

/** Wrap a trusted server/plugin-owned typed capability, validating all tainted results.
 * The plugin owns credentials/codecs/network deadlines and dispatch rechecks; this
 * wrapper adds no retry or generic tool path. @example createConversionDeliveryAdapter({ capability }) */
export function createConversionDeliveryAdapter(required: { capability: ConversionDeliveryPort }): ConversionDeliveryPort {
  return {
    async deliver(input, options) {
      const event = parseBoundary({ schema: conversionSchema, input: input.event });
      if (!event.ok) return event;
      const grant = parseBoundary({ schema: measurementGrantSchema, input: input.grant });
      if (!grant.ok) return grant;
      if (!input.deliveryId) return failure({ code: "invalid_input", message: "Stable delivery identity is required" });
      const result = await required.capability.deliver({ ...input, event: event.value, grant: grant.value }, options);
      if (!result.ok) return result;
      return parseBoundary({ schema: deliveryStatusSchema, input: result.value });
    },
    async reconcile(input, options) {
      if (!required.capability.reconcile) return { ok: true, value: { status: "unknown" } };
      const result = await required.capability.reconcile(input, options);
      if (!result.ok) return result;
      return parseBoundary({ schema: deliveryStatusSchema, input: result.value });
    },
  };
}
/** Bind provider normalization OUTSIDE measure core; extra platform conversion totals reject. */
export function createPlatformReportingAdapter(required: { capability: PlatformReportingPort }): PlatformReportingPort {
  return {
    async snapshot(input, options) {
      const query = parseBoundary({ schema: querySchema, input: input.query });
      if (!query.ok) return query;
      const result = await required.capability.snapshot({ ...input, query: query.value }, options);
      if (!result.ok) return result;
      return parseBoundary({ schema: snapshotSchema, input: result.value });
    },
  };
}
/** Transport authentication stays in a trusted adapter; current revision/scope must match. */
export function createConversionSourceAuthenticationAdapter(required: { capability: ConversionSourceAuthenticationPort }): ConversionSourceAuthenticationPort {
  return {
    async verify(input, options) {
      const source = parseBoundary({ schema: sourceSchema, input: input.source });
      if (!source.ok) return source;
      const result = await required.capability.verify({ source: source.value }, options);
      if (!result.ok) return result;
      return parseBoundary({ schema: authenticationSchema, input: result.value });
    },
  };
}
/** Validates canonical policy's tainted assessment without duplicating its decision rules. */
export function createMeasurementShareabilityAdapter(required: { capability: MeasurementShareabilityPort }): MeasurementShareabilityPort {
  return {
    async assess(input, options) {
      const event = parseBoundary({ schema: conversionSchema, input: input.event });
      if (!event.ok) return event;
      const result = await required.capability.assess({ ...input, event: event.value }, options);
      if (!result.ok) return result;
      return parseBoundary({ schema: assessmentSchema, input: result.value });
    },
  };
}

import { describe, expect, it } from "vitest";
import { createFakeClock } from "@open-marketing/om-clock";
import { ConversionDeliveryPortSuite, PlatformReportingPortSuite, ConversionSourceAuthenticationPortSuite, MeasurementShareabilityPortSuite } from "./port-suites.js";
import { createConversionDeliveryAdapter, createPlatformReportingAdapter, createConversionSourceAuthenticationAdapter, createMeasurementShareabilityAdapter, createMemoryConversionDelivery, createMemoryPlatformReporting, createMemoryConversionSourceAuthentication, createMemoryMeasurementShareability } from "../../index.js";
import { consent, context, event, grant, query, serviceContext, snapshot, source } from "../fixtures.js";
ConversionDeliveryPortSuite({ create: () => createConversionDeliveryAdapter({ capability: createMemoryConversionDelivery({}) }) });
PlatformReportingPortSuite({ create: () => createPlatformReportingAdapter({ capability: createMemoryPlatformReporting({ snapshot }) }) });
ConversionSourceAuthenticationPortSuite({ create: () => createConversionSourceAuthenticationAdapter({ capability: createMemoryConversionSourceAuthentication({ sources: [source] }) }) });
MeasurementShareabilityPortSuite({ create: () => createMeasurementShareabilityAdapter({ capability: createMemoryMeasurementShareability({ clock: createFakeClock({ initial: 300 }), evidence: [consent] }) }) });
describe("tainted local capability output", () => {
  it("rejects platform-attributed totals rather than silently summing them", async () => {
    const port = createPlatformReportingAdapter({ capability: { async snapshot() { return { ok: true, value: { ...snapshot, platformConversions: 500, otherPlatformConversions: 300 } }; } } });
    expect(await port.snapshot({ context, query })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });
  it("rejects extra egress authority and unknown schemas", async () => {
    const port = createConversionDeliveryAdapter({ capability: { async deliver() { return { ok: true, value: { status: "delivered", arbitraryExport: true } }; } } });
    expect(await port.deliver({ context: serviceContext, event, grant, deliveryId: "delivery" })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });
});

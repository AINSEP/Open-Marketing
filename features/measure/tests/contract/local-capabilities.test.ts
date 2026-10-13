import { describe, expect, it } from "vitest";
import { createConversionDeliveryAdapter, createPlatformReportingAdapter } from "../../index.js";
import { ConversionDeliveryPortSuite, PlatformReportingPortSuite } from "./port-suites.js";
import { createLocalCapabilityFixture } from "../local-capability-fixture.js";
import { resolvedEvent, grant, serviceContext } from "../fixtures.js";

ConversionDeliveryPortSuite({ create: async () => createConversionDeliveryAdapter({ capability: (await createLocalCapabilityFixture({})).delivery }) });
PlatformReportingPortSuite({ create: async () => createPlatformReportingAdapter({ capability: (await createLocalCapabilityFixture({})).reports }) });
describe("real local typed capability transport", () => {
  it("carries the worker trace across HTTP without an agent session", async () => {
    const fixture = await createLocalCapabilityFixture({});
    const delivery = createConversionDeliveryAdapter({ capability: fixture.delivery });
    expect(await delivery.deliver({ context: serviceContext, event: resolvedEvent, grant, deliveryId: "http-delivery" })).toEqual({ ok: true, value: { status: "delivered" } });
    expect(fixture.traces).toEqual([serviceContext.traceId]);
  });
});

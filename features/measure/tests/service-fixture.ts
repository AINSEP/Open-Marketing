import { createFakeClock } from "@open-marketing/om-clock";
import { createMeasureService, createMemoryMeasureRepo, createMemoryMeasurementShareability, createMemoryPlatformReporting, createMemoryTrackedLink, createMemoryConversionSourceAuthentication } from "../index.js";
import { consent, snapshot, source } from "./fixtures.js";

export function createServiceFixture(required: Record<string, never>) {
  const clock = createFakeClock({ initial: 300 });
  const repo = createMemoryMeasureRepo({});
  const policy = createMemoryMeasurementShareability({ clock, evidence: [consent] });
  const authentication = createMemoryConversionSourceAuthentication({ sources: [source] });
  const dependencies = { repo, policy, reports: createMemoryPlatformReporting({ snapshot }), links: createMemoryTrackedLink({}), clock };
  return { ...dependencies, authentication, service: createMeasureService(dependencies, { authentication }) };
}

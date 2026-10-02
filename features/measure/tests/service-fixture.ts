import { createFakeClock } from "@open-marketing/om-clock";
import { createMeasureService, createMemoryMeasureRepo, createMemoryMeasurementShareability, createMemoryConversionDelivery, createMemoryPlatformReporting, createMemoryMeasureJob, createMemoryTrackedLink, createMemoryMeasureAudit, createMemoryConversionSourceAuthentication } from "../index.js";
import { consent, createIds, snapshot, source } from "./fixtures.js";

export function createServiceFixture(required: Record<string, never>) {
  const clock = createFakeClock({ initial: 300 });
  const repo = createMemoryMeasureRepo({});
  const policy = createMemoryMeasurementShareability({ clock, evidence: [consent] });
  const authentication = createMemoryConversionSourceAuthentication({ sources: [source] });
  const dependencies = { repo, policy, conversions: createMemoryConversionDelivery({}), reports: createMemoryPlatformReporting({ snapshot }), jobs: createMemoryMeasureJob({}), links: createMemoryTrackedLink({}), clock, ids: createIds({}), audit: createMemoryMeasureAudit({}) };
  return { ...dependencies, authentication, service: createMeasureService(dependencies, { authentication }) };
}

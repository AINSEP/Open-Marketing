import { callContextSchema, parseBoundary } from "@open-marketing/contracts";
import type { ClockPort, IdPort } from "@open-marketing/contracts";
import type { ConversionSourceAuthenticationPort, MeasureRepoPort, MeasurementShareabilityPort, ConversionDeliveryPort, PlatformReportingPort, MeasureJobPort, TrackedLinkPort, MeasureAuditPort, MeasureObserverPort } from "./ports.js";
import type { MeasureService } from "./types.js";
import { runBoundary } from "./boundary.js";
import { ingest } from "./ingestion/ingest.js";
import { reportCac } from "./reporting/report.js";
import { ingestionContext, linkRequestSchema } from "./rules.js";

/** Inert feature factory; work starts only on method calls. repo.appendConversion
 * owns atomic job composition; jobs/conversions remain compatibility dependencies.
 * Server workers use createConversionDispatcher separately from interactive sessions.
 * @example createMeasureService({ repo, policy, conversions, reports, jobs, links, clock, ids, audit }, { authentication })
 * @complexity O(1) construction; operations inherit bounded port behavior. */
export function createMeasureService(required: { repo: MeasureRepoPort; policy: MeasurementShareabilityPort; conversions: ConversionDeliveryPort; reports: PlatformReportingPort; jobs: MeasureJobPort; links: TrackedLinkPort; clock: ClockPort; ids: IdPort; audit: MeasureAuditPort }, optional?: { observer?: MeasureObserverPort; authentication?: ConversionSourceAuthenticationPort }): MeasureService {
  return {
    async createTrackedLink(input, options) {
      const context = parseBoundary({ schema: callContextSchema, input: input.context });
      if (!context.ok) return context;
      return runBoundary({ operation: "measure.createTrackedLink", context: context.value, observer: optional?.observer, work: async () => {
        const request = parseBoundary({ schema: linkRequestSchema, input: input.request });
        if (!request.ok) return request;
        return required.links.create({ context: context.value, request: request.value }, options);
      } }, options);
    },
    async ingestConversion(input, options) {
      return runBoundary({ operation: "measure.ingestConversion", context: ingestionContext(input), observer: optional?.observer, work: () => ingest({ input, repo: required.repo, policy: required.policy, authentication: optional?.authentication, clock: required.clock }, options) }, options);
    },
    async reportCac(input, options) {
      const context = parseBoundary({ schema: callContextSchema, input: input.context });
      if (!context.ok) return context;
      return runBoundary({ operation: "measure.reportCac", context: context.value, observer: optional?.observer, work: () => reportCac({ ...input, context: context.value, repo: required.repo, reports: required.reports, clock: required.clock }, options) }, options);
    },
  };
}

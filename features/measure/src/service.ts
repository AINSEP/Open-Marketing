import type { Outcome, CallContext, CallOptions, ClockPort, IdPort, ObserverPort, Scope, Money, TimeWindow, Page, PageQuery, ConfirmationCard, EffectEnvelope, GenerationAllowanceSettings, GenerationCostQuote, GenerationApprovalRequirement, HaltStopRequest, HaltStopPermit, ServiceContext, MeasurementGrant, CapabilityEnvelope } from "@open-marketing/contracts";
import { notImplemented } from "@open-marketing/contracts";
import type { MeasureRepoPort, MeasurementShareabilityPort, ConversionDeliveryPort, PlatformReportingPort, MeasureJobPort, TrackedLinkPort, MeasureAuditPort, MeasureObserverPort } from "./ports.js";
import type { TrackedLinkRequest, TrackedLink, VerifiedConversionSource, ConversionInput, ConversionReceipt, CacQuery, CacReport, PlatformMetricSnapshot, AttributionResult, MeasureService } from "./types.js";
/** Inert measure factory. @returns Service whose operations fail with typed not_implemented; no I/O or startup. @example createMeasureService({ injectedPorts: undefined } as Parameters<typeof createMeasureService>[0]) @complexity O(1). */
export function createMeasureService(
  required: {
    repo: MeasureRepoPort;
    policy: MeasurementShareabilityPort;
    conversions: ConversionDeliveryPort;
    reports: PlatformReportingPort;
    jobs: MeasureJobPort;
    links: TrackedLinkPort;
    clock: ClockPort;
    ids: IdPort;
    audit: MeasureAuditPort;
  },
  optional?: { observer?: MeasureObserverPort },
): MeasureService {
return {
 async createTrackedLink() { return notImplemented({ operation: "measure.createTrackedLink" }); },
 async ingestConversion() { return notImplemented({ operation: "measure.ingestConversion" }); },
 async reportCac() { return notImplemented({ operation: "measure.reportCac" }); },
};
}

import { MeasureRepoPortSuite, MeasurementShareabilityPortSuite, ConversionDeliveryPortSuite, PlatformReportingPortSuite, MeasureJobPortSuite, TrackedLinkPortSuite, MeasureAuditPortSuite } from "./port-suites.js";
import { createMemoryMeasureRepo, createMemoryMeasurementShareability, createMemoryConversionDelivery, createMemoryPlatformReporting, createMemoryMeasureJob, createMemoryTrackedLink, createMemoryMeasureAudit } from "../../index.js";
MeasureRepoPortSuite({ create: () => createMemoryMeasureRepo({}) });
MeasurementShareabilityPortSuite({ create: () => createMemoryMeasurementShareability({}) });
ConversionDeliveryPortSuite({ create: () => createMemoryConversionDelivery({}) });
PlatformReportingPortSuite({ create: () => createMemoryPlatformReporting({}) });
MeasureJobPortSuite({ create: () => createMemoryMeasureJob({}) });
TrackedLinkPortSuite({ create: () => createMemoryTrackedLink({}) });
MeasureAuditPortSuite({ create: () => createMemoryMeasureAudit({}) });

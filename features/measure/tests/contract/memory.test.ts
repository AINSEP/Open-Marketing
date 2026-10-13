import { createFakeClock } from "@open-marketing/om-clock";
import { ConversionIdentifiersPortSuite, ConversionVerificationPortSuite, MeasureRepoPortSuite, MeasurementShareabilityPortSuite, ConversionDeliveryPortSuite, PlatformReportingPortSuite, MeasureJobPortSuite, TrackedLinkPortSuite, MeasureAuditPortSuite, ConversionSourceAuthenticationPortSuite, MeasurementGrantPortSuite, ConversionDeliveryStatePortSuite } from "./port-suites.js";
import { createMemoryConversionVerification, createMemoryMeasureRepo, createMemoryMeasurementShareability, createMemoryConversionDelivery, createMemoryPlatformReporting, createMemoryMeasureJob, createMemoryTrackedLink, createMemoryMeasureAudit, createMemoryConversionSourceAuthentication, createMemoryMeasurementGrant, createMemoryConversionDeliveryState } from "../../index.js";
import { consent, createIdentifiers, createIds, event, grant, scope, snapshot, source } from "../fixtures.js";
MeasureRepoPortSuite({ create: () => createMemoryMeasureRepo({}) });
MeasurementShareabilityPortSuite({ create: () => createMemoryMeasurementShareability({ clock: createFakeClock({ initial: 300 }), evidence: [consent] }) });
ConversionDeliveryPortSuite({ create: () => createMemoryConversionDelivery({}) });
PlatformReportingPortSuite({ create: () => createMemoryPlatformReporting({ snapshot }) });
MeasureJobPortSuite({ create: () => createMemoryMeasureJob({}) });
TrackedLinkPortSuite({ create: () => createMemoryTrackedLink({ allowedOrigins: ["https://shop.example"], allowedQueryKeys: ["click_id"], baseUrl: "https://om.example/l/", ids: createIds({}) }) });
MeasureAuditPortSuite({ create: () => createMemoryMeasureAudit({}) });
ConversionSourceAuthenticationPortSuite({ create: () => createMemoryConversionSourceAuthentication({ sources: [source] }) });
MeasurementGrantPortSuite({ create: () => createMemoryMeasurementGrant({ grants: [grant] }) });
ConversionDeliveryStatePortSuite({ create: () => createMemoryConversionDeliveryState({}) });

ConversionVerificationPortSuite({ create: () => createMemoryConversionVerification({ events: [{ scope, event }] }) });

ConversionIdentifiersPortSuite({ create: () => createIdentifiers({}) });

import { createFakeClock } from "@open-marketing/om-clock";
import { ConversionVerificationPortSuite, MeasureRepoPortSuite, ConversionDeliveryStatePortSuite, MeasureAuditPortSuite, TrackedLinkPortSuite, MeasureJobPortSuite } from "./port-suites.js";
import { createSqlConversionVerification, createSqlMeasureRepo, createSqlConversionDeliveryState, createSqlMeasureAudit, createSqlTrackedLink, createSqlMeasureJob } from "../../index.js";
import { createSqlFixture } from "../sql-fixture.js";
import { createIds, event, source } from "../fixtures.js";
MeasureRepoPortSuite({ create: () => { const fixture = createSqlFixture({}); return createSqlMeasureRepo({ database: fixture.database, jobs: fixture.jobs }); } });
ConversionDeliveryStatePortSuite({ create: () => createSqlConversionDeliveryState({ database: createSqlFixture({}).database }) });
MeasureAuditPortSuite({ create: () => createSqlMeasureAudit({ database: createSqlFixture({}).database, ids: createIds({}), clock: createFakeClock({ initial: 300 }) }) });
TrackedLinkPortSuite({ create: () => createSqlTrackedLink({ database: createSqlFixture({}).database, ids: createIds({}), baseUrl: "https://om.example/l/", allowedOrigins: ["https://shop.example"], allowedQueryKeys: ["click_id"] }) });
MeasureJobPortSuite({ create: () => { const fixture = createSqlFixture({}); return createSqlMeasureJob({ database: fixture.database, jobs: fixture.jobs }); } });

ConversionVerificationPortSuite({ create: async () => {
  const fixture = createSqlFixture({});
  await createSqlMeasureRepo(fixture).appendConversion({ source, event });
  return createSqlConversionVerification({ database: fixture.database });
} });

import { CreativeRepoPortSuite, GenerationCapabilityPortSuite, CreativeAssetPortSuite, CreativeJobPortSuite, CreativeSpendPortSuite, CreativeAuditPortSuite, CreativeObserverPortSuite } from "./port-suites.js";
import { createMemoryCreativeRepo, createMemoryGenerationCapability, createMemoryCreativeAsset, createMemoryCreativeJob, createMemoryCreativeSpend, createMemoryCreativeAudit, createMemoryCreativeObserver } from "../../index.js";
import { completedStatus, context, intentFor, value } from "../support/fixtures.js";
CreativeRepoPortSuite({ create: () => createMemoryCreativeRepo({}) });
GenerationCapabilityPortSuite({ create: async () => {
  const repo = createMemoryCreativeRepo({});
  const status = value({ outcome: await repo.save({ context, status: { ...intentFor(), dispatchState: "dispatching", reservationId: "reservation" } }) });
  const port = createMemoryGenerationCapability({ repo, quote: status.quote });
  return { repo, port, status, async finish() { port.setStatus({ context, status: completedStatus({ status }) }); } };
} });
CreativeAssetPortSuite({ create: () => createMemoryCreativeAsset({}) });
CreativeJobPortSuite({ create: () => {
  const repo = createMemoryCreativeRepo({});
  return { repo, port: createMemoryCreativeJob({ repo }) };
} });
CreativeSpendPortSuite({ create: () => createMemoryCreativeSpend({}) });
CreativeAuditPortSuite({ create: () => createMemoryCreativeAudit({}) });
CreativeObserverPortSuite({ create: () => createMemoryCreativeObserver({}) });

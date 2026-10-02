import { CreativeRepoPortSuite, GenerationCapabilityPortSuite, CreativeAssetPortSuite, CreativeJobPortSuite, CreativeSpendPortSuite, CreativeAuditPortSuite } from "./port-suites.js";
import { createMemoryCreativeRepo, createMemoryGenerationCapability, createMemoryCreativeAsset, createMemoryCreativeJob, createMemoryCreativeSpend, createMemoryCreativeAudit } from "../../index.js";
CreativeRepoPortSuite({ create: () => createMemoryCreativeRepo({}) });
GenerationCapabilityPortSuite({ create: () => createMemoryGenerationCapability({}) });
CreativeAssetPortSuite({ create: () => createMemoryCreativeAsset({}) });
CreativeJobPortSuite({ create: () => createMemoryCreativeJob({}) });
CreativeSpendPortSuite({ create: () => createMemoryCreativeSpend({}) });
CreativeAuditPortSuite({ create: () => createMemoryCreativeAudit({}) });

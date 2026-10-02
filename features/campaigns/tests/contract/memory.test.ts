import { CampaignRepoPortSuite, CampaignCapabilityPortSuite, CampaignAssetPortSuite, CampaignSafetyPortSuite, CampaignJobPortSuite, CampaignAuditPortSuite } from "./port-suites.js";
import { createMemoryCampaignRepo, createMemoryCampaignCapability, createMemoryCampaignAsset, createMemoryCampaignSafety, createMemoryCampaignJob, createMemoryCampaignAudit } from "../../index.js";
CampaignRepoPortSuite({ create: () => createMemoryCampaignRepo({}) });
CampaignCapabilityPortSuite({ create: () => createMemoryCampaignCapability({}) });
CampaignAssetPortSuite({ create: () => createMemoryCampaignAsset({}) });
CampaignSafetyPortSuite({ create: () => createMemoryCampaignSafety({}) });
CampaignJobPortSuite({ create: () => createMemoryCampaignJob({}) });
CampaignAuditPortSuite({ create: () => createMemoryCampaignAudit({}) });

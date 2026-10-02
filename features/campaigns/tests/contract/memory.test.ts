import { CampaignRepoPortSuite, CampaignCapabilityPortSuite, CampaignAssetPortSuite, CampaignSafetyPortSuite, CampaignJobPortSuite, CampaignAuditPortSuite } from "./port-suites.js";
import { createMemoryCampaignRepo, createMemoryCampaignCapability, createMemoryCampaignAsset, createMemoryCampaignSafety, createMemoryCampaignJob, createMemoryCampaignAudit } from "../../index.js";
import { context, draft } from "../fixtures.js";
CampaignRepoPortSuite({ create: () => createMemoryCampaignRepo({}) });
CampaignCapabilityPortSuite({ create: () => createMemoryCampaignCapability({}) });
CampaignAssetPortSuite({ create: () => createMemoryCampaignAsset({}) });
CampaignSafetyPortSuite({ create: () => createMemoryCampaignSafety({ accounts: [{ scope: context.scope, connectionId: draft.connectionId, accountId: draft.accountId, accountMode: "sandbox", allowCreation: true }] }) });
CampaignJobPortSuite({ create: () => createMemoryCampaignJob({}) });
CampaignAuditPortSuite({ create: () => createMemoryCampaignAudit({}) });

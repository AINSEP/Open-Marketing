import type { ClockPort, IdPort, ObserverPort } from "@open-marketing/contracts";
import type { CampaignRepoPort, CampaignCapabilityPort, CampaignAssetPort, CampaignSafetyPort, CampaignJobPort, CampaignAuditPort } from "./ports.js";
/** Factory dependencies are supplied by server composition, never constructed here. */
export interface CampaignDependencies {
  repo: CampaignRepoPort;
  capabilities: CampaignCapabilityPort;
  assets: CampaignAssetPort;
  safety: CampaignSafetyPort;
  jobs: CampaignJobPort;
  clock: ClockPort;
  ids: IdPort;
  audit: CampaignAuditPort;
}
export interface CampaignInstrumentation { observer?: ObserverPort }

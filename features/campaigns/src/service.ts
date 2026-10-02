import type { Outcome, CallContext, CallOptions, ClockPort, IdPort, ObserverPort, Scope, Money, TimeWindow, Page, PageQuery, ConfirmationCard, EffectEnvelope, GenerationAllowanceSettings, GenerationCostQuote, GenerationApprovalRequirement, HaltStopRequest, HaltStopPermit, ServiceContext, MeasurementGrant, CapabilityEnvelope } from "@open-marketing/contracts";
import { notImplemented } from "@open-marketing/contracts";
import type { CampaignRepoPort, CampaignCapabilityPort, CampaignAssetPort, CampaignSafetyPort, CampaignJobPort, CampaignAuditPort, CampaignObserverPort } from "./ports.js";
import type { CampaignDraft, CampaignReceipt, FlightProposal, LaunchProposal, ApprovedLaunchRequest, LaunchReceipt, ObservedCampaignState, CampaignService } from "./types.js";
/** Inert campaigns factory. @returns Service whose operations fail with typed not_implemented; no I/O or startup. @example createCampaignService({ injectedPorts: undefined } as Parameters<typeof createCampaignService>[0]) @complexity O(1). */
export function createCampaignService(
  required: {
    repo: CampaignRepoPort;
    capabilities: CampaignCapabilityPort;
    assets: CampaignAssetPort;
    safety: CampaignSafetyPort;
    jobs: CampaignJobPort;
    clock: ClockPort;
    ids: IdPort;
    audit: CampaignAuditPort;
  },
  optional?: { observer?: CampaignObserverPort },
): CampaignService {
return {
 async createPaused() { return notImplemented({ operation: "campaigns.createPaused" }); },
 async proposeLaunch() { return notImplemented({ operation: "campaigns.proposeLaunch" }); },
 async launch() { return notImplemented({ operation: "campaigns.launch" }); },
};
}

export { createCampaignService } from "./src/service.js";
export type { CampaignDraft, CampaignReceipt, FlightProposal, LaunchProposal, ApprovedLaunchRequest, LaunchReceipt, ObservedCampaignState, CampaignService } from "./src/types.js";
export type { CampaignRepoPort, CampaignCapabilityPort, CampaignAssetPort, CampaignSafetyPort, CampaignJobPort, CampaignAuditPort, CampaignObserverPort } from "./src/ports.js";
export { createMemoryCampaignRepo, createMemoryCampaignCapability, createMemoryCampaignAsset, createMemoryCampaignSafety, createMemoryCampaignJob, createMemoryCampaignAudit } from "./src/memory.js";
export type { Outcome, CallContext, CallOptions, ClockPort, IdPort, Scope, ConfirmationCard, HaltStopRequest, HaltStopPermit, GenerationAllowanceSettings, GenerationCostQuote, GenerationApprovalRequirement, MeasurementGrant } from "@open-marketing/contracts";

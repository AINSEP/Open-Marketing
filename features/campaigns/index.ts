/** Vendor-neutral paused drafts and exact launch orchestration. Public imports use this entry. */
export { neutralCampaignLaunchSchema } from "./src/neutral-launch.js";
export type { NeutralCampaignLaunch } from "./src/neutral-launch.js";
export { createCampaignService } from "./src/service.js";
export type { CampaignDependencies } from "./src/dependencies.js";
export type { CampaignDraft, CampaignReceipt, FlightProposal, LaunchArguments, LaunchProposal, ApprovedLaunchRequest, LaunchReceipt, ObservedCampaignState, CampaignReadback, CampaignRecord, CampaignIntent, CampaignJob, CampaignService } from "./src/types.js";
export type { CampaignRepoPort, CampaignCapabilityPort, CampaignAssetPort, CampaignSafetyPort, CampaignJobPort, CampaignAuditPort, CampaignObserverPort, CampaignSqlPort } from "./src/ports.js";
export { createMemoryCampaignRepo, createMemoryCampaignCapability, createMemoryCampaignAsset, createMemoryCampaignSafety, createMemoryCampaignJob, createMemoryCampaignAudit, createMemoryCampaignObserver } from "./src/memory.js";
export type { MemoryCampaignCapability } from "./src/memory-capability.js";
export type { MemoryCampaignAsset } from "./src/memory-assets.js";
export type { MemoryCampaignAccount, MemoryCampaignSafety } from "./src/memory-safety.js";
export type { MemoryCampaignAudit, MemoryCampaignObserver } from "./src/memory.js";
export { createSqlCampaignRepo } from "./src/adapters/sql-repo.js";
export { createCampaignCapabilityAdapter } from "./src/adapters/capability.js";
export type { CampaignBackendPort } from "./src/adapters/capability.js";
export type { Outcome, CallContext, CallOptions, ClockPort, IdPort, Scope, ConfirmationCard, HaltStopRequest, HaltStopPermit, GenerationAllowanceSettings, GenerationCostQuote, GenerationApprovalRequirement, MeasurementGrant } from "@open-marketing/contracts";

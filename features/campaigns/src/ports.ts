import type { Outcome, CallContext, CallOptions, ClockPort, IdPort, ObserverPort, Scope, Money, TimeWindow, Page, PageQuery, ConfirmationCard, EffectEnvelope, GenerationAllowanceSettings, GenerationCostQuote, GenerationApprovalRequirement, HaltStopRequest, HaltStopPermit, ServiceContext, MeasurementGrant, CapabilityEnvelope } from "@open-marketing/contracts";
import type { CampaignDraft, CampaignReceipt, FlightProposal, LaunchProposal, ApprovedLaunchRequest, LaunchReceipt, ObservedCampaignState, CampaignService } from "./types.js";
/** CampaignRepoPort: caller-owned, injected boundary. j00 doubles fail explicitly until its owning job implements the suite. */
export interface CampaignRepoPort {
 save(required: { context: CallContext; draft: CampaignDraft }, optional?: CallOptions): Promise<Outcome<CampaignReceipt>>;
 observe(required: { context: CallContext; state: ObservedCampaignState }, optional?: CallOptions): Promise<Outcome<ObservedCampaignState>>;
}
/** CampaignCapabilityPort: caller-owned, injected boundary. j00 doubles fail explicitly until its owning job implements the suite. */
export interface CampaignCapabilityPort {
 createPaused(required: { context: CallContext; draft: CampaignDraft }, optional?: CallOptions): Promise<Outcome<CampaignReceipt>>;
 launch(required: { context: CallContext; request: ApprovedLaunchRequest }, optional?: CallOptions): Promise<Outcome<LaunchReceipt>>;
}
/** CampaignAssetPort: caller-owned, injected boundary. j00 doubles fail explicitly until its owning job implements the suite. */
export interface CampaignAssetPort {
 resolve(required: { context: CallContext; creativeIds: readonly string[] }, optional?: CallOptions): Promise<Outcome<{ readonly creativeDigest: string }>>;
}
/** CampaignSafetyPort: caller-owned, injected boundary. j00 doubles fail explicitly until its owning job implements the suite. */
export interface CampaignSafetyPort {
 authorize(required: { context: CallContext; request: ApprovedLaunchRequest }, optional?: CallOptions): Promise<Outcome<{ readonly permitId: string }>>;
}
/** CampaignJobPort: caller-owned, injected boundary. j00 doubles fail explicitly until its owning job implements the suite. */
export interface CampaignJobPort {
 enqueue(required: { context: CallContext; operationId: string; argumentsDigest: string }, optional?: CallOptions): Promise<Outcome<{ readonly jobId: string }>>;
}
/** CampaignAuditPort: caller-owned, injected boundary. j00 doubles fail explicitly until its owning job implements the suite. */
export interface CampaignAuditPort {
 record(required: { context: CallContext; operationId: string; outcome: string }, optional?: CallOptions): Promise<Outcome<void>>;
}
export type CampaignObserverPort = ObserverPort;

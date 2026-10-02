import type { Outcome, CallContext, CallOptions, ClockPort, IdPort, ObserverPort, Scope, Money, TimeWindow, Page, PageQuery, ConfirmationCard, EffectEnvelope, GenerationAllowanceSettings, GenerationCostQuote, GenerationApprovalRequirement, HaltStopRequest, HaltStopPermit, ServiceContext, MeasurementGrant, CapabilityEnvelope } from "@open-marketing/contracts";
/** CampaignDraft domain value; validation belongs at the boundary. */
export type CampaignDraft = { readonly operationId: string; readonly connectionId: string; readonly accountId: string; readonly name: string; readonly objective: string; readonly creativeIds: readonly string[]; readonly creativeDigest: string; readonly placements: readonly string[] };
/** CampaignReceipt domain value; validation belongs at the boundary. */
export type CampaignReceipt = { readonly campaignId: string; readonly desiredState: "paused"; readonly observedState: "paused" | "unknown" };
/** FlightProposal domain value; validation belongs at the boundary. */
export type FlightProposal = { readonly window: TimeWindow; readonly expectedExposure: Money; readonly timezone: string };
/** LaunchProposal domain value; validation belongs at the boundary. */
export type LaunchProposal = { readonly campaignId: string; readonly operations: readonly EffectEnvelope[]; readonly creativeDigest: string };
/** ApprovedLaunchRequest domain value; validation belongs at the boundary. */
export type ApprovedLaunchRequest = { readonly campaignId: string; readonly operationId: string; readonly approvalId: string; readonly argumentsDigest: string; readonly creativeDigest: string };
/** LaunchReceipt domain value; validation belongs at the boundary. */
export type LaunchReceipt = { readonly operationId: string; readonly status: "pending" | "submitted" | "unknown" };
/** ObservedCampaignState domain value; validation belongs at the boundary. */
export type ObservedCampaignState = { readonly campaignId: string; readonly state: "paused" | "active" | "unknown"; readonly observedAt: number; readonly providerReference: string };
export interface CampaignService {
  createPaused(
    required: { context: CallContext; draft: CampaignDraft },
    optional?: CallOptions,
  ): Promise<Outcome<CampaignReceipt>>;

  proposeLaunch(
    required: { context: CallContext; campaignId: string; flight: FlightProposal },
    optional?: CallOptions,
  ): Promise<Outcome<LaunchProposal>>;

  launch(
    required: { context: CallContext; request: ApprovedLaunchRequest },
    optional?: CallOptions,
  ): Promise<Outcome<LaunchReceipt>>;
}

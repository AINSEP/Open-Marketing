import type { Outcome, CallContext, CallOptions, Scope, Money, TimeWindow, EffectEnvelope } from "@open-marketing/contracts";
import type { NeutralCampaignLaunch, NeutralCampaignRecord } from "./neutral-launch.js";

/** Immutable paused-only plan. No activation/budget fields are admitted. */
export type CampaignDraft = { readonly operationId: string; readonly connectionId: string; readonly accountId: string; readonly name: string; readonly objective: string; readonly creativeIds: readonly string[]; readonly creativeDigest: string; readonly placements: readonly string[] };
/** A local campaign identity; unknown never means verified paused. */
export type CampaignReceipt = { readonly campaignId: string; readonly desiredState: "paused"; readonly observedState: "paused" | "unknown" };
/** Exposure describes this one flight; it grants no reusable budget authority. */
export type FlightProposal = { readonly window: TimeWindow; readonly expectedExposure: Money; readonly timezone: string };
/** Frozen arguments used for card rendering, enqueue, authorization and dispatch. */
export type LaunchArguments = { readonly campaignId: string; readonly connectionId: string; readonly accountId: string; readonly creativeDigest: string; readonly flight: FlightProposal; readonly action: "launch" };
/** Each proposal has one fresh operation; later mutations require another proposal/card. */
export type LaunchProposal = { readonly campaignId: string; readonly operations: readonly EffectEnvelope[]; readonly creativeDigest: string; readonly arguments: LaunchArguments; readonly proposedAt: number };
/** References an exact approval; the caller cannot substitute the stored arguments. */
export type ApprovedLaunchRequest = { readonly campaignId: string; readonly operationId: string; readonly approvalId: string; readonly argumentsDigest: string; readonly creativeDigest: string };
/** Pending is durable intent, submitted is acknowledged, unknown requires reconciliation. */
export type LaunchReceipt = { readonly operationId: string; readonly status: "pending" | "submitted" | "unknown" };
/** Read evidence, never an inferred acknowledgement of a write. */
export type ObservedCampaignState = { readonly campaignId: string; readonly state: "paused" | "active" | "unknown"; readonly observedAt: number; readonly providerReference: string };
/** Adapter includes every campaign/ad-set/ad in the created hierarchy. */
export type CampaignReadback = { readonly state: ObservedCampaignState; readonly hierarchy: readonly { readonly entityId: string; readonly state: "paused" | "active" | "unknown" }[]; readonly complete: boolean; readonly operationId: string | null };
/** Repository-owned scope and immutable draft survive service/worker restart. */
export type CampaignRecord = { readonly scope: Scope; readonly draft: CampaignDraft; readonly receipt: CampaignReceipt; readonly observation: ObservedCampaignState | null };
/** Domain intent commits in the same transaction as the single jobs outbox entry. */
export type CampaignIntent = { readonly kind: "create"; readonly campaignId: string; readonly draft: CampaignDraft } | { readonly kind: "launch"; readonly request: ApprovedLaunchRequest; readonly proposal: LaunchProposal };
/** A dispatch claim is never automatically retried, including after a crash. */
export type CampaignJob = { readonly jobId: string; readonly scope: Scope; readonly operationId: string; readonly argumentsDigest: string; readonly intent: CampaignIntent; readonly status: "queued" | "dispatching" | "submitted" | "unknown" };
export interface CampaignService {
  /** Persist neutral intent locally. Does not resolve credentials, create remote objects or enqueue. */
  saveLocal(required: { context: CallContext; campaign: NeutralCampaignLaunch }, optional?: CallOptions): Promise<Outcome<NeutralCampaignRecord>>;
  getLocal(required: { context: CallContext; campaignId: string }, optional?: CallOptions): Promise<Outcome<NeutralCampaignRecord | null>>;
  createPaused(required: { context: CallContext; draft: CampaignDraft }, optional?: CallOptions): Promise<Outcome<CampaignReceipt>>;
  proposeLaunch(required: { context: CallContext; campaignId: string; flight: FlightProposal }, optional?: CallOptions): Promise<Outcome<LaunchProposal>>;
  launch(required: { context: CallContext; request: ApprovedLaunchRequest }, optional?: CallOptions): Promise<Outcome<LaunchReceipt>>;
  /** Server worker entry: claims once, rechecks authority and dispatches frozen intent. */
  dispatch(required: { context: CallContext; operationId: string }, optional?: CallOptions): Promise<Outcome<LaunchReceipt>>;
  /** Read-only reconciliation. Incomplete/ambiguous evidence remains unknown. */
  reconcile(required: { context: CallContext; operationId: string }, optional?: CallOptions): Promise<Outcome<LaunchReceipt>>;
}

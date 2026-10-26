import type { SqlSession } from "@open-marketing/contracts";
import type { Outcome, CallContext, CallOptions, ObserverPort, Page, PageQuery } from "@open-marketing/contracts";
import type { CampaignDraft, CampaignReceipt, LaunchProposal, ApprovedLaunchRequest, LaunchReceipt, ObservedCampaignState, CampaignReadback, CampaignRecord, CampaignIntent, CampaignJob } from "./types.js";
import type { NeutralCampaignLaunch, NeutralCampaignRecord } from "./neutral-launch.js";

/** Scoped persistence. save is idempotent by operationId; differing reuse conflicts. */
export interface CampaignRepoPort {
  /** Immutable local-only intent; duplicate operation/same values deduplicates, changed values conflict. */
  saveNeutral(required: { context: CallContext; campaign: NeutralCampaignLaunch }, optional?: CallOptions): Promise<Outcome<NeutralCampaignRecord>>;
  getNeutral(required: { context: CallContext; campaignId: string }, optional?: CallOptions): Promise<Outcome<NeutralCampaignRecord | null>>;
  /** Scoped keyset page, ordered by campaignId, limit 1..100; cursor is the last returned ID. */
  list(required: { context: CallContext; query: PageQuery }, optional?: CallOptions): Promise<Outcome<Page<CampaignRecord>>>;
  save(required: { context: CallContext; draft: CampaignDraft }, optional?: CallOptions): Promise<Outcome<CampaignReceipt>>;
  get(required: { context: CallContext; campaignId: string }, optional?: CallOptions): Promise<Outcome<CampaignRecord | null>>;
  observe(required: { context: CallContext; state: ObservedCampaignState }, optional?: CallOptions): Promise<Outcome<ObservedCampaignState>>;
  saveProposal(required: { context: CallContext; proposal: LaunchProposal }, optional?: CallOptions): Promise<Outcome<LaunchProposal>>;
  getProposal(required: { context: CallContext; operationId: string }, optional?: CallOptions): Promise<Outcome<LaunchProposal | null>>;
}
/** Generic plugin seam. Writes use stable operation IDs; hierarchy readback is mandatory. */
export interface CampaignCapabilityPort {
  createPaused(required: { context: CallContext; draft: CampaignDraft; campaignId: string; permitId: string }, optional?: CallOptions): Promise<Outcome<CampaignReceipt>>;
  launch(required: { context: CallContext; request: ApprovedLaunchRequest; proposal: LaunchProposal; permitId: string }, optional?: CallOptions): Promise<Outcome<LaunchReceipt>>;
  readState(required: { context: CallContext; campaignId: string; connectionId: string; accountId: string; operationId: string }, optional?: CallOptions): Promise<Outcome<CampaignReadback>>;
}
/** Resolves current revisions in one bounded batch; missing/foreign IDs fail closed. */
export interface CampaignAssetPort {
  resolve(required: { context: CallContext; creativeIds: readonly string[] }, optional?: CallOptions): Promise<Outcome<{ readonly creativeDigest: string }>>;
}
/** Safety owns account binding/mode, halt, admission and exact-card authority.
 * Dispatch methods serialize final authority consumption and effect against halt.
 * No await gap may exist between the final halt check and invoking execute.
 */
export interface CampaignSafetyPort {
  authorizeCreation(required: { context: CallContext; draft: CampaignDraft }, optional?: CallOptions): Promise<Outcome<{ readonly permitId: string }>>;
  authorize(required: { context: CallContext; request: ApprovedLaunchRequest; proposal: LaunchProposal }, optional?: CallOptions): Promise<Outcome<{ readonly permitId: string }>>;
  dispatchCreation(required: { context: CallContext; draft: CampaignDraft; execute: (required: { permitId: string }) => Promise<Outcome<CampaignReceipt>> }, optional?: CallOptions): Promise<Outcome<CampaignReceipt>>;
  dispatchLaunch(required: { context: CallContext; request: ApprovedLaunchRequest; proposal: LaunchProposal; execute: (required: { permitId: string }) => Promise<Outcome<LaunchReceipt>> }, optional?: CallOptions): Promise<Outcome<LaunchReceipt>>;
}
/** Composition adapts the ONE jobs outbox. enqueue atomically stores immutable
 * intent and job; claim is CAS queued->dispatching. Never reclaim dispatching
 * on lease expiry: reconcile uncertain outcomes. finish appends evidence.
 */
export interface CampaignJobPort {
  enqueue(required: { context: CallContext; operationId: string; argumentsDigest: string; intent: CampaignIntent }, optional?: CallOptions): Promise<Outcome<{ readonly jobId: string }>>;
  get(required: { context: CallContext; operationId: string }, optional?: CallOptions): Promise<Outcome<CampaignJob | null>>;
  claim(required: { context: CallContext; operationId: string }, optional?: CallOptions): Promise<Outcome<CampaignJob | null>>;
  finish(required: { context: CallContext; operationId: string; status: "submitted" | "unknown" }, optional?: CallOptions): Promise<Outcome<void>>;
}
/** Append-only audit; context carries run/correlation/trace IDs. */
export interface CampaignAuditPort {
  record(required: { context: CallContext; operationId: string; outcome: string }, optional?: CallOptions): Promise<Outcome<void>>;
}
export type CampaignObserverPort = ObserverPort;
/** Server-owned SQL query shape; composition adapts its DB port. No driver or shim import. */
export type CampaignSqlPort = Pick<SqlSession, "query">;

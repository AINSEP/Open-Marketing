import type { Outcome, CallContext, CallOptions, ClockPort, IdPort, ObserverPort, Scope, Money, TimeWindow, Page, PageQuery, ConfirmationCard, EffectEnvelope, GenerationAllowanceSettings, GenerationCostQuote, GenerationApprovalRequirement, HaltStopRequest, HaltStopPermit, ServiceContext, MeasurementGrant, CapabilityEnvelope } from "@open-marketing/contracts";
import type { SessionReference, AccountBinding, VerifiedIdentity, WorkspaceService } from "./types.js";
/** WorkspaceRepoPort: caller-owned, injected boundary. j00 doubles fail explicitly until its owning job implements the suite. */
export interface WorkspaceRepoPort {
 resolve(required: { session: SessionReference; workspaceId: string }, optional?: CallOptions): Promise<Outcome<CallContext>>;
 bind(required: { context: CallContext; binding: AccountBinding }, optional?: CallOptions): Promise<Outcome<AccountBinding>>;
}
/** IdentityPort: caller-owned, injected boundary. j00 doubles fail explicitly until its owning job implements the suite. */
export interface IdentityPort {
 verify(required: { session: SessionReference }, optional?: CallOptions): Promise<Outcome<VerifiedIdentity>>;
}
/** AccountBindingLookupPort: caller-owned, injected boundary. j00 doubles fail explicitly until its owning job implements the suite. */
export interface AccountBindingLookupPort {
 find(required: { context: CallContext; externalAccountId: string }, optional?: CallOptions): Promise<Outcome<AccountBinding | null>>;
}
export type WorkspaceObserverPort = ObserverPort;

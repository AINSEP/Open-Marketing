import type { Outcome, CallContext, CallOptions, ClockPort, IdPort, ObserverPort, Scope, Money, TimeWindow, Page, PageQuery, ConfirmationCard, EffectEnvelope, GenerationAllowanceSettings, GenerationCostQuote, GenerationApprovalRequirement, HaltStopRequest, HaltStopPermit, ServiceContext, MeasurementGrant, CapabilityEnvelope } from "@open-marketing/contracts";
/** SessionReference domain value; validation belongs at the boundary. */
export type SessionReference = { readonly sessionId: string };
/** AccountBinding domain value; validation belongs at the boundary. */
export type AccountBinding = { readonly id: string; readonly scope: Scope; readonly connectionId: string; readonly externalAccountId: string };
/** VerifiedIdentity domain value; validation belongs at the boundary. */
export type VerifiedIdentity = { readonly ownerId: string; readonly sessionId: string };
export interface WorkspaceService {
  resolveContext(
    required: { session: SessionReference; workspaceId: string },
    optional?: CallOptions,
  ): Promise<Outcome<CallContext>>;

  bindAccount(
    required: { context: CallContext; binding: AccountBinding },
    optional?: CallOptions,
  ): Promise<Outcome<AccountBinding>>;
}

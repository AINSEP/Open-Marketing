import type { Outcome, CallContext, CallOptions, ClockPort, IdPort, ObserverPort, Scope, Money, TimeWindow, Page, PageQuery, ConfirmationCard, EffectEnvelope, GenerationAllowanceSettings, GenerationCostQuote, GenerationApprovalRequirement, HaltStopRequest, HaltStopPermit, ServiceContext, MeasurementGrant, CapabilityEnvelope } from "@open-marketing/contracts";
/** ConnectRequest domain value; validation belongs at the boundary. */
export type ConnectRequest = { readonly pluginId: string; readonly returnUri: string };
/** ConnectChallenge domain value; validation belongs at the boundary. */
export type ConnectChallenge = { readonly transactionId: string; readonly authorizationUrl: string; readonly expiresAt: number };
/** VerifiedOAuthCallback domain value; validation belongs at the boundary. */
export type VerifiedOAuthCallback = { readonly transactionId: string; readonly state: string; readonly code: string; readonly redirectUri: string };
/** ConnectionSummary domain value; validation belongs at the boundary. */
export type ConnectionSummary = { readonly connectionId: string; readonly scope: Scope; readonly pluginId: string; readonly status: "connected" | "revoked" | "reconnect_required" };
/** RevocationReceipt domain value; validation belongs at the boundary. */
export type RevocationReceipt = { readonly connectionId: string; readonly revokedAt: number };
/** SealedSecret domain value; validation belongs at the boundary. */
export type SealedSecret = { readonly ciphertext: string; readonly version: number; readonly aadDigest: string };
/** KeyringConfiguration domain value; validation belongs at the boundary. */
export type KeyringConfiguration = { readonly hkdfSalt: string; readonly envVarName: string; readonly keyFilePath: string };
/** CredentialReference domain value; validation belongs at the boundary. */
export type CredentialReference = { readonly scope: Scope; readonly connectionId: string; readonly version: number };
export interface CredentialService {
  beginConnect(
    required: { context: CallContext; request: ConnectRequest },
    optional?: CallOptions,
  ): Promise<Outcome<ConnectChallenge>>;

  completeConnect(
    required: { callback: VerifiedOAuthCallback },
    optional?: CallOptions,
  ): Promise<Outcome<ConnectionSummary>>;

  revoke(
    required: { context: CallContext; connectionId: string },
    optional?: CallOptions,
  ): Promise<Outcome<RevocationReceipt>>;
}

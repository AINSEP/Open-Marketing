import type { Outcome, CallContext, CallOptions, Scope } from "@open-marketing/contracts";
/** ConnectRequest domain value; validation belongs at the boundary. */
export type ConnectRequest = { readonly pluginId: string; readonly returnUri: string };
/** ConnectChallenge domain value; validation belongs at the boundary. */
export type ConnectChallenge = { readonly transactionId: string; readonly authorizationUrl: string; readonly expiresAt: number };
/** Browser result has exactly one code/error; provider descriptions are discarded at parsing. */
export type BrowserOAuthCallback = { readonly state: string; readonly redirectUri: string } & (
  { readonly code: string; readonly error?: never } | { readonly error: string; readonly code?: never; readonly error_description?: string }
);
/** Internal callback bound to an existing connection transaction. */
export type VerifiedOAuthCallback = BrowserOAuthCallback & { readonly transactionId: string };
/** Owner-scoped sign-in progress; saved connection IDs equal transaction IDs. */
export type ConnectStatus = { readonly status: "pending" | "complete" | "expired"; readonly connection?: ConnectionSummary };
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
    required: { callback: VerifiedOAuthCallback | BrowserOAuthCallback },
    optional?: CallOptions,
  ): Promise<Outcome<ConnectionSummary>>;

  /** Owner-only progress lookup; no secret-bearing records leave this boundary. */
  connectStatus(
    required: { context: CallContext; transactionId: string },
    optional?: CallOptions,
  ): Promise<Outcome<ConnectStatus>>;

  revoke(
    required: { context: CallContext; connectionId: string },
    optional?: CallOptions,
  ): Promise<Outcome<RevocationReceipt>>;
}

/** Host-only encrypted record; never a public connection DTO. */
export type CredentialRecord = { readonly summary: ConnectionSummary; readonly reference: CredentialReference; readonly secret: SealedSecret };

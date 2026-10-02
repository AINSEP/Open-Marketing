import type { Outcome, CallContext, CallOptions, ObserverPort } from "@open-marketing/contracts";
import type { ConnectRequest, ConnectChallenge, VerifiedOAuthCallback, ConnectionSummary, RevocationReceipt, SealedSecret, KeyringConfiguration, CredentialReference, CredentialRecord } from "./types.js";

/** Server-owned repository. Stores advance one version; revocation is terminal for an ID. */
export interface CredentialRepoPort {
  get(required: { context: CallContext; connectionId: string }, optional?: CallOptions): Promise<Outcome<ConnectionSummary | null>>;
  getSecret(required: { context: CallContext; connectionId: string }, optional?: CallOptions): Promise<Outcome<CredentialRecord | null>>;
  store(required: { context: CallContext; reference: CredentialReference; secret: SealedSecret; pluginId: string }, optional?: CallOptions): Promise<Outcome<ConnectionSummary>>;
  revoke(required: { context: CallContext; connectionId: string }, optional?: CallOptions): Promise<Outcome<RevocationReceipt>>;
  requireReconnect(required: { context: CallContext; connectionId: string }, optional?: CallOptions): Promise<Outcome<ConnectionSummary>>;
}
/** Encryption binds owner, workspace, connection and key version using authenticated data. */
export interface SecretSealerPort {
  seal(required: { reference: CredentialReference; plaintext: string }, optional?: CallOptions): Promise<Outcome<SealedSecret>>;
  open(required: { reference: CredentialReference; secret: SealedSecret }, optional?: CallOptions): Promise<Outcome<string>>;
}
/** Key material is available only to trusted server composition. */
export interface KeyringPort {
  resolve(required: { configuration: KeyringConfiguration; version: number }, optional?: CallOptions): Promise<Outcome<Uint8Array>>;
}
/** Transaction ID identifies the new connection, sealed at version one. */
export interface OAuthClientPort {
  begin(required: { context: CallContext; request: ConnectRequest }, optional?: CallOptions): Promise<Outcome<ConnectChallenge>>;
  complete(required: { callback: VerifiedOAuthCallback }, optional?: CallOptions): Promise<Outcome<SealedSecret>>;
}
/** Locks bind scope and connection, deliberately excluding version. Share across service/broker. */
export interface CredentialLockPort {
  acquire(required: { reference: CredentialReference }, optional?: CallOptions): Promise<Outcome<{ readonly lockId: string }>>;
  release(required: { lockId: string }, optional?: CallOptions): Promise<Outcome<void>>;
}
/** Append correlated metadata only; never record callback URLs, codes or secrets. */
export interface CredentialAuditPort {
  record(required: { context: CallContext; operation: string; connectionId: string }, optional?: CallOptions): Promise<Outcome<void>>;
}
/** Host-only capability. Never expose through HTTP/MCP/studio/agent DTOs. */
export interface CredentialBrokerPort {
  use(required: { context: CallContext; reference: CredentialReference; operationId: string }, optional?: CallOptions): Promise<Outcome<SealedSecret>>;
}
/** Provider adapter owns token expiry and Jini refresh. Null means still fresh. */
export interface CredentialRefreshPort {
  refresh(required: { context: CallContext; record: CredentialRecord }, optional?: CallOptions): Promise<Outcome<SealedSecret | null>>;
}
export type CredentialObserverPort = ObserverPort;

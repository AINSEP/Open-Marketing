import type { Outcome, CallContext, CallOptions, ClockPort, IdPort, ObserverPort, Scope, Money, TimeWindow, Page, PageQuery, ConfirmationCard, EffectEnvelope, GenerationAllowanceSettings, GenerationCostQuote, GenerationApprovalRequirement, HaltStopRequest, HaltStopPermit, ServiceContext, MeasurementGrant, CapabilityEnvelope } from "@open-marketing/contracts";
import type { ConnectRequest, ConnectChallenge, VerifiedOAuthCallback, ConnectionSummary, RevocationReceipt, SealedSecret, KeyringConfiguration, CredentialReference, CredentialService } from "./types.js";
/** CredentialRepoPort: caller-owned, injected boundary. j00 doubles fail explicitly until its owning job implements the suite. */
export interface CredentialRepoPort {
 get(required: { context: CallContext; connectionId: string }, optional?: CallOptions): Promise<Outcome<ConnectionSummary | null>>;
 store(required: { context: CallContext; reference: CredentialReference; secret: SealedSecret }, optional?: CallOptions): Promise<Outcome<ConnectionSummary>>;
 revoke(required: { context: CallContext; connectionId: string }, optional?: CallOptions): Promise<Outcome<RevocationReceipt>>;
}
/** SecretSealerPort: caller-owned, injected boundary. j00 doubles fail explicitly until its owning job implements the suite. */
export interface SecretSealerPort {
 seal(required: { reference: CredentialReference; plaintext: string }, optional?: CallOptions): Promise<Outcome<SealedSecret>>;
 open(required: { reference: CredentialReference; secret: SealedSecret }, optional?: CallOptions): Promise<Outcome<string>>;
}
/** KeyringPort: caller-owned, injected boundary. j00 doubles fail explicitly until its owning job implements the suite. */
export interface KeyringPort {
 resolve(required: { configuration: KeyringConfiguration; version: number }, optional?: CallOptions): Promise<Outcome<Uint8Array>>;
}
/** OAuthClientPort: caller-owned, injected boundary. j00 doubles fail explicitly until its owning job implements the suite. */
export interface OAuthClientPort {
 begin(required: { context: CallContext; request: ConnectRequest }, optional?: CallOptions): Promise<Outcome<ConnectChallenge>>;
 complete(required: { callback: VerifiedOAuthCallback }, optional?: CallOptions): Promise<Outcome<SealedSecret>>;
}
/** CredentialLockPort: caller-owned, injected boundary. j00 doubles fail explicitly until its owning job implements the suite. */
export interface CredentialLockPort {
 acquire(required: { reference: CredentialReference }, optional?: CallOptions): Promise<Outcome<{ readonly lockId: string }>>;
 release(required: { lockId: string }, optional?: CallOptions): Promise<Outcome<void>>;
}
/** CredentialAuditPort: caller-owned, injected boundary. j00 doubles fail explicitly until its owning job implements the suite. */
export interface CredentialAuditPort {
 record(required: { context: CallContext; operation: string; connectionId: string }, optional?: CallOptions): Promise<Outcome<void>>;
}
/** CredentialBrokerPort: caller-owned, injected boundary. j00 doubles fail explicitly until its owning job implements the suite. */
export interface CredentialBrokerPort {
 use(required: { context: CallContext; reference: CredentialReference; operationId: string }, optional?: CallOptions): Promise<Outcome<SealedSecret>>;
}
export type CredentialObserverPort = ObserverPort;

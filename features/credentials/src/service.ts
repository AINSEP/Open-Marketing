import type { Outcome, CallContext, CallOptions, ClockPort, IdPort, ObserverPort, Scope, Money, TimeWindow, Page, PageQuery, ConfirmationCard, EffectEnvelope, GenerationAllowanceSettings, GenerationCostQuote, GenerationApprovalRequirement, HaltStopRequest, HaltStopPermit, ServiceContext, MeasurementGrant, CapabilityEnvelope } from "@open-marketing/contracts";
import { notImplemented } from "@open-marketing/contracts";
import type { CredentialRepoPort, SecretSealerPort, KeyringPort, OAuthClientPort, CredentialLockPort, CredentialAuditPort, CredentialBrokerPort, CredentialObserverPort } from "./ports.js";
import type { ConnectRequest, ConnectChallenge, VerifiedOAuthCallback, ConnectionSummary, RevocationReceipt, SealedSecret, KeyringConfiguration, CredentialReference, CredentialService } from "./types.js";
/** Inert credentials factory. @returns Service whose operations fail with typed not_implemented; no I/O or startup. @example createCredentialService({ injectedPorts: undefined } as Parameters<typeof createCredentialService>[0]) @complexity O(1). */
export function createCredentialService(
  required: {
    repo: CredentialRepoPort;
    sealer: SecretSealerPort;
    keyring: KeyringPort;
    oauth: OAuthClientPort;
    clock: ClockPort;
    locks: CredentialLockPort;
    audit: CredentialAuditPort;
  },
  optional?: { observer?: CredentialObserverPort },
): CredentialService {
return {
 async beginConnect() { return notImplemented({ operation: "credentials.beginConnect" }); },
 async completeConnect() { return notImplemented({ operation: "credentials.completeConnect" }); },
 async revoke() { return notImplemented({ operation: "credentials.revoke" }); },
};
}

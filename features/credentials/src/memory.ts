import type { Outcome, CallContext, CallOptions, ClockPort, IdPort, ObserverPort, Scope, Money, TimeWindow, Page, PageQuery, ConfirmationCard, EffectEnvelope, GenerationAllowanceSettings, GenerationCostQuote, GenerationApprovalRequirement, HaltStopRequest, HaltStopPermit, ServiceContext, MeasurementGrant, CapabilityEnvelope } from "@open-marketing/contracts";
import { notImplemented } from "@open-marketing/contracts";
import type { CredentialRepoPort, SecretSealerPort, KeyringPort, OAuthClientPort, CredentialLockPort, CredentialAuditPort, CredentialBrokerPort } from "./ports.js";
/** Stub double for CredentialRepoPort; B1 suite is shared with its future real adapter. No persistence claim. */
export function createMemoryCredentialRepo(required: Record<string, never>): CredentialRepoPort { return {
 async get() { return notImplemented({ operation: "CredentialRepoPort.get" }); },
 async store() { return notImplemented({ operation: "CredentialRepoPort.store" }); },
 async revoke() { return notImplemented({ operation: "CredentialRepoPort.revoke" }); },
}; }
/** Stub double for SecretSealerPort; B1 suite is shared with its future real adapter. No persistence claim. */
export function createMemorySecretSealer(required: Record<string, never>): SecretSealerPort { return {
 async seal() { return notImplemented({ operation: "SecretSealerPort.seal" }); },
 async open() { return notImplemented({ operation: "SecretSealerPort.open" }); },
}; }
/** Stub double for KeyringPort; B1 suite is shared with its future real adapter. No persistence claim. */
export function createMemoryKeyring(required: Record<string, never>): KeyringPort { return {
 async resolve() { return notImplemented({ operation: "KeyringPort.resolve" }); },
}; }
/** Stub double for OAuthClientPort; B1 suite is shared with its future real adapter. No persistence claim. */
export function createMemoryOAuthClient(required: Record<string, never>): OAuthClientPort { return {
 async begin() { return notImplemented({ operation: "OAuthClientPort.begin" }); },
 async complete() { return notImplemented({ operation: "OAuthClientPort.complete" }); },
}; }
/** Stub double for CredentialLockPort; B1 suite is shared with its future real adapter. No persistence claim. */
export function createMemoryCredentialLock(required: Record<string, never>): CredentialLockPort { return {
 async acquire() { return notImplemented({ operation: "CredentialLockPort.acquire" }); },
 async release() { return notImplemented({ operation: "CredentialLockPort.release" }); },
}; }
/** Stub double for CredentialAuditPort; B1 suite is shared with its future real adapter. No persistence claim. */
export function createMemoryCredentialAudit(required: Record<string, never>): CredentialAuditPort { return {
 async record() { return notImplemented({ operation: "CredentialAuditPort.record" }); },
}; }
/** Stub double for CredentialBrokerPort; B1 suite is shared with its future real adapter. No persistence claim. */
export function createMemoryCredentialBroker(required: Record<string, never>): CredentialBrokerPort { return {
 async use() { return notImplemented({ operation: "CredentialBrokerPort.use" }); },
}; }

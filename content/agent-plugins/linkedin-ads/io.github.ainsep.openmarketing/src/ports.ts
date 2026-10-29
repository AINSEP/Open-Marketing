import type { CallContext, CallOptions, ClockPort, EffectEnvelope, ObserverPort, Outcome, Scope } from "@open-marketing/contracts";
import type { LinkedInCommand } from "./commands.js";
import type { LinkedInWireRequest } from "./wire.js";

export type { LinkedInWireRequest } from "./wire.js";

/** Server-owned binding; never part of assistant tool arguments. Version 202610 is verified. */
export interface LinkedInConfiguration {
  readonly scope: Scope;
  readonly connectionId: string;
  readonly accountId: string;
  readonly currency: string;
  readonly apiVersion: "202610";
  readonly pluginDigest: string;
  readonly bindingId: string;
}
/** Credential broker checks connection/account ownership, OAuth scopes and refresh in server custody.
 * Returned tokens stay in this server-loaded plugin; never include them in results or observations.
 */
export interface LinkedInCredentialPort {
  access(required: { connectionId: string; accountId: string }, optional?: CallOptions): Promise<Outcome<{ accessToken: string; expiresAt?: number }>>;
}
/** One reviewed call. The host MUST enforce admission, scope/account/parent ownership, current
 * connection, production-server mode for ad writes, halt and exact cards on EVERY ad_spend call.
 * It claims operationId + argumentsDigest in the ONE jobs outbox before execute, never executes
 * an already dispatched claim again, and appends egress audit with context IDs. No plugin store.
 * Credentials resolve BEFORE dispatch. Hold the server safety fence through execute; no await
 * between the final authority check and execute.
 * execute's zero-argument shape is the existing host callback ABI, exercised by the shared suite.
 */
export interface LinkedInGatewayPort {
  dispatch(required: {
    context: CallContext;
    configuration: LinkedInConfiguration;
    operation: LinkedInCommand["kind"];
    request: LinkedInWireRequest;
    effect: EffectEnvelope;
    execute: () => Promise<Outcome<LinkedInResult>>;
  }, optional?: CallOptions): Promise<Outcome<LinkedInResult>>;
}
/** Acknowledgement is not observed serving state. List items expose provider state separately. */
export interface LinkedInResult {
  readonly operationId: string;
  readonly status: "succeeded" | "acknowledged" | "unknown";
  readonly observedState: "unknown";
  readonly data: unknown;
}
/** Spend metadata is assembled by the server from the exact request, using existing contracts. */
export interface LinkedInInvocation {
  readonly context: CallContext;
  readonly operationId: string;
  readonly command: LinkedInCommand;
  readonly moneyExposure: EffectEnvelope["moneyExposure"];
  readonly requiredLimit: EffectEnvelope["requiredLimit"];
}
/** Inert adapter; invoke performs at most one vendor request, with zero retries. */
export interface LinkedInAdsAdapter {
  invoke(required: LinkedInInvocation, optional?: CallOptions): Promise<Outcome<LinkedInResult>>;
}
/** Dependencies are supplied by server composition. fetch is the documented browser/Node ABI. */
export interface LinkedInDependencies {
  readonly configuration: LinkedInConfiguration;
  readonly gateway: LinkedInGatewayPort;
  readonly credentials: LinkedInCredentialPort;
  readonly fetch: typeof fetch;
  readonly clock: ClockPort;
  readonly observer: ObserverPort;
}

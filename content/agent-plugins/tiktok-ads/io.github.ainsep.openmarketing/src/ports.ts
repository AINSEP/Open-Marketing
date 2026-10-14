import type { CallContext, CallOptions, EffectEnvelope, HaltStopPermit, Outcome, ServiceContext } from "@open-marketing/contracts";
import type { TikTokDispatchCommand } from "./commands.js";
import type { TikTokEventsPayload } from "./events-payload.js";

/** Backend Events request is deliberately absent from the agent tool union/catalog. */
export type TikTokEgressCommand = TikTokDispatchCommand | { readonly kind: "track-event"; readonly payload: TikTokEventsPayload };

/** Caller-owned server credential broker. It enforces current scope/account binding and
 * returns only the token for this call. Honor optional.signal's transport deadline.
 * Never persist the token or expose it to the agent.
 */
export interface TikTokCredentialPort {
  access(required: { context: CallContext | ServiceContext; connectionId: string; accountId: string }, optional?: CallOptions): Promise<Outcome<{ accessToken: string }>>;
}

/** Server-only fenced egress. isCurrent MUST check the live host dispatch fence, not
 * a cached approval. Transport rechecks it after asynchronous credential resolution.
 */
export interface TikTokEgressRequest {
  readonly context: CallContext | ServiceContext;
  readonly connectionId: string;
  readonly accountId: string;
  readonly operationId: string;
  readonly request: TikTokEgressCommand;
  readonly isCurrent: () => boolean;
}

/** Real injected-fetch adapter and memory fixture implement this same boundary. */
export interface TikTokEgressPort {
  send(required: TikTokEgressRequest, optional?: CallOptions): Promise<Outcome<unknown>>;
}

/** Token-free call data for the ONE host dispatcher. Host owns policy, account/mode
 * authority, admission, audit, halt serialization and ONE outbox claim.
 */
export interface TikTokCall {
  readonly operationId: string;
  readonly connectionId: string;
  readonly accountId: string;
  readonly request: TikTokDispatchCommand;
  readonly argumentsDigest: string;
  readonly pluginDigest: string;
  readonly schemaFingerprint: string;
  readonly haltStopPermit?: HaltStopPermit;
}

/** Trusted host re-encodes requests, checks digests/effects/current binding, and returns
 * a validated code/data envelope. Duplicate write claims must never send twice.
 * For halt_stop verify the current permit/epoch and existing campaign ownership under
 * the halt fence; normal invoke cannot acquire halt authority. Never retry writes.
 */
export interface TikTokGatewayPort {
  invoke(required: { context: CallContext; call: TikTokCall; effect: EffectEnvelope }, optional?: CallOptions): Promise<Outcome<unknown>>;
}

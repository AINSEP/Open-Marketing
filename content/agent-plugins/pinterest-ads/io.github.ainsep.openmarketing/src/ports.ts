import type { AppError, CallContext, CallOptions, ClockPort, EffectEnvelope, ObserverPort, Outcome, Scope } from "@open-marketing/contracts";
import type { PinterestCommand } from "./commands.js";

/** Server-resolved binding. Null account/currency permits connection-only account discovery. */
export interface PinterestConfiguration {
  readonly scope: Scope;
  readonly connectionId: string;
  readonly accountId: string | null;
  readonly currency: string | null;
  readonly apiVersion: "v5";
  readonly pluginDigest: string;
  readonly bindingId: string;
}
/** Server broker owns required scope checks (ads:read/ads:write), token custody and refresh; expiry is epoch ms. */
export interface PinterestCredentialPort {
  access(required: { connectionId: string; accountId: string | null }, optional?: CallOptions): Promise<Outcome<{ accessToken: string; expiresAt?: number }>>;
}
export interface PinterestWireRequest { readonly method: "GET"; readonly url: string }
/** Internal finite deployment/CAPI request; never exposed as a standalone assistant tool. */
export interface PinterestWriteRequest { readonly method: "GET" | "POST"; readonly url: string; readonly body?: string }
export interface PinterestResult { readonly operationId: string; readonly status: "succeeded"; readonly observedState: "unknown"; readonly data: unknown }
export interface PinterestInvocation { readonly context: CallContext; readonly operationId: string; readonly command: PinterestCommand }
/** Recheck current admission/connection/account after token lookup, then execute under the server
 * fence. Host owns policy, operation identity and durable audit. execute is the host callback ABI.
 */
export interface PinterestGatewayPort {
  dispatch(required: { context: CallContext; configuration: PinterestConfiguration; operation: PinterestCommand["kind"]; request: PinterestWireRequest; effect: EffectEnvelope; execute: () => Promise<Outcome<PinterestResult>> }, optional?: CallOptions): Promise<Outcome<PinterestResult>>;
}
export interface PinterestAdsAdapter { invoke(required: PinterestInvocation, optional?: CallOptions): Promise<Outcome<PinterestResult>> }
/** Server-only dependencies; factories perform no I/O. fetch retains the standard platform ABI. */
export interface PinterestDependencies {
  readonly configuration: PinterestConfiguration;
  readonly admitted: boolean;
  readonly gateway: PinterestGatewayPort;
  readonly credentials: PinterestCredentialPort;
  readonly fetch: typeof fetch;
  /** Host-created abort signal; covers fetch and body consumption (e.g. ({ timeoutMs }) => AbortSignal.timeout(timeoutMs)). */
  readonly deadline: (required: { timeoutMs: number }) => AbortSignal;
  readonly clock: ClockPort;
  readonly observer: ObserverPort;
}
/** Sanitized boundary failures never echo provider bodies, tokens or URLs. */
export function failure(required: { code: AppError["code"] }): Outcome<never> {
  return { ok: false, error: { code: required.code, message: "Pinterest request " + required.code, retryable: false } };
}

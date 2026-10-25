import type { CallContext, CallOptions, ClockPort, EffectEnvelope, ObserverPort, Outcome, Scope } from "@open-marketing/contracts";
import type { ResendCommand, ResendDomain } from "./commands.js";

/** Server binding only; never assistant arguments or a credential-bearing config. */
export interface ResendEmailConfiguration { readonly scope: Scope; readonly connectionId: string; readonly pluginDigest: string; readonly bindingId: string }
/** Server broker enforces scope, active connection and Full-access key custody. */
export interface ResendEmailCredentialPort { access(required: { connectionId: string }, optional?: CallOptions): Promise<Outcome<{ accessToken: string }>> }
/** Read-only request excludes Authorization; the digest binds the exact domain path. */
export interface ResendEmailRequest { readonly method: "GET"; readonly path: string }
/** Validated provider observations only; domain data never grants sending authority. */
export interface ResendEmailResult { readonly operationId: string; readonly status: "succeeded"; readonly domains: readonly ResendDomain[]; readonly nextCursor: string | null }
/** After credential lookup, hold the server dispatch barrier through execute: recheck current
 * admission, scope, connection and read authority. Append egress audit with context IDs.
 * This plugin has no production gateway implementation; absent host binding stays unavailable.
 * Never log credentials or provider error bodies.
 * execute's zero-argument callback is the existing host ABI; the shared suite exercises it.
 */
export interface ResendEmailGatewayPort {
  dispatch(required: { context: CallContext; configuration: ResendEmailConfiguration; command: ResendCommand;
    request: ResendEmailRequest; effect: EffectEnvelope; execute: () => Promise<Outcome<ResendEmailResult>> }, optional?: CallOptions): Promise<Outcome<ResendEmailResult>>;
}
/** Server invocation accepts domain reads only. */
export interface ResendEmailInvocation { readonly context: CallContext; readonly operationId: string; readonly command: ResendCommand }
/** Inert until invoked; one request per invocation, no retries or private stores. */
export interface ResendEmailAdapter { invoke(required: ResendEmailInvocation, optional?: CallOptions): Promise<Outcome<ResendEmailResult>> }
/** Server composition supplies every effect dependency; fetch retains its foreign platform ABI. */
export interface ResendEmailDependencies { readonly configuration: ResendEmailConfiguration; readonly gateway: ResendEmailGatewayPort;
  readonly credentials: ResendEmailCredentialPort; readonly fetch: typeof fetch; readonly clock: ClockPort; readonly observer: ObserverPort;
  /** Host-owned timing: return a signal that aborts after timeoutMs, covering fetch and its body.
   * @example deadline: ({ timeoutMs }) => hostDeadline({ timeoutMs }) */
  readonly deadline: (required: { timeoutMs: number }) => AbortSignal }

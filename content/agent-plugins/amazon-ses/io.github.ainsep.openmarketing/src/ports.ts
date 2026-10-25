import type { CallContext, CallOptions, ClockPort, EffectEnvelope, ObserverPort, Outcome, Scope } from "@open-marketing/contracts";
import type { SesCommand, SesCredentials, SesData } from "./commands.js";

/** Server-owned binding, never assistant arguments. Standard AWS partition only in R1. */
export interface SesConfiguration {
  readonly scope: Scope;
  readonly connectionId: string;
  readonly region: string;
  readonly domainIdentity: string;
  readonly pluginDigest: string;
  readonly bindingId: string;
}
/** Broker verifies workspace/connection ownership; secrets stay inside the server. */
export interface SesCredentialPort {
  access(required: { connectionId: string }, optional?: CallOptions): Promise<Outcome<SesCredentials>>;
}
export interface SesWireRequest { readonly method: "GET"; readonly url: string }
export interface SesResult { readonly operationId: string; readonly status: "succeeded"; readonly data: SesData }
export interface SesInvocation { readonly context: CallContext; readonly operationId: string; readonly command: SesCommand }
/** Host rechecks admission, scope, enabled connection and current authority before execute;
 * host owns durable egress audit with run/correlation/trace IDs. No plugin policy/store.
 * execute is the existing zero-argument host callback ABI, covered by the shared suite.
 */
export interface SesGatewayPort {
  dispatch(required: {
    context: CallContext; configuration: SesConfiguration; operation: SesCommand["kind"];
    request: SesWireRequest; effect: EffectEnvelope; execute: () => Promise<Outcome<SesResult>>;
  }, optional?: CallOptions): Promise<Outcome<SesResult>>;
}
/** Factories are inert; each invocation performs at most one GET, with no retries. */
export interface AmazonSesAdapter { invoke(required: SesInvocation, optional?: CallOptions): Promise<Outcome<SesResult>> }
/** All I/O comes from server composition. fetch retains its foreign callback ABI. */
export interface SesDependencies {
  readonly configuration: SesConfiguration;
  readonly credentials: SesCredentialPort;
  readonly gateway: SesGatewayPort;
  readonly fetch: typeof fetch;
  readonly clock: ClockPort;
  readonly observer: ObserverPort;
}

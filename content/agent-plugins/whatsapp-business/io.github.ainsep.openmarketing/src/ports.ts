import type { CallContext, CallOptions, ClockPort, EffectEnvelope, ObserverPort, Outcome, Scope } from "@open-marketing/contracts";
import type { WhatsAppReadCommand, WhatsAppReadData } from "./commands.js";

/** Server-only binding. Admission defaults off; tokens never enter tool arguments. */
export interface WhatsAppConfiguration {
  readonly scope: Scope;
  readonly connectionId: string;
  readonly wabaId: string;
  readonly phoneNumberId: string;
  readonly apiVersion: "v26.0";
  readonly pluginDigest: string;
  readonly bindingId: string;
  readonly admitted: boolean;
}
/** Broker verifies scope, connection and WABA/phone ownership plus whatsapp_business_management.
 * Reuse O2 Meta sign-in or a sealed system-user token; no OAuth implementation here.
 */
export interface WhatsAppCredentialPort {
  access(required: { configuration: WhatsAppConfiguration; context: CallContext }, optional?: CallOptions): Promise<Outcome<{ accessToken: string; expiresAt?: number }>>;
}
/** Fixed, read-only request. A cursor can never replace the Graph origin or path. */
export interface WhatsAppWireRequest { readonly url: string; readonly method: "GET" }
/** Host enforces current admission, scope, asset ownership and connection BEFORE execute.
 * Denial must not execute or refresh credentials. Hold the authority fence through execute,
 * including broker access. Host appends egress audit with context IDs.
 * The zero-argument execute callback is the host ABI, covered by dispatch-suite.ts.
 */
export interface WhatsAppGatewayPort {
  dispatch(required: {
    configuration: WhatsAppConfiguration; context: CallContext; operation: WhatsAppReadCommand["kind"];
    request: WhatsAppWireRequest; effect: EffectEnvelope;
    execute: () => Promise<Outcome<WhatsAppReadResult>>;
  }, optional?: CallOptions): Promise<Outcome<WhatsAppReadResult>>;
}
/** Status fields are vendor observations, never permission to send. Missing fields remain unknown. */
export interface WhatsAppReadResult { readonly operationId: string; readonly data: WhatsAppReadData }
/** Server supplies the authenticated context; commands cannot select accounts or credentials. */
export interface WhatsAppInvocation { readonly context: CallContext; readonly operationId: string; readonly command: WhatsAppReadCommand }
/** Inert, read-only v1 adapter; each invocation makes at most one Graph request. */
export interface WhatsAppBusinessAdapter { invoke(required: WhatsAppInvocation, optional?: CallOptions): Promise<Outcome<WhatsAppReadResult>> }
/** All I/O and time come from server composition. fetch uses the standard platform ABI. */
export interface WhatsAppDependencies {
  readonly configuration: WhatsAppConfiguration; readonly credentials: WhatsAppCredentialPort; readonly gateway: WhatsAppGatewayPort;
  readonly fetch: typeof fetch; readonly clock: ClockPort; readonly observer: ObserverPort;
  /** Host creates a fresh deadline signal per GET; fixtures supply controlled signals without timers. */
  readonly createDeadline: (required: { timeoutMs: number }) => AbortSignal;
}

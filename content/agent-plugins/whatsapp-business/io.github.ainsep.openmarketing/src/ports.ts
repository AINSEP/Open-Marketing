import type { z } from "zod";
import type { configurationSchema } from "./commands.js";
import type { CallContext, CallOptions, ClockPort, ObserverPort, Outcome } from "@open-marketing/contracts";
import type { WhatsAppReadCommand, WhatsAppReadData } from "./commands.js";

/** Server-only binding; current admission belongs to the host's guarded effects. */
export type WhatsAppConfiguration = z.infer<typeof configurationSchema>;
/** Broker verifies scope, connection and WABA/phone ownership plus whatsapp_business_management.
 * Reuse O2 Meta sign-in or a sealed system-user token; no OAuth implementation here.
 */
export interface WhatsAppCredentialPort {
  access(required: { connectionId: string; accountId: string }, optional?: CallOptions): Promise<Outcome<{ accessToken: string; expiresAt?: number }>>;
}
/** Fixed, read-only request. A cursor can never replace the Graph origin or path. */
export interface WhatsAppWireRequest { readonly url: string; readonly method: "GET" }
/** Status fields are vendor observations, never permission to send. Missing fields remain unknown. */
export interface WhatsAppReadResult { readonly operationId: string; readonly data: WhatsAppReadData }
/** Server supplies the authenticated context; commands cannot select accounts or credentials. */
export interface WhatsAppInvocation { readonly context: CallContext; readonly operationId: string; readonly command: WhatsAppReadCommand }
/** Inert, read-only v1 adapter; each invocation makes at most one Graph request. */
export interface WhatsAppBusinessAdapter { invoke(required: WhatsAppInvocation, optional?: CallOptions): Promise<Outcome<WhatsAppReadResult>> }
/** All I/O and time come from server composition. fetch uses the standard platform ABI. */
export interface WhatsAppDependencies {
  readonly configuration: WhatsAppConfiguration; readonly credentials: WhatsAppCredentialPort;
  readonly fetch: typeof fetch; readonly clock: ClockPort; readonly observer: ObserverPort;
  /** Host creates a fresh deadline signal per GET; fixtures supply controlled signals without timers. */
  readonly createDeadline: (required: { timeoutMs: number }) => AbortSignal;
}

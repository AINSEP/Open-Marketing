import type { CallContext, CallOptions, ClockPort, EffectEnvelope, ObserverPort, Outcome } from "@open-marketing/contracts";
import type { z } from "zod";
import type { configurationSchema, commandSchema, readDataSchema } from "./commands.js";

/** Server-owned account, one service/sender and existing registration; never assistant configuration. */
export type TwilioConfiguration = z.infer<typeof configurationSchema>;
/** Closed read commands; credentials and arbitrary phone destinations are excluded. */
export type TwilioCommand = z.infer<typeof commandSchema>;
/** Validated, minimal vendor projections; no webhook URLs, auth tokens or raw responses. */
export type TwilioReadData = z.infer<typeof readDataSchema>;
/** API-key material stays in the server-loaded plugin and is never returned or observed. */
export interface TwilioCredentialPort {
  access(required: { context: CallContext; connectionId: string; accountSid: string }, optional?: CallOptions): Promise<Outcome<{ accountSid: string; apiKeySid: string; apiKeySecret: string; expiresAt?: number }>>;
}
/** Host MUST recheck current admission, scope, connection/account ownership and plugin revision
 * before execute, and append egress audit with context IDs. No plugin approval or credential store.
 * execute is the host's existing zero-argument callback ABI; one invocation permits one fetch.
 */
export interface TwilioGatewayPort {
  dispatch(required: { context: CallContext; configuration: TwilioConfiguration; command: TwilioCommand; effect: EffectEnvelope; execute: () => Promise<Outcome<TwilioResult>> }, optional?: CallOptions): Promise<Outcome<TwilioResult>>;
}
/** Readiness stays unknown; permission_limited has no data and Accounts 401 cannot prove key validity. */
export interface TwilioResult {
  readonly operationId: string;
  readonly status: "succeeded" | "permission_limited";
  readonly sendReadiness: "unknown";
  readonly data: TwilioReadData | null;
}
/** The caller supplies trusted context; command connectionId must match the server binding. */
export interface TwilioInvocation { readonly context: CallContext; readonly operationId: string; readonly command: TwilioCommand }
/** Inert, read-only v1 surface. Each invoke performs at most one request with no retries. */
export interface TwilioSmsAdapter { invoke(required: TwilioInvocation, optional?: CallOptions): Promise<Outcome<TwilioResult>> }
/** No defaults construct dependencies. Fetch uses its documented native callback ABI. */
export interface TwilioDependencies {
  readonly configuration: TwilioConfiguration;
  readonly credentials: TwilioCredentialPort;
  readonly gateway: TwilioGatewayPort;
  readonly fetch: typeof fetch;
  /** Host creates a fresh signal expiring within timeoutMs, covering fetch and body consumption.
   * Example host binding: ({ timeoutMs }) => AbortSignal.timeout(timeoutMs).
   */
  readonly deadlineSignal: (required: { timeoutMs: number }) => AbortSignal;
  readonly clock: ClockPort;
  readonly observer: ObserverPort;
}

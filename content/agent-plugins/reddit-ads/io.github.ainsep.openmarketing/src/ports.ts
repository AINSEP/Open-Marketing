import type { CallContext, CallOptions, ClockPort, ObserverPort, Outcome, Scope } from "@open-marketing/contracts";
import type { RedditCommand } from "./commands.js";

/** Server-owned selection. Null account/currency is permitted for discovery only. */
export interface RedditConfiguration {
  readonly scope: Scope;
  readonly connectionId: string;
  readonly accountId: string | null;
  readonly currency: string | null;
}
/** Host enforces connection/plugin/scope ownership; paste tokens never enter tool arguments. */
export interface RedditCredentialPort {
  access(required: { connectionId: string; accountId: string | null }, optional?: CallOptions): Promise<Outcome<{ accessToken: string; expiresAt?: number }>>;
}
/** Fixed vendor request, constructed solely from parsed commands. POST reports are reads. */
export interface RedditWireRequest { readonly url: string; readonly method: "GET" | "POST"; readonly body?: string }
/** Public receipts contain projected data only, with no inferred serving or spend state. */
export interface RedditResult { readonly operationId: string; readonly status: "succeeded"; readonly observedState: "unknown"; readonly data: unknown }
/** Read-only invocation: spend metadata must be null. */
export interface RedditInvocation { readonly context: CallContext; readonly operationId: string; readonly command: RedditCommand; readonly moneyExposure: null; readonly requiredLimit: null }
/** Server composition and fixtures share this inert boundary; no services start at import/factory. */
export interface RedditAdsAdapter { invoke(required: RedditInvocation, optional?: CallOptions): Promise<Outcome<RedditResult>> }
/** Host supplies its guarded fetch and current admission check; no second policy or gateway.
 * Fetch uses the native ABI; observer and clock use canonical contracts.
 */
export interface RedditDependencies {
  readonly configuration: RedditConfiguration;
  readonly admitted: (required: { context: CallContext }) => boolean;
  readonly credentials: RedditCredentialPort;
  readonly fetch: typeof fetch;
  /** Host creates a fresh signal that aborts after timeoutMs, including during response streaming. */
  readonly createDeadline: (required: { timeoutMs: number }) => AbortSignal;
  readonly clock: ClockPort;
  readonly observer: ObserverPort;
}

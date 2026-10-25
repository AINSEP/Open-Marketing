import type { CallContext, CallOptions, ClockPort, ObserverPort, Outcome, Scope } from "@open-marketing/contracts";
import type { LineAdsCommand } from "./commands.js";

/** Server-owned connection/account metadata; accountId:null permits account discovery only. */
export interface LineAdsConfiguration {
  readonly scope: Scope;
  readonly connectionId: string;
  readonly accountId: string | null;
  readonly country: "JP" | "TW" | "TH";
  readonly currency: string;
  readonly timezone: string;
}
/** Existing paste-token custody: accessToken contains JSON {accessKey,secretKey,groupId}.
 * The server verifies current connection/account ownership; secrets never enter tool arguments.
 */
export interface LineAdsCredentialPort {
  access(required: { connectionId: string; accountId: string | null }, optional?: CallOptions): Promise<Outcome<{ accessToken: string }>>;
}
/** One fixed GET, with no caller-controlled URL or headers. */
export interface LineAdsWireRequest { readonly url: string; readonly method: "GET" }
/** Read receipt. Data is a validated page or a source-labelled report, never raw vendor JSON. */
export interface LineAdsResult { readonly operationId: string; readonly status: "succeeded"; readonly observedState: "unknown"; readonly data: unknown }
/** The sole invocation shape; no account/group/credential overrides in commands. */
export interface LineAdsInvocation { readonly context: CallContext; readonly operationId: string; readonly command: LineAdsCommand }
/** Inert adapter; a call consumes one page, performs no retries and creates no services. */
export interface LineAdsAdapter { invoke(required: LineAdsInvocation, optional?: CallOptions): Promise<Outcome<LineAdsResult>> }
/** Composition injects live admission and a guarded fetch which rechecks current policy,
 * connection ownership and plugin revision immediately before egress. No new policy authority.
 * fetch follows the foreign Node ABI; the shared acceptance suite exercises that wrapper.
 */
export interface LineAdsDependencies {
  readonly admitted: boolean;
  readonly configuration: LineAdsConfiguration;
  readonly credentials: LineAdsCredentialPort;
  readonly fetch: typeof fetch;
  readonly clock: ClockPort;
  /** Host creates the abort signal for the adapter's fixed 15000ms deadline. */
  readonly createDeadline: (required: { timeoutMs: number }) => AbortSignal;
  readonly observer: ObserverPort;
}

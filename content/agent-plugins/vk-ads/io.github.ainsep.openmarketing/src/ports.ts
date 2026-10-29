import type { CallContext, CallOptions, ClockPort, ObserverPort, Outcome, Scope } from "@open-marketing/contracts";
import type { VkCommand } from "./commands.js";

/** Server-owned binding; null account permits token-account discovery only. */
export interface VkConfiguration { readonly scope: Scope; readonly connectionId: string; readonly accountId: string | null }
/** Server-sealed token. OAuth tokens include expiry and refreshToken; pasted tokens may omit them. */
export interface VkToken { readonly accessToken: string; readonly expiresAt?: number; readonly refreshToken?: string }
/** Client credentials are server-only. Missing/expired client tokens are unavailable: no issuance. */
export type VkCredential = VkToken | { readonly clientId: string; readonly clientSecret: string; readonly token: VkToken | null };
/** Existing sealed broker. Access rechecks server ownership/admission and honors cancellation.
 * Issuance/refresh require durable broker reconciliation not provided here; save is unused.
 */
export interface VkCredentials {
  access(required: { connectionId: string; accountId: string | null }, optional?: CallOptions): Promise<Outcome<VkCredential>>;
  save?(required: { connectionId: string; accountId: string | null; token: VkToken }, optional?: CallOptions): Promise<Outcome<void>>;
}
/** Private GET path; callers cannot supply hosts, headers, bodies or account overrides. */
export interface VkWireRequest { readonly path: string; readonly method: "GET" }
/** Explicit token identity; timezone remains unknown instead of inferred from currency. */
export interface VkAccount { readonly id: string; readonly username: string; readonly currency: string; readonly status: "active" | "deleted" | "blocked" }
/** A single validated page, never a raw response or a serving-state assertion. */
export interface VkPage { readonly source: "vk_ads"; readonly accountId: string; readonly retrievedAt: number; readonly timezone: null; readonly items: readonly (VkAccount | { readonly id: string; readonly name: string })[]; readonly nextOffset: number | null }
/** Vendor user summary, not a currency-normalized ledger or campaign attribution claim. */
export interface VkReport {
  readonly source: "vk_ads_statistics"; readonly accountId: string; readonly retrievedAt: number;
  readonly currency: null; readonly timezone: null; readonly monetarySemantics: "unavailable";
  readonly since: string; readonly until: string; readonly dateToInclusive: true; readonly attribution: "impression";
  readonly rows: readonly { readonly id: string; readonly spent: string; readonly impressions: number; readonly clicks: number }[];
}
export interface VkResult { readonly operationId: string; readonly status: "succeeded"; readonly observedState: "unknown"; readonly data: VkPage | VkReport }
export interface VkInvocation { readonly context: CallContext; readonly operationId: string; readonly command: VkCommand }
/** Read-only invocation; denial precedes credentials and network. */
export interface VkAdsAdapter { invoke(required: VkInvocation, optional?: CallOptions): Promise<Outcome<VkResult>> }
/** Server composition seams. Guarded fetch must recheck authority, binding and revision at egress
 * using the foreign fetch ABI.
 */
export interface VkDependencies {
  readonly configuration: VkConfiguration;
  readonly credentials: VkCredentials;
  readonly fetch: typeof fetch;
  /** Server-created 15s deadline; the adapter combines it with caller cancellation.
   * @example deadline: ({ timeoutMs }) => serverDeadlines.signal({ timeoutMs })
   */
  deadline(required: { timeoutMs: number }): AbortSignal;
  readonly clock: ClockPort;
  readonly observer: ObserverPort;
}

import type { CallContext, CallOptions, ClockPort, ObserverPort, Outcome, Scope } from "@open-marketing/contracts";
import type { VkCommand } from "./commands.js";

/** Server-owned binding; null account permits token-account discovery only. */
export interface VkConfiguration { readonly scope: Scope; readonly connectionId: string; readonly accountId: string | null }
/** Existing sealed paste-token broker, scoped by the server to this connection/account.
 * Implementations must recheck ownership/admission and honor cancellation; no plugin token store.
 */
export interface VkCredentials {
  access(required: { connectionId: string; accountId: string | null }, optional?: CallOptions): Promise<Outcome<{ accessToken: string; expiresAt?: number }>>;
}
/** Private GET path; callers cannot supply hosts, headers, bodies or account overrides. */
export interface VkWireRequest { readonly path: string; readonly method: "GET" }
/** Explicit token identity; timezone remains unknown instead of inferred from currency. */
export interface VkAccount { readonly id: string; readonly username: string; readonly currency: string; readonly status: "active" | "deleted" | "blocked" }
/** A single validated page, never a raw response or a serving-state assertion. */
export interface VkPage { readonly source: "vk_ads"; readonly accountId: string; readonly retrievedAt: number; readonly timezone: null; readonly items: readonly (VkAccount | { readonly id: string; readonly name: string })[]; readonly nextOffset: number | null }
export interface VkResult { readonly operationId: string; readonly status: "succeeded"; readonly observedState: "unknown"; readonly data: VkPage }
export interface VkInvocation { readonly context: CallContext; readonly operationId: string; readonly command: VkCommand }
/** Held integration: typed denials/unavailable only, with no credential or network I/O. */
export interface VkAdsAdapter { invoke(required: VkInvocation, optional?: CallOptions): Promise<Outcome<VkResult>> }
/** Approved server composition seams, unused while evidence is incomplete. Future guarded fetch
 * must recheck authority, binding and revision immediately at egress using the foreign fetch ABI.
 */
export interface VkDependencies {
  readonly admitted: boolean;
  readonly configuration: VkConfiguration;
  readonly credentials: VkCredentials;
  readonly fetch: typeof fetch;
  readonly clock: ClockPort;
  readonly observer: ObserverPort;
}

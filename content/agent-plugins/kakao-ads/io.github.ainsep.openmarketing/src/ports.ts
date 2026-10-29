import type { CallContext, CallOptions, ClockPort, ObserverPort, Outcome, Scope } from "@open-marketing/contracts";
import type { KakaoCommand } from "./commands.js";
import type { KakaoReport } from "./reporting.js";

/** Server binding, never tool arguments. Only list_accounts permits an unbound account. */
export interface KakaoConfiguration { readonly scope: Scope; readonly connectionId: string; readonly accountId: string | null }
/** Server integrations.access wrapper owns scope/plugin/connection checks and token custody.
 * No refresh rules are inferred for Business tokens. Example: access({ connectionId, accountId }). */
export interface KakaoCredentialPort {
  access(required: { connectionId: string; accountId: string | null }, optional?: CallOptions): Promise<Outcome<{ accessToken: string; expiresAt?: number }>>;
}
/** Validated vendor projections. config is user configuration, not observed delivery state. */
export interface KakaoEntity { readonly id: string; readonly name: string; readonly config: "ON" | "OFF" | "DEL" }
export interface KakaoAccountsPage { readonly content: readonly KakaoEntity[]; readonly number: number; readonly size: number; readonly totalElements: number; readonly totalPages: number; readonly page: number }
export interface KakaoCampaignList { readonly content: readonly KakaoEntity[] }
/** Read receipt; BASIC reports retain their source dates and unavailable metrics. */
export interface KakaoResult { readonly operationId: string; readonly data: KakaoAccountsPage | KakaoCampaignList | KakaoReport }
export interface KakaoInvocation { readonly context: CallContext; readonly operationId: string; readonly command: KakaoCommand }
/** One read, no retries or pagination loop. Example: invoke({ context, operationId, command: { kind: "list_accounts" } }). */
export interface KakaoAdsAdapter { invoke(required: KakaoInvocation, optional?: CallOptions): Promise<Outcome<KakaoResult>> }
/** Host fetch MUST recheck current admission and connection/account authority at egress and audit
 * context IDs. Factory and imports are inert; observer failures cannot change a read receipt. */
export interface KakaoDependencies {
  readonly configuration: KakaoConfiguration; readonly credentials: KakaoCredentialPort;
  readonly fetch: typeof fetch; readonly clock: ClockPort; readonly observer: ObserverPort;
  /** Host-owned deadline covering fetch and body I/O; called once per GET with 15000ms.
   * Example host binding: ({ timeoutMs }) => AbortSignal.timeout(timeoutMs).
   */
  readonly createDeadlineSignal: (required: { timeoutMs: number }) => AbortSignal;
}

import { z } from "zod";
import type { PluginCapability, AppError, CallContext, CallOptions, ClockPort, EffectEnvelope, ObserverPort, Outcome, Scope } from "@open-marketing/contracts";
export const date = z.iso.date();
const ids = z.array(z.string().regex(/^[0-9]{1,18}$/)).min(1).max(100).refine(value => new Set(value).size === value.length);
/** Native vendor UTC date parameters; no unverified inclusive/exclusive conversion. */
export const reportCommandSchema = z.strictObject({ kind: z.literal("report"), level: z.enum(["ACCOUNT", "CAMPAIGN"]), startDate: date, endDate: date, campaignIds: ids.optional() })
  .refine(value => value.level === "CAMPAIGN" ? value.campaignIds !== undefined : value.campaignIds === undefined);
export const cursor = z.string().min(1).max(2048).regex(/^[^\x00-\x1f\x7f]+$/);
const page = { pageSize: z.number().int().min(1).max(100).default(100), pageToken: cursor.optional() };
export const accounts = z.strictObject({ kind: z.literal("list_accounts"), ...page });
export const campaigns = z.strictObject({ kind: z.literal("list_campaigns"), ...page });
export const commandSchema = z.discriminatedUnion("kind", [accounts, campaigns, reportCommandSchema]);
export type PinterestCommand = z.input<typeof commandSchema>;

/** Server-resolved binding. Null account/currency permits connection-only account discovery. */
export interface PinterestConfiguration {
  readonly scope: Scope;
  readonly connectionId: string;
  readonly accountId: string | null;
  readonly currency: string | null;
  readonly apiVersion: "v5";
  readonly pluginDigest: string;
  readonly bindingId: string;
}
/** Server broker owns required scope checks (ads:read/ads:write), token custody and refresh; expiry is epoch ms. */
export interface PinterestCredentialPort {
  access(required: { connectionId: string; accountId: string | null }, optional?: CallOptions): Promise<Outcome<{ accessToken: string; expiresAt?: number }>>;
}
export interface PinterestWireRequest { readonly method: "GET"; readonly url: string }
/** Internal finite deployment/CAPI request; never exposed as a standalone assistant tool. */
export interface PinterestWriteRequest { readonly method: "GET" | "POST"; readonly url: string; readonly body?: string }
export interface PinterestResult { readonly operationId: string; readonly status: "succeeded"; readonly observedState: "unknown"; readonly data: unknown }
export interface PinterestInvocation { readonly context: CallContext; readonly operationId: string; readonly command: PinterestCommand }
/** Recheck current admission/connection/account after token lookup, then execute under the server
 * fence. Host owns policy, operation identity and durable audit. execute is the host callback ABI.
 */
export interface PinterestGatewayPort {
  dispatch(required: { context: Parameters<PluginCapability>[0]["context"]; configuration: PinterestConfiguration; operation: PinterestCommand["kind"]; request: PinterestWireRequest; effect: EffectEnvelope; execute: () => Promise<Outcome<PinterestResult>> }, optional?: CallOptions): Promise<Outcome<PinterestResult>>;
}
export interface PinterestAdsAdapter {
  invoke(required: PinterestInvocation, optional?: CallOptions): Promise<Outcome<PinterestResult>> }
/** Server-only dependencies; factories perform no I/O. fetch retains the standard platform ABI. */
export interface PinterestDependencies {
  readonly configuration: PinterestConfiguration;
  readonly gateway: PinterestGatewayPort;
  readonly credentials: PinterestCredentialPort;
  readonly fetch: typeof fetch;
  /** Host-created abort signal; covers fetch and body consumption (e.g. ({ timeoutMs }) => AbortSignal.timeout(timeoutMs)). */
  readonly deadline: (required: { timeoutMs: number }) => AbortSignal;
  readonly clock: ClockPort;
  readonly observer: ObserverPort;
}
/** Sanitized boundary failures never echo provider bodies, tokens or URLs. */
export function failure(required: { code: AppError["code"] }): Outcome<never> {
  return { ok: false, error: { code: required.code, message: "Pinterest request " + required.code, retryable: false } };
}

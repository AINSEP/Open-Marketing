import type { AppError, CallContext, CallOptions, ClockPort, ObserverPort, Outcome, Scope } from "@open-marketing/contracts";
import type { AmazonCommand } from "./commands.js";

/** Server binding; accountId is a profile ID, null only during account discovery. */
export interface AmazonConfiguration { readonly scope: Scope; readonly connectionId: string; readonly accountId: string | null; readonly region: "NA" | "EU" | "FE" }
/** Existing sealed-token broker ABI; accessToken contains the pasted Amazon JSON envelope. */
export interface AmazonCredentialPort {
  access(required: { connectionId: string; accountId: string | null }, optional?: CallOptions): Promise<Outcome<{ accessToken: string; expiresAt?: number }>>;
}
/** No policy gateway here: composition supplies fetch guarded by current host authority on EVERY
 * request, including report storage. Report requests must already be claimed in the ONE outbox.
 * Imports/factories perform no I/O.
 */
export interface AmazonDependencies {
  readonly configuration: AmazonConfiguration;
  readonly credentials: AmazonCredentialPort;
  readonly fetch: typeof fetch;
  /** Host timer returns a fresh signal that expires through response body consumption. */
  readonly createDeadlineSignal: (required: { timeoutMs: number }) => AbortSignal;
  readonly clock: ClockPort;
  readonly observer: ObserverPort;
}
/** A report request ACK is not completed reporting; unknown requests must never be resent. */
export interface AmazonResult { readonly operationId: string; readonly status: "succeeded" | "acknowledged" | "unknown"; readonly observedState: "unknown"; readonly data: unknown }
/** Host supplies context and operation identity; credentials and profile are never tool arguments. */
export interface AmazonInvocation { readonly context: CallContext; readonly operationId: string; readonly command: AmazonCommand }
/** Sole callable adapter boundary, fixture and production implementations share this shape. */
export interface AmazonAdsAdapter {
  invoke(required: AmazonInvocation, optional?: CallOptions): Promise<Outcome<AmazonResult>> }
/** Internal redacted failures; never include provider bodies, secrets or signed locations. */
export function failure(required: { code: AppError["code"] }): Outcome<never> {
  return { ok: false, error: { code: required.code, message: "Amazon Ads: " + required.code + (["expired", "unauthenticated"].includes(required.code) ? "; reconnect with current sealed credentials" : ""), retryable: false } };
}

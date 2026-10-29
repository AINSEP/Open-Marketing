import type { AppError, CallContext, CallOptions, ClockPort, EffectEnvelope, ObserverPort, Outcome, Scope } from "@open-marketing/contracts";
import type { MicrosoftAdsCommand } from "./commands.js";
/** Server-owned binding. Null account/customer/currency permits account discovery only. */
export interface MicrosoftAdsConfiguration {
  readonly scope: Scope;
  readonly admitted: boolean;
  readonly connectionId: string;
  readonly accountId: string | null;
  readonly customerId: string | null;
  readonly currency: string | null;
  readonly pluginDigest: string;
  readonly bindingId: string;
}
/** POST JSON RPCs and credential-free report GETs share the server's policy/audit fence. */
export type MicrosoftAdsWireRequest =
  | { readonly url: string; readonly method: "POST"; readonly body: string }
  | { readonly url: string; readonly method: "GET"; readonly body?: never };
/** Host rechecks current workspace/plugin/connection binding before AND after each lookup.
 * Developer token arrives in the bound credential's declared plugin secrets, never tool arguments. */
export interface MicrosoftAdsCredentialPort {
  access(required: { connectionId: string; accountId: string | null }, optional?: CallOptions): Promise<Outcome<{ accessToken: string; expiresAt?: number; secrets?: Readonly<Record<string, string>> }>>;
}
/** Existing server policy fences EACH RPC/download; guarded fetch/download recheck after awaits.
 * The zero-argument execute callback follows OM's existing host ABI. No policy lives here. */
export interface MicrosoftAdsGatewayPort {
  dispatch<T>(required: { context: CallContext; configuration: MicrosoftAdsConfiguration; operation: MicrosoftAdsCommand["kind"]; request: MicrosoftAdsWireRequest; effect: EffectEnvelope; execute: () => Promise<Outcome<T>> }, optional?: CallOptions): Promise<Outcome<T>>;
}
/** Structural copy of the installed Jini archive-reader ABI; no Jini dependency. */
export type MicrosoftAdsArchiveEntry =
    | { kind: "file"; entryPath: string; declaredSize?: number; executable?: boolean; openReadStream(required: Record<string, never>): AsyncIterable<Uint8Array> }
    | { kind: "directory" | "symlink" | "hardlink" | "device" | "fifo"; entryPath: string };
export interface MicrosoftAdsArchiveReader {
  entries(required: { archive: Uint8Array }): AsyncIterable<MicrosoftAdsArchiveEntry>;
}
export interface MicrosoftAdsDependencies {
  readonly configuration: MicrosoftAdsConfiguration;
  readonly credentials: MicrosoftAdsCredentialPort;
  readonly gateway: MicrosoftAdsGatewayPort;
  readonly fetch: typeof fetch;
  readonly clock: ClockPort;
  /** Host-owned deadline timer; effects must honor the returned signal.
   * @example timeoutSignal: ({ milliseconds }) => AbortSignal.timeout(milliseconds)
   */
  readonly timeoutSignal: (required: { milliseconds: number }) => AbortSignal;
  readonly observer: ObserverPort;
  readonly wait: (required: { milliseconds: number }, optional?: CallOptions) => Promise<void>;
  /** Guarded HTTPS, public destinations only, DNS checked, no redirects or credentials; <=2MiB. */
  readonly download: (required: { url: string; maxBytes: number }, optional?: CallOptions) => Promise<Outcome<Uint8Array>>;
  readonly archiveReader: MicrosoftAdsArchiveReader;
}
export interface MicrosoftAdsInvocation { readonly context: CallContext; readonly operationId: string; readonly command: MicrosoftAdsCommand }
export interface MicrosoftAdsResult { readonly operationId: string; readonly status: "succeeded"; readonly observedState: "unknown"; readonly data: unknown }
export interface MicrosoftAdsAdapter { invoke(required: MicrosoftAdsInvocation, optional?: CallOptions): Promise<Outcome<MicrosoftAdsResult>> }
/** Safe static errors; tainted provider text and credential-port messages never escape. */
export function failure(required: { code: AppError["code"] }): Outcome<never> {
  return { ok: false, error: { code: required.code, message: "Microsoft Ads request " + required.code, retryable: false } };
}

/** Existing host effects shared by read transport and server-owned jobs; no second gateway/outbox. */
export type MicrosoftAdsIoDependencies = Pick<MicrosoftAdsDependencies, "configuration" | "credentials" | "fetch" | "clock" | "timeoutSignal" | "observer">;

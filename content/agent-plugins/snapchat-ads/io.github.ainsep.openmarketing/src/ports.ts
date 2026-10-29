import type { PluginCapability, CallContext, CallOptions, ClockPort, EffectEnvelope, ObserverPort, Outcome, Scope } from "@open-marketing/contracts";
import type { SnapchatCommand } from "./commands.js";
import type { SnapchatCapiConfiguration, SnapchatCapiRequest, SnapchatCapiPayload, SnapchatConversionOutcome } from "./capi.js";

/** Server-resolved binding. Null account permits discovery only; currency/timezone come from the account. */
export interface SnapchatConfiguration {
  readonly scope: Scope;
  readonly connectionId: string;
  readonly accountId: string | null;
  readonly currency: string;
  readonly timezone: string;
  readonly apiVersion: "v1";
  readonly pluginDigest: string;
}
/** Existing server token broker; expiresAt is epoch milliseconds. No plugin token store/refresh service. */
export interface SnapchatCredentialPort {
  access(required: { connectionId: string; accountId: string | null }, optional?: CallOptions): Promise<Outcome<{ accessToken: string; expiresAt?: number }>>;
}
/** Fixed GET, never a caller-supplied URL. */
export interface SnapchatWireRequest { readonly url: string; readonly method: "GET" }
/** Existing server-policy seam. After token resolution, recheck admission, scope, connection,
 * account/organization authority and cancellation. Inject guarded fetch to recheck every fetch.
 * Hold the existing fence through execute. Reads do not claim another outbox job or approval.
 * execute's zero-argument callback follows LinkedIn's host ABI and the shared acceptance suite. */
export interface SnapchatGatewayPort {
  dispatch(required: { context: Parameters<PluginCapability>[0]["context"]; configuration: SnapchatConfiguration; operation: SnapchatCommand["kind"]; request: SnapchatWireRequest; effect: EffectEnvelope; execute: () => Promise<Outcome<SnapchatResult>> }, optional?: CallOptions): Promise<Outcome<SnapchatResult>>;
}
/** Projected provider data; succeeded never asserts a serving state. */
export interface SnapchatResult { readonly operationId: string; readonly status: "succeeded"; readonly observedState: "unknown"; readonly data: unknown }
/** Host-owned context/operation identity, separate from assistant command arguments. */
export interface SnapchatInvocation { readonly context: CallContext; readonly operationId: string; readonly command: SnapchatCommand }
/** Inert, read-only adapter; campaign reports use an ownership GET before the stats GET. */
export interface SnapchatAdsAdapter {
  invoke(required: SnapchatInvocation, optional?: CallOptions): Promise<Outcome<SnapchatResult>> }
/** No dependencies are constructed here. fetch uses the documented Node/browser callback ABI. */
export interface SnapchatDependencies {
  readonly configuration: SnapchatConfiguration;
  readonly credentials: SnapchatCredentialPort;
  readonly gateway: SnapchatGatewayPort;
  readonly fetch: typeof fetch;
  readonly clock: ClockPort;
  readonly observer: ObserverPort;
}
/** Same owning-job checkpoint ABI as LinkedIn. Host durably rejects repeated dispatch intents;
 * guarded fetch rechecks the grouped card, halt, binding and admission after every token lookup.
 * No second gateway, approval or outbox is entered by deployment. */
export type SnapchatDeploymentDependencies = Omit<SnapchatDependencies, "gateway">;
/** Candidate IDs survive every subsequent uncertainty; they do not establish verified ownership. */
export interface SnapchatDeploymentReferences { campaign?: string; squad?: string; ad?: string }
/** Verified hierarchy is distinct from candidate IDs; unknown receipts must never be replayed. */
export interface SnapchatDeploymentResult { status: "acknowledged" | "unknown"; references: SnapchatDeploymentReferences; entityIds: string[]; hierarchy: unknown[] }
/** Host ABI for the one approved job; only checkpoint and guarded fetch perform durable effects. */
export interface SnapchatDeploymentInput { context: CallContext; operationId: string; plan: unknown; dependencies: SnapchatDeploymentDependencies;
  checkpoint: (input: { step: string; phase: "dispatch" | "acknowledged"; references: SnapchatDeploymentReferences }) => Promise<Outcome<void>> }
/** Existing measurement authority ABI: verify owned Pixel/offline definition, current consent,
 * grant, contacts' internal digest evidence and exact destination SHA-256 payload after credentials.
 * Claim deliveryId once in OM's outbox; never execute an already-dispatched claim again.
 * Hold the fence and append redacted egress audit; isCurrent is synchronous at actual fetch. */
export interface SnapchatConversionAuthorityPort {
  dispatch(required: SnapchatCapiRequest & { configuration: SnapchatCapiConfiguration; payload: SnapchatCapiPayload;
    execute: (fence: { isCurrent: () => boolean }) => Promise<Outcome<SnapchatConversionOutcome>> }, optional?: CallOptions): Promise<Outcome<SnapchatConversionOutcome>>;
}
/** Inert server-only backend; suitable Pixel credentials are resolved by the server broker. */
export type SnapchatCapiDependencies = Pick<SnapchatDependencies, "credentials" | "fetch" | "clock" | "observer"> & {
  configuration: SnapchatCapiConfiguration; authority: SnapchatConversionAuthorityPort };

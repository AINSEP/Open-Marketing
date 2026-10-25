import type { OAuthClientRequest, OAuthClientStatus, OAuthStatus } from "./validation.js";
import type { A2uiSurfacePayload, SurfaceAcknowledgement, ToolCall, ToolResult } from '@open-marketing/contracts';
import type { AssistantSettings, AssistantSettingsStatus, Conversation, ConversationList, ConversationSummary, ToolRequestedPayload, ToolResultPayload, ApprovalPayload, CancellationReceipt, ChatMessage, ConfirmationCard, NavigationResult, Outcome, ApprovalResponse, RunEvent, NavigationAction, Money, ClockPort, IdPort, CaptureEvent } from "@open-marketing/contracts";

/** Small read model for j19–j21 to replace with domain canvases. */
export interface StudioRow { readonly id: string; readonly title: string; readonly detail: string; readonly status: string }
export interface StudioMetric { readonly label: string; readonly value: string; readonly detail: string }
/** Server-decided presentation data. Null costs carry no evidence of a free operation. */
export interface StudioPages {
  readonly creative: {
    readonly generations: readonly {
      readonly id: string; readonly title: string; readonly brief: string;
      readonly status: "review" | "pending" | "succeeded" | "failed" | "unknown";
      readonly quote: Money | null; readonly estimated: Money | null; readonly actual: Money | null;
      readonly costEvidence: string;
      readonly allowanceClassification: "within_allowance" | "over_allowance" | "unknown_cost";
      readonly approvalCardId: string | null;
    }[];
    readonly assets: readonly {
      readonly id: string; readonly title: string; readonly dimensions: string;
      readonly originalId: string | null; readonly crop: string | null;
      readonly provenance: string; readonly cost: Money | null;
      readonly costEvidence: string; readonly importEvidence: string;
    }[];
  };
  readonly campaigns: {
    readonly drafts: readonly {
      readonly id: string; readonly title: string; readonly status: "paused";
      readonly review: "ready" | "blocked" | "unavailable";
      readonly reasons: readonly string[]; readonly approvalCardId: string | null;
    }[];
    readonly halts: readonly {
      readonly id: string; readonly account: string;
      readonly localBarrier: "blocked" | "unconfirmed";
      readonly remoteStop: "stopped" | "pending" | "partial" | "unknown";
      readonly detail: string; readonly operationId: string; readonly auditId: string;
    }[];
    readonly allowances: readonly {
      readonly id: "image-generation" | "paid-sending"; readonly title: string;
      readonly daily: Money; readonly used: Money; readonly reserved: Money; readonly remaining: Money;
      readonly timezone: string; readonly reset: string; readonly revision: string;
    }[];
  };
  readonly operations: {
    readonly reports: readonly {
      readonly id: string; readonly title: string;
      readonly source: "om_ledger" | "platform_report" | "om_attribution";
      readonly period: string; readonly freshness: string; readonly gaps: readonly string[];
      readonly restates: string | null; readonly cac: Money | null; readonly cacReason: string | null;
    }[];
    readonly connections: readonly {
      readonly id: string; readonly title: string;
      readonly status: "connected" | "reauthentication_required" | "not_connected";
      readonly scope: string; readonly recovery: string;
    }[];
    readonly plugins: readonly {
      readonly id: string; readonly title: string; readonly version: string;
      readonly status: "admitted" | "update_requires_review" | "revoked";
      readonly authority: string; readonly recovery: string;
    }[];
    readonly measurementGrant: {
      readonly status: "active" | "revoked" | "unavailable";
      readonly events: readonly string[]; readonly destinations: readonly string[];
      readonly purposes: readonly string[]; readonly detail: string;
    };
    readonly activity: readonly {
      readonly id: string; readonly title: string; readonly status: "recorded" | "pending" | "unknown";
      readonly operationId: string; readonly jobId: string | null; readonly auditId: string | null;
      readonly detail: string;
    }[];
  };
}
export interface StudioSnapshot {
  readonly workspace: string;
  readonly mode: "sample" | "connected" | "unavailable";
  readonly metrics: readonly StudioMetric[];
  readonly rows: Readonly<Record<string, readonly StudioRow[]>>;
  readonly messages: readonly ChatMessage[];
  readonly cards: readonly ConfirmationCard[];
  readonly allowance: { readonly daily: Money; readonly remaining: Money; readonly timezone: string };
  /** Optional for shell-only adapters; absence never implies successful domain state. */
  readonly pages?: StudioPages;
}
/** A run receipt carries lifecycle metadata, never a vendor or bearer credential. */
export interface StudioRun { readonly runId: string; readonly status: "requested" | "pending"; readonly expiresAt: number; readonly conversationId?: string; readonly mode?: "sandbox" | "model" }
export type StudioPayload = A2uiSurfacePayload
  | { readonly type: "message"; readonly message: ChatMessage }
  | { readonly type: "confirmation"; readonly card: ConfirmationCard }
  | { readonly type: "navigation"; readonly action: NavigationAction }
  | { readonly type: "status"; readonly text: string }
  | { readonly type: "text_delta"; readonly text: string }
  | ToolRequestedPayload | ToolResultPayload | ApprovalPayload;
/** Diagnostic context is supplied by the composition decorator, never used as authority. */
export interface StudioTrace { readonly correlationId: string; readonly traceId: string }
type BrowserEvent = Exclude<CaptureEvent, { kind: 'trace' }>;
/** Owner-specified track(name, fields) callback ABI, bound and injected per application instance. */
export type StudioTrack = <N extends BrowserEvent['name']>(name: N, fields: Omit<Extract<BrowserEvent, { name: N }>, 'kind' | 'name' | 'at' | 'correlationId' | 'traceId'>) => void;
/** Fixture and future HTTP adapters implement this boundary. Writes are never implicitly retried. */
export interface StudioApiPort {
  captureEvent?(required: { event: BrowserEvent; signal?: AbortSignal }): Promise<Outcome<{ status: 'recorded' }>>;
  recentEvents?(required: { signal?: AbortSignal }): Promise<Outcome<{ items: CaptureEvent[] }>>;
  tool?(required: { call: ToolCall; signal?: AbortSignal; trace?: StudioTrace; runId?: string; frontendSessionId?: string }): Promise<Outcome<ToolResult>>;
  operation?(required: { operationId: string; signal?: AbortSignal; trace?: StudioTrace }): Promise<Outcome<import("@open-marketing/contracts").ToolOperation>>;
  approvalCard?(required: { cardId: string; signal?: AbortSignal; trace?: StudioTrace }): Promise<Outcome<ConfirmationCard>>;
  acknowledgeSurface?(required: { result: SurfaceAcknowledgement; trace?: StudioTrace }): Promise<Outcome<{ status: 'recorded' }>>;

  /** Owner upload/connection forms use this surface; plaintext never enters chat. */
  readonly addons?: {
    setOAuthClient(required: { request: OAuthClientRequest; signal?: AbortSignal; trace?: StudioTrace }): Promise<Outcome<OAuthClientStatus>>;
    oauthStatus(required: { query: { pluginId: 'google-ads' | 'linkedin-ads' | 'meta-ads' } | { transactionId: string }; signal?: AbortSignal; trace?: StudioTrace }): Promise<Outcome<OAuthStatus>>;
    setDeveloperToken(required: { request: { pluginId: 'google-ads'; token: string | null }; signal?: AbortSignal; trace?: StudioTrace }): Promise<Outcome<{ configured: boolean }>>;
    developerTokenStatus(required: { pluginId: 'google-ads'; signal?: AbortSignal; trace?: StudioTrace }): Promise<Outcome<{ configured: boolean }>>;
    list(required: { query: import('@open-marketing/contracts').AddonListRequest; signal?: AbortSignal; trace?: StudioTrace }): Promise<Outcome<import('@open-marketing/contracts').AddonList>>;
    install(required: { request: import('@open-marketing/contracts').InstallAddon; signal?: AbortSignal; trace?: StudioTrace }): Promise<Outcome<import('@open-marketing/contracts').AddonSummary>>;
    setEnabled(required: { request: import('@open-marketing/contracts').SetAddonEnabled; signal?: AbortSignal; trace?: StudioTrace }): Promise<Outcome<import('@open-marketing/contracts').AddonSummary>>;
    uninstall(required: { request: import('@open-marketing/contracts').UninstallAddon; signal?: AbortSignal; trace?: StudioTrace }): Promise<Outcome<import('@open-marketing/contracts').AddonUninstallReceipt>>;
    integrations(required: { query: { limit: number; cursor?: string }; signal?: AbortSignal; trace?: StudioTrace }): Promise<Outcome<import('@open-marketing/contracts').IntegrationList>>;
    connect(required: { request: import('@open-marketing/contracts').ConnectIntegrationToken; signal?: AbortSignal; trace?: StudioTrace }): Promise<Outcome<import('@open-marketing/contracts').IntegrationSummary>>;
    disconnect(required: { request: import('@open-marketing/contracts').DisconnectIntegration; signal?: AbortSignal; trace?: StudioTrace }): Promise<Outcome<import('@open-marketing/contracts').IntegrationSummary>>;
  };
  conversations?(required: { signal?: AbortSignal; trace?: StudioTrace; cursor?: string }): Promise<Outcome<ConversationList>>;
  conversation?(required: { conversationId: string; signal?: AbortSignal; trace?: StudioTrace; cursor?: string }): Promise<Outcome<Conversation>>;
  settings?(required: { signal?: AbortSignal; trace?: StudioTrace }): Promise<Outcome<AssistantSettingsStatus>>;
  setSettings?(required: { settings: AssistantSettings; signal?: AbortSignal; trace?: StudioTrace }): Promise<Outcome<AssistantSettingsStatus>>;
  snapshot(required: { signal?: AbortSignal; trace?: StudioTrace }): Promise<Outcome<StudioSnapshot>>;
  start(required: { message: ChatMessage; signal: AbortSignal; trace?: StudioTrace; conversationId?: string; frontendSessionId?: string; frontendBindToken?: string }): Promise<Outcome<StudioRun>>;
  /** Validated cursor scan of the existing endpoint; no run is started. */
  runStatus?(required: { runId: string; after?: number; signal?: AbortSignal; trace?: StudioTrace }): Promise<Outcome<{ runId: string; status: 'running' | 'completed' | 'cancelled' | 'interrupted'; usage?: import('@open-marketing/contracts').AssistantUsage }>>;
  events(required: { runId: string; after: number; signal: AbortSignal; trace?: StudioTrace }): AsyncIterable<Outcome<RunEvent>>;
  cancel(required: { runId: string; reason: "owner" | "expired"; trace?: StudioTrace }): Promise<Outcome<CancellationReceipt>>;
  approve(required: { response: ApprovalResponse; signal?: AbortSignal; trace?: StudioTrace }): Promise<Outcome<{ status: "recorded" }>>;
  acknowledgeNavigation(required: { result: NavigationResult; trace?: StudioTrace }): Promise<Outcome<{ status: "recorded" }>>;
}


/** Host-owned timers; doubles advance every deadline deterministically. */
export interface TimerPort {
  schedule(required: { delayMs: number; callback: () => void }): unknown;
  cancel(required: { handle: unknown }): void;
  wait(required: { delayMs: number; signal?: AbortSignal }): Promise<void>;
}
/** Browser mounting injects these once; modules never read time or construct runtime dependencies. */
export interface StudioRuntime { readonly clock: ClockPort; readonly ids: IdPort; readonly timers: TimerPort; readonly abort: () => AbortController; readonly track?: StudioTrack }

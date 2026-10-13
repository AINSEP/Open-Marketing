import type { CancellationReceipt, ChatMessage, ConfirmationCard, NavigationResult, Outcome, ApprovalResponse, RunEvent, NavigationAction, Money, ClockPort, IdPort } from "@open-marketing/contracts";

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
export interface StudioRun { readonly runId: string; readonly status: "requested" | "pending"; readonly expiresAt: number }
export type StudioPayload =
  | { readonly type: "message"; readonly message: ChatMessage }
  | { readonly type: "confirmation"; readonly card: ConfirmationCard }
  | { readonly type: "navigation"; readonly action: NavigationAction }
  | { readonly type: "status"; readonly text: string };
/** Fixture and future HTTP adapters implement this boundary. Writes are never implicitly retried. */
export interface StudioApiPort {
  snapshot(required: { signal?: AbortSignal }): Promise<Outcome<StudioSnapshot>>;
  start(required: { message: ChatMessage; signal: AbortSignal }): Promise<Outcome<StudioRun>>;
  events(required: { runId: string; after: number; signal: AbortSignal }): AsyncIterable<Outcome<RunEvent>>;
  cancel(required: { runId: string; reason: "owner" | "expired" }): Promise<Outcome<CancellationReceipt>>;
  approve(required: { response: ApprovalResponse; signal?: AbortSignal }): Promise<Outcome<{ status: "recorded" }>>;
  acknowledgeNavigation(required: { result: NavigationResult }): Promise<Outcome<{ status: "recorded" }>>;
}


/** Host-owned timers; doubles advance every deadline deterministically. */
export interface TimerPort {
  schedule(required: { delayMs: number; callback: () => void }): unknown;
  cancel(required: { handle: unknown }): void;
  wait(required: { delayMs: number; signal?: AbortSignal }): Promise<void>;
}
/** Browser mounting injects these once; modules never read time or construct runtime dependencies. */
export interface StudioRuntime { readonly clock: ClockPort; readonly ids: IdPort; readonly timers: TimerPort; readonly abort: () => AbortController }

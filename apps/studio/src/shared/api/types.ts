import type { CancellationReceipt, ChatMessage, ConfirmationCard, NavigationResult, Outcome, ApprovalResponse, RunEvent, NavigationAction, Money, ClockPort, IdPort } from "@open-marketing/contracts";

/** Small read model for j19–j21 to replace with domain canvases. */
export interface StudioRow { readonly id: string; readonly title: string; readonly detail: string; readonly status: string }
export interface StudioMetric { readonly label: string; readonly value: string; readonly detail: string }
export interface StudioSnapshot {
  readonly workspace: string;
  readonly mode: "sample" | "connected" | "unavailable";
  readonly metrics: readonly StudioMetric[];
  readonly rows: Readonly<Record<string, readonly StudioRow[]>>;
  readonly messages: readonly ChatMessage[];
  readonly cards: readonly ConfirmationCard[];
  readonly allowance: { readonly daily: Money; readonly remaining: Money; readonly timezone: string };
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

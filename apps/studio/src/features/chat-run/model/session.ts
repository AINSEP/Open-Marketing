import { chatMessageSchema, idSchema, epochSchema, parseBoundary } from "@open-marketing/contracts";
import type { ChatMessage, ConfirmationCard, NavigationAction, NavigationResult, Outcome } from "@open-marketing/contracts";
import type { StudioApiPort, StudioPayload, StudioRun } from "../../../shared/api/index.js";
import { parseStudioEvent, parseStudioSnapshot, isSafeUiValue } from "../../../shared/api/index.js";
import type { StudioRuntime } from "../../../shared/api/index.js";

export interface ChatState {
  readonly messages: readonly ChatMessage[];
  readonly cards: readonly ConfirmationCard[];
  readonly status: "idle" | "starting" | "running" | "cancelling" | "cancelled" | "expired" | "complete" | "unavailable";
  readonly notice: string;
  readonly navigation: NavigationResult | null;
}
export interface ChatSession {
  getSnapshot(): ChatState;
  subscribe(required: { listener: () => void }): () => void;
  hydrate(required: { input: unknown }): void;
  send(required: { text: string }): Promise<void>;
  cancel(): Promise<void>;
  dispose(): void;
}
interface ActiveRun { readonly receipt: StudioRun; readonly controller: AbortController; readonly timer: unknown; sequence: number; count: number; readonly seen: Map<string, string> }
interface Dependencies { api: StudioApiPort; runtime: StudioRuntime; navigate: (required: { action: NavigationAction }) => Promise<NavigationResult> }
function isActive(required: { status: ChatState["status"] }): boolean { return ["starting", "running", "cancelling"].includes(required.status); }
function validReceipt(receipt: StudioRun): boolean { return isSafeUiValue({ value: receipt, maxCharacters: 4096 }) && idSchema.safeParse(receipt.runId).success && epochSchema.safeParse(receipt.expiresAt).success && ["requested", "pending"].includes(receipt.status); }
/** Append/replace a full shared ChatMessage, bounded to the latest 200 messages. */
function mergeMessage(required: { messages: readonly ChatMessage[]; message: ChatMessage }): readonly ChatMessage[] {
  const previous = required.messages.findIndex(message => message.id === required.message.id);
  if (previous === -1) return [...required.messages, required.message].slice(-200);
  return required.messages.map((message, index) => index === previous ? required.message : message);
}
/** Headless chat lifecycle; stopping observation never asserts remote no-charge/no-effect.
 * Ports return typed failures; the HTTP adapter must translate opaque exceptions.
 * @example createChatSession({ api, runtime, navigate })
 * @complexity O(messages + cards) per update, bounded to 200/50; 1000 events per run.
 */
export function createChatSession(required: Dependencies): ChatSession {
  let state: ChatState = { messages: [], cards: [], status: "idle", notice: "Agent runtime is not connected.", navigation: null };
  let active: ActiveRun | null = null;
  let pendingController: AbortController | null = null;
  let pendingTimer: unknown = null;
  let disposed = false;
  const listeners = new Set<() => void>();
  const update = (patch: Partial<ChatState>): void => {
    if (disposed) return;
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  const clearRun = (): void => {
    if (!active) return;
    active.controller.abort();
    required.runtime.timers.cancel({ handle: active.timer });
    active = null;
  };
  const clearPending = (): void => {
    pendingController?.abort(); pendingController = null;
    if (pendingTimer !== null) required.runtime.timers.cancel({ handle: pendingTimer });
    pendingTimer = null;
  };
  const stop = async (input: { reason: "owner" | "expired" }): Promise<void> => {
    clearPending();
    const runId = active?.receipt.runId;
    clearRun();
    update({ status: input.reason === "expired" ? "expired" : "cancelling", notice: input.reason === "expired" ? "Run expired. External outcomes remain unconfirmed." : "Observation stopped. Requesting server cancellation…" });
    if (!runId) { update({ status: "cancelled", notice: "Local request cancelled." }); return; }
    const result = await required.api.cancel({ runId, reason: input.reason });
    if (input.reason === "expired") return;
    if (!result.ok) { update({ status: "unavailable", notice: "Observation stopped; server cancellation could not be confirmed." }); return; }
    update({ status: result.value.status === "cancelled" ? "cancelled" : "cancelling", notice: result.value.status === "cancelled" ? "Server acknowledged cancellation. External outcomes may still need reconciliation." : "Cancellation requested; remote completion is unconfirmed." });
  };
  const applyPayload = async (input: { payload: StudioPayload; run: ActiveRun }): Promise<void> => {
    const payload = input.payload;
    switch (payload.type) {
      case "message": update({ messages: mergeMessage({ messages: state.messages, message: payload.message }) }); return;
      case "confirmation": update({ cards: [...state.cards.filter(card => card.cardId !== payload.card.cardId), payload.card].slice(-50) }); return;
      case "status": return; // Status copy is derived from lifecycle, not untrusted agent claims.
      case "navigation": {
        update({ navigation: { status: "pending", actionId: payload.action.actionId } });
        const result = await required.navigate({ action: payload.action });
        if (active !== input.run) return;
        const acknowledged = await required.api.acknowledgeNavigation({ result });
        if (active !== input.run) return;
        update({ navigation: result, notice: acknowledged.ok ? state.notice : "Browser result could not be acknowledged to the server." });
        return;
      }
      default: { const exhaustive: never = payload; return exhaustive; }
    }
  };
  const accept = async (input: { value: unknown; run: ActiveRun }): Promise<boolean> => {
    input.run.count += 1;
    if (input.run.count > 1000) { update({ status: "unavailable", notice: "Event limit reached. Reconnect with the server to reconcile." }); return false; }
    const parsed = parseStudioEvent({ input: input.value });
    if (!parsed.ok) { update({ status: "unavailable", notice: "Unsafe or invalid event rejected." }); return false; }
    const { event, payload } = parsed.value;
    const signature = JSON.stringify(event);
    if (event.runId !== input.run.receipt.runId || conflictingReplay({ run: input.run, id: event.eventId, signature })) { update({ status: "unavailable", notice: "Event scope or replay mismatch." }); return false; }
    if (event.sequence <= input.run.sequence) {
      if (input.run.seen.has(event.eventId)) return true;
      update({ status: "unavailable", notice: "Out-of-order event identity rejected." }); return false;
    }
    input.run.seen.set(event.eventId, signature); input.run.sequence = event.sequence;
    await applyPayload({ payload, run: input.run });
    if (active !== input.run) return false;
    return finishEvent({ kind: event.kind, update });
  };
  const consume = async (input: { run: ActiveRun }): Promise<void> => {
    const run = input.run;
    for await (const event of required.api.events({ runId: run.receipt.runId, after: 0, signal: run.controller.signal })) {
      if (active !== run) return;
      if (!event.ok) { update({ status: "unavailable", notice: "Run stream unavailable. External outcomes are unconfirmed." }); break; }
      if (!await accept({ value: event.value, run })) break;
    }
    if (active !== run) return;
    if (state.status === "running") update({ status: "unavailable", notice: "Stream ended without a completion event. Outcomes are unconfirmed." });
    clearRun();
  };
  return {
    getSnapshot() { return state; },
    subscribe(input) { listeners.add(input.listener); return () => { listeners.delete(input.listener); }; },
    hydrate(input) {
      const parsed = parseStudioSnapshot(input);
      if (!parsed.ok) { update({ notice: "Studio snapshot rejected.", status: "unavailable" }); return; }
      update({ messages: parsed.value.messages, cards: parsed.value.cards, notice: parsed.value.mode === "sample" ? "Sample conversation · agent runtime is not connected." : "Ready" });
    },
    async send(input) {
      if (disposed || isActive({ status: state.status })) return;
      const message = prepareMessage({ text: input.text, id: required.runtime.ids.next({}) });
      if (!message.ok) { update({ notice: message.error.message }); return; }
      update({ messages: mergeMessage({ messages: state.messages, message: message.value }), status: "starting", notice: "Requesting a run…" });
      const controller = required.runtime.abort(); pendingController = controller;
      const startDeadline = required.runtime.timers.schedule({ delayMs: 15000, callback: () => {
        if (pendingController !== controller) return;
        clearPending(); update({ status: "unavailable", notice: "Run start timed out. Server outcome is unconfirmed." });
      } });
      pendingTimer = startDeadline;
      const result = await required.api.start({ message: message.value, signal: controller.signal });
      required.runtime.timers.cancel({ handle: startDeadline });
      if (disposed || controller.signal.aborted) return;
      pendingController = null; pendingTimer = null;
      if (!result.ok || !validReceipt(result.value)) { update({ status: "unavailable", notice: "Run could not be started." }); return; }
      if (result.value.expiresAt <= required.runtime.clock.now({})) { update({ status: "expired", notice: "Server run receipt already expired." }); return; }
      const timer = required.runtime.timers.schedule({ delayMs: result.value.expiresAt - required.runtime.clock.now({}), callback: () => { void stop({ reason: "expired" }); } });
      active = { receipt: result.value, controller, timer, sequence: 0, count: 0, seen: new Map() };
      update({ status: "running", notice: "Receiving a response…" });
      await consume({ run: active });
    },
    async cancel() {
      if (disposed || state.status === "cancelling") return;
      await stop({ reason: "owner" });
    },
    dispose() { clearPending(); clearRun(); disposed = true; listeners.clear(); },
  };
}
function conflictingReplay(required: { run: ActiveRun; id: string; signature: string }): boolean {
  const previous = required.run.seen.get(required.id);
  return previous !== undefined && previous !== required.signature;
}
function finishEvent(required: { kind: string; update: (patch: Partial<ChatState>) => void }): boolean {
  if (required.kind === "ended") { required.update({ status: "complete", notice: "Response complete. No action result is implied by an approval." }); return false; }
  if (required.kind === "cancelled") { required.update({ status: "cancelled", notice: "Server reported cancellation." }); return false; }
  if (required.kind === "error") { required.update({ status: "unavailable", notice: "Server reported a run error. Outcomes are unconfirmed." }); return false; }
  return true;
}

/** Outgoing message boundary excludes recognizable credentials before optimistic transcript insertion. */
function prepareMessage(required: { text: string; id: string }): Outcome<ChatMessage> {
  const parsed = parseBoundary({ schema: chatMessageSchema, input: { id: required.id, role: "user", text: required.text.trim() } });
  if (!parsed.ok || !parsed.value.text) return { ok: false, error: { code: "invalid_input", message: "Enter a message of at most 65,536 characters.", retryable: false } };
  if (!isSafeUiValue({ value: parsed.value, maxCharacters: 65536 })) return { ok: false, error: { code: "invalid_input", message: "Message rejected: keep credentials out of chat.", retryable: false } };
  return parsed;
}

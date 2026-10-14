import { assistantSettingsStatusSchema, conversationListSchema, conversationSchema, chatMessageSchema, idSchema, epochSchema, parseBoundary } from "@open-marketing/contracts";
import type { AssistantSettingsStatus, ConversationSummary, ChatMessage, ConfirmationCard, NavigationAction, NavigationResult, Outcome } from "@open-marketing/contracts";
import type { StudioApiPort, StudioPayload, StudioRun } from "../../../shared/api/index.js";
import { parseStudioEvent, parseStudioSnapshot, isSafeUiValue } from "../../../shared/api/index.js";
import type { StudioRuntime } from "../../../shared/api/index.js";

export interface ChatState {
  readonly messages: readonly ChatMessage[];
  readonly cards: readonly ConfirmationCard[];
  readonly status: "idle" | "starting" | "running" | "cancelling" | "cancelled" | "expired" | "complete" | "unavailable";
  readonly notice: string;
  readonly navigation: NavigationResult | null;
  readonly conversationId: string | null;
  readonly conversations: readonly ConversationSummary[];
  readonly settings: AssistantSettingsStatus | null;
  readonly mode: 'sandbox' | 'model' | null;
  readonly tools: readonly { operationId: string; name: string; status: 'running' | 'completed' | 'pending' | 'cancelled' }[];
}
export interface ChatSession {
  getSnapshot(): ChatState;
  subscribe(required: { listener: () => void }): () => void;
  hydrate(required: { input: unknown }): void;
  refresh(): Promise<void>;
  selectConversation(required: { conversationId: string }): Promise<void>;
  newConversation(): Promise<void>;
  selectModel(required: { model: 'sandbox' | 'claude-sonnet-5-5' | 'claude-opus-5-5' }): Promise<void>;
  send(required: { text: string }): Promise<void>;
  cancel(): Promise<void>;
  dispose(): void;
}
interface ActiveRun { readonly receipt: StudioRun; readonly controller: AbortController; readonly timer: unknown; sequence: number; count: number; bytes: number; correlationId?: string; traceId?: string; readonly cardIds: Set<string>; readonly seen: Map<string, string> }
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
 * @complexity O(messages + cards) per update, bounded to 200/50; 8,192 unique events/2 MiB per run.
 */
export function createChatSession(required: Dependencies): ChatSession {
  let state: ChatState = { messages: [], cards: [], status: "idle", notice: "Agent runtime is not connected.", navigation: null, conversationId: null, conversations: [], settings: null, mode: null, tools: [] };
  let active: ActiveRun | null = null;
  let pendingController: AbortController | null = null;
  let pendingTimer: unknown = null;
  let disposed = false;
  let historyController: AbortController | null = null;
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
    const cards = state.cards.filter(card => !active?.cardIds.has(card.cardId));
    update({ cards, tools: state.tools.map(tool => tool.status === 'running' || tool.status === 'pending' ? { ...tool, status: 'cancelled' } : tool) });
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
      case "confirmation": input.run.cardIds.add(payload.card.cardId); update({ cards: [...state.cards.filter(card => card.cardId !== payload.card.cardId), payload.card].slice(-50) }); return;
      case "text_delta": {
        const id = input.run.receipt.runId + '-reply';
        const prior = state.messages.find(message => message.id === id)?.text ?? '';
        if (prior.length + payload.text.length > 65536) throw new Error('Assistant message bound exceeded');
        update({ messages: mergeMessage({ messages: state.messages, message: { id, role: 'assistant', text: prior + payload.text } }) });
        return;
      }
      case "tool_requested": update({ tools: [...state.tools.filter(tool => tool.operationId !== payload.call.operationId), { operationId: payload.call.operationId, name: payload.call.name, status: 'running' as const }].slice(-100) }); return;
      case "tool_result": update({ tools: state.tools.map(tool => tool.operationId === payload.operationId ? { ...tool, status: payload.result.status === 'completed' ? 'completed' : 'pending' } : tool) }); return;
      case "confirmation_resolved": update({ cards: state.cards.filter(card => card.cardId !== payload.cardId),
        tools: state.tools.map(tool => tool.operationId === payload.operationId
          ? { ...tool, status: payload.status === 'completed' ? 'completed' : 'cancelled' } : tool) }); return;
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
    const parsed = parseStudioEvent({ input: input.value });
    if (!parsed.ok) { update({ status: "unavailable", notice: "Unsafe or invalid event rejected." }); return false; }
    const { event, payload } = parsed.value;
    const cursor = retainEvent({ event, run: input.run });
    if (!cursor.ok) { update({ status: 'unavailable', notice: cursor.error.message }); return false; }
    if (cursor.value === 'duplicate') return true;
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
    if (state.status !== 'complete') update({ cards: state.cards.filter(card => !run.cardIds.has(card.cardId)) });
    clearRun();
    await refresh();
  };
  /** History requests have their own cancellation and cannot overwrite a subsequently selected chat. */
  async function refresh(): Promise<void> {
    if (!required.api.conversations || !required.api.settings || disposed) return;
    historyController?.abort(); const controller = required.runtime.abort(); historyController = controller;
    const [conversations, settings] = await Promise.all([required.api.conversations({ signal: controller.signal }), required.api.settings({ signal: controller.signal })]);
    if (disposed || controller.signal.aborted) return;
    const list = conversations.ok ? parseBoundary({ schema: conversationListSchema, input: conversations.value }) : conversations;
    const config = settings.ok ? parseBoundary({ schema: assistantSettingsStatusSchema, input: settings.value }) : settings;
    if (list.ok) update({ conversations: list.value.items });
    if (config.ok) update({ settings: config.value });
  }
  return {
    getSnapshot() { return state; },
    refresh,
    async selectConversation(input) {
      if (disposed || isActive({ status: state.status }) || !required.api.conversation) return;
      historyController?.abort(); const controller = required.runtime.abort(); historyController = controller;
      const result = await required.api.conversation({ conversationId: input.conversationId, signal: controller.signal });
      if (controller.signal.aborted || disposed) return;
      const parsed = result.ok ? parseBoundary({ schema: conversationSchema, input: result.value }) : result;
      if (!parsed.ok || !isSafeUiValue({ value: parsed.ok ? parsed.value : null, maxCharacters: 262144 }) || parsed.value.conversation.conversationId !== input.conversationId) { update({ notice: 'Conversation could not be safely loaded.' }); return; }
      update({ conversationId: input.conversationId, messages: parsed.value.messages, cards: [], tools: [], status: 'idle', mode: null,
        notice: parsed.value.cursor ? 'Saved conversation. Showing the first 100 messages.' : 'Saved conversation.' });
    },
    async newConversation() {
      if (disposed || isActive({ status: state.status })) return;
      historyController?.abort();
      update({ conversationId: null, messages: [], cards: [], tools: [], status: 'idle', mode: null, notice: 'New conversation.' });
    },
    async selectModel(input) {
      if (disposed || isActive({ status: state.status }) || !required.api.setSettings) return;
      const settings = { mode: input.model === 'sandbox' ? 'sandbox' as const : 'model' as const,
        model: input.model === 'sandbox' ? state.settings?.settings.model ?? 'claude-sonnet-5-5' : input.model,
        connectionId: state.settings?.settings.connectionId ?? null };
      const result = await required.api.setSettings({ settings });
      if (disposed) return;
      const parsed = result.ok ? parseBoundary({ schema: assistantSettingsStatusSchema, input: result.value }) : result;
      if (!parsed.ok) { update({ notice: 'Assistant settings could not be saved.' }); return; }
      update({ settings: parsed.value, notice: parsed.value.ready ? 'Assistant settings saved.' : 'Reconnect Anthropic in Add-ons / Integrations, or choose Sandbox.' });
    },
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
      update({ messages: mergeMessage({ messages: state.messages, message: message.value }), tools: [], status: "starting", notice: "Requesting a run…" });
      const controller = required.runtime.abort(); pendingController = controller;
      const startDeadline = required.runtime.timers.schedule({ delayMs: 15000, callback: () => {
        if (pendingController !== controller) return;
        clearPending(); update({ status: "unavailable", notice: "Run start timed out. Server outcome is unconfirmed." });
      } });
      pendingTimer = startDeadline;
      const result = await required.api.start({ message: message.value, signal: controller.signal, conversationId: state.conversationId ?? undefined });
      required.runtime.timers.cancel({ handle: startDeadline });
      if (disposed || controller.signal.aborted) return;
      pendingController = null; pendingTimer = null;
      if (!result.ok || !validReceipt(result.value)) { update({ status: "unavailable", notice: "Run could not be started." }); return; }
      if (result.value.expiresAt <= required.runtime.clock.now({})) { update({ status: "expired", notice: "Server run receipt already expired." }); return; }
      const timer = required.runtime.timers.schedule({ delayMs: result.value.expiresAt - required.runtime.clock.now({}), callback: () => { void stop({ reason: "expired" }); } });
      active = { receipt: result.value, controller, timer, sequence: 0, count: 0, bytes: 0, cardIds: new Set(), seen: new Map() };
      update({ status: "running", conversationId: result.value.conversationId ?? state.conversationId, mode: result.value.mode ?? null, notice: result.value.mode === 'sandbox' ? "Sandbox response · no model or vendor calls." : "Receiving a response…" });
      try { await consume({ run: active }); }
      catch { clearRun(); update({ status: 'unavailable', notice: 'Run stream interrupted. Saved work remains on the server.', cards: [] }); }
    },
    async cancel() {
      if (disposed || state.status === "cancelling") return;
      await stop({ reason: "owner" });
    },
    dispose() { historyController?.abort(); clearPending(); clearRun(); disposed = true; listeners.clear(); },
  };
}
/** Only a byte-identical known event is a replay; new identities must be contiguous and scoped. */
function eventCursor(required: { event: import('@open-marketing/contracts').RunEvent; run: ActiveRun; signature: string }): Outcome<'new' | 'duplicate'> {
 const { event, run, signature } = required;
 if (event.runId !== run.receipt.runId) return eventFailure({ message: 'Event scope or replay mismatch.' });
 const previous = run.seen.get(event.eventId);
 if (previous !== undefined) {
  if (previous !== signature) return eventFailure({ message: 'Event scope or replay mismatch.' });
  return { ok: true, value: 'duplicate' };
 }
 if (event.sequence !== run.sequence + 1) return eventFailure({ message: 'Event cursor gap rejected.' });
 if (tracingChanged({ event, run })) return eventFailure({ message: 'Event tracing identity changed.' });
 return { ok: true, value: 'new' };
}
function tracingChanged(required: { event: import('@open-marketing/contracts').RunEvent; run: ActiveRun }): boolean {
 return (required.run.correlationId !== undefined && required.run.correlationId !== required.event.correlationId)
  || (required.run.traceId !== undefined && required.run.traceId !== required.event.traceId);
}
function eventFailure(required: { message: string }): Outcome<never> { return { ok: false, error: { code: 'protocol_mismatch', message: required.message, retryable: false } }; }
/** Count retained unique events only. Duplicate deliveries consume neither count nor byte allowance. */
function retainEvent(required: { event: import('@open-marketing/contracts').RunEvent; run: ActiveRun }): Outcome<'new' | 'duplicate'> {
 const signature = JSON.stringify(required.event);
 const cursor = eventCursor({ ...required, signature });
 if (!cursor.ok || cursor.value === 'duplicate') return cursor;
 const bytes = new TextEncoder().encode(signature).length;
 if (required.run.count + 1 > 8192 || required.run.bytes + bytes > 2097152) return eventFailure({ message: 'Event limit reached. Reconnect with the server to reconcile.' });
 required.run.count++; required.run.bytes += bytes;
 required.run.correlationId = required.event.correlationId; required.run.traceId = required.event.traceId;
 required.run.seen.set(required.event.eventId, signature); required.run.sequence = required.event.sequence;
 return cursor;
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

import { z } from "zod";
import type { AgentEvent, ChatTransport, RunHandlers, ChatRunStatus } from "@jini-ai/chat";
import type { A2uiSurfacePayload } from '@open-marketing/contracts';
import { a2uiSurfacePayloadSchema, confirmationCardSchema, assistantSettingsStatusSchema, assistantUsageSchema, conversationListSchema, conversationSchema, chatMessageSchema, idSchema, epochSchema, parseBoundary } from "@open-marketing/contracts";
import type { AssistantSettingsStatus, ConversationSummary, ChatMessage, ConfirmationCard, NavigationAction, NavigationResult, Outcome } from "@open-marketing/contracts";
import type { StudioApiPort, StudioPayload, StudioRun } from "../../../shared/api/index.js";
import { parseStudioEvent, parseStudioSnapshot, isSafeUiValue } from "../../../shared/api/index.js";
import type { StudioRuntime } from "../../../shared/api/index.js";
import { usageEvents, sampleReplyUsage } from './usage.js';
import { runtimeSettings } from './runtime-selection.js';
import type { AssistantProvider } from '@open-marketing/contracts';

export interface ChatState {
  /** Changes only on history/reset/hydration, never on run acceptance or stream updates. */
  readonly transcriptVersion: number;
  readonly surfaces: readonly A2uiSurfacePayload[];
  readonly messages: readonly ChatMessage[];
  readonly cards: readonly ConfirmationCard[];
  readonly status: "idle" | "starting" | "running" | "cancelling" | "cancelled" | "expired" | "complete" | "unavailable";
  readonly notice: string;
  readonly navigation: NavigationResult | null;
  readonly conversationId: string | null;
  readonly conversations: readonly ConversationSummary[];
  readonly settings: AssistantSettingsStatus | null;
  readonly settingsPending: boolean;
  readonly mode: 'sandbox' | 'model' | null;
  readonly tools: readonly { operationId: string; name: string; status: 'running' | 'completed' | 'pending' | 'cancelled' }[];
}
export interface ChatSession {
  /** Published Jini transport over this session; detach never requests remote cancellation. */
  readonly transport: ChatTransport;
  currentRun(): { runId: string; expiresAt: number; frontendSessionId?: string } | null;
  receiveSurface(required: { input: unknown }): void;
  receiveFrontendBinding(required: { runId: string; expiresAt: number; frontendSessionId: string }): void;
  voidFrontendRun(required: { runId: string; status: 'cancelled' | 'interrupted' }): void;
  addSurfaceApproval(required: { runId: string; card: ConfirmationCard }): void;
  getSnapshot(): ChatState;
  subscribe(required: { listener: () => void }): () => void;
  hydrate(required: { input: unknown }): void;
  refresh(): Promise<void>;
  selectConversation(required: { conversationId: string }): Promise<void>;
  newConversation(): Promise<void>;
  selectModel(required: { model: string }): Promise<void>;
  selectRuntime(required: { provider: AssistantProvider; model: string; effort?: string }): Promise<void>;
  send(required: { text: string }): Promise<void>;
  cancel(): Promise<void>;
  dispose(): void;
}
interface ActiveRun { readonly frontendSessionId?: string; readonly receipt: StudioRun; readonly controller: AbortController; readonly timer: unknown; sequence: number; count: number; bytes: number; correlationId?: string; traceId?: string; readonly cardIds: Set<string>; readonly seen: Map<string, string> }
interface Dependencies { frontendSessionId?: () => string | undefined; frontendBindToken?: () => string | undefined; api: StudioApiPort; runtime: StudioRuntime; navigate: (required: { action: NavigationAction }) => Promise<NavigationResult> }
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
  let state: ChatState = { transcriptVersion: 0, surfaces: [], messages: [], cards: [], status: "idle", notice: "Agent runtime is not connected.", navigation: null, conversationId: null, conversations: [], settings: null, settingsPending: false, mode: null, tools: [] };
  let active: ActiveRun | null = null;
  let lastRun: ActiveRun | null = null;
  let displayEvents: AgentEvent[] = [];
  let display: { handlers: RunHandlers; release: () => void } | null = null;
  const emit = (event: AgentEvent): void => {
    if (displayEvents.length >= 8192) {
      state = { ...state, status: 'unavailable', notice: 'Display event limit reached. Reconnect to reconcile.' }; clearRun(); finishDisplay(); return;
    }
    displayEvents.push(event); display?.handlers.onEvent(event);
  };
  // Frontend-session deliveries use the same slots as run events, once per identity.
  const extensionIds = new Set<string>();
  const extensions = (): void => {
    const slots = [...state.cards.map(card => ({ name: 'om.approval', id: card.cardId })),
      ...state.surfaces.map(surface => ({ name: 'om.surface', id: surface.runId + ':' + surface.surfaceId }))];
    for (const slot of slots) {
      const key = slot.name + ':' + slot.id;
      if (extensionIds.has(key)) continue;
      extensionIds.add(key); emit({ kind: 'ext', name: slot.name, data: { id: slot.id } });
    }
  };
  const finishDisplay = (): void => {
    const status = displayStatus({ status: state.status });
    if (!display || !lastRun || !status || status === 'running') return;
    const handlers = display.handlers; display.release();
    handlers.onCheckpoint?.({ id: lastRun.receipt.runId + '-reply', role: 'assistant', content: '', runId: lastRun.receipt.runId, runStatus: status, events: displayEvents });
    if (status === 'failed') handlers.onError(new Error(state.notice));
    handlers.onDone([...displayEvents]);
  };
  let frontendRun: { runId: string; expiresAt: number; frontendSessionId: string } | null = null;
  const frontendCardIds = new Set<string>();
  let pendingController: AbortController | null = null;
  let pendingTimer: unknown = null;
  let disposed = false;
  let sample = false;
  let historyController: AbortController | null = null;
  const listeners = new Set<() => void>();
  const update = (patch: Partial<ChatState>): void => {
    if (disposed) return;
    state = { ...state, ...patch };
    extensions();
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
    const runId = active?.receipt.runId ?? frontendRun?.runId ?? lastRun?.receipt.runId;
    frontendRun = null;
    const cards = state.cards.filter(card => !lastRun?.cardIds.has(card.cardId) && !frontendCardIds.has(card.cardId));
    frontendCardIds.clear();
    update({ cards, tools: state.tools.map(tool => tool.status === 'running' || tool.status === 'pending' ? { ...tool, status: 'cancelled' } : tool) });
    clearRun();
    update({ status: input.reason === "expired" ? "expired" : "cancelling", notice: input.reason === "expired" ? "Run expired. External outcomes remain unconfirmed." : "Observation stopped. Requesting server cancellation…" });
    if (!runId) { update({ status: "cancelled", notice: "Local request cancelled." }); return; }
    const result = await required.api.cancel({ runId, reason: input.reason });
    if (input.reason === "expired") return;
    if (!result.ok) { update({ status: "unavailable", notice: "Observation stopped; server cancellation could not be confirmed." }); return; }
    update({ status: result.value.status === "cancelled" ? "cancelled" : "cancelling", notice: result.value.status === "cancelled" ? "Server acknowledged cancellation. External outcomes may still need reconciliation." : "Cancellation requested; remote completion is unconfirmed." });
  };
  const applySurface = (input: { payload: Extract<StudioPayload, { type: 'a2ui' }>; run: ActiveRun }): void => {
    const payload = input.payload;
    if (payload.runId !== input.run.receipt.runId || payload.frontendSessionId !== input.run.frontendSessionId)
      throw new Error('Surface run/frontend mismatch');
    update({ surfaces: [...state.surfaces.filter(surface => surface.surfaceId !== payload.surfaceId), payload].slice(-20) });
  };
  const applyPayload = async (input: { payload: StudioPayload; run: ActiveRun }): Promise<void> => {
    const payload = input.payload;
    switch (payload.type) {
      case 'a2ui': applySurface({ payload, run: input.run }); return;
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
    const rendered = displayPayload({ payload, state });
    if (rendered) emit(rendered);
    if (active !== input.run) return false;
    await applyPayload({ payload, run: input.run });
    if (active !== input.run) return false;
    return finishEvent({ kind: event.kind, update });
  };
  const consume = async (input: { run: ActiveRun }): Promise<void> => {
    const run = input.run;
    for await (const event of required.api.events({ runId: run.receipt.runId, after: run.sequence, signal: run.controller.signal })) {
      if (active !== run) return;
      if (!event.ok) { update({ status: "unavailable", notice: "Run stream unavailable. External outcomes are unconfirmed." }); break; }
      if (!await accept({ value: event.value, run })) break;
    }
    await settleObservation({ run });
  };
  /** Optional server usage (or explicit sample fixtures); never establishes spend authority. */
  async function readUsage(input: { run: ActiveRun }): Promise<void> {
    if (!['complete', 'cancelled'].includes(state.status)) return;
    const run = input.run;
    const result = sample ? { ok: true as const, value: { usage: sampleReplyUsage } }
      : await required.api.runStatus?.({ runId: run.receipt.runId, after: Math.max(0, run.sequence - 1), signal: run.controller.signal });
    if (active !== run) return;
    const usage = assistantUsageSchema.safeParse(result?.ok ? result.value.usage : undefined);
    if (!usage.success) return;
    for (const event of usageEvents({ usage: usage.data, sample })) emit(event);
    update({ messages: state.messages.map(message => message.id === run.receipt.runId + '-reply' ? { ...message, usage: usage.data } : message) });
  }
  async function settleObservation(input: { run: ActiveRun }): Promise<void> {
    const run = input.run;
    if (active !== run) return;
    if (state.status === 'running') update({ status: 'unavailable', notice: 'Stream ended without a completion event. Outcomes are unconfirmed.' });
    if (state.status !== 'complete') update({ cards: state.cards.filter(card => !run.cardIds.has(card.cardId)) });
    await readUsage({ run });
    if (active !== run) return;
    finishDisplay(); clearRun(); await refresh();
  }
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
  /** Acceptance ends at the receipt; the existing consumer owns the sole subscription. */
  async function start(input: { text: string }): Promise<ActiveRun | null> {
      if (disposed || state.settingsPending || isActive({ status: state.status })) return null;
      const message = prepareMessage({ text: input.text, id: required.runtime.ids.next({}) });
      if (!message.ok) { update({ notice: message.error.message }); return null; }
      display?.release(); extensionIds.clear(); extensions(); displayEvents = []; lastRun = null;
      historyController?.abort(); frontendRun = null;
      frontendCardIds.clear();
      update({ messages: mergeMessage({ messages: state.messages, message: message.value }), tools: [], status: "starting", notice: "Requesting a run…" });
      const controller = required.runtime.abort(); pendingController = controller;
      const startDeadline = required.runtime.timers.schedule({ delayMs: 15000, callback: () => {
        if (pendingController !== controller) return;
        clearPending(); update({ status: "unavailable", notice: "Run start timed out. Server outcome is unconfirmed." });
      } });
      pendingTimer = startDeadline;
      const frontendSessionId = required.frontendSessionId?.();
      const frontendBindToken = required.frontendBindToken?.();
      const result = await required.api.start({ message: message.value, signal: controller.signal, conversationId: state.conversationId ?? undefined, frontendSessionId, frontendBindToken });
      required.runtime.timers.cancel({ handle: startDeadline });
      if (disposed || controller.signal.aborted) return null;
      pendingController = null; pendingTimer = null;
      if (!result.ok || !validReceipt(result.value)) { update({ status: "unavailable", notice: "Run could not be started." }); return null; }
      if (!matchingFrontendReceipt({ binding: frontendRun, receipt: result.value })) { update({ status: 'unavailable', notice: 'Frontend run binding disagrees with the server receipt.' }); return null; }
      if (result.value.expiresAt <= required.runtime.clock.now({})) { update({ status: "expired", notice: "Server run receipt already expired." }); return null; }
      const timer = required.runtime.timers.schedule({ delayMs: result.value.expiresAt - required.runtime.clock.now({}), callback: () => { void stop({ reason: "expired" }).then(finishDisplay); } });
      active = { frontendSessionId, receipt: result.value, controller, timer, sequence: 0, count: 0, bytes: 0, cardIds: new Set(frontendCardIds), seen: new Map() };
      lastRun = active;
      update({ status: "running", conversationId: result.value.conversationId ?? state.conversationId, mode: result.value.mode ?? null, notice: result.value.mode === 'sandbox' ? "Sandbox response · no model or vendor calls." : "Receiving a response…" });
      return active;
  }
  async function consumeSafely(input: { run: ActiveRun }): Promise<void> {
    try { await consume(input); }
    catch {
      if (active !== input.run) return;
      clearRun(); update({ status: 'unavailable', notice: 'Run stream interrupted. Saved work remains on the server.', cards: [] }); finishDisplay();
    }
  }
  /** Jini's foreign callbacks retain their ABI. Releasing handlers is separate from Stop. */
  function observe(input: { handlers: RunHandlers; signal?: AbortSignal }): void {
    display?.release();
    const release = (): void => { input.signal?.removeEventListener('abort', detach); if (display?.release === release) display = null; };
    const detach = (): void => { release(); clearRun(); };
    display = { handlers: input.handlers, release };
    input.signal?.addEventListener('abort', detach, { once: true });
    input.handlers.onCheckpoint?.({ id: lastRun!.receipt.runId + '-reply', role: 'assistant', content: '', runId: lastRun!.receipt.runId, runStatus: 'running', events: [...displayEvents] });
    if (input.signal?.aborted) detach();
    else finishDisplay();
  }
  const transport: ChatTransport = {
    async startRun(input, handlers) {
      if (input.attachments?.length) throw new Error('This server does not accept image attachments. Your message was not sent.');
      const message = input.history.findLast(item => item.role === 'user');
      const plugins = z.array(z.string().max(400)).max(100).safeParse(input.context?.pluginInstructions ?? []);
      if (!plugins.success) throw new Error('Invalid add-on selection.');
      const prefix = plugins.data.length ? 'Use these enabled add-ons when relevant: ' + plugins.data.join(', ') + '. This selection grants no authority.\n\n' : '';
      const run = await start({ text: prefix + (message?.content ?? '') });
      if (!run) throw new Error(state.notice);
      observe({ handlers, signal: input.signal });
      if (active === run) void consumeSafely({ run });
      return { runId: run.receipt.runId };
    },
    async reattachRun(runId, handlers, options) {
      const known = lastRun?.receipt.runId === runId;
      if (disposed || !idSchema.safeParse(runId).success) throw new Error('Invalid run.');
      if (lastRun?.receipt.runId !== runId) {
        clearRun(); displayEvents = []; extensionIds.clear();
        lastRun = { receipt: { runId, status: 'pending', expiresAt: required.runtime.clock.now({}) + 300000 }, controller: required.runtime.abort(), timer: null,
          sequence: 0, count: 0, bytes: 0, cardIds: new Set(), seen: new Map(), frontendSessionId: required.frontendSessionId?.() };
      }
      if (known && ['complete', 'cancelled'].includes(state.status)) { observe({ handlers, signal: options?.signal }); return; }
      if (lastRun.receipt.expiresAt <= required.runtime.clock.now({})) throw new Error('Run observation expired.');
      const alreadyObserving = active?.receipt.runId === runId;
      if (!alreadyObserving) {
        active = { ...lastRun, controller: required.runtime.abort(), timer: required.runtime.timers.schedule({ delayMs: lastRun.receipt.expiresAt - required.runtime.clock.now({}), callback: () => { void stop({ reason: 'expired' }).then(finishDisplay); } }) };
        lastRun = active; update({ status: 'running' });
      }
      observe({ handlers, signal: options?.signal });
      if (!alreadyObserving && active) void consumeSafely({ run: active });
    },
    async fetchRunStatus(runId) {
      if ((active?.receipt.runId === runId || ['complete', 'cancelled'].includes(state.status)) && lastRun?.receipt.runId === runId) return displayStatus({ status: state.status });
      const result = await required.api.runStatus?.({ runId });
      if (!result?.ok) return null;
      return { running: 'running', completed: 'succeeded', cancelled: 'canceled', interrupted: 'failed' }[result.value.status] as ChatRunStatus;
    },
    async stopRun(runId) {
      if (lastRun?.receipt.runId === runId) { await stop({ reason: 'owner' }); finishDisplay(); return; }
      const result = await required.api.cancel({ runId, reason: 'owner' });
      if (!result.ok) throw new Error(result.error.message);
    },
  };
  return {
    transport,
    currentRun() { if (disposed) return null; return active ? { runId: active.receipt.runId, expiresAt: active.receipt.expiresAt, frontendSessionId: active.frontendSessionId } : state.status === 'starting' ? frontendRun : null; },
    receiveFrontendBinding(input) {
      if (disposed || state.status !== 'starting' || input.frontendSessionId !== required.frontendSessionId?.() || !idSchema.safeParse(input.runId).success || !epochSchema.safeParse(input.expiresAt).success || input.expiresAt <= required.runtime.clock.now({})) return;
      frontendRun = input;
    },
    voidFrontendRun(input) {
      if (input.runId !== (active?.receipt.runId ?? frontendRun?.runId)) return;
      const cards = state.cards.filter(card => !lastRun?.cardIds.has(card.cardId) && !frontendCardIds.has(card.cardId));
      clearPending(); clearRun(); frontendRun = null; frontendCardIds.clear();
      update({ cards, status: input.status === 'cancelled' ? 'cancelled' : 'unavailable', notice: 'Server voided browser actions for this run. External outcomes may need reconciliation.',
        tools: state.tools.map(tool => tool.status === 'running' || tool.status === 'pending' ? { ...tool, status: 'cancelled' } : tool) });
      finishDisplay();
    },
    receiveSurface(input) {
      const parsed = a2uiSurfacePayloadSchema.safeParse(input.input);
      const runId = active?.receipt.runId ?? (state.status === 'starting' ? frontendRun?.runId : undefined);
      const frontendSessionId = active?.frontendSessionId ?? frontendRun?.frontendSessionId;
      if (!parsed.success || !runId || parsed.data.runId !== runId || parsed.data.frontendSessionId !== frontendSessionId) return;
      update({ surfaces: [...state.surfaces.filter(surface => surface.surfaceId !== parsed.data.surfaceId), parsed.data].slice(-20) });
    },
    addSurfaceApproval(input) {
      const parsed = confirmationCardSchema.safeParse(input.card);
      if (!parsed.success || ['cancelled', 'cancelling', 'expired', 'unavailable'].includes(state.status) || !state.surfaces.some(surface => surface.runId === input.runId)) return;
      if (active?.receipt.runId === input.runId) active.cardIds.add(parsed.data.cardId);
      if (state.status === 'starting' && frontendRun?.runId === input.runId) frontendCardIds.add(parsed.data.cardId);
      update({ cards: [...state.cards.filter(card => card.cardId !== parsed.data.cardId), parsed.data].slice(-50) });
    },
    getSnapshot() { return state; },
    refresh,
    async selectConversation(input) {
      if (disposed || isActive({ status: state.status }) || !required.api.conversation) return;
      historyController?.abort(); const controller = required.runtime.abort(); historyController = controller;
      const result = await required.api.conversation({ conversationId: input.conversationId, signal: controller.signal });
      if (controller.signal.aborted || disposed) return;
      const parsed = result.ok ? parseBoundary({ schema: conversationSchema, input: result.value }) : result;
      if (!parsed.ok || !isSafeUiValue({ value: parsed.ok ? parsed.value : null, maxCharacters: 262144 }) || parsed.value.conversation.conversationId !== input.conversationId) { update({ notice: 'Conversation could not be safely loaded.' }); return; }
      update({ transcriptVersion: state.transcriptVersion + 1, conversationId: input.conversationId, surfaces: [], messages: parsed.value.messages, cards: [], tools: [], status: 'idle', mode: null,
        notice: parsed.value.cursor ? 'Saved conversation. Showing the first 100 messages.' : 'Saved conversation.' });
    },
    async newConversation() {
      if (disposed || isActive({ status: state.status })) return;
      historyController?.abort();
      update({ transcriptVersion: state.transcriptVersion + 1, conversationId: null, surfaces: [], messages: [], cards: [], tools: [], status: 'idle', mode: null, notice: 'New conversation.' });
    },
    async selectModel(input) {
      if (disposed || state.settingsPending || isActive({ status: state.status }) || !required.api.setSettings) return;
      if (input.model !== 'sandbox' && !state.settings?.models?.some(model => model.id === input.model)) return;
      const settings = { ...state.settings?.settings, mode: input.model === 'sandbox' ? 'sandbox' as const : 'model' as const,
        model: input.model === 'sandbox' ? state.settings?.settings.model ?? '' : input.model,
        connectionId: state.settings?.settings.connectionId ?? null };
      const result = await required.api.setSettings({ settings });
      if (disposed) return;
      const parsed = result.ok ? parseBoundary({ schema: assistantSettingsStatusSchema, input: result.value }) : result;
      if (!parsed.ok) { update({ notice: 'Assistant settings could not be saved.' }); return; }
      update({ settings: parsed.value, notice: parsed.value.ready ? 'Assistant settings saved.' : 'Connect the selected provider in Add-ons / Integrations, or choose Sandbox.' });
    },
    /** Save only advertised selections; pending writes block another selection and run acceptance. */
    async selectRuntime(input) {
      if (disposed || state.settingsPending || isActive({ status: state.status }) || !required.api.setSettings || !state.settings) return;
      const settings = runtimeSettings({ status: state.settings, ...input });
      if (!settings) return;
      historyController?.abort();
      update({ settingsPending: true });
      const result = await required.api.setSettings({ settings });
      if (disposed) return;
      const parsed = result.ok ? parseBoundary({ schema: assistantSettingsStatusSchema, input: result.value }) : result;
      if (!parsed.ok) { update({ settingsPending: false, notice: 'Assistant selection could not be saved.' }); return; }
      update({ settingsPending: false, settings: parsed.value, notice: parsed.value.ready ? 'Assistant selection saved.' : 'Connect this vendor in Integrations.' });
    },
    subscribe(input) { listeners.add(input.listener); return () => { listeners.delete(input.listener); }; },
    hydrate(input) {
      const parsed = parseStudioSnapshot(input);
      if (!parsed.ok) { update({ notice: "Studio snapshot rejected.", status: "unavailable" }); return; }
      sample = parsed.value.mode === 'sample';
      update({ transcriptVersion: state.transcriptVersion + 1, messages: parsed.value.messages, cards: parsed.value.cards, notice: parsed.value.mode === "sample" ? "Sample conversation · agent runtime is not connected." : "Ready" });
    },
    async send(input) { const run = await start(input); if (run) await consumeSafely({ run }); },
    async cancel() {
      if (disposed || state.status === "cancelling") return;
      await stop({ reason: "owner" }); finishDisplay();
    },
    dispose() { display?.release(); historyController?.abort(); clearPending(); clearRun(); frontendRun = null; frontendCardIds.clear(); disposed = true; listeners.clear(); },
  };
}
/** A bind frame can arrive while start awaits I/O; headless starts have no binding to compare. */
function matchingFrontendReceipt(required: { binding: { runId: string } | null; receipt: StudioRun }): boolean {
  return required.binding === null || required.binding.runId === required.receipt.runId;
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

/** Pure display translation; authority remains in the validated OM payload/session. */
function displayPayload(required: { payload: StudioPayload; state: ChatState }): AgentEvent | null {
  const p = required.payload;
  switch (p.type) {
    case 'text_delta': return { kind: 'text', text: p.text };
    case 'message': return p.message.role === 'assistant' ? { kind: 'text', text: p.message.text.slice(required.state.messages.find(message => message.id === p.message.id)?.text.length ?? 0) } : null;
    case 'tool_requested': return { kind: 'tool_use', id: p.call.operationId, name: p.call.name, input: p.call.input };
    case 'tool_result': return p.result.status === 'completed' ? { kind: 'tool_result', toolUseId: p.operationId, content: JSON.stringify(p.result.output), isError: false } : null;
    case 'confirmation_resolved': return p.status === 'cancelled' ? { kind: 'tool_result', toolUseId: p.operationId, content: 'Cancelled', isError: true } : null;
    case 'confirmation': case 'a2ui': case 'navigation': case 'status': return null;
    default: { const exhaustive: never = p; return exhaustive; }
  }
}
function displayStatus(required: { status: ChatState['status'] }): ChatRunStatus | null {
  switch (required.status) {
    case 'starting': return 'queued';
    case 'running': case 'cancelling': return 'running';
    case 'complete': return 'succeeded';
    case 'cancelled': return 'canceled';
    case 'expired': case 'unavailable': return 'failed';
    case 'idle': return null;
    default: { const exhaustive: never = required.status; return exhaustive; }
  }
}
